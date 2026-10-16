import type { PoolClient } from 'pg';
import { withTransaction } from '../../config/db';
import { sendEmailInBackground } from '../../services/email';
import { donationPledgeReceivedThankYou } from '../../services/emailTemplates';
import { errors } from '../../utils/AppError';
import { recordAudit } from '../../utils/audit';
import { todayInJohannesburg } from '../../utils/dates';
import { centsToNumeric, formatRand, numericToCents } from '../../utils/money';
import { pageMeta, pageToLimitOffset } from '../../utils/pagination';
import type { PageMeta } from '../../utils/respond';
import { findDonationPledge, saveDecision } from '../reviews/reviews.repository';
import { type PledgeItem, toPledgeItem } from '../reviews/reviews.service';
import { canMove, refusalMessage } from '../reviews/reviews.transitions';
import { lockStockItems, recordMovement } from '../stock/stock.repository';
import { amountOf } from '../stock/stock.service';
import * as repo from './donations.repository';
import type { DonationRow } from './donations.repository';
import {
  type CreateDonationInput,
  type DonationListQuery,
  type DonationType,
  type ReceivePledgeInput,
  type VoidDonationInput,
  donationShapeProblems,
} from './donations.schemas';

/**
 * Recorded donations (Task 1, UC-04 "Record donation"). A goods donation is
 * saved together with a stock movement in and the new quantity on hand, in one
 * transaction that locks the stock item: if anything fails halfway, nothing is
 * saved. A monetary donation has an amount and no stock.
 */

export type Donation = ReturnType<typeof toDonation>;

function toDonation(row: DonationRow) {
  const cents = row.amount === null ? null : numericToCents(row.amount);
  return {
    donationId: row.donation_id,
    type: row.donation_type,
    donorName: row.donor_name,
    isAnonymous: row.is_anonymous,
    amountCents: cents,
    amount: cents === null ? null : formatRand(cents),
    receiptReference: row.receipt_reference,
    stockItem:
      row.stock_item_id === null
        ? null
        : { stockItemId: row.stock_item_id, name: row.item_name, unit: row.unit_of_measure },
    quantity: row.quantity,
    initiative:
      row.initiative_id === null
        ? null
        : { initiativeId: row.initiative_id, title: row.initiative_title },
    pledge:
      row.pledge_id === null
        ? null
        : { pledgeId: row.pledge_id, referenceNumber: row.pledge_reference },
    dateReceived: row.date_received,
    recordedBy: { adminId: row.recorded_by, fullName: row.recorded_by_name },
    voided:
      row.voided_at === null
        ? null
        : {
            at: row.voided_at,
            by: { adminId: row.voided_by, fullName: row.voided_by_name },
            reason: row.void_reason,
          },
  };
}

const donationNotFound = () => errors.notFound("We couldn't find that donation.");

export async function listDonations(
  filters: DonationListQuery,
): Promise<{ items: Donation[]; meta: PageMeta }> {
  const page = pageToLimitOffset(filters.page, filters.pageSize);
  const { rows, total } = await repo.listDonations({ ...filters, ...page });
  return { items: rows.map(toDonation), meta: pageMeta(filters.page, filters.pageSize, total) };
}

export async function getDonation(donationId: number): Promise<Donation> {
  const row = await repo.findDonation(donationId);
  if (!row) throw donationNotFound();
  return toDonation(row);
}

type NewDonation = {
  type: DonationType;
  donorName: string;
  isAnonymous: boolean;
  initiativeId: number | null;
  amount?: number;
  receiptReference?: string;
  stockItemId?: number;
  quantity?: number;
  dateReceived?: string;
  pledgeId: number | null;
};

/**
 * Saves a donation inside the caller's transaction. For goods: locks the stock
 * item, then saves the donation, the movement in, and the new quantity.
 */
async function saveDonation(client: PoolClient, adminId: number, input: NewDonation) {
  const problems = donationShapeProblems(input.type, input);
  if (problems.length > 0) throw errors.validation(problems);

  if (input.initiativeId !== null && !(await repo.initiativeExists(client, input.initiativeId))) {
    throw errors.validation([
      { field: 'initiativeId', message: 'Please choose one of the events.' },
    ]);
  }
  if (input.type === 'Goods') {
    const item = (await lockStockItems(client, [input.stockItemId!])).get(input.stockItemId!);
    if (!item) {
      throw errors.validation([{ field: 'stockItemId', message: 'Please choose a stock item.' }]);
    }
  }

  const donationId = await repo.insertDonation(client, {
    adminId,
    type: input.type,
    donorName: input.donorName,
    isAnonymous: input.isAnonymous,
    initiativeId: input.initiativeId,
    amount: input.type === 'Monetary' ? centsToNumeric(input.amount!) : null,
    receiptReference: input.receiptReference ?? null,
    stockItemId: input.type === 'Goods' ? input.stockItemId! : null,
    quantity: input.type === 'Goods' ? input.quantity! : null,
    dateReceived: input.dateReceived ?? todayInJohannesburg(),
    pledgeId: input.pledgeId,
  });
  if (input.type === 'Goods') {
    await recordMovement(client, {
      stockItemId: input.stockItemId!,
      type: 'Increase',
      quantity: input.quantity!,
      adminId,
      donationId,
      reason: null,
    });
  }
  await recordAudit(
    {
      adminId,
      action: 'donation_recorded',
      tableName: 'donation',
      recordId: donationId,
      details: {
        type: input.type,
        ...(input.type === 'Goods'
          ? { stockItemId: input.stockItemId, quantity: input.quantity }
          : { amountCents: input.amount }),
        ...(input.pledgeId ? { pledgeId: input.pledgeId } : {}),
      },
    },
    client,
  );
  return (await repo.findDonation(donationId, client))!;
}

/** POST /admin/donations */
export async function recordDonation(
  adminId: number,
  input: CreateDonationInput,
): Promise<Donation> {
  const row = await withTransaction((client) =>
    saveDonation(client, adminId, {
      ...input,
      donorName: input.donorName ?? 'Anonymous',
      initiativeId: input.initiativeId ?? null,
      pledgeId: null,
    }),
  );
  return toDonation(row);
}

/**
 * POST /admin/donations/:id/void. Keeps the record and reverses its stock. If
 * some of the goods have already been given out, stock would go below zero,
 * so it refuses (409) and says so.
 */
export async function voidDonation(
  adminId: number,
  donationId: number,
  input: VoidDonationInput,
): Promise<Donation> {
  const row = await withTransaction(async (client) => {
    const donation = await repo.findDonation(donationId, client, { lock: true });
    if (!donation) throw donationNotFound();
    if (donation.voided_at !== null) {
      throw errors.conflict('This donation has already been voided.');
    }

    if (donation.donation_type === 'Goods') {
      const itemId = donation.stock_item_id!;
      const item = (await lockStockItems(client, [itemId])).get(itemId)!;
      const quantity = donation.quantity!;
      if (item.quantity_on_hand < quantity) {
        throw errors.conflict(
          'Some of these goods have already been given out: the donation added ' +
            `${amountOf(quantity, item.unit_of_measure)} of ${item.item_name}, but only ` +
            `${item.quantity_on_hand} are left in stock, so it can't be voided. ` +
            'If it was recorded by mistake, correct the stock with an adjustment instead.',
        );
      }
      await recordMovement(client, {
        stockItemId: itemId,
        type: 'Decrease',
        quantity,
        adminId,
        donationId,
        reason: `Donation voided: ${input.reason}`,
      });
    }
    await repo.markVoided(client, donationId, adminId, input.reason);
    await recordAudit(
      {
        adminId,
        action: 'donation_voided',
        tableName: 'donation',
        recordId: donationId,
        details: { type: donation.donation_type },
      },
      client,
    );
    return (await repo.findDonation(donationId, client))!;
  });
  return toDonation(row);
}

/**
 * POST /admin/donation-pledges/:id/receive. The pledge must be Accepted. It
 * becomes a donation linked by pledge_id (with its stock, for goods), and the
 * pledge becomes Received, all in one transaction. The donor gets a thank-you.
 */
export async function receivePledge(
  adminId: number,
  pledgeId: number,
  input: ReceivePledgeInput,
): Promise<{ pledge: PledgeItem; donation: Donation }> {
  const result = await withTransaction(async (client) => {
    const pledge = await findDonationPledge(pledgeId, client, { lock: true });
    if (!pledge) throw errors.notFound("We couldn't find that pledge.");
    if (!canMove('pledge', pledge.status, 'Received')) {
      throw errors.conflict(
        pledge.status === 'Pending'
          ? 'Accept the pledge before recording that it was received.'
          : refusalMessage('pledge', pledge.status, 'Received'),
      );
    }

    const type: DonationType =
      input.type ?? (pledge.category === 'Monetary' ? 'Monetary' : 'Goods');
    const donation = await saveDonation(client, adminId, {
      ...input,
      type,
      donorName: pledge.donor_name,
      isAnonymous: false,
      initiativeId: pledge.initiative_id,
      pledgeId,
    });
    await saveDecision(client, 'pledge', pledgeId, { status: 'Received', adminId, reason: null });
    await recordAudit(
      {
        adminId,
        action: 'donation_pledge_received',
        tableName: 'donation_pledge',
        recordId: pledgeId,
        details: { from: pledge.status, to: 'Received', donationId: donation.donation_id },
      },
      client,
    );
    return { pledge: (await findDonationPledge(pledgeId, client))!, donation };
  });

  sendEmailInBackground(
    donationPledgeReceivedThankYou({
      to: result.pledge.email,
      name: result.pledge.donor_name,
      referenceNumber: result.pledge.reference_number,
      category: result.pledge.category,
    }),
    'donation-pledge-received',
  );
  return { pledge: toPledgeItem(result.pledge), donation: toDonation(result.donation) };
}

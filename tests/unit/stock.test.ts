import { describe, expect, it } from 'vitest';
import {
  createDonationSchema,
  donationShapeProblems,
  receivePledgeSchema,
} from '../../src/modules/donations/donations.schemas';
import {
  adjustmentSchema,
  fulfilSchema,
  updateStockItemSchema,
} from '../../src/modules/stock/stock.schemas';
import { amountOf } from '../../src/modules/stock/stock.service';

const firstMessages = (result: {
  error?: { issues: Array<{ path: PropertyKey[]; message: string }> };
}) => {
  const messages: Record<string, string> = {};
  for (const issue of result.error?.issues ?? []) {
    messages[issue.path.join('.') || 'request'] ??= issue.message;
  }
  return messages;
};

describe('donation rules (Task 1, Section 8.4)', () => {
  it('rejects a monetary donation with a quantity', () => {
    const result = createDonationSchema.safeParse({
      type: 'Monetary',
      donorName: 'Naledi Mokoena',
      amount: 250,
      quantity: 3,
    });
    expect(firstMessages(result)).toEqual({
      quantity: 'A monetary donation has no quantity. Record goods as a goods donation.',
    });
  });

  it('needs a stock item and quantity for goods, and no amount', () => {
    expect(donationShapeProblems('Goods', { amount: 100 }).map((p) => p.field)).toEqual([
      'stockItemId',
      'quantity',
      'amount',
    ]);
    expect(donationShapeProblems('Goods', { stockItemId: 1, quantity: 12 })).toEqual([]);
    expect(donationShapeProblems('Monetary', { amount: 25_050 })).toEqual([]);
  });

  it('reads amounts in rands and keeps them as cents', () => {
    const parsed = createDonationSchema.parse({
      type: 'Monetary',
      isAnonymous: true,
      amount: 'R250.50',
      receiptReference: 'EFT-001',
      initiativeId: '',
    });
    expect(parsed).toMatchObject({ amount: 25_050, isAnonymous: true });
    expect(parsed.initiativeId).toBeUndefined();
    expect(
      firstMessages(createDonationSchema.safeParse({ type: 'Monetary', amount: 10 })).donorName,
    ).toBe("Please enter the donor's name, or tick anonymous.");
  });

  it("doesn't accept a date in the future", () => {
    const result = createDonationSchema.safeParse({
      type: 'Monetary',
      donorName: 'Naledi Mokoena',
      amount: 10,
      dateReceived: '2999-01-01',
    });
    expect(firstMessages(result).dateReceived).toBe("The date received can't be in the future.");
  });

  it('lets a received pledge leave the type to the pledge', () => {
    const parsed = receivePledgeSchema.parse({ stockItemId: 4, quantity: 8 });
    expect(parsed).toMatchObject({ stockItemId: 4, quantity: 8 });
    expect(parsed.type).toBeUndefined();
  });
});

describe('stock rules', () => {
  it('only changes stock through movements', () => {
    const result = updateStockItemSchema.safeParse({ quantityOnHand: 50 });
    expect(firstMessages(result).quantityOnHand).toMatch(
      /only change through a donation, a fulfilled request or a stock adjustment/,
    );
  });

  it('needs a reason for a manual adjustment', () => {
    const result = adjustmentSchema.safeParse({ stockItemId: 1, type: 'Decrease', quantity: 2 });
    expect(firstMessages(result).reason).toMatch(/Please say why the stock changed/);
  });

  it('lists each item once when fulfilling, and allows no goods at all', () => {
    const twice = fulfilSchema.safeParse({
      items: [
        { stockItemId: 3, quantity: 1 },
        { stockItemId: 3, quantity: 2 },
      ],
    });
    expect(firstMessages(twice)).toEqual({
      'items.1.stockItemId': 'Each item can only be listed once. Add the quantities together.',
    });
    expect(fulfilSchema.parse({ items: [] })).toEqual({ items: [] });
  });

  it('writes amounts with their unit', () => {
    expect(amountOf(12, 'blanket')).toBe('12 blankets');
    expect(amountOf(1, 'blanket')).toBe('1 blanket');
    expect(amountOf(3, 'kits')).toBe('3 kits');
  });
});

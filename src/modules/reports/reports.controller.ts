import type { Request, Response } from 'express';
import { validated } from '../../middleware/validate';
import { sendCsv } from '../../utils/csv';
import { ok } from '../../utils/respond';
import type { DonationReportQuery, FormatQuery, RangeQuery } from './reports.schemas';
import * as service from './reports.service';

/** Thin layer: each report as JSON, or as a CSV download with ?format=csv. */

const span = (range: { from: string; to: string }) => `${range.from}_to_${range.to}`;

/** GET /admin/dashboard */
export async function dashboard(_req: Request, res: Response): Promise<void> {
  ok(res, await service.dashboard());
}

/** GET /admin/reports/donations */
export async function donations(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: DonationReportQuery }>(res);
  if (query.format === 'csv') {
    sendCsv(res, `donations_${span(query)}`, await service.donationReportCsv(query));
    return;
  }
  ok(res, await service.donationReport(query));
}

/** GET /admin/reports/stock */
export async function stock(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: RangeQuery }>(res);
  if (query.format === 'csv') {
    sendCsv(res, `stock_${span(query)}`, await service.stockReportCsv(query));
    return;
  }
  ok(res, await service.stockReport(query));
}

/** GET /admin/reports/assistance-requests */
export async function assistanceRequests(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: RangeQuery }>(res);
  if (query.format === 'csv') {
    sendCsv(res, `assistance-requests_${span(query)}`, await service.requestReportCsv(query));
    return;
  }
  ok(res, await service.requestReport(query));
}

/** GET /admin/reports/initiatives */
export async function initiatives(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: RangeQuery }>(res);
  if (query.format === 'csv') {
    sendCsv(res, `initiatives_${span(query)}`, await service.initiativesReportCsv(query));
    return;
  }
  ok(res, await service.initiativesReport(query));
}

/** GET /admin/reports/initiatives/:id */
export async function initiative(_req: Request, res: Response): Promise<void> {
  const { params, query } = validated<{ params: { id: number }; query: FormatQuery }>(res);
  if (query.format === 'csv') {
    sendCsv(res, `initiative-${params.id}`, await service.initiativeReportCsv(params.id));
    return;
  }
  ok(res, await service.initiativeReport(params.id));
}

/** GET /admin/reports/sales */
export async function sales(_req: Request, res: Response): Promise<void> {
  const { query } = validated<{ query: RangeQuery }>(res);
  if (query.format === 'csv') {
    sendCsv(res, `sales_${span(query)}`, await service.salesReportCsv(query));
    return;
  }
  ok(res, await service.salesReport(query));
}

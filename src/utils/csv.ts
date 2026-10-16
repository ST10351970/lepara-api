import type { Response } from 'express';
import { centsToNumeric } from './money';

/**
 * CSV files that open cleanly in Excel and are safe to open.
 *
 *  - Text is always quoted, with any " doubled, so commas, quotes and line
 *    breaks inside a value can't break the columns.
 *  - Text starting with = + - @ (or a tab or carriage return) gets a ' in front.
 *    Excel would otherwise run it as a formula: a donor named
 *    =HYPERLINK("http://evil.example","Click") must show as plain text
 *    ("CSV injection").
 *  - Numbers and amounts are written as plain numbers, so Excel can add them up.
 *  - The file starts with a byte-order mark and uses Windows line endings, so
 *    Excel reads names like Thabiso Mokoena-Dlamini or Zoë correctly.
 */

/** An amount in cents, written as rands with 2 decimals (25050 → 250.50). */
export type Rands = { cents: number };
export const rands = (cents: number): Rands => ({ cents });

export type CsvValue = string | number | boolean | null | undefined | Rands;

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: CsvValue): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (typeof value === 'object') return centsToNumeric(value.cents);
  const text = FORMULA_START.test(value) ? `'${value}` : value;
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(headers: string[], rows: CsvValue[][]): string {
  const lines = [headers, ...rows].map((row) => row.map(csvCell).join(','));
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

/** Sends a CSV as a download. `name` is made only of fixed words and dates. */
export function sendCsv(res: Response, name: string, csv: string): void {
  const filename = `${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.csv`;
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send(csv);
}

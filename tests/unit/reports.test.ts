import { describe, expect, it } from 'vitest';
import { donationReportQuery, rangeQuery } from '../../src/modules/reports/reports.schemas';
import { csvCell, rands, toCsv } from '../../src/utils/csv';
import { todayInJohannesburg } from '../../src/utils/dates';

describe('CSV files', () => {
  it('quotes text and doubles any quotes inside it', () => {
    expect(csvCell('Zoë "ZZ" Dlamini')).toBe('"Zoë ""ZZ"" Dlamini"');
    expect(csvCell('Line one\nline two, with comma')).toBe('"Line one\nline two, with comma"');
  });

  it('stops Excel running a cell as a formula', () => {
    expect(csvCell('=HYPERLINK("http://evil.example","Click")')).toBe(
      '"\'=HYPERLINK(""http://evil.example"",""Click"")"',
    );
    for (const start of ['=', '+', '-', '@', '\t', '\r']) {
      expect(csvCell(`${start}1+1`).startsWith(`"'${start}`)).toBe(true);
    }
    expect(csvCell('Thabo')).toBe('"Thabo"');
  });

  it('writes numbers and amounts as plain numbers, and yes/no for flags', () => {
    expect(csvCell(-3)).toBe('-3');
    expect(csvCell(rands(125050))).toBe('1250.50');
    expect(csvCell(true)).toBe('Yes');
    expect(csvCell(null)).toBe('');
  });

  it('starts with a byte-order mark and uses Windows line endings', () => {
    const csv = toCsv(['Donor', 'Amount (R)'], [['Thabo', rands(25000)]]);
    expect(csv).toBe('\uFEFF"Donor","Amount (R)"\r\n"Thabo",250.00\r\n');
  });
});

describe('report date ranges', () => {
  it('covers this month so far when no dates are given', () => {
    const today = todayInJohannesburg();
    expect(rangeQuery.parse({})).toEqual({
      from: `${today.slice(0, 8)}01`,
      to: today,
      format: 'json',
    });
  });

  it('refuses an end date before the start date', () => {
    const result = rangeQuery.safeParse({ from: '2026-10-31', to: '2026-10-01' });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ['to'],
      message: 'The end date must be on or after the start date.',
    });
  });

  it('allows a one-day range, refuses impossible dates, and reads the format', () => {
    expect(rangeQuery.parse({ from: '2026-10-16', to: '2026-10-16', format: 'csv' })).toEqual({
      from: '2026-10-16',
      to: '2026-10-16',
      format: 'csv',
    });
    expect(rangeQuery.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(rangeQuery.parse({ from: '2026-10-01', format: 'pdf' }).format).toBe('json');
  });

  it('ignores donation filters it cannot read', () => {
    const query = donationReportQuery.parse({
      from: '2026-10-01',
      to: '2026-10-31',
      type: 'Cash',
      initiativeId: 'abc',
    });
    expect(query.type).toBeUndefined();
    expect(query.initiativeId).toBeUndefined();
    expect(donationReportQuery.parse({ type: 'Goods', initiativeId: '4' })).toMatchObject({
      type: 'Goods',
      initiativeId: 4,
    });
  });
});

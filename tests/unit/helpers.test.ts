import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MIGRATION_NAME_PATTERN, parseMigrationFile } from '../../db/migrationFile';
import { pageMeta, pageToLimitOffset } from '../../src/utils/pagination';
import { pickSort } from '../../src/utils/sql';

describe('pickSort', () => {
  const sorts = { newest: 'submitted_date DESC', oldest: 'submitted_date ASC' };

  it('returns only SQL written in the code', () => {
    expect(pickSort('oldest', sorts, 'newest')).toBe('submitted_date ASC');
    expect(pickSort(undefined, sorts, 'newest')).toBe('submitted_date DESC');
  });

  it('ignores anything else a user sends, including injection attempts', () => {
    expect(pickSort('submitted_date; DROP TABLE donation', sorts, 'newest')).toBe(
      'submitted_date DESC',
    );
    expect(pickSort('constructor', sorts, 'newest')).toBe('submitted_date DESC');
    expect(pickSort('__proto__', sorts, 'newest')).toBe('submitted_date DESC');
  });
});

describe('pagination helpers', () => {
  it('turns pages into LIMIT and OFFSET', () => {
    expect(pageToLimitOffset(1, 20)).toEqual({ limit: 20, offset: 0 });
    expect(pageToLimitOffset(3, 20)).toEqual({ limit: 20, offset: 40 });
  });

  it('reports the number of pages, at least one', () => {
    expect(pageMeta(1, 20, 0)).toEqual({ page: 1, pageSize: 20, total: 0, totalPages: 1 });
    expect(pageMeta(2, 20, 41)).toEqual({ page: 2, pageSize: 20, total: 41, totalPages: 3 });
  });
});

describe('migration files', () => {
  it('splits a file into its up and down sections', () => {
    const parsed = parseMigrationFile(
      '-- about\n-- migrate:up\nCREATE TABLE a ();\n-- migrate:down\nDROP TABLE a;\n',
      'x.sql',
    );
    expect(parsed).toEqual({ up: 'CREATE TABLE a ();', down: 'DROP TABLE a;' });
  });

  it('refuses files without both sections', () => {
    expect(() => parseMigrationFile('CREATE TABLE a ();', 'x.sql')).toThrow(/needs both/);
    expect(() => parseMigrationFile('-- migrate:down\nx;\n-- migrate:up\ny;', 'x.sql')).toThrow(
      /must come before/,
    );
    expect(() =>
      parseMigrationFile('-- migrate:up\n-- migrate:down\nDROP TABLE a;', 'x.sql'),
    ).toThrow(/up section is empty/);
  });

  it('every file in db/migrations is named and written correctly', () => {
    const dir = path.join(__dirname, '../../db/migrations');
    const files = readdirSync(dir).filter((name) => name.endsWith('.sql'));
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      expect(file).toMatch(MIGRATION_NAME_PATTERN);
      const parsed = parseMigrationFile(readFileSync(path.join(dir, file), 'utf8'), file);
      expect(parsed.up.length).toBeGreaterThan(0);
      expect(parsed.down.length).toBeGreaterThan(0);
    }
  });
});

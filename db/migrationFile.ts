/**
 * A migration file is plain SQL with two markers:
 *
 *   -- migrate:up
 *   CREATE TABLE ...;
 *   -- migrate:down
 *   DROP TABLE ...;
 *
 * Anything above "-- migrate:up" is a comment block describing the file.
 */

export const UP_MARKER = '-- migrate:up';
export const DOWN_MARKER = '-- migrate:down';
export const MIGRATION_NAME_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

export type ParsedMigration = { up: string; down: string };

export function parseMigrationFile(text: string, fileName: string): ParsedMigration {
  const upAt = text.indexOf(UP_MARKER);
  const downAt = text.indexOf(DOWN_MARKER);

  if (upAt === -1 || downAt === -1) {
    throw new Error(`${fileName} needs both "${UP_MARKER}" and "${DOWN_MARKER}" lines.`);
  }
  if (downAt < upAt) {
    throw new Error(`${fileName}: "${UP_MARKER}" must come before "${DOWN_MARKER}".`);
  }
  if (text.indexOf(UP_MARKER, upAt + 1) !== -1 || text.indexOf(DOWN_MARKER, downAt + 1) !== -1) {
    throw new Error(`${fileName}: each marker may appear only once.`);
  }

  const up = text.slice(upAt + UP_MARKER.length, downAt).trim();
  const down = text.slice(downAt + DOWN_MARKER.length).trim();

  if (!up) throw new Error(`${fileName}: the up section is empty.`);
  if (!down) throw new Error(`${fileName}: the down section is empty.`);
  return { up, down };
}

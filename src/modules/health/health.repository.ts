import { query } from '../../config/db';

export async function pingDatabase(): Promise<boolean> {
  const result = await query<{ ok: number }>('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

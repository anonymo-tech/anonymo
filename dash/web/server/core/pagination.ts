import { ServiceError } from './errors.ts';

export function readCursor(value: string | null, scope: string): { time: string; id: string } | null {
  if (!value) return null;
  try {
    if (!/^[A-Za-z0-9_-]{1,512}$/.test(value)) throw new Error();
    const cursor: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    if (!Array.isArray(cursor) || cursor.length !== 3 || cursor[2] !== scope || typeof cursor[0] !== 'string' || typeof cursor[1] !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(cursor[0]) || !Number.isFinite(Date.parse(cursor[0])) ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(cursor[1])) throw new Error();
    return { time: cursor[0], id: cursor[1] };
  } catch { throw new ServiceError(400, 'INVALID_CURSOR', 'This page cursor is invalid.'); }
}

export function nextCursor(rows: { id: string; cursorTime: string }[], pageSize: number, scope: string) {
  if (rows.length <= pageSize) return null;
  const last = rows[pageSize - 1];
  return Buffer.from(JSON.stringify([last.cursorTime, last.id, scope])).toString('base64url');
}

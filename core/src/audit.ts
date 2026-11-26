import type { Db } from './db';

export interface AccessEntry {
  userId: string;
  destination: string;
  tool: string;
  request: Record<string, unknown>;
  projectId?: string;
  returned: Record<string, unknown>;
}

export async function logAccess(db: Db, e: AccessEntry) {
  await db.query(
    `insert into access_log (user_id, destination, tool, request, project_id, returned) values ($1,$2,$3,$4::jsonb,$5,$6::jsonb)`,
    [e.userId, e.destination, e.tool, JSON.stringify(e.request), e.projectId ?? null, JSON.stringify(e.returned)],
  );
}

export async function recentAccess(db: Db, limit = 20) {
  const rows = await db.query(
    `select seq, at, user_id, destination, tool, request, project_id, returned from access_log order by seq desc limit $1`,
    [limit],
  );
  const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
  return rows.reverse().map(r => ({ ...r, request: parse(r.request), returned: parse(r.returned) }));
}

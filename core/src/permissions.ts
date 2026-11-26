import type { Db } from './db';
import type { RelationTuple } from './types';

export async function grant(db: Db, t: RelationTuple) {
  await db.query(
    'insert into relation_tuples values ($1,$2,$3,$4,$5) on conflict do nothing',
    [t.subject.type, t.subject.id, t.relation, t.resource.type, t.resource.id],
  );
}

/** Projects a user may read: member/approver of the project, or admin of its workspace. */
export async function allowedProjectIds(db: Db, userId: string): Promise<string[]> {
  const rows = await db.query<{ id: string }>(
    `select p.id from projects p
     where exists (select 1 from relation_tuples r
                   where r.subject_type = 'user' and r.subject_id = $1
                     and r.resource_type = 'project' and r.resource_id = p.id
                     and r.relation in ('member', 'approver'))
        or exists (select 1 from relation_tuples r
                   where r.subject_type = 'user' and r.subject_id = $1
                     and r.resource_type = 'workspace' and r.resource_id = p.workspace_id
                     and r.relation = 'admin')
     order by p.id`,
    [userId],
  );
  return rows.map(r => r.id);
}

export async function can(db: Db, userId: string, relation: string, projectId: string): Promise<boolean> {
  const rows = await db.query(
    `select 1 from relation_tuples where subject_type = 'user' and subject_id = $1
       and relation = $2 and resource_type = 'project' and resource_id = $3 limit 1`,
    [userId, relation, projectId],
  );
  return rows.length > 0;
}

/**
 * Projects whose names may appear in the AI-facing tool description: the user's projects whose classification is
 * at or below `nameCeiling`. Names in a tool definition reach the AI vendor on every request, so the bar is lower
 * than for answering a question that already names the project.
 */
export async function nameableProjects(db: Db, userId: string, nameCeiling: string): Promise<{ id: string; name: string; aliases: string[] }[]> {
  const order = ['public', 'internal', 'confidential', 'restricted'];
  const ok = order.slice(0, order.indexOf(nameCeiling) + 1);
  const ids = await allowedProjectIds(db, userId);
  return db.query(
    `select id, name, aliases from projects where id = any($1::text[]) and default_classification = any($2::text[]) order by name`,
    [ids, ok],
  );
}

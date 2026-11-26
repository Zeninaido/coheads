import { randomUUID } from 'node:crypto';
import type { Db } from './db';
import { can } from './permissions';
import type { Classification, Decision, DecisionValue, ISODate, SourceRef, SubjectRef } from './types';

export interface ProposeInput {
  projectId: string;
  topicKey: string;
  label: string;
  value: DecisionValue;
  validFrom?: ISODate;
  sources: SourceRef[];
  by: SubjectRef;
  classification?: Classification;
  /** Replaying a shared-folder event: keep its id and time. */
  id?: string;
  at?: Date;
  /** Replaying: the author's membership was checked when the event was written. */
  trusted?: boolean;
}

const json = (v: unknown) => JSON.stringify(v);
const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);

/** Dates come back as text (`::text`) so no engine or time zone can shift them. */
const DECISION_COLS = `id, workspace_id, project_id, topic_key, label, value, status, retired_reason,
  valid_from::text as valid_from, valid_to::text as valid_to, recorded_at, recorded_by,
  approved_by, approved_at, sources, classification, supersedes`;

function rowToDecision(r: any): Decision {
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    projectId: r.project_id,
    topicKey: r.topic_key,
    label: r.label,
    value: parse(r.value),
    status: r.status,
    retiredReason: r.retired_reason ?? undefined,
    validFrom: r.valid_from ?? undefined,
    validTo: r.valid_to ?? undefined,
    recordedAt: new Date(r.recorded_at).toISOString(),
    recordedBy: parse(r.recorded_by),
    approvedBy: r.approved_by ? parse(r.approved_by) : undefined,
    approvedAt: r.approved_at ? new Date(r.approved_at).toISOString() : undefined,
    sources: parse(r.sources),
    classification: r.classification,
    supersedes: r.supersedes ?? undefined,
  };
}

/** Record a candidate. Members may propose; nothing becomes current without an approver. */
export async function propose(db: Db, input: ProposeInput): Promise<Decision> {
  const [p] = await db.query('select workspace_id, default_classification from projects where id = $1', [input.projectId]);
  if (!p) throw new Error(`unknown project ${input.projectId}`);
  if (!input.trusted && input.by.type === 'user' && !(await can(db, input.by.id, 'member', input.projectId)) && !(await can(db, input.by.id, 'approver', input.projectId))) {
    throw new Error('forbidden: not a member of the project');
  }
  const id = input.id ?? randomUUID();
  const at = (input.at ?? new Date()).toISOString();
  return db.tx(async tx => {
    await tx.query(
      `insert into decisions (id, workspace_id, project_id, topic_key, label, value, status, valid_from, recorded_by, sources, classification, recorded_at)
       values ($1,$2,$3,$4,$5,$6::jsonb,'candidate',$7::date,$8::jsonb,$9::jsonb,$10,$11)`,
      [id, p.workspace_id, input.projectId, input.topicKey, input.label, json(input.value), input.validFrom ?? null,
       json(input.by), json(input.sources), input.classification ?? p.default_classification, at],
    );
    await tx.query(`insert into decision_events (decision_id, at, by, type) values ($1, $2, $3::jsonb, 'proposed')`, [id, at, json(input.by)]);
    const [row] = await tx.query(`select ${DECISION_COLS} from decisions where id = $1`, [id]);
    return rowToDecision(row);
  });
}

/**
 * Approve a candidate. The approved decision on the same topic is retired as superseded and its validity
 * closes at the new decision's start date. Approvers only; never exposed to AI clients.
 */
export async function approve(db: Db, decisionId: string, approverId: string, at: Date = new Date()): Promise<Decision> {
  return db.tx(async tx => {
    const [cand] = await tx.query(`select ${DECISION_COLS} from decisions where id = $1 for update`, [decisionId]);
    if (!cand) throw new Error('unknown decision');
    if (cand.status !== 'candidate' && cand.status !== 'on_hold') throw new Error(`cannot approve a ${cand.status} decision`);
    if (!(await can(tx, approverId, 'approver', cand.project_id))) throw new Error('forbidden: not an approver of the project');

    const by = json({ type: 'user', id: approverId });
    const validFrom: string = cand.valid_from ?? localDate(at);
    const [prev] = await tx.query(
      `select id from decisions where project_id = $1 and topic_key = $2 and status = 'approved' for update`,
      [cand.project_id, cand.topic_key],
    );
    if (prev) {
      await tx.query(`update decisions set status = 'retired', retired_reason = 'superseded', valid_to = $2::date where id = $1`, [prev.id, validFrom]);
      await tx.query(`insert into decision_events (decision_id, at, by, type, note) values ($1,$2,$3::jsonb,'retired',$4)`,
        [prev.id, at.toISOString(), by, `superseded by ${decisionId}`]);
    }
    await tx.query(
      `update decisions set status = 'approved', approved_by = $2::jsonb, approved_at = $3, valid_from = $4::date, supersedes = $5 where id = $1`,
      [decisionId, by, at.toISOString(), validFrom, prev ? prev.id : null],
    );
    await tx.query(`insert into decision_events (decision_id, at, by, type) values ($1,$2,$3::jsonb,'approved')`, [decisionId, at.toISOString(), by]);
    const [row] = await tx.query(`select ${DECISION_COLS} from decisions where id = $1`, [decisionId]);
    return rowToDecision(row);
  });
}

export async function reject(db: Db, decisionId: string, approverId: string, note?: string, at: Date = new Date()) {
  return db.tx(async tx => {
    const [cand] = await tx.query('select project_id, status from decisions where id = $1 for update', [decisionId]);
    if (!cand || cand.status !== 'candidate') throw new Error('only candidates can be rejected');
    if (!(await can(tx, approverId, 'approver', cand.project_id))) throw new Error('forbidden: not an approver of the project');
    await tx.query(`update decisions set status = 'rejected' where id = $1`, [decisionId]);
    await tx.query(`insert into decision_events (decision_id, at, by, type, note) values ($1,$2,$3::jsonb,'rejected',$4)`,
      [decisionId, at.toISOString(), json({ type: 'user', id: approverId }), note ?? null]);
  });
}

export async function decisionsFor(db: Db, projectId: string): Promise<Decision[]> {
  const rows = await db.query(`select ${DECISION_COLS} from decisions where project_id = $1 order by recorded_at`, [projectId]);
  return rows.map(rowToDecision);
}

/** Which value was approved and in force for a topic on a given business date. */
export async function valueAsOf(db: Db, projectId: string, topicKey: string, date: ISODate): Promise<Decision | undefined> {
  const [row] = await db.query(
    `select ${DECISION_COLS} from decisions
     where project_id = $1 and topic_key = $2 and approved_at is not null
       and (status = 'approved' or (status = 'retired' and retired_reason = 'superseded'))
       and valid_from <= $3::date and (valid_to is null or valid_to > $3::date)
     order by valid_from desc limit 1`,
    [projectId, topicKey, date],
  );
  return row ? rowToDecision(row) : undefined;
}

/** Calendar date in the display time zone. */
export function localDate(d: Date, tz = process.env.SB_DISPLAY_TZ ?? 'Asia/Tokyo'): string {
  return d.toLocaleDateString('sv-SE', { timeZone: tz });
}

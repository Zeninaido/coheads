// Team trial without a server: the decision ledger lives inside the shared folder (Google Drive, Box, OneDrive…).
//
//   <folder>/.coheads/events/<time>-<id>.json   one file per event, never edited, so sync tools never conflict
//   <folder>/.coheads/team.json                 optional, older form: { "approvers": ["佐藤", ...] } (read as the starting list)
//
// Who may approve is set on the approval page and recorded as events too (approver_added / approver_removed),
// so the list has the same history and sync behavior as the decisions. An empty list means "every member" (trial).
// Every member's Coheads replays the event files into its own local index. Files that arrive late (sync delay)
// are handled by replaying from the start whenever the order changes.
//
// Trust model (trial): anyone who can write to the folder can write events. Approver names are checked against
// the approver list as of the event's time; while the list is empty, every member may approve. Server mode (WalkOn support) replaces this.
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';
import { approve, propose, reject } from './ledger';
import { grant } from './permissions';
import type { Classification, DecisionValue, ISODate, SourceRef } from './types';

export type LedgerEvent =
  | { v: 1; type: 'proposed'; at: string; by: string; decisionId: string; projectId: string; topicKey: string; label: string;
      value: DecisionValue; validFrom?: ISODate; sources: SourceRef[]; classification?: Classification }
  | { v: 1; type: 'approved'; at: string; by: string; decisionId: string }
  | { v: 1; type: 'rejected'; at: string; by: string; decisionId: string; note?: string }
  | { v: 1; type: 'approver_added' | 'approver_removed'; at: string; by: string; name: string };

export type ApproverEvent = Extract<LedgerEvent, { name: string }>;
const isApproverEvent = (ev: LedgerEvent): ev is ApproverEvent => ev.type === 'approver_added' || ev.type === 'approver_removed';

const dirs = (root: string) => ({ base: join(root, '.coheads'), events: join(root, '.coheads', 'events') });

export function readTeam(root: string): { approvers?: string[] } {
  const f = join(dirs(root).base, 'team.json');
  if (!existsSync(f)) return {};
  try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return {}; }
}

/** Write one event file (atomically: temp name, then rename). Returns the file name. */
export function writeEvent(root: string, ev: LedgerEvent): string {
  const { events } = dirs(root);
  mkdirSync(events, { recursive: true });
  const name = `${ev.at.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}.json`;
  const tmp = join(events, `.${name}.tmp`);
  writeFileSync(tmp, JSON.stringify(ev, null, 2));
  renameSync(tmp, join(events, name));
  return name;
}

function listEvents(root: string): string[] {
  const { events } = dirs(root);
  if (!existsSync(events)) return [];
  // File names start with the event time, so name order is time order.
  return readdirSync(events).filter(n => n.endsWith('.json') && !n.startsWith('.')).sort();
}

async function ensureTables(db: Db) {
  await db.exec(`create table if not exists shared_events_applied (name text primary key, ok boolean not null, note text);
    create table if not exists shared_approver_changes (seq serial primary key, at text not null, by text not null, kind text not null, who text not null);`);
}

/** The approver list now: team.json (older form) as the start, then every accepted change in order. Empty = every member. */
async function approverList(db: Db, root: string): Promise<string[]> {
  let list = [...(readTeam(root).approvers ?? [])];
  for (const c of await db.query<{ kind: string; who: string }>('select kind, who from shared_approver_changes order by seq')) {
    if (c.kind === 'approver_added') { if (!list.includes(c.who)) list.push(c.who); }
    else list = list.filter(n => n !== c.who);
  }
  return list;
}

/** Make the approver rights match the list (or, while it is empty, give them to every member). */
async function setApproverRights(db: Db, projectIds: string[], list: string[], people: Iterable<string> = []) {
  const members = (await db.query<{ subject_id: string }>(
    `select distinct subject_id from relation_tuples where relation = 'member' and resource_type = 'project' and resource_id = any($1::text[])`,
    [projectIds])).map(r => r.subject_id);
  const approvers = list.length ? list : [...new Set([...members, ...people])];
  await db.query(
    `delete from relation_tuples where relation = 'approver' and resource_type = 'project' and resource_id = any($1::text[]) and not (subject_id = any($2::text[]))`,
    [projectIds, approvers]);
  for (const pid of projectIds) {
    for (const who of approvers) await grant(db, { subject: { type: 'user', id: who }, relation: 'approver', resource: { type: 'project', id: pid } });
  }
}

export const cleanName = (s: string) => s.replace(/\s+/g, ' ').trim().slice(0, 40);

async function applyApproverChange(db: Db, root: string, ev: ApproverEvent, projectIds: string[]): Promise<string | undefined> {
  const name = cleanName(ev.name ?? '');
  if (!name) return 'empty name';
  const list = await approverList(db, root);
  // While nobody is listed every member may set the list; after that, only listed approvers may change it.
  if (list.length && !list.includes(ev.by)) return 'forbidden: not an approver';
  if (ev.type === 'approver_added' ? list.includes(name) : !list.includes(name)) return undefined; // nothing to change
  await db.query('insert into shared_approver_changes (at, by, kind, who) values ($1, $2, $3, $4)', [ev.at, ev.by, ev.type, name]);
  await setApproverRights(db, projectIds, await approverList(db, root));
  return undefined;
}

async function applyOne(db: Db, root: string, ev: LedgerEvent, projectIds: string[]): Promise<string | undefined> {
  const at = new Date(ev.at);
  if (ev.type === 'proposed') {
    if (!projectIds.includes(ev.projectId)) return `unknown project ${ev.projectId}`;
    await propose(db, { id: ev.decisionId, at, trusted: true, projectId: ev.projectId, topicKey: ev.topicKey, label: ev.label,
      value: ev.value, validFrom: ev.validFrom, sources: ev.sources ?? [], classification: ev.classification, by: { type: 'user', id: ev.by } });
  } else if (ev.type === 'approved') {
    await approve(db, ev.decisionId, ev.by, at);
  } else if (ev.type === 'rejected') {
    await reject(db, ev.decisionId, ev.by, ev.note, at);
  } else if (isApproverEvent(ev)) {
    return applyApproverChange(db, root, ev, projectIds);
  }
  return undefined;
}

/** For the approval page: who may approve now, and every accepted change (oldest first). */
export async function teamState(db: Db, root: string) {
  await ensureTables(db);
  const changes = await db.query<{ at: string; by: string; kind: 'approver_added' | 'approver_removed'; who: string }>(
    'select at, by, kind, who from shared_approver_changes order by seq');
  return { approvers: await approverList(db, root), fromFile: readTeam(root).approvers ?? [], changes };
}

/**
 * Bring the local index up to date with the folder's event files. Called on every open in folder mode.
 * Returns how many events were applied and which ones were refused (e.g. an approval by someone not on the approver list).
 */
export async function syncSharedLedger(db: Db, root: string, projectIds: string[], localUser: string) {
  await ensureTables(db);
  const names = listEvents(root);
  const applied = (await db.query<{ name: string }>('select name from shared_events_applied order by name')).map(r => r.name);
  const isPrefix = applied.every((n, i) => names[i] === n);
  if (!isPrefix) {
    // A late file landed before something already applied (or a file disappeared): replay from scratch.
    await db.exec(`delete from decision_events; delete from decisions; delete from shared_events_applied; delete from shared_approver_changes;`);
    applied.length = 0;
  }

  const pending = names.slice(applied.length);
  const events: [string, LedgerEvent][] = [];
  for (const n of pending) {
    try { events.push([n, JSON.parse(readFileSync(join(dirs(root).events, n), 'utf8'))]); } catch { /* half-synced file: try next time */ break; }
  }
  const people = new Set<string>([localUser, ...events.map(([, e]) => e.by)]);
  for (const pid of projectIds) {
    for (const who of people) await grant(db, { subject: { type: 'user', id: who }, relation: 'member', resource: { type: 'project', id: pid } });
  }
  // Approver rights as of the last applied event; each approver change in the files updates them as it is replayed,
  // so an approval is checked against the list at its own time.
  await setApproverRights(db, projectIds, await approverList(db, root), people);

  const refused: { name: string; reason: string }[] = [];
  for (const [n, ev] of events) {
    let note: string | undefined;
    try { note = await applyOne(db, root, ev, projectIds); } catch (e) { note = (e as Error).message; }
    if (note) refused.push({ name: n, reason: note });
    await db.query('insert into shared_events_applied values ($1, $2, $3)', [n, !note, note ?? null]);
  }
  return { applied: events.length, refused };
}

/**
 * Folder mode writes: apply locally first (this checks permissions and state), then record the event file
 * in the shared folder so every member's Coheads picks it up.
 */
export async function recordAndApply(db: Db, root: string, ev: LedgerEvent, projectIds: string[]) {
  await ensureTables(db);
  const note = await applyOne(db, root, ev, projectIds);
  if (note) throw new Error(note);
  const name = writeEvent(root, ev);
  await db.query('insert into shared_events_applied values ($1, true, null) on conflict do nothing', [name]);
  return name;
}

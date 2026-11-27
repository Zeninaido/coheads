// Team trial: two members share one folder (as with Google Drive). Each has its own local index.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { cpSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect, migrate, reset, type Db } from '../src/db';
import { buildContextPack } from '../src/contextPack';
import { FolderAdapter } from '../src/adapters/folder';
import { grant } from '../src/permissions';
import { newerRecordCount, recordAndApply, syncSharedLedger, teamState, writeEvent } from '../src/sharedLedger';

if (process.env.SB_ENGINE === 'postgres') test.skip('shared ledger runs on PGLite only (two local stores)', () => {});
else {
const root = mkdtempSync(join(tmpdir(), 'coheads-shared-'));
const PROJECTS = ['A社'];
const dest = { id: 'claude-desktop', ceiling: 'confidential' as const };

async function member(name: string, root2 = root): Promise<{ db: Db; folder: FolderAdapter; sync: () => Promise<{ applied: number; refused: { name: string; reason: string }[] }> }> {
  const db = await connect(); // in-memory PGLite: each member's own local index
  await reset(db);
  await db.query(`insert into workspaces values ('local', 'team', 'shared') on conflict do nothing`);
  await db.query(`insert into projects values ('A社', 'local', 'A社', $1::text[], 'internal') on conflict do nothing`, [['エー社']]);
  await grant(db, { subject: { type: 'user', id: name }, relation: 'member', resource: { type: 'project', id: 'A社' } });
  const folder = new FolderAdapter(db, root2, { 'A社': 'A社' }, { prefixIds: true });
  await folder.ingest();
  return { db, folder, sync: () => syncSharedLedger(db, root2, PROJECTS, name) };
}

const money = (amount: number) => ({ type: 'money' as const, amount, currency: 'JPY', period: 'monthly' as const, tax: 'excluded' as const });
const current = async (db: Db, folder: FolderAdapter, who: string) =>
  (await buildContextPack(db, [folder], { userId: who, query: 'A社の提案価格は？', destination: dest, asOf: '2026-12-10' })).current.map(d => (d.value as any).amount);

let sato: Awaited<ReturnType<typeof member>>;
let suzuki: Awaited<ReturnType<typeof member>>;

beforeAll(async () => {
  mkdirSync(join(root, 'A社'));
  cpSync(join(import.meta.dir, '..', '..', 'corpus', 'a-sha', '2026-10-28-a-proposal-v1.md'), join(root, 'A社', '提案書v1.md'));
  sato = await member('佐藤');
  suzuki = await member('鈴木');
});
afterAll(async () => { await sato.db.close(); await suzuki.db.close(); });

describe('shared-folder ledger', () => {
  test('a candidate proposed by one member reaches the other through the folder', async () => {
    await suzuki.sync();
    await recordAndApply(suzuki.db, root, { v: 1, type: 'proposed', at: '2026-12-01T01:00:00.000Z', by: '鈴木', decisionId: 'd-100',
      projectId: 'A社', topicKey: 'proposal.price', label: '提案価格', value: money(100000), validFrom: '2026-12-01', sources: [] }, PROJECTS);
    expect(readdirSync(join(root, '.coheads', 'events'))).toHaveLength(1);
    const r = await sato.sync();
    expect(r.applied).toBe(1);
    expect(await current(sato.db, sato.folder, '佐藤')).toEqual([]); // still a candidate
  });

  test('without team.json any member may approve; the approval reaches the proposer', async () => {
    await recordAndApply(sato.db, root, { v: 1, type: 'approved', at: '2026-12-01T02:00:00.000Z', by: '佐藤', decisionId: 'd-100' }, PROJECTS);
    expect(await current(sato.db, sato.folder, '佐藤')).toEqual([100000]);
    await suzuki.sync();
    expect(await current(suzuki.db, suzuki.folder, '鈴木')).toEqual([100000]);
  });

  test('with team.json, an approval by someone not listed is refused on every machine', async () => {
    mkdirSync(join(root, '.coheads'), { recursive: true });
    writeFileSync(join(root, '.coheads', 'team.json'), JSON.stringify({ approvers: ['佐藤'] }));
    await suzuki.sync();
    await recordAndApply(suzuki.db, root, { v: 1, type: 'proposed', at: '2026-12-02T01:00:00.000Z', by: '鈴木', decisionId: 'd-120',
      projectId: 'A社', topicKey: 'proposal.price', label: '提案価格', value: money(120000), validFrom: '2026-12-05', sources: [] }, PROJECTS);
    // 鈴木 is not an approver: the local write is refused, nothing is written.
    const before = readdirSync(join(root, '.coheads', 'events')).length;
    await expect(recordAndApply(suzuki.db, root, { v: 1, type: 'approved', at: '2026-12-02T02:00:00.000Z', by: '鈴木', decisionId: 'd-120' }, PROJECTS)).rejects.toThrow();
    expect(readdirSync(join(root, '.coheads', 'events')).length).toBe(before);
    // A hand-written file with the same approval is refused when replayed.
    writeEvent(root, { v: 1, type: 'approved', at: '2026-12-02T02:00:00.000Z', by: '鈴木', decisionId: 'd-120' });
    const r = await sato.sync();
    expect(r.refused.map(x => x.reason).join()).toContain('not an approver');
    expect(await current(sato.db, sato.folder, '佐藤')).toEqual([100000]);
  });

  test('the approver approves; the old price expires on the new start date everywhere', async () => {
    await recordAndApply(sato.db, root, { v: 1, type: 'approved', at: '2026-12-03T00:00:00.000Z', by: '佐藤', decisionId: 'd-120' }, PROJECTS);
    await suzuki.sync();
    for (const m of [sato, suzuki]) expect(await current(m.db, m.folder, m === sato ? '佐藤' : '鈴木')).toEqual([120000]);
    const pack = await buildContextPack(suzuki.db, [suzuki.folder], { userId: '鈴木', query: 'エー社の提案書', destination: dest, asOf: '2026-12-10' });
    expect(pack.previous.map(d => (d.value as any).amount)).toEqual([100000]);
    expect(pack.documents[0].annotations[0].message).toContain('現行ではない');
  });

  test('a file that syncs late (older time) triggers a full replay and the same result', async () => {
    // Someone rejected an unrelated candidate earlier, but the file arrives only now.
    const late = writeEvent(root, { v: 1, type: 'proposed', at: '2026-12-01T01:30:00.000Z', by: '鈴木', decisionId: 'd-memo',
      projectId: 'A社', topicKey: 'topic.memo', label: 'メモ', value: { type: 'text', text: '後から届いた候補' }, sources: [] });
    expect(late).toBeTruthy();
    const r = await suzuki.sync();
    expect(r.applied).toBe(readdirSync(join(root, '.coheads', 'events')).filter(n => n.endsWith('.json')).length); // replayed all
    expect(await current(suzuki.db, suzuki.folder, '鈴木')).toEqual([120000]);
    const [{ n }] = await suzuki.db.query<{ n: number }>(`select count(*)::int as n from decisions where status = 'candidate'`);
    expect(n).toBe(1);
  });

  test('a half-synced file (unreadable JSON) is skipped until it is complete', async () => {
    const dir = join(root, '.coheads', 'events');
    writeFileSync(join(dir, '2099-01-01T00-00-00-000Z-partial.json'), '{"v":1,"type":"appro');
    const r = await sato.sync();
    expect(r.refused.some(x => x.name.includes('partial'))).toBe(false);
    const applied = await sato.db.query<{ name: string }>('select name from shared_events_applied');
    expect(applied.some(a => a.name.includes('partial'))).toBe(false);
    renameSync(join(dir, '2099-01-01T00-00-00-000Z-partial.json'), join(dir, '.ignored.json'));
  });
});

describe('approvers set on the approval page (recorded as events)', () => {
  const team = mkdtempSync(join(tmpdir(), 'coheads-team-'));
  let a: Awaited<ReturnType<typeof member>>; // 佐藤
  let b: Awaited<ReturnType<typeof member>>; // 鈴木
  const events = () => readdirSync(join(team, '.coheads', 'events')).filter(n => n.endsWith('.json'));
  const add = (by: string, name: string, at: string) => ({ v: 1 as const, type: 'approver_added' as const, at, by, name });
  const removed = (by: string, name: string, at: string) => ({ v: 1 as const, type: 'approver_removed' as const, at, by, name });

  beforeAll(async () => {
    mkdirSync(join(team, 'A社'));
    cpSync(join(import.meta.dir, '..', '..', 'corpus', 'a-sha', '2026-10-28-a-proposal-v1.md'), join(team, 'A社', '提案書v1.md'));
    a = await member('佐藤', team);
    b = await member('鈴木', team);
    await a.sync(); await b.sync();
  });
  afterAll(async () => { await a.db.close(); await b.db.close(); });

  test('whoever names the first approver is listed too, so nobody locks themselves out', async () => {
    expect((await teamState(b.db, team)).approvers).toEqual([]);
    await recordAndApply(b.db, team, add('鈴木', '佐藤', '2026-12-01T00:00:00.000Z'), PROJECTS);
    expect(events()).toHaveLength(1); // one change, one file
    await a.sync();
    expect((await teamState(a.db, team)).approvers).toEqual(['鈴木', '佐藤']);
  });

  test('a listed person may step down; then only listed people may approve or change the list', async () => {
    await recordAndApply(b.db, team, removed('鈴木', '鈴木', '2026-12-01T00:10:00.000Z'), PROJECTS);
    await recordAndApply(b.db, team, { v: 1, type: 'proposed', at: '2026-12-01T01:00:00.000Z', by: '鈴木', decisionId: 't-1',
      projectId: 'A社', topicKey: 'proposal.price', label: '提案価格', value: money(100000), validFrom: '2026-12-01', sources: [] }, PROJECTS);
    await expect(recordAndApply(b.db, team, { v: 1, type: 'approved', at: '2026-12-01T02:00:00.000Z', by: '鈴木', decisionId: 't-1' }, PROJECTS)).rejects.toThrow('not an approver');
    const before = events().length;
    await expect(recordAndApply(b.db, team, add('鈴木', '鈴木', '2026-12-01T03:00:00.000Z'), PROJECTS)).rejects.toThrow('not an approver');
    expect(events().length).toBe(before);
    await a.sync();
    expect((await teamState(a.db, team)).approvers).toEqual(['佐藤']);
  });

  test('an approver adds a member, who approves; a later removal does not undo that approval on any machine', async () => {
    await recordAndApply(a.db, team, add('佐藤', '鈴木', '2026-12-02T00:00:00.000Z'), PROJECTS);
    await b.sync();
    await recordAndApply(b.db, team, { v: 1, type: 'approved', at: '2026-12-02T01:00:00.000Z', by: '鈴木', decisionId: 't-1' }, PROJECTS);
    await a.sync();
    await recordAndApply(a.db, team, removed('佐藤', '鈴木', '2026-12-03T00:00:00.000Z'), PROJECTS);
    // A late file forces a full replay: the approval is checked against the list at its own time.
    writeEvent(team, { v: 1, type: 'proposed', at: '2026-12-01T00:30:00.000Z', by: '鈴木', decisionId: 't-memo',
      projectId: 'A社', topicKey: 'topic.memo', label: 'メモ', value: { type: 'text', text: '後から届いた候補' }, sources: [] });
    for (const [m, who] of [[a, '佐藤'], [b, '鈴木']] as const) {
      const r = await m.sync();
      expect(r.refused).toEqual([]);
      expect(await current(m.db, m.folder, who)).toEqual([100000]);
      const st = await teamState(m.db, team);
      expect(st.approvers).toEqual(['佐藤']);
      expect(st.changes.map(c => `${c.by}:${c.kind}:${c.who}`)).toEqual([
        '鈴木:approver_added:鈴木', '鈴木:approver_added:佐藤', '鈴木:approver_removed:鈴木', '佐藤:approver_added:鈴木', '佐藤:approver_removed:鈴木']);
    }
  });

  test('a removed member can no longer approve; when the list is emptied, every member may approve again', async () => {
    await recordAndApply(b.db, team, { v: 1, type: 'proposed', at: '2026-12-04T00:00:00.000Z', by: '鈴木', decisionId: 't-2',
      projectId: 'A社', topicKey: 'proposal.price', label: '提案価格', value: money(110000), validFrom: '2026-12-05', sources: [] }, PROJECTS);
    await expect(recordAndApply(b.db, team, { v: 1, type: 'approved', at: '2026-12-04T01:00:00.000Z', by: '鈴木', decisionId: 't-2' }, PROJECTS)).rejects.toThrow('not an approver');
    await a.sync();
    await recordAndApply(a.db, team, removed('佐藤', '佐藤', '2026-12-04T02:00:00.000Z'), PROJECTS);
    await b.sync();
    expect((await teamState(b.db, team)).approvers).toEqual([]);
    await recordAndApply(b.db, team, { v: 1, type: 'approved', at: '2026-12-04T03:00:00.000Z', by: '鈴木', decisionId: 't-2' }, PROJECTS);
    expect(await current(b.db, b.folder, '鈴木')).toEqual([110000]);
  });

  test('a record from a newer version is skipped and counted; everything else still applies', async () => {
    writeFileSync(join(team, '.coheads', 'events', '2026-12-05T00-00-00-000Z-future01.json'),
      JSON.stringify({ v: 1, type: 'expired', at: '2026-12-05T00:00:00.000Z', by: '佐藤', decisionId: 't-2' }));
    await recordAndApply(a.db, team, { v: 1, type: 'proposed', at: '2026-12-06T00:00:00.000Z', by: '佐藤', decisionId: 't-3',
      projectId: 'A社', topicKey: 'topic.memo', label: 'メモ', value: { type: 'text', text: '新しい版のあとの候補' }, sources: [] }, PROJECTS);
    expect(await newerRecordCount(a.db)).toBe(0);
    const r = await b.sync();
    expect(r.refused.map(x => x.reason)).toEqual(['newer version: expired']);
    expect(await newerRecordCount(b.db)).toBe(1);
    const [{ n }] = await b.db.query<{ n: number }>(`select count(*)::int as n from decisions where id = 't-3'`);
    expect(n).toBe(1);
  });
});
}

describe('which version each member runs (#1)', () => {
  test('versions compare by number, not as text', async () => {
    const { compareVersions } = await import('../src/sharedLedger');
    expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
    expect(compareVersions('0.4.1', '0.4.1')).toBe(0);
    expect(compareVersions('0.4.0', '0.4.1')).toBeLessThan(0);
  });
});

// Demo data shared by the tests, the MCP server and the admin CLI (fictional A社 / B社).
import { join } from 'node:path';
import { moduleDir } from './paths';
import type { Db } from './db';
import { FolderAdapter } from './adapters/folder';
import { approve, propose } from './ledger';
import { grant } from './permissions';

export const CORPUS_DIR = process.env.SB_CORPUS_DIR ?? join(moduleDir(import.meta), '..', '..', 'corpus');
export const PRICE = 'proposal.price';

const user = (id: string) => ({ type: 'user' as const, id });
const proj = (id: string) => ({ type: 'project' as const, id });

/** Workspace, projects, people and the shared folder. sato = A社 approver, suzuki = A社 member, kimura = B社 member. */
export async function seedBase(db: Db, corpusDir = CORPUS_DIR): Promise<FolderAdapter> {
  await db.query(`insert into workspaces values ('walkon', 'team', 'WalkOn') on conflict do nothing`);
  await db.query(`insert into projects values ('a-sha', 'walkon', 'A社', $1::text[], 'internal') on conflict do nothing`, [['エー社', '株式会社エー']]);
  await db.query(`insert into projects values ('b-sha', 'walkon', 'B社', $1::text[], 'confidential') on conflict do nothing`, [[]]);
  await grant(db, { subject: user('sato'), relation: 'approver', resource: proj('a-sha') });
  await grant(db, { subject: user('sato'), relation: 'member', resource: proj('a-sha') });
  await grant(db, { subject: user('suzuki'), relation: 'member', resource: proj('a-sha') });
  await grant(db, { subject: user('kimura'), relation: 'member', resource: proj('b-sha') });
  await db.query(`insert into open_items values ('a-sha', 'delivery.date', '納期', '先方の稼働日程待ち') on conflict do nothing`);
  await db.query(`insert into project_contacts values ('a-sha', '田中', '株式会社エー 情報システム部') on conflict do nothing`);
  const folder = new FolderAdapter(db, corpusDir, { 'a-sha': 'a-sha', 'b-sha': 'b-sha' });
  await folder.ingest();
  return folder;
}

/** Price history: 100,000 approved on 10/28; 120,000 proposed (and, unless told otherwise, approved on 11/24). */
export async function seedPriceHistory(db: Db, opts: { approve120: boolean }) {
  const p100 = await propose(db, {
    projectId: 'a-sha', topicKey: PRICE, label: '提案価格', value: { type: 'money', amount: 100000, currency: 'JPY', period: 'monthly', tax: 'excluded' },
    validFrom: '2026-10-28', sources: [{ adapterId: 'folder', uri: 'a-sha/2026-10-28-a-proposal-v1.md' }], by: user('suzuki'),
  });
  await approve(db, p100.id, 'sato', new Date('2026-10-28T10:00:00+09:00'));
  const p120 = await propose(db, {
    projectId: 'a-sha', topicKey: PRICE, label: '提案価格', value: { type: 'money', amount: 120000, currency: 'JPY', period: 'monthly', tax: 'excluded' },
    validFrom: '2026-11-24', sources: [{ adapterId: 'folder', uri: 'a-sha/2026-11-24-a-price-approval.md' }], by: user('suzuki'),
  });
  if (opts.approve120) await approve(db, p120.id, 'sato', new Date('2026-11-24T15:10:00+09:00'));
  return { p100, p120 };
}

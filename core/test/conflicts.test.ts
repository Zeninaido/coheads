// Documents that disagree about a price, before anyone has recorded a decision (a team's first day).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connect, reset, type Db } from '../src/db';
import type { FolderAdapter } from '../src/adapters/folder';
import { buildContextPack } from '../src/contextPack';
import { renderCopyText } from '../src/renderers/copyText';
import { seedBase, seedPriceHistory } from '../src/seed';

const dest = { id: 'claude-desktop', ceiling: 'confidential' as const };
let db: Db;
let folder: FolderAdapter;
const ask = () => buildContextPack(db, [folder], { userId: 'suzuki', query: 'A社の田中さんに送る見積メールを書いて', destination: dest, asOf: '2026-11-26' });

beforeAll(async () => {
  db = await connect();
  await reset(db);
  folder = await seedBase(db); // documents only; the ledger is empty
});
afterAll(async () => { await db.close(); });

describe('資料どうしの食い違い', () => {
  test('候補の下書き：決定の行から課金の単位を読む', async () => {
    const { candidateDraft } = await import('../src/conflicts');
    expect(candidateDraft('A社', { amount: 1, docId: 'doc:x', title: 'x', updatedAt: '2026-01-01', line: '月額1円', signal: 'undecided' }, '').period).toBe('monthly');
  });

  test('台帳が空でも、10万円と12万円が両方あることをAIに伝える', async () => {
    const pack = await ask();
    expect(pack.current).toEqual([]);
    const c = pack.conflicts?.[0];
    expect(c?.values.map(v => v.amount).sort()).toEqual([100000, 120000]);
    expect(c?.latest.amount).toBe(120000);
    expect(c?.latest.signal).toBe('decided');
    const v120 = c!.values.find(v => v.amount === 120000)!;
    expect(v120.mentions.find(m => m.docId === 'doc:2026-11-18-a-weekly')?.signal).toBe('undecided');
    const v100 = c!.values.find(v => v.amount === 100000)!;
    expect(v100.mentions.find(m => m.docId === 'doc:2026-11-24-a-price-approval')?.signal).toBe('old');
    expect(pack.cautions.some(c => c.includes('食い違い') && c.includes('この金額で書いてよい') && c.includes('正式な記録はまだない'))).toBe(true);
    expect(c?.draft).toMatchObject({ amount: 120000, period: 'monthly', tax: 'excluded', validFrom: '2026-11-24', label: '提案価格',
      sourceDocId: 'doc:2026-11-24-a-price-approval', approverInDoc: '佐藤（営業責任者）' });
    const text = renderCopyText(pack);
    expect(text).toContain('→ 候補の下書き');
    expect(text).not.toContain('台帳');
    expect(text).toContain('■ 資料どうしの食い違い');
    expect(text).toContain('100,000円');
  });

  test('決定や承認者を示す資料がなければ、金額を書く前に聞く', async () => {
    await db.query(`update documents set body = replace(body, '承認者：佐藤（営業責任者）', '') where id = '2026-11-24-a-price-approval'`);
    const pack = await ask();
    expect(pack.conflicts?.[0]?.draft?.approverInDoc).toBeUndefined();
    expect(pack.cautions.some(c => c.includes('金額を書く前に、どれで進めるかを利用者に聞く'))).toBe(true);
    await folder.ingest(); // restore the documents
  });

  test('候補を記録した後は、下書きを出さず、承認待ちだと伝える', async () => {
    const { propose } = await import('../src/ledger');
    const c = await propose(db, { projectId: 'a-sha', topicKey: 'proposal.price', label: '提案価格', value: { type: 'money', amount: 120000, currency: 'JPY', period: 'monthly', tax: 'excluded' } as any,
      validFrom: '2026-11-24', sources: [{ adapterId: 'folder', uri: 'doc:2026-11-24-a-price-approval' }], by: { type: 'user', id: 'suzuki' } });
    const pack = await ask();
    expect(pack.conflicts?.[0]?.draft).toBeUndefined();
    expect(pack.cautions.some(x => x.includes('承認待ちの候補として記録済み'))).toBe(true);
    const { reject } = await import('../src/ledger');
    await reject(db, c.id, 'sato');
  });

  test('承認された金額が台帳にあれば、食い違いの節は出さない（決定と注釈で足りる）', async () => {
    await seedPriceHistory(db, { approve120: true });
    const pack = await ask();
    expect(pack.current.map(d => (d.value as any).amount)).toEqual([120000]);
    expect(pack.conflicts).toEqual([]);
    expect(renderCopyText(pack)).not.toContain('食い違い');
  });
});

// O-02 (SC-23): candidates and open items read from documents. S20: a newer document states a decided amount, with who
// approved it, that differs from the current one. S21: lines that say 案・検討・保留 are open, never current or candidates.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connect, reset, type Db } from '../src/db';
import type { FolderAdapter } from '../src/adapters/folder';
import { buildContextPack } from '../src/contextPack';
import { renderCopyText } from '../src/renderers/copyText';
import { seedBase, seedPriceHistory } from '../src/seed';

const dest = { id: 'claude-desktop', ceiling: 'confidential' as const };
let db: Db;
let folder: FolderAdapter;
const ask = () => buildContextPack(db, [folder], { userId: 'suzuki', query: 'A社に送る見積のメールを書いて', destination: dest, asOf: '2026-11-30' });

async function addDoc(id: string, date: string, title: string, body: string) {
  await db.query(
    `insert into documents (id, project_id, adapter_id, uri, title, body, body_norm, updated_at, classification)
     values ($1, 'a-sha', 'folder', $2, $3, $4, $4, $5, 'internal') on conflict (id) do update set title = excluded.title, body = excluded.body, body_norm = excluded.body, updated_at = excluded.updated_at`,
    [id, `a-sha/${id}.md`, title, body, date]);
}
const removeDoc = (id: string) => db.query('delete from documents where id = $1', [id]);

beforeAll(async () => {
  db = await connect();
  await reset(db);
  folder = await seedBase(db);
  await seedPriceHistory(db, { approve120: true }); // current: 120,000 approved 11/24
});
afterAll(async () => { await db.close(); });

describe('S20 資料から決定の候補', () => {
  test('現行と違う金額が、確定の言葉と承認者つきで新しい資料にあれば、差分の候補になる', async () => {
    await addDoc('2026-11-28-a-price-2', '2026-11-28', '価格改定 承認記録 A社', '# 価格改定\n- 決定：提案価格を月額140,000円（税別）に改定する\n- 適用日：2026年12月1日\n- 承認者：佐藤（営業責任者）');
    const pack = await ask();
    expect(pack.current.map(d => (d.value as any).amount)).toEqual([120000]); // not current until approved
    const [c] = pack.docCandidates ?? [];
    expect(c).toBeDefined();
    expect(c.current.value).toMatchObject({ amount: 120000 });
    expect(c.draft).toMatchObject({ amount: 140000, period: 'monthly', tax: 'excluded', validFrom: '2026-12-01', sourceDocId: 'doc:2026-11-28-a-price-2', approverInDoc: '佐藤（営業責任者）', label: '提案価格' });
    expect(c.line).toContain('140,000');
    const text = renderCopyText(pack);
    expect(text).toContain('■ 現行と違う金額の資料（チームでは未承認）：提案価格');
    expect(text).toContain('- 現行：月額120,000円（税別）');
    expect(text).toContain('- 資料：月額140,000円（税別）');
    expect(text).toContain('- 有効日：2026-12-01');
    expect(text).toContain('2026-11-28の「価格改定 承認記録 A社」');
    expect(pack.cautions.some(x => x.includes('承認されるまでは現行の120,000円で書く'))).toBe(true);
  });

  test('承認者の名前がなければ、候補にしない', async () => {
    await addDoc('2026-11-28-a-price-2', '2026-11-28', '価格改定 承認記録 A社', '- 決定：提案価格を月額140,000円（税別）に改定する');
    expect((await ask()).docCandidates).toEqual([]);
  });

  test('「案」「検討」と書かれていれば候補にせず、未確定の事項になる（S21）', async () => {
    await addDoc('2026-11-28-a-price-2', '2026-11-28', '価格の検討メモ A社', '- 提案価格を月額140,000円にする案を検討中。承認者：佐藤');
    const pack = await ask();
    expect(pack.docCandidates).toEqual([]);
    // A money line on another topic stays open while the price is decided.
    await addDoc('2026-11-28-a-price-2', '2026-11-28', '保守の検討メモ A社', '# 保守の検討メモ\n- 保守サポートは月額20,000円の案。採用するかは保留。');
    expect((await ask()).open.filter(o => o.source?.docId === 'doc:2026-11-28-a-price-2')).toHaveLength(1); // not the heading
    expect((await ask()).open.find(o => o.source?.docId === 'doc:2026-11-28-a-price-2')?.source?.line).toBe('保守サポートは月額20,000円の案。採用するかは保留。');
    await addDoc('2026-11-28-a-price-2', '2026-11-28', '保守の検討メモ A社', '- 保守の範囲は保留。次回の打ち合わせで決める。');
    const p2 = await ask();
    const item = p2.open.find(o => o.source?.docId === 'doc:2026-11-28-a-price-2');
    expect(item?.source).toMatchObject({ date: '2026-11-28', title: '保守の検討メモ A社', line: '保守の範囲は保留。次回の打ち合わせで決める。' });
    expect(renderCopyText(p2)).toContain('- 資料の記載：2026-11-28の「保守の検討メモ A社」');
    expect(p2.cautions.some(x => x.includes('確定事項として書かず') && x.includes('「未確定」と添える'))).toBe(true);
  });

  test('現行より前の資料や、すでに記録した金額は、候補にしない', async () => {
    await removeDoc('2026-11-28-a-price-2');
    // The 11/24 approval memo (120,000) is the current one; the 10/28 proposal (100,000) is older.
    expect((await ask()).docCandidates).toEqual([]);
    await addDoc('2026-11-20-a-old', '2026-11-20', '古い承認記録', '- 決定：提案価格を月額150,000円（税別）に改定する\n- 承認者：佐藤');
    expect((await ask()).docCandidates).toEqual([]); // dated before the current amount was approved
    await removeDoc('2026-11-20-a-old');
  });

  test('承認ページで扱った（候補として記録した）金額は、もう出さない', async () => {
    await addDoc('2026-11-28-a-price-2', '2026-11-28', '価格改定 承認記録 A社', '- 決定：提案価格を月額140,000円（税別）に改定する\n- 承認者：佐藤');
    const { propose, reject } = await import('../src/ledger');
    const c = await propose(db, { projectId: 'a-sha', topicKey: 'proposal.price', label: '提案価格', value: { type: 'money', amount: 140000, currency: 'JPY', period: 'monthly', tax: 'excluded' } as any,
      sources: [{ adapterId: 'folder', uri: 'doc:2026-11-28-a-price-2' }], by: { type: 'user', id: 'sato' } });
    await reject(db, c.id, 'sato');
    expect((await ask()).docCandidates).toEqual([]);
    await removeDoc('2026-11-28-a-price-2');
  });

  test('台帳に現行の金額がなければ、これまでどおり資料どうしの食い違いで扱う（SC-17/18）', async () => {
    const db2 = await connect();
    await reset(db2);
    const f2 = await seedBase(db2);
    const pack = await buildContextPack(db2, [f2], { userId: 'suzuki', query: 'A社に送る見積のメールを書いて', destination: dest, asOf: '2026-11-30' });
    expect(pack.docCandidates).toEqual([]);
    expect(pack.conflicts?.[0]?.draft?.amount).toBe(120000);
    await db2.close();
    await reset(db); folder = await seedBase(db); await seedPriceHistory(db, { approve120: true });
  });
});

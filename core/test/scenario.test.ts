// Section 10 validation scenario. Runs on PGLite by default, or on PostgreSQL with SB_ENGINE=postgres.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { connect, reset, type Db } from '../src/db';
import type { FolderAdapter } from '../src/adapters/folder';
import { buildContextPack } from '../src/contextPack';
import { approve, propose, valueAsOf } from '../src/ledger';
import { renderCopyText } from '../src/renderers/copyText';
import { PRICE, seedBase, seedPriceHistory } from '../src/seed';
import type { DestinationProfile } from '../src/types';

const claudeTeam: DestinationProfile = { id: 'claude-team', ceiling: 'confidential' };
const chatgptPlus: DestinationProfile = { id: 'chatgpt-plus', ceiling: 'internal' };

let sql: Db;
let folder: FolderAdapter;
const ids: Record<string, string> = {};
const user = (id: string) => ({ type: 'user' as const, id });

beforeAll(async () => {
  sql = await connect();
  await reset(sql);
  folder = await seedBase(sql);
  const { p100, p120 } = await seedPriceHistory(sql, { approve120: false });
  ids.p100 = p100.id;
  ids.p120 = p120.id;
  console.log(`engine=${sql.engine} pg_bigm=${sql.hasBigm}`);
});

afterAll(async () => {
  await sql.close();
});

describe('実証シナリオ', () => {
  test('承認前の12万円は候補のまま。現行は10万円で、会議メモに「未承認」の注釈が付く', async () => {
    const pack = await buildContextPack(sql, [folder], { userId: 'suzuki', query: 'A社の値上げの話', destination: claudeTeam, asOf: '2026-11-20' });
    expect(pack.current.map(d => (d.value as any).amount)).toEqual([100000]);
    expect(pack.cautions.some(c => c.includes('月額120,000円（税別）は未承認の候補'))).toBe(true);
    const weekly = pack.documents.find(d => d.source.uri === 'doc:2026-11-18-a-weekly');
    expect(weekly?.annotations.map(a => a.kind)).toContain('unapproved');
  });

  test('承認できるのはapproverだけ', async () => {
    await expect(approve(sql, ids.p120, 'suzuki')).rejects.toThrow('forbidden');
  });

  test('11/24の承認後：現行12万円、旧10万円、納期は未確定、旧提案書に失効の注釈', async () => {
    await approve(sql, ids.p120, 'sato', new Date('2026-11-24T15:10:00+09:00'));
    const pack = await buildContextPack(sql, [folder], { userId: 'suzuki', query: 'A社の提案価格はいくら？', destination: claudeTeam, asOf: '2026-11-25' });
    expect(pack.project?.id).toBe('a-sha');
    expect(pack.current.map(d => (d.value as any).amount)).toEqual([120000]);
    expect(pack.previous.map(d => (d.value as any).amount)).toEqual([100000]);
    expect(pack.open.map(o => o.label)).toEqual(['納期', '資料の記載', '資料の記載']);
    // Read from the documents (S21): lines that say it is not settled, newest first, with the document. The 11/18 memo's
    // "12万円に上げたい意見" is not among them: a later document says the price was decided.
    expect(pack.open.filter(o => o.source).map(o => o.source!.docId)).toEqual(['doc:2026-11-25-a-hearing', 'doc:2026-10-20-a-kickoff']);
    expect(pack.open.some(o => o.note?.includes('12万円'))).toBe(false);
    expect(pack.citation).toContain('11/24');
    const proposal = pack.documents.find(d => d.source.uri === 'doc:2026-10-28-a-proposal-v1');
    expect(proposal?.annotations[0]?.message).toContain('100,000円は現行ではない。現行は月額120,000円（税別）、11/24から適用（11/24承認）');
    console.log('\n--- コピー用テキスト（11/25時点）---\n' + renderCopyText(pack));
  });

  test('別名「エー社」でも案件が特定され、ヒアリングメモが返る', async () => {
    const pack = await buildContextPack(sql, [folder], { userId: 'suzuki', query: 'エー社の導入時期は決まった？', destination: claudeTeam, asOf: '2026-11-25' });
    expect(pack.project?.id).toBe('a-sha');
    expect(pack.documents[0]?.source.uri).toBe('doc:2026-11-25-a-hearing');
  });

  test('13万円へ正式変更：適用日前は12万円のまま＋変更予定の注意、適用日以降は13万円', async () => {
    const p130 = await propose(sql, {
      projectId: 'a-sha', topicKey: PRICE, label: '提案価格', value: { type: 'money', amount: 130000, currency: 'JPY', period: 'monthly', tax: 'excluded' },
      validFrom: '2026-12-01', sources: [{ adapterId: 'folder', uri: 'a-sha/2026-11-30-a-price-approval-2.md' }], by: user('sato'),
    });
    await approve(sql, p130.id, 'sato', new Date('2026-11-30T08:30:00+09:00'));

    const before = await buildContextPack(sql, [folder], { userId: 'suzuki', query: 'A社の提案価格', destination: claudeTeam, asOf: '2026-11-30' });
    expect(before.current.map(d => (d.value as any).amount)).toEqual([120000]);
    expect(before.cautions.some(c => c.includes('2026-12-01から月額130,000円（税別）'))).toBe(true);

    const after = await buildContextPack(sql, [folder], { userId: 'suzuki', query: 'A社の提案価格', destination: claudeTeam, asOf: '2026-12-01' });
    expect(after.current.map(d => (d.value as any).amount)).toEqual([130000]);
    expect(after.previous.map(d => (d.value as any).amount)).toEqual([120000]);
    const approval = after.documents.find(d => d.source.uri === 'doc:2026-11-24-a-price-approval');
    expect(approval?.annotations[0]?.message).toContain('現行は月額130,000円（税別）、12/1から適用（11/30承認）');
    console.log('\n--- コピー用テキスト（12/1時点）---\n' + renderCopyText(after));
  });

  test('過去の時点で、どの価格が有効だったかを再現できる', async () => {
    expect(((await valueAsOf(sql, 'a-sha', PRICE, '2026-11-20'))!.value as any).amount).toBe(100000);
    expect(((await valueAsOf(sql, 'a-sha', PRICE, '2026-11-28'))!.value as any).amount).toBe(120000);
    expect(((await valueAsOf(sql, 'a-sha', PRICE, '2026-12-05'))!.value as any).amount).toBe(130000);
  });

  test('A社の権限がない人には、A社の情報が何も返らない', async () => {
    const pack = await buildContextPack(sql, [folder], { userId: 'kimura', query: 'A社の提案価格はいくら？', destination: claudeTeam, asOf: '2026-11-25' });
    expect(pack.project).toBeUndefined();
    expect(pack.current).toEqual([]);
    expect(pack.documents).toEqual([]);
  });

  test('社外秘のB社は、上限がinternalの出力先（Plusなど）には渡らない', async () => {
    const plus = await buildContextPack(sql, [folder], { userId: 'kimura', query: 'B社の見積額', destination: chatgptPlus, asOf: '2026-11-25' });
    expect(plus.documents).toEqual([]);
    expect(plus.cautions[0]).toContain('渡せない区分');
    const team = await buildContextPack(sql, [folder], { userId: 'kimura', query: 'B社の見積額', destination: claudeTeam, asOf: '2026-11-25' });
    expect(team.documents.some(d => d.source.uri === 'doc:2026-11-10-b-estimate')).toBe(true);
  });

  test('案件が特定できない依頼には何も差し込まない', async () => {
    const pack = await buildContextPack(sql, [folder], { userId: 'suzuki', query: '来週の天気は？', destination: claudeTeam });
    expect(pack.project).toBeUndefined();
    expect(pack.documents).toEqual([]);
  });
});

describe('資料の取得（get_document）', () => {
  test('権限のある人は本文と注釈を取得できる', async () => {
    const { getDocument } = await import('../src/contextPack');
    const d: any = await getDocument(sql, { userId: 'suzuki', id: 'doc:2026-10-28-a-proposal-v1', destination: claudeTeam, asOf: '2026-12-01' });
    expect(d.found).toBe(true);
    expect(d.body).toContain('100,000円');
    expect(d.annotations[0].message).toContain('現行は月額130,000円（税別）');
  });

  test('権限のない人・上限を超える出力先には、存在も含めて返さない', async () => {
    const { getDocument } = await import('../src/contextPack');
    expect((await getDocument(sql, { userId: 'kimura', id: 'doc:2026-10-28-a-proposal-v1', destination: claudeTeam })).found).toBe(false);
    expect((await getDocument(sql, { userId: 'kimura', id: 'doc:2026-11-10-b-estimate', destination: chatgptPlus })).found).toBe(false);
    expect((await getDocument(sql, { userId: 'kimura', id: 'doc:2026-11-10-b-estimate', destination: claudeTeam })).found).toBe(true);
    expect((await getDocument(sql, { userId: 'suzuki', id: 'doc:does-not-exist', destination: claudeTeam })).found).toBe(false);
  });
});

describe('金額の表記とアクセスログ', () => {
  test('金額は課金の単位と税の扱いと一緒に表示される', async () => {
    const { formatValue } = await import('../src/normalize');
    expect(formatValue({ type: 'money', amount: 120000, currency: 'JPY', period: 'monthly', tax: 'excluded' })).toBe('月額120,000円（税別）');
    expect(formatValue({ type: 'money', amount: 500000, currency: 'JPY', period: 'one_time', tax: 'included' })).toBe('一括500,000円（税込）');
  });

  test('AIからの呼び出しは、誰が何を求め、何を返したかが記録される', async () => {
    const { logAccess, recentAccess } = await import('../src/audit');
    await logAccess(sql, { userId: 'suzuki', destination: 'test', tool: 'get_document', request: { id: 'doc:x' }, returned: { found: false } });
    const [last] = (await recentAccess(sql, 1));
    expect(last.tool).toBe('get_document');
    expect(last.request.id).toBe('doc:x');
    expect(last.returned.found).toBe(false);
  });
});

describe('関係者の名前から案件を特定する', () => {
  test('「田中さん」だけの依頼でも、A社のメンバーにはA社の文脈が返る', async () => {
    const pack = await buildContextPack(sql, [folder], { userId: 'suzuki', query: '田中さんに送る見積のメールを書いて', destination: claudeTeam, asOf: '2026-12-01' });
    expect(pack.project?.id).toBe('a-sha');
    expect(pack.project?.matchedBy).toBe('contact');
  });

  test('A社の権限がない人には、田中さんの名前でもA社は返らない', async () => {
    const pack = await buildContextPack(sql, [folder], { userId: 'kimura', query: '田中さんに送る見積のメールを書いて', destination: claudeTeam });
    expect(pack.project).toBeUndefined();
    expect(pack.cautions).toEqual([]);
  });

  test('同じ名前の関係者が複数の案件にいるときは、決めつけずに確認を促す', async () => {
    const { grant } = await import('../src/permissions');
    await grant(sql, { subject: { type: 'user', id: 'boss' }, relation: 'admin', resource: { type: 'workspace', id: 'walkon' } });
    await sql.query(`insert into project_contacts values ('b-sha', '田中', 'B社 物流部')`);
    const pack = await buildContextPack(sql, [folder], { userId: 'boss', query: '田中さんに連絡したい', destination: claudeTeam });
    expect(pack.project).toBeUndefined();
    expect(pack.cautions[0]).toContain('A社、B社');
    // kimura (B社 only) sees just B社, so for kimura it is not ambiguous
    const k = await buildContextPack(sql, [folder], { userId: 'kimura', query: '田中さんに連絡したい', destination: claudeTeam });
    expect(k.project?.id).toBe('b-sha');
  });
});

// S20 on the approval page: a newer document says another amount was decided, with who approved it. The page shows the
// difference (current / document / start day / the line) and an approver records it with one press (SC-23).
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(mkdtempSync(join(tmpdir(), 'coheads-pagedocs-')), 'team');
const data = join(mkdtempSync(join(tmpdir(), 'coheads-pagedocs-data-')), '.coheads');
const port = 43900 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let child: ChildProcess;
let token = '';
const get = async (path: string) => (await fetch(base + path)).text();
const post = async (path: string, form: Record<string, string>) => (await fetch(base + path, { method: 'POST', body: new URLSearchParams({ t: token, ...form }) })).text();
const events = () => readdirSync(join(root, '.coheads', 'events')).map(n => JSON.parse(readFileSync(join(root, '.coheads', 'events', n), 'utf8')))
  .filter(e => e.type !== 'version_used');

beforeAll(async () => {
  // Current: 130,000 approved 11/26. A newer memo says 140,000 was decided, with who approved it.
  cpSync(join(import.meta.dir, '..', '..', 'eval', 'behavior', 'fixtures', 'a-sha-approved-130'), root, { recursive: true });
  writeFileSync(join(root, 'A社', '2026-11-28-a-price-2.md'),
    '---\ntitle: 価格改定 承認記録 A社（2）\ndate: 2026-11-28\n---\n- 決定：提案価格を月額140,000円（税別）に改定する\n- 適用日：2026年12月1日\n- 承認者：佐藤（営業責任者）\n');
  const env: Record<string, string> = { ...process.env as Record<string, string>, SB_FOLDER: root, SB_DATA_DIR: data, SB_USER: '鈴木', SB_APPROVAL_PORT: String(port) };
  delete env.SB_DATABASE_URL; delete env.SB_ENGINE;
  child = spawn(process.execPath, ['run', join(import.meta.dir, 'fixtures', 'approval-server.ts')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>(r => child.stdout!.once('data', () => r()));
  for (let i = 0; i < 50; i++) { try { await get('/'); break; } catch { await Bun.sleep(100); } }
  token = /name="t" value="([0-9a-f]+)"/.exec(await get('/team'))![1];
}, 30000);
afterAll(() => { child?.kill(); });

describe('candidates read from documents (S20)', () => {
  test('the page shows the difference and the line, and says the AI keeps the current amount until approved', async () => {
    const html = await get('/');
    expect(html).toContain('資料から見つかった候補');
    expect(html).toContain('<td>月額130,000円（税別）</td><td><b>月額140,000円（税別）</b></td><td>2026-12-01</td>');
    expect(html).toContain('出典：2026-11-28の「価格改定 承認記録 A社（2）」');
    expect(html).toContain('該当行：決定：提案価格を月額140,000円（税別）に改定する');
    expect(html).toContain('資料に書かれた承認者：佐藤（営業責任者）（資料の記載です。チームの承認にはなりません）');
    expect(html).toContain('承認するまで、AI はいまの決定で書きます');
    expect(events()).toHaveLength(2); // nothing written just by looking
  });

  test('approving records it in the shared folder with the document as its source, and it is no longer offered', async () => {
    const msg = await post('/doc-decide', { project: 'A社', doc: 'doc:A社/2026-11-28-a-price-2', amount: '140000', do: 'approve' });
    expect(msg).toContain('「提案価格」を月額140,000円（税別）で承認しました。');
    const evs = events();
    const prop = evs.find(e => e.type === 'proposed' && e.value?.amount === 140000);
    expect(prop).toMatchObject({ by: '鈴木', projectId: 'A社', topicKey: 'proposal.price', validFrom: '2026-12-01' });
    expect(prop.sources[0]).toMatchObject({ uri: 'doc:A社/2026-11-28-a-price-2', title: '価格改定 承認記録 A社（2）' });
    expect(evs.some(e => e.type === 'approved' && e.decisionId === prop.decisionId)).toBe(true);
    expect(await get('/')).not.toContain('資料から見つかった候補');
  });

  test('a form for a candidate that is not there records nothing', async () => {
    const before = events().length;
    const msg = await post('/doc-decide', { project: 'A社', doc: 'doc:A社/2026-11-28-a-price-2', amount: '999', do: 'approve' });
    expect(msg).toContain('その候補は見つかりませんでした');
    expect(events()).toHaveLength(before);
  });
});

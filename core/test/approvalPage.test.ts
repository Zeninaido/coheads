// The approval page as people use it: tabs, setting who may approve, copy text for other AIs,
// what reached the AI, and deleting this computer's data. The page runs in a child process on a free port.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'coheads-page-folder-'));
const data = join(mkdtempSync(join(tmpdir(), 'coheads-page-data-')), '.coheads');
const port = 43400 + Math.floor(Math.random() * 500);
const base = `http://127.0.0.1:${port}`;
let child: ChildProcess;
let token = '';

const get = async (path: string) => (await fetch(base + path)).text();
const post = async (path: string, form: Record<string, string>, t = token) =>
  fetch(base + path, { method: 'POST', body: new URLSearchParams({ t, ...form }) });
const visible = (html: string) => html.replace(/<title>.*?<\/title>/s, '').replace(/<style>.*?<\/style>/s, '').replace(/<code>.*?<\/code>/gs, '')
  // Named only where people look for it themselves: the extension list and the plugin list.
  .replace('「マイプラグイン」で Coheads を選び', '').replace('プラグインの一覧から Coheads を外します', '');

beforeAll(async () => {
  mkdirSync(join(root, 'A社'));
  cpSync(join(import.meta.dir, '..', '..', 'corpus', 'a-sha', '2026-10-28-a-proposal-v1.md'), join(root, 'A社', '提案書v1.md'));
  const env: Record<string, string> = { ...process.env as Record<string, string>, SB_FOLDER: root, SB_DATA_DIR: data, SB_USER: '鈴木', SB_APPROVAL_PORT: String(port) };
  delete env.SB_DATABASE_URL; delete env.SB_ENGINE; // the page always uses this computer's own store
  child = spawn(process.execPath, ['run', join(import.meta.dir, 'fixtures', 'approval-server.ts')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise<void>(r => child.stdout!.once('data', () => r()));
  for (let i = 0; i < 50; i++) { try { await get('/'); break; } catch { await Bun.sleep(100); } }
  token = /name="t" value="([0-9a-f]+)"/.exec(await get('/team'))![1];
}, 30000);
afterAll(() => { child?.kill(); });

describe('approval page', () => {
  test('every tab opens, and none names the product, the ledger or a tool (except the browser tab title and the extension list)', async () => {
    for (const path of ['/', '/team', '/copy', '/log', '/data', '/copy?project=A社']) {
      const html = await get(path);
      expect(html).toContain('<nav>');
      expect(visible(html)).not.toMatch(/Coheads|台帳|get_context|propose_decision|team\.json|hook/);
    }
  }, 30000);

  test('requests from another host name, or posts without the page token, are refused', async () => {
    const r = await fetch(base + '/log', { headers: { host: `evil.example:${port}` } });
    expect(r.status).toBe(403);
    expect((await post('/team', { do: 'add', name: '佐藤' }, 'wrong')).status).toBe(403);
    expect(existsSync(join(root, '.coheads', 'events'))).toBe(false);
  });

  test('who may approve is chosen from names in the team records, and the person naming the first one is listed too', async () => {
    const first = await get('/team');
    expect(first).toContain('まだ指定されていません');
    expect(first).toContain('<option value="鈴木">鈴木（あなた）</option>'); // picked from the records, not typed
    expect(first).toContain('なりすましを防ぐ仕組みではありません');
    expect(await (await post('/team', { do: 'add', name: '佐藤' })).text()).toContain('佐藤 さんと、あなた（鈴木）を承認する人に加えました');
    const files = readdirSync(join(root, '.coheads', 'events'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, '.coheads', 'events', files[0]), 'utf8'))).toMatchObject({ type: 'approver_added', by: '鈴木', name: '佐藤' });
    // 鈴木 steps down: no remove buttons any more, and a change is refused with a plain explanation.
    expect(await (await post('/team', { do: 'remove', name: '鈴木' })).text()).toContain('鈴木 さんを承認する人から外しました');
    const page = await get('/team');
    expect(page).toContain('佐藤さんに頼んでください');
    expect(page).not.toContain('value="remove"');
    expect(await (await post('/team', { do: 'add', name: '鈴木' })).text()).toContain('「承認する人」に載っている人だけです');
    expect(readdirSync(join(root, '.coheads', 'events'))).toHaveLength(2);
  });

  test('a project can be copied as paste-ready text for other AIs, headed 「チームの決定」', async () => {
    const html = await get('/copy');
    expect(html).toContain('<option value="A社">A社</option>');
    const copy = await get('/copy?project=' + encodeURIComponent('A社'));
    const text = /<textarea id="copytext" readonly>([\s\S]*?)<\/textarea>/.exec(copy)![1];
    expect(text.startsWith('【チームの決定】案件：A社')).toBe(true);
    expect(text).toContain('提案書v1');
    expect(text).not.toContain('Coheads');
    expect(copy).not.toContain('社外秘の案件です'); // an internal project: no extra confirmation
  });

  test('what reached the AI is listed in plain words, with the project and the documents', async () => {
    const html = await get('/log');
    expect(html).toContain('ほかの AI に貼る文面を作った');
    expect(html).toContain('資料：');
    expect(html).not.toContain('server_start');
  });

  test('a record from a newer version shows an update notice on the page and in what reaches the AI', async () => {
    const file = join(root, '.coheads', 'events', '2026-11-20T00-00-00-000Z-future01.json');
    writeFileSync(file, JSON.stringify({ v: 1, type: 'expired', at: '2026-11-20T00:00:00.000Z', by: '佐藤', decisionId: 'x' }));
    expect(await get('/')).toContain('チームの誰かが新しい版を使っています');
    const hook = await (await fetch(base + '/hook/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt: 'A社に送る見積のメールを書いて' }) })).json() as any;
    expect(hook.hookSpecificOutput.additionalContext).toContain('拡張機能を更新するよう');
    // The approver list survives the replay that the older-named file caused.
    expect(await get('/team')).toContain('佐藤さんに頼んでください');
  }, 30000);

  test("deleting this computer's data needs the check mark, removes the data folder and leaves the shared folder", async () => {
    expect(existsSync(data)).toBe(true);
    expect(await get('/data')).toContain('AI に渡したものの記録も消えます');
    expect(await (await post('/data/clear', {})).text()).toContain('確認の印を付けてから');
    expect(existsSync(data)).toBe(true);
    expect(await (await post('/data/clear', { ok: '1' })).text()).toContain('このパソコンのデータを消しました');
    expect(existsSync(data)).toBe(false);
    expect(readdirSync(join(root, '.coheads', 'events'))).toHaveLength(3);
    // Coheads keeps working: the next visit rebuilds the index, and the approver list comes back from the shared folder.
    const page = await get('/team');
    expect(page).toContain('佐藤');
    expect(page).toContain('加えた');
    expect(await get('/log')).toContain('まだ記録はありません');
  }, 30000);
});

describe('approval page (demo)', () => {
  // The demo has a confidential project (B社): copying it asks once whether that AI is allowed.
  test('copying a confidential project asks for confirmation first', async () => {
    const p = port + 1;
    const env: Record<string, string> = { ...process.env as Record<string, string>, SB_DATA_DIR: join(mkdtempSync(join(tmpdir(), 'coheads-demo-')), 'd'), SB_USER: 'kimura', SB_APPROVAL_PORT: String(p) };
    delete env.SB_DATABASE_URL; delete env.SB_ENGINE; delete env.SB_FOLDER;
    const demo = spawn(process.execPath, ['run', join(import.meta.dir, 'fixtures', 'approval-server.ts')], { env, stdio: ['ignore', 'pipe', 'inherit'] });
    try {
      await new Promise<void>(r => demo.stdout!.once('data', () => r()));
      const html = await (await fetch(`http://127.0.0.1:${p}/copy?project=b-sha`)).text();
      expect(html).toContain("confirm('社外秘の案件です。会社が使ってよいと決めた AI にだけ貼ってください。')");
      expect(html).toContain('【チームの決定】案件：B社');
    } finally { demo.kill(); }
  }, 30000);
});

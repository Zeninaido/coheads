// The approval page as people use it: tabs, setting who may approve, copy text for other AIs,
// what reached the AI, and deleting this computer's data. The page runs in a child process on a free port.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
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
  .replace('「拡張機能」で Coheads を選んで', '').replace('プラグインの一覧から Coheads を外します', '');

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

  test('who may approve is set on the page and recorded in the shared folder, one file per change', async () => {
    expect(await get('/team')).toContain('まだ指定されていません');
    expect(await (await post('/team', { do: 'add', name: '佐藤' })).text()).toContain('佐藤 さんを承認する人に加えました');
    const files = readdirSync(join(root, '.coheads', 'events'));
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(root, '.coheads', 'events', files[0]), 'utf8'))).toMatchObject({ type: 'approver_added', by: '鈴木', name: '佐藤' });
    // 鈴木 is not on the list now: no remove buttons, and a change is refused with a plain explanation.
    const page = await get('/team');
    expect(page).toContain('佐藤さんに頼んでください');
    expect(page).not.toContain('value="remove"');
    expect(await (await post('/team', { do: 'add', name: '鈴木' })).text()).toContain('「承認する人」に載っている人だけです');
    expect(readdirSync(join(root, '.coheads', 'events'))).toHaveLength(1);
  });

  test('a project can be copied as paste-ready text for other AIs, headed 「チームの決定」', async () => {
    const html = await get('/copy');
    expect(html).toContain('<option value="A社">A社</option>');
    const copy = await get('/copy?project=' + encodeURIComponent('A社'));
    const text = /<textarea id="copytext" readonly>([\s\S]*?)<\/textarea>/.exec(copy)![1];
    expect(text.startsWith('【チームの決定】案件：A社')).toBe(true);
    expect(text).toContain('提案書v1');
    expect(text).not.toContain('Coheads');
  });

  test('what reached the AI is listed in plain words, with the project and the documents', async () => {
    const html = await get('/log');
    expect(html).toContain('ほかの AI に貼る文面を作った');
    expect(html).toContain('資料：');
    expect(html).not.toContain('server_start');
  });

  test("deleting this computer's data needs the check mark, removes the data folder and leaves the shared folder", async () => {
    expect(existsSync(data)).toBe(true);
    expect(await (await post('/data/clear', {})).text()).toContain('確認の印を付けてから');
    expect(existsSync(data)).toBe(true);
    expect(await (await post('/data/clear', { ok: '1' })).text()).toContain('このパソコンのデータを消しました');
    expect(existsSync(data)).toBe(false);
    expect(readdirSync(join(root, '.coheads', 'events'))).toHaveLength(1);
    // Coheads keeps working: the next visit rebuilds the index, and the approver list comes back from the shared folder.
    const page = await get('/team');
    expect(page).toContain('佐藤');
    expect(page).toContain('加えた');
    expect(await get('/log')).toContain('まだ記録はありません');
  }, 30000);
});

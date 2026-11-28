// Checks the packaged extension the way Claude Desktop runs it: plain Node, `node server/mcp.js`, settings in the
// environment, a documents folder with Japanese names, Word and PDF files. Used by CI on Windows (#7).
//
//   node scripts/extension-check.mjs <extracted .mcpb dir>
//
// On CI the data folder is the real one Desktop would use (<home>/.coheads, as ${HOME}/.coheads in the manifest).
// Anywhere else it is a temporary folder, because step 6 deletes it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// CHECK_TRACE=<file> writes each step as it starts (for a run that stops without output).
const trace = m => { if (process.env.CHECK_TRACE) appendFileSync(process.env.CHECK_TRACE, `${new Date().toISOString()} ${m}\n`); };
process.on('exit', c => trace(`exit ${c}`));
const ext = resolve(process.argv[2] ?? '');
if (!existsSync(join(ext, 'server', 'mcp.js'))) { console.error(`usage: node scripts/extension-check.mjs <extracted .mcpb dir>`); process.exit(2); }
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
trace('start');
const work = mkdtempSync(join(tmpdir(), 'coheads-check-'));
const home = process.env.CI ? homedir() : join(work, 'home');
const dataDir = join(home, '.coheads');
const folder = join(work, '資料 フォルダ'); // a space and Japanese, as people name folders
const project = join(folder, 'A社');
trace(`folder ${folder}`);
mkdirSync(project, { recursive: true });
// copyFileSync, not cpSync: on Windows, Node 22's cpSync exits the process without a word on Japanese paths
// (seen on GitHub Actions, Node 22.23.5). The extension does not use cpSync (only the eval runner on the Mac does).
const docs = join(repo, 'eval', 'behavior', 'fixtures', 'a-sha-docs', 'A社');
for (const f of readdirSync(docs)) copyFileSync(join(docs, f), join(project, f));
for (const f of ['見積書_A社.docx', '提案書v1.pdf', 'スキャン.pdf']) copyFileSync(join(repo, 'core', 'test', 'fixtures', 'office', f), join(project, f));
trace('copied');
const port = process.env.CI ? 4319 : 4339; // off CI, stay clear of a Coheads running in Claude Desktop
const page = `http://127.0.0.1:${port}`;

const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };

// Start the server as Desktop does (from another working folder, settings as in manifest.json).
const server = spawn(process.execPath, [join(ext, 'server', 'mcp.js')], {
  cwd: tmpdir(),
  env: { ...process.env, SB_FOLDER: folder, SB_USER: '鈴木', SB_DATA_DIR: dataDir, SB_CORPUS_DIR: join(ext, 'server', 'demo-corpus'),
    SB_DESTINATION: 'claude-desktop', SB_APPROVAL_PORT: String(port) },
  stdio: ['pipe', 'pipe', 'pipe'],
});
trace('spawned');
let stderr = '';
server.stderr.on('data', d => { stderr += d; });
let buf = '';
const waiting = new Map();
server.stdout.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id != null && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); }
  }
});
let nextId = 1;
const rpc = (method, params) => new Promise((res, rej) => {
  const id = nextId++;
  const timer = setTimeout(() => rej(new Error(`${method}: no answer in 60s\n${stderr}`)), 60000);
  waiting.set(id, m => { clearTimeout(timer); m.error ? rej(new Error(`${method}: ${JSON.stringify(m.error)}`)) : res(m.result); });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
});
const tool = async (name, args) => (await rpc('tools/call', { name, arguments: args })).content.map(c => c.text).join('\n');
const form = (body) => fetch(page + body.path, { method: 'POST', body: new URLSearchParams(body.fields) }).then(r => r.text());

try {
  trace('initialize');
  // 1. Starts and answers.
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'extension-check', version: '0' } });
  server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  check('starts on Node and answers', init?.serverInfo, `${init?.serverInfo?.name} ${init?.serverInfo?.version} on Node ${process.version}, ${process.platform}`);
  const tools = (await rpc('tools/list', {})).tools.map(t => t.name);
  check('offers the three tools', ['get_context', 'get_document', 'propose_decision'].every(t => tools.includes(t)), tools.join(', '));

  // 2. Reads the folder (Japanese names, a space, Word and PDF) and answers from it.
  const ctx = await tool('get_context', { request: 'A社に送る見積のメールを書いて' });
  check('finds the project in a Japanese-named folder', ctx.includes('案件：A社'));
  check('sees the conflicting amounts in the documents', ctx.includes('100,000') && ctx.includes('120,000'));
  const docx = await tool('get_document', { id: 'doc:A社/見積書_A社.docx' });
  check('reads Word', docx.includes('月額利用料 | 月額120,000円（税別）'));
  const pdf = await tool('get_document', { id: 'doc:A社/提案書v1.pdf' });
  check('reads PDF (Japanese text)', pdf.includes('月額100,000円（税別）'));
  const scan = await tool('get_document', { id: 'doc:A社/スキャン.pdf' });
  check('says a scanned PDF cannot be read', scan.includes('文字のない PDF'));

  // 3. Keeps its data in <home>/.coheads, one store per folder.
  const store = join(dataDir, 'folder-' + createHash('sha256').update(folder).digest('hex').slice(0, 12));
  check('keeps data in <home>/.coheads', existsSync(store), store);

  // 4. The approval page opens on this computer.
  const top = await (await fetch(page + '/')).text();
  check('approval page opens', top.includes('承認待ちの決定') && top.includes(folder), `${page}/`);
  const token = /name="t" value="([0-9a-f]+)"/.exec(await (await fetch(page + '/team')).text())?.[1];

  // 5. A change on the page is written to the shared folder (one file per change).
  const added = await form({ path: '/team', fields: { t: token, do: 'add', name: '佐藤' } });
  const events = join(folder, '.coheads', 'events');
  check('setting an approver writes to the shared folder', added.includes('承認する人に加えました') && existsSync(events) && readdirSync(events).length === 1);
  const proposed = await tool('propose_decision', { project: 'A社', label: '提案価格', amount_yen: 130000, period: 'monthly', tax: 'excluded' });
  check('after recording a candidate, says who may approve and where', proposed.includes('承認できる人：鈴木、佐藤') && proposed.includes('自分のパソコンで同じアドレスを開く'));
  check('what reached the AI is listed', (await (await fetch(page + '/log')).text()).includes('AI がチームの決定と資料を確かめた'));

  // 6. Deleting this computer's data works while the extension keeps running (files must not stay locked).
  const cleared = await form({ path: '/data/clear', fields: { t: token, ok: '1' } });
  check("deletes this computer's data while running", cleared.includes('このパソコンのデータを消しました') && !existsSync(dataDir),
    existsSync(dataDir) ? `still there: ${readdirSync(dataDir).join(', ')}` : '');
  check('the shared folder is kept', existsSync(events) && readdirSync(events).length === 2);

  // 7. After deleting, the next request rebuilds the index and the team's records come back.
  const again = await tool('get_context', { request: 'A社に送る見積のメールを書いて' });
  check('keeps working after the data is deleted', again.includes('案件：A社') && existsSync(store));
  check('the approver list comes back from the shared folder', (await (await fetch(page + '/team')).text()).includes('佐藤'));
} catch (e) {
  check('no errors', false, String(e?.stack ?? e));
} finally {
  server.kill();
}

const failed = results.filter(r => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed (${process.platform}, Node ${process.version})`);
if (failed.length && stderr) console.log('\nserver stderr:\n' + stderr.slice(-4000));
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import('node:fs');
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Extension on ${process.platform} (Node ${process.version})\n\n| check | result |\n| --- | --- |\n` +
    results.map(r => `| ${r.name} | ${r.ok ? 'ok' : 'FAIL ' + r.detail.replace(/\|/g, '/').slice(0, 200)} |`).join('\n') + '\n');
}
process.exit(failed.length ? 1 : 0);

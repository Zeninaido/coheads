// Automated trials: run the same prompts many times through Claude Code in print mode (your subscription, no API key)
// and count which tool the AI reaches for. Decoy mail/drive/Notion tools recreate the competition seen in Claude Desktop.
//
//   bun run trials                         # every prompt in eval/prompts.json, 5 runs each, decoys on
//   bun run trials --n 3 --only p1,p4      # fewer runs, some prompts
//   bun run trials --decoys off --label no-decoys
//   bun run trials --names off             # project names left out of get_context's description (comparison)
//   bun run trials --baseline folder       # no Coheads: the AI reads the demo folder itself (Read/Glob/Grep), for comparison
//   bun run trials --baseline rag          # no ledger: a plain document search (top 3 excerpts) over the same documents
//   bun run trials --plugin skill          # load the Coheads plugin (skill only: no local service for the hook)
//   bun run trials --plugin full           # plugin with its hook: a local Coheads service injects decisions into the prompt
//   bun run trials --decoys empty          # decoys return nothing (the behavior before 11/26), for comparison
//
// Results: a table on screen, and every run (tools in order + answer) in eval/trials/<time>-<label>.json.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withStore } from './runtime';

const flags: Record<string, string> = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[++i];

const CORE = join(import.meta.dir, '..');
const ROOT = join(CORE, '..');
const N = Number(flags.n ?? 5);
const DECOYS = (flags.decoys ?? 'on') !== 'off';
const DECOYS_EMPTY = flags.decoys === 'empty';
const PLUGIN = flags.plugin as 'skill' | 'full' | undefined;
const PLUGIN_SRC = join(import.meta.dir, '..', '..', 'packaging', 'plugin', 'coheads');
// Trials use their own port, so a Coheads extension running in Claude Desktop (port 4319) never answers the trial's hook.
const TRIAL_HOOK_PORT = '4329';
const LABEL = flags.label ?? (flags.baseline ? `baseline-${flags.baseline}` : PLUGIN ? `plugin-${PLUGIN}` : `${DECOYS ? 'decoys' : 'no-decoys'}-${(flags.names ?? 'on') !== 'off' ? 'names' : 'no-names'}`);
const USER = flags.user ?? 'suzuki';
const NAMES = (flags.names ?? 'on') !== 'off'; // off: no project names in get_context's description (for comparison)
const CLAUDE = process.env.SB_CLAUDE_BIN ?? 'claude';
const TIMEOUT_MS = Number(flags.timeout ?? 180) * 1000;
// Baseline "folder": Coheads is not connected; the same documents sit in the working folder and the AI may read them.
const BASELINE = flags.baseline === 'folder';
// Baseline "rag": the same server in plain-search mode (no ledger, annotations or cautions).
const RAG = flags.baseline === 'rag';

type Prompt = { id: string; prompt: string; kind: string; shouldCall: boolean };
let prompts: Prompt[] = JSON.parse(readFileSync(join(ROOT, 'eval', 'prompts.json'), 'utf8'));
if (flags.only) prompts = prompts.filter(p => flags.only.split(',').includes(p.id));

// MCP config passed with --strict-mcp-config: only these servers load, nothing from your own Claude Code setup.
const bun = process.execPath;
const servers: Record<string, unknown> = BASELINE ? {} : {
  'shared-second-brain': {
    command: bun, args: ['run', join(CORE, 'src', 'mcp.ts')],
    env: { SB_USER: USER, SB_DESTINATION: 'claude-code-trial', SB_APPROVAL_PAGE: '0', ...(NAMES ? {} : { SB_NAME_CEILING: 'none' }), ...(RAG ? { SB_PLAIN_SEARCH: '1' } : {}) },
  },
};
if (DECOYS) servers['workspace-apps'] = { command: bun, args: ['run', join(CORE, 'src', 'decoy.ts')], env: DECOYS_EMPTY ? { SB_DECOYS_EMPTY: '1' } : {} };

// Plugin "full": the hook posts each prompt to a local Coheads service. It runs as its own process on its own copy of
// the demo data (PGLite allows one process per store).
let hookProc: ReturnType<typeof Bun.spawn> | undefined;
const HOOK_LOG = join(CORE, '.data-hook', 'hook.log');
const hookLines = () => (PLUGIN === 'full' ? readFileSync(HOOK_LOG, 'utf8').split('\n').filter(Boolean) : []);
if (PLUGIN === 'full') {
  mkdirSync(join(CORE, '.data-hook'), { recursive: true });
  writeFileSync(HOOK_LOG, '');
  hookProc = Bun.spawn({ cmd: [bun, 'run', join(CORE, 'src', 'hookServer.ts')], env: { ...process.env, SB_DATA_DIR: join(CORE, '.data-hook'), SB_USER: USER, SB_APPROVAL_PORT: TRIAL_HOOK_PORT, SB_HOOK_LOG: HOOK_LOG }, stdout: 'pipe', stderr: 'inherit' });
  const reader = hookProc.stdout.getReader();
  const { value } = await reader.read();
  if (!new TextDecoder().decode(value).includes('ready')) { console.log('hook server did not start'); process.exit(1); }
  process.on('exit', () => hookProc?.kill());
}
const work = mkdtempSync(join(tmpdir(), 'sb-trial-')); // empty folder: the AI cannot read the corpus files directly
if (BASELINE) cpSync(join(ROOT, 'corpus'), join(work, '社内資料'), { recursive: true });
const cfgPath = join(work, 'mcp.json');
// A copy of the plugin whose hook points at the trial's own hook server.
const PLUGIN_DIR = join(work, 'plugin-coheads');
if (PLUGIN) {
  cpSync(PLUGIN_SRC, PLUGIN_DIR, { recursive: true });
  const hooksPath = join(PLUGIN_DIR, 'hooks', 'hooks.json');
  writeFileSync(hooksPath, readFileSync(hooksPath, 'utf8').replace('127.0.0.1:4319', `127.0.0.1:${TRIAL_HOOK_PORT}`));
}
writeFileSync(cfgPath, JSON.stringify({ mcpServers: servers }, null, 2));

// Preflight: start the server exactly as Claude Code will, before spending any usage.
if (!BASELINE) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const ours: any = servers['shared-second-brain'];
  const t = new StdioClientTransport({ command: ours.command, args: ours.args, env: ours.env, cwd: work, stderr: 'pipe' });
  let err = '';
  t.stderr?.on('data', (d: any) => (err += d.toString()));
  const c = new Client({ name: 'preflight', version: '0' });
  try {
    await c.connect(t);
    const names = (await c.listTools()).tools.map(x => x.name);
    await c.close();
    console.log(`preflight: shared-second-brain OK (${names.join(', ')})`);
  } catch (e) {
    console.log(`preflight: shared-second-brain が起動できませんでした：${String(e)}`);
    if (err) console.log('--- サーバーのエラー出力 ---\n' + err.slice(0, 2000));
    console.log('試験は実行していません（利用枠は使っていません）。この出力を共有してください。');
    process.exit(1);
  }
}

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const allowed = [
  ...(BASELINE ? READ_TOOLS
    : RAG ? ['mcp__shared-second-brain__search_documents', 'mcp__shared-second-brain__get_document']
    : ['mcp__shared-second-brain__get_context', 'mcp__shared-second-brain__get_document']),
  ...(DECOYS ? ['mcp__workspace-apps__search_mail', 'mcp__workspace-apps__search_drive', 'mcp__workspace-apps__search_notion', 'mcp__workspace-apps__search_past_chats'] : []),
];
const blocked = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'NotebookEdit', 'TodoWrite']
  .filter(t => !(BASELINE && READ_TOOLS.includes(t)));
// Baseline only: tell the AI where the documents are, as a shared drive or a folder-based RAG would.
const BASELINE_PROMPT = '社内の資料は、作業フォルダの「社内資料」フォルダに案件ごとに入っています（a-sha がA社、b-sha がB社）。';

/** Every tool call in the stream with its input, in order (inputs show what the AI searched for or opened). */
function toolCalls(lines: string[]): { name: string; input: unknown }[] {
  const out: { name: string; input: unknown }[] = [];
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (v.type === 'tool_use' && typeof v.name === 'string') out.push({ name: v.name.replace(/^mcp__.+?__/, ''), input: v.input });
    for (const k of Object.keys(v)) walk(v[k]);
  };
  for (const l of lines) { try { walk(JSON.parse(l)); } catch { /* not JSON */ } }
  return out;
}

/** Every tool_use name in the stream, in order, wherever the event nests it. */
function toolUses(lines: string[]): string[] {
  const out: string[] = [];
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (v.type === 'tool_use' && typeof v.name === 'string') out.push(v.name.replace(/^mcp__.+?__/, ''));
    for (const k of Object.keys(v)) walk(v[k]);
  };
  for (const l of lines) { try { walk(JSON.parse(l)); } catch { /* not JSON */ } }
  return out;
}

/** Connection status of each MCP server as Claude Code reported it at startup (system/init event). */
function serverStatus(lines: string[]): Record<string, string> {
  for (const l of lines) {
    try {
      const j = JSON.parse(l);
      if (j.type === 'system' && j.subtype === 'init' && Array.isArray(j.mcp_servers)) {
        return Object.fromEntries(j.mcp_servers.map((m: any) => [m.name, m.status ?? 'unknown']));
      }
    } catch {}
  }
  return {};
}

/** Cost and token use reported by Claude Code in its final result event. */
function usage(lines: string[]): { costUsd?: number; inputTokens?: number; outputTokens?: number; model?: string; modelUsage?: Record<string, unknown> } {
  let model: string | undefined;
  for (const l of lines) {
    try { const j = JSON.parse(l); if (j.type === 'system' && j.subtype === 'init' && j.model) { model = j.model; break; } } catch {}
  }
  for (const l of [...lines].reverse()) {
    try {
      const j = JSON.parse(l);
      // modelUsage lists every model the run used (e.g. a smaller model for internal steps) with its own cost.
      if (j.type === 'result') return { model, costUsd: j.total_cost_usd, inputTokens: j.usage?.input_tokens, outputTokens: j.usage?.output_tokens, modelUsage: j.modelUsage };
    } catch {}
  }
  return { model };
}

function finalText(lines: string[]): string {
  for (const l of [...lines].reverse()) {
    try { const j = JSON.parse(l); if (j.type === 'result' && typeof j.result === 'string') return j.result; } catch {}
  }
  return '';
}

/** get_context calls the server logged since `afterSeq`, oldest first: which project each one resolved. */
async function contextCallsSince(afterSeq: number): Promise<{ seq: number; project: string | null }[]> {
  if (BASELINE) return [];
  return withStore(async db => {
    const rows = await db.query(`select seq, project_id from access_log where seq > $1 and tool = 'get_context' order by seq`, [afterSeq]);
    return rows.map((r: any) => ({ seq: Number(r.seq), project: r.project_id ?? null }));
  });
}
async function lastSeq(): Promise<number> {
  if (BASELINE) return 0;
  return withStore(async db => Number((await db.query(`select coalesce(max(seq), 0) as m from access_log`))[0].m));
}

type Run = { id: string; run: number; injected?: string | null; model?: string; modelUsage?: Record<string, unknown>; calls?: { name: string; input: unknown }[]; costUsd?: number; inputTokens?: number; outputTokens?: number; firstContextProject?: string | null; contextProjects?: (string | null)[]; servers: Record<string, string>; tools: string[]; calledContext: boolean; firstTool: string | null; answer: string; error?: string };
const runs: Run[] = [];

console.log(`trials: ${prompts.length} prompts × ${N} runs, decoys=${DECOYS ? 'on' : 'off'}, user=${USER}, label=${LABEL}\n`);
for (const p of prompts) {
  for (let i = 1; i <= N; i++) {
    const before = await lastSeq();
    const hookBefore = hookLines().length;
    const proc = Bun.spawnSync({
      cmd: [CLAUDE, '-p', p.prompt, '--mcp-config', cfgPath, '--strict-mcp-config',
        '--output-format', 'stream-json', '--verbose', '--max-turns', '8',
        '--allowedTools', allowed.join(','), '--disallowedTools', blocked.join(','),
        ...(BASELINE ? ['--append-system-prompt', BASELINE_PROMPT] : []),
        ...(PLUGIN ? ['--plugin-dir', PLUGIN_DIR] : [])],
      cwd: work, timeout: TIMEOUT_MS, stdout: 'pipe', stderr: 'pipe',
    });
    const lines = proc.stdout.toString().split('\n').filter(Boolean);
    const tools = toolUses(lines);
    const run: Run = {
      id: p.id, run: i, servers: serverStatus(lines), tools, calledContext: tools.includes('get_context'),
      // ToolSearch only looks tools up; the first real choice is what matters.
      firstTool: tools.find(t => t !== 'ToolSearch') ?? null,
      answer: finalText(lines),
      calls: toolCalls(lines),
      ...usage(lines),
      error: proc.exitCode === 0 ? undefined : (proc.stderr.toString().trim().split('\n').pop() || `exit ${proc.exitCode}`),
    };
    if (PLUGIN === 'full') {
      const fired = hookLines().slice(hookBefore);
      run.injected = fired.length ? fired[0].split('\t')[1] : null; // project the hook matched, '-' = fired but no match, null = never fired
    }
    const calls = await contextCallsSince(before);
    run.contextProjects = calls.map(c => c.project);
    run.firstContextProject = calls.length ? calls[0].project : undefined;
    runs.push(run);
    const ours = BASELINE ? '比較のため未接続' : (run.servers['shared-second-brain'] ?? '状態不明');
    process.stdout.write(`${p.id} #${i} [shared-second-brain: ${ours}]: ${run.error ? 'ERROR ' + run.error : (tools.join(' → ') || '（ツールなし）')}\n`);
    if (!BASELINE && i === 1 && p === prompts[0] && ours !== 'connected' && ours !== '状態不明') {
      console.log('\nClaude Codeから shared-second-brain に接続できていません。試験を中止します（残りの利用枠を使わないため）。');
      console.log('core/.data/mcp-error.log があれば、その内容を共有してください。');
      process.exit(1);
    }
  }
}

console.log(BASELINE ? `\n比較：Coheadsなし、AIが資料フォルダを直接読む／おとり：${DECOYS ? 'あり' : 'なし'}` : RAG ? `\n比較：台帳なしの資料検索（上位3件）／おとり：${DECOYS ? 'あり' : 'なし'}` : `\n説明文の案件名：${NAMES ? 'あり' : 'なし'}／おとり：${DECOYS ? 'あり' : 'なし'}`);
console.log('| 依頼 | 種類 | 呼ぶべきか | get_contextが呼ばれた回数 | 最初の呼び出しで案件を特定 | 最初に使ったツール（ToolSearchを除く） |');
console.log('| --- | --- | --- | --- | --- | --- |');
for (const p of prompts) {
  const rs = runs.filter(r => r.id === p.id && !r.error);
  const called = rs.filter(r => r.calledContext).length;
  const first: Record<string, number> = {};
  for (const r of rs) first[r.firstTool ?? 'なし'] = (first[r.firstTool ?? 'なし'] ?? 0) + 1;
  const firstText = Object.entries(first).map(([k, v]) => `${k}×${v}`).join('、');
  const hit = rs.filter(r => r.firstContextProject).length;
  console.log(`| ${p.id} | ${p.kind} | ${p.shouldCall ? '呼ぶ' : '呼ばない'} | ${called}/${rs.length} | ${hit}/${rs.length} | ${firstText} |`);
}
const models = [...new Set(runs.map(r => r.model).filter(Boolean))];
const usedModels = [...new Set(runs.flatMap(r => Object.keys(r.modelUsage ?? {})))];
console.log(`\nモデル：${models.join('、') || '不明'}${usedModels.length ? `（実際に使われたモデル：${usedModels.join('、')}）` : ''}`);
const costs = runs.map(r => r.costUsd).filter((c): c is number => typeof c === 'number');
if (costs.length) console.log(`\n費用（Claude Codeの報告値、API料金換算）：合計 $${costs.reduce((a, b) => a + b, 0).toFixed(3)}、1回あたり平均 $${(costs.reduce((a, b) => a + b, 0) / costs.length).toFixed(4)}（${costs.length}回）`);
if (PLUGIN === 'full') {
  const ok = runs.filter(r => !r.error);
  console.log(`フックが動いた回：${ok.filter(r => r.injected != null).length}/${ok.length}／案件を差し込んだ回：${ok.filter(r => r.injected && r.injected !== '-').length}/${ok.length}`);
}
// Prices in the answers (the demo's current price is 120,000; 100,000 is the expired one).
{
  const ok = runs.filter(r => !r.error);
  const has = (re: RegExp) => ok.filter(r => re.test(r.answer)).length;
  console.log(`回答に現行の120,000円（12万円）を含む回：${has(/120,000|12万/)}/${ok.length}／旧価格の100,000円（10万円）を含む回：${has(/100,000|10万/)}/${ok.length}（旧価格は「失効」として触れている場合もあるので、中身は結果ファイルで確認する）`);
}
// Words that should not leak into drafts meant for customers (internal tool names, labels).
for (const w of (flags.watch ?? 'Coheads,社内メモリ').split(',')) {
  const hits = runs.filter(r => !r.error && r.answer.includes(w));
  console.log(`回答に「${w}」を含む回：${hits.length}/${runs.filter(r => !r.error).length}${hits.length ? `（${hits.map(r => `${r.id}#${r.run}`).join('、')}）` : ''}`);
}
const errors = runs.filter(r => r.error).length;
if (errors) console.log(`\n実行エラー：${errors}件（詳細は結果ファイル）`);

const outDir = join(ROOT, 'eval', 'trials');
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const outPath = join(outDir, `${stamp}-${LABEL}.json`);
writeFileSync(outPath, JSON.stringify({ label: LABEL, baseline: flags.baseline, decoys: DECOYS, names: NAMES, user: USER, n: N, runs }, null, 2));
console.log(`\n結果ファイル：${outPath}`);

// The hook server is a child process; stop it, or it keeps this process (and the terminal) waiting.
hookProc?.kill();
process.exit(0);

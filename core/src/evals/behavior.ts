// L2 behavior evals: does the AI act right in each scene, under fixed conditions, over several runs?
//
// Cases (eval/behavior/cases/*.yaml) say what is asked, on which data, and what counts as a pass.
// Suites (eval/behavior/suites/*.yaml) say which cases run under which conditions, and how many times.
// Runs go through Claude Code in print mode (`claude -p`, your own login; no API key), one fresh setup per run.
//
//   bun run eval --dry                     check every case and suite file, start the server once; spends nothing
//   bun run eval --suite core              run a suite (default: core)
//   bun run eval --suite core --cases quote-by-contact,conflict-grounded --runs 1
//
// Results: eval/behavior/results/<version>/<time>-<suite>.json (every run: tools, answer, checks) and .md (the table).
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import pkg from '../../package.json' with { type: 'json' };

const CORE = join(import.meta.dir, '..', '..');
const ROOT = join(CORE, '..');
const BEHAVIOR = join(ROOT, 'eval', 'behavior');
const PLUGIN_SRC = join(ROOT, 'packaging', 'plugin', 'coheads');
// SB_CLAUDE_BIN may carry arguments (the tests use `bun test/fixtures/fake-claude.ts`).
const CLAUDE = (process.env.SB_CLAUDE_BIN ?? 'claude').split(' ');
const BUN = process.execPath;
// Evals use their own port, so a Coheads extension running in Claude Desktop (port 4319) never answers.
const EVAL_HOOK_PORT = '4329';

// ---------- case and suite files ----------

export interface Case {
  id: string;
  title: string;
  scene?: string;
  prompt: string;
  /** demo: the built-in fictional data (current price 120,000円). folder:<name>: eval/behavior/fixtures/<name>. */
  data: string;
  /** Share of runs that must pass, for this case (overrides the suite's min_pass). 1 = every run. */
  min_pass?: number;
  expect: {
    /** required: the AI got this project's decisions (tool call or hook). none: no project's decisions reached it. */
    context?: 'required' | 'none' | 'any';
    project?: string;
    /** Tools that must be called (any one of them), e.g. propose_decision. */
    calls?: string[];
    includes_any?: string[];
    excludes?: string[];
    /** Statements a separate Claude call checks against the answer. Every one must hold. */
    judge?: string[];
  };
}
export interface Condition {
  id: string;
  description?: string;
  /** coheads: the server as shipped. rag: plain document search (no ledger). files: no server, documents in the folder. */
  server?: 'coheads' | 'rag' | 'files';
  plugin?: 'none' | 'skill' | 'full';
  /** realistic: mail/drive/Notion/past-chat tools returning stale data. empty: they return nothing. none: absent. */
  decoys?: 'realistic' | 'empty' | 'none';
}
export interface Suite { id: string; title?: string; runs: number; cases: string[] | '*'; conditions: Condition[]; min_pass?: number }

const yaml = (p: string) => Bun.YAML.parse(readFileSync(p, 'utf8')) as any;
const list = (dir: string) => (existsSync(dir) ? readdirSync(dir).filter(f => /\.ya?ml$/.test(f)).sort() : []);

export function loadCases(): Case[] {
  return list(join(BEHAVIOR, 'cases')).map(f => yaml(join(BEHAVIOR, 'cases', f)) as Case);
}
export function loadSuite(id: string): Suite {
  return yaml(join(BEHAVIOR, 'suites', `${id}.yaml`)) as Suite;
}

/** Problems in the case and suite files, in words. Empty when everything can run. */
export function validate(cases: Case[], suites: Suite[]): string[] {
  const errs: string[] = [];
  const ids = new Set<string>();
  for (const c of cases) {
    const at = `case ${c.id ?? '(no id)'}`;
    if (!c.id || !c.title || !c.prompt || !c.data || !c.expect) errs.push(`${at}: id, title, prompt, data and expect are required`);
    if (ids.has(c.id)) errs.push(`${at}: duplicate id`);
    ids.add(c.id);
    if (c.data && c.data !== 'demo') {
      const m = /^folder:(.+)$/.exec(c.data);
      if (!m) errs.push(`${at}: data must be "demo" or "folder:<fixture>"`);
      else if (!existsSync(join(BEHAVIOR, 'fixtures', m[1]))) errs.push(`${at}: fixture ${m[1]} not found`);
    }
    const e = c.expect ?? {};
    if (e.context && !['required', 'none', 'any'].includes(e.context)) errs.push(`${at}: expect.context must be required, none or any`);
    if (!e.context && !e.calls && !e.includes_any && !e.excludes && !e.judge) errs.push(`${at}: expect has no checks`);
    if (c.min_pass !== undefined && !(c.min_pass > 0 && c.min_pass <= 1)) errs.push(`${at}: min_pass must be more than 0 and at most 1`);
  }
  for (const s of suites) {
    const at = `suite ${s.id}`;
    if (!s.runs || s.runs < 1) errs.push(`${at}: runs must be 1 or more`);
    if (s.cases !== '*') for (const id of s.cases ?? []) if (!ids.has(id)) errs.push(`${at}: unknown case ${id}`);
    for (const k of s.conditions ?? []) {
      if (!k.id) errs.push(`${at}: a condition has no id`);
      if (k.server && !['coheads', 'rag', 'files'].includes(k.server)) errs.push(`${at}/${k.id}: server must be coheads, rag or files`);
      if (k.plugin && !['none', 'skill', 'full'].includes(k.plugin)) errs.push(`${at}/${k.id}: plugin must be none, skill or full`);
      if (k.decoys && !['realistic', 'empty', 'none'].includes(k.decoys)) errs.push(`${at}/${k.id}: decoys must be realistic, empty or none`);
      if (k.plugin && k.plugin !== 'none' && k.server && k.server !== 'coheads') errs.push(`${at}/${k.id}: the plugin needs server coheads`);
    }
  }
  return errs;
}

// ---------- one run ----------

interface Setup { work: string; cfg: string; allowed: string[]; blocked: string[]; pluginDir?: string; accessLog: string; hookLog: string; hook?: ReturnType<typeof Bun.spawn>; appendPrompt?: string }

const READ_TOOLS = ['Read', 'Glob', 'Grep'];
const DECOY_TOOLS = ['search_mail', 'search_drive', 'search_notion', 'search_past_chats'].map(t => `mcp__workspace-apps__${t}`);

async function prepare(c: Case, k: Condition): Promise<Setup> {
  const work = mkdtempSync(join(tmpdir(), 'coheads-eval-'));
  const server = k.server ?? 'coheads';
  const accessLog = join(work, 'access.log');
  const hookLog = join(work, 'hook.log');
  writeFileSync(accessLog, '');
  writeFileSync(hookLog, '');
  // Data: a fresh store per run; folder fixtures are copied, so events written during the run stay in the copy.
  // No approval page in evals, but the AI gets the same guide after recording a candidate as in Desktop (address on the eval port).
  const env: Record<string, string> = { SB_DATA_DIR: join(work, 'store'), SB_APPROVAL_PAGE: '0', SB_APPROVAL_GUIDE: '1', SB_APPROVAL_PORT: EVAL_HOOK_PORT, SB_DESTINATION: 'claude-code-eval', SB_ACCESS_LOG: accessLog };
  let docsDir = join(ROOT, 'corpus');
  if (c.data.startsWith('folder:')) {
    const folder = join(work, 'team-folder');
    cpSync(join(BEHAVIOR, 'fixtures', c.data.slice(7)), folder, { recursive: true });
    env.SB_FOLDER = folder;
    env.SB_USER = 'me';
    docsDir = folder;
  } else {
    env.SB_USER = 'suzuki';
  }
  if (server === 'rag') env.SB_PLAIN_SEARCH = '1';

  const servers: Record<string, unknown> = {};
  if (server !== 'files') servers['shared-second-brain'] = { command: BUN, args: ['run', join(CORE, 'src', 'mcp.ts')], env };
  const decoys = k.decoys ?? 'realistic';
  if (decoys !== 'none') servers['workspace-apps'] = { command: BUN, args: ['run', join(CORE, 'src', 'decoy.ts')], env: decoys === 'empty' ? { SB_DECOYS_EMPTY: '1' } : {} };
  const cfg = join(work, 'mcp.json');
  writeFileSync(cfg, JSON.stringify({ mcpServers: servers }, null, 2));

  const ours = server === 'files' ? READ_TOOLS
    : server === 'rag' ? ['search_documents', 'get_document'].map(t => `mcp__shared-second-brain__${t}`)
    : ['get_context', 'get_document', 'propose_decision'].map(t => `mcp__shared-second-brain__${t}`);
  const allowed = [...ours, ...(decoys !== 'none' ? DECOY_TOOLS : [])];
  const blocked = ['Bash', 'Read', 'Write', 'Edit', 'MultiEdit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task', 'NotebookEdit', 'TodoWrite']
    .filter(t => !(server === 'files' && READ_TOOLS.includes(t)));
  const setup: Setup = { work, cfg, allowed, blocked, accessLog, hookLog };
  if (server === 'files') {
    cpSync(docsDir, join(work, '社内資料'), { recursive: true });
    setup.appendPrompt = '社内の資料は、作業フォルダの「社内資料」フォルダに案件ごとに入っています。';
  }

  const plugin = k.plugin ?? 'none';
  if (plugin !== 'none') {
    setup.pluginDir = join(work, 'plugin-coheads');
    cpSync(PLUGIN_SRC, setup.pluginDir, { recursive: true });
    const hooks = join(setup.pluginDir, 'hooks', 'hooks.json');
    if (plugin === 'skill') writeFileSync(hooks, JSON.stringify({ hooks: {} }));
    else writeFileSync(hooks, readFileSync(hooks, 'utf8').replace('127.0.0.1:4319', `127.0.0.1:${EVAL_HOOK_PORT}`));
  }
  if (plugin === 'full') {
    // The hook's local service: its own store (PGLite allows one process per store), the same data.
    const hook = Bun.spawn({
      cmd: [BUN, 'run', join(CORE, 'src', 'hookServer.ts')],
      env: { ...process.env, ...env, SB_DATA_DIR: join(work, 'hook-store'), SB_APPROVAL_PORT: EVAL_HOOK_PORT, SB_APPROVAL_PAGE: '1', SB_HOOK_LOG: hookLog, SB_ACCESS_LOG: '' },
      stdout: 'pipe', stderr: 'pipe',
    });
    const { value } = await hook.stdout.getReader().read();
    if (!new TextDecoder().decode(value).includes('ready')) throw new Error('hook server did not start');
    setup.hook = hook;
  }
  return setup;
}

interface Call { name: string; input: unknown }
function streamEvents(stdout: string): any[] {
  return stdout.split('\n').filter(Boolean).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
}
function toolCalls(events: any[]): Call[] {
  const out: Call[] = [];
  const walk = (v: any) => {
    if (!v || typeof v !== 'object') return;
    if (v.type === 'tool_use' && typeof v.name === 'string') out.push({ name: v.name.replace(/^mcp__.+?__/, ''), input: v.input });
    for (const x of Object.values(v)) walk(x);
  };
  events.forEach(walk);
  return out.filter(c => c.name !== 'ToolSearch');
}

export interface RunResult {
  case: string; condition: string; run: number;
  pass: boolean; checks: { check: string; pass: boolean; detail?: string }[];
  calls: Call[]; contextProjects: (string | null)[]; injected: (string | null)[];
  answer: string; model?: string; costUsd?: number; error?: string;
}

async function judge(answer: string, statements: string[]): Promise<{ statement: string; pass: boolean; reason: string }[]> {
  const prompt = [
    '次の「回答」について、各「確認事項」が成り立つかを判定してください。',
    '回答の文面だけを根拠にしてください。推測で補わないでください。',
    '出力は JSON の配列だけにしてください。形式：[{"i":番号,"pass":true または false,"reason":"短い理由"}]',
    '', '# 確認事項', ...statements.map((s, i) => `${i + 1}. ${s}`), '', '# 回答', answer,
  ].join('\n');
  const p = Bun.spawnSync({ cmd: [...CLAUDE, '-p', prompt, '--output-format', 'json', '--max-turns', '1', '--tools', ''], stdout: 'pipe', stderr: 'pipe', timeout: 120_000 });
  let text = '';
  try { text = JSON.parse(p.stdout.toString()).result ?? ''; } catch { text = p.stdout.toString(); }
  const m = text.match(/\[[\s\S]*\]/);
  const parsed: { i: number; pass: boolean; reason: string }[] = m ? JSON.parse(m[0]) : [];
  return statements.map((statement, i) => {
    const r = parsed.find(x => x.i === i + 1);
    return { statement, pass: !!r?.pass, reason: r?.reason ?? '判定を読み取れなかった' };
  });
}

async function runOnce(c: Case, k: Condition, n: number, timeoutMs: number): Promise<RunResult> {
  const s = await prepare(c, k);
  try {
    const proc = Bun.spawnSync({
      cmd: [...CLAUDE, '-p', c.prompt, '--mcp-config', s.cfg, '--strict-mcp-config', '--output-format', 'stream-json', '--verbose', '--max-turns', '8',
        '--allowedTools', s.allowed.join(','), '--disallowedTools', s.blocked.join(','),
        ...(s.appendPrompt ? ['--append-system-prompt', s.appendPrompt] : []),
        ...(s.pluginDir ? ['--plugin-dir', s.pluginDir] : [])],
      cwd: s.work, timeout: timeoutMs, stdout: 'pipe', stderr: 'pipe',
    });
    const events = streamEvents(proc.stdout.toString());
    const result = [...events].reverse().find(e => e.type === 'result');
    const init = events.find(e => e.type === 'system' && e.subtype === 'init');
    const answer: string = typeof result?.result === 'string' ? result.result : '';
    const calls = toolCalls(events);
    const access = readFileSync(s.accessLog, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
    const contextProjects = access.filter(a => a.tool === 'get_context').map(a => a.projectId ?? null);
    const injected = readFileSync(s.hookLog, 'utf8').split('\n').filter(Boolean).map(l => { const p = l.split('\t')[1]; return p === '-' ? null : p; });
    const error = proc.exitCode === 0 ? undefined : (proc.stderr.toString().trim().split('\n').filter(l => l.trim()).slice(-6).join(' / ') || `exit ${proc.exitCode}`);

    const checks: RunResult['checks'] = [];
    const e = c.expect;
    const got = [...contextProjects, ...injected].filter((p): p is string => !!p);
    if (e.context === 'required') checks.push({ check: 'context', pass: got.length > 0 && (!e.project || got.includes(e.project)), detail: got.join(',') || 'none' });
    if (e.context === 'none') checks.push({ check: 'context', pass: got.length === 0, detail: got.join(',') || 'none' });
    if (e.calls) checks.push({ check: 'calls', pass: calls.some(x => e.calls!.includes(x.name)), detail: calls.map(x => x.name).join('→') });
    if (e.includes_any) checks.push({ check: 'includes_any', pass: e.includes_any.some(w => answer.includes(w)) });
    if (e.excludes) {
      const hit = e.excludes.filter(w => answer.includes(w));
      checks.push({ check: 'excludes', pass: hit.length === 0, detail: hit.join(',') || undefined });
    }
    if (e.judge?.length && answer) {
      for (const j of await judge(answer, e.judge)) checks.push({ check: `judge: ${j.statement}`, pass: j.pass, detail: j.reason });
    }
    return {
      case: c.id, condition: k.id, run: n, pass: !error && !!answer && checks.every(x => x.pass), checks,
      calls, contextProjects, injected, answer, model: init?.model, costUsd: result?.total_cost_usd, error,
    };
  } finally {
    s.hook?.kill();
  }
}

// ---------- main ----------

async function preflight(): Promise<void> {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const work = mkdtempSync(join(tmpdir(), 'coheads-preflight-'));
  const t = new StdioClientTransport({ command: BUN, args: ['run', join(CORE, 'src', 'mcp.ts')], env: { ...process.env, SB_DATA_DIR: join(work, 'store'), SB_APPROVAL_PAGE: '0' } as Record<string, string>, stderr: 'pipe' });
  const c = new Client({ name: 'preflight', version: '0' });
  await c.connect(t);
  const names = (await c.listTools()).tools.map(x => x.name);
  await c.close();
  console.log(`preflight: server OK (${names.join(', ')})`);
}

if (import.meta.main) {
  const flags: Record<string, string> = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) flags[argv[i].slice(2)] = argv[i + 1]?.startsWith('--') || argv[i + 1] === undefined ? 'true' : argv[++i];

  const cases = loadCases();
  const suites = list(join(BEHAVIOR, 'suites')).map(f => yaml(join(BEHAVIOR, 'suites', f)) as Suite);
  const errs = validate(cases, suites);
  if (errs.length) { console.error(errs.map(e => `- ${e}`).join('\n')); process.exit(1); }
  console.log(`eval files OK: ${cases.length} cases, ${suites.length} suites`);
  await preflight();
  if (flags.dry) process.exit(0);

  const suite = loadSuite(flags.suite ?? 'core');
  const runs = Number(flags.runs ?? suite.runs);
  const only = flags.cases?.split(',');
  const picked = cases.filter(c => (suite.cases === '*' || suite.cases.includes(c.id)) && (!only || only.includes(c.id)));
  const conditions = suite.conditions.filter(k => !flags.conditions || flags.conditions.split(',').includes(k.id));
  const timeoutMs = Number(flags.timeout ?? 180) * 1000;
  console.log(`suite ${suite.id}: ${picked.length} cases × ${conditions.length} conditions × ${runs} runs (version ${pkg.version})\n`);

  const results: RunResult[] = [];
  for (const k of conditions) for (const c of picked) for (let n = 1; n <= runs; n++) {
    const r = await runOnce(c, k, n, timeoutMs);
    results.push(r);
    const failed = r.checks.filter(x => !x.pass).map(x => x.check);
    console.log(`${k.id} / ${c.id} #${n}: ${r.error ? `ERROR ${r.error}` : r.pass ? 'pass' : `FAIL (${failed.join('; ')})`}  [${r.calls.map(x => x.name).join('→') || 'no tools'}]`);
  }

  // Table: pass count per case and condition.
  const need = (c: Case, total: number) => Math.ceil((c.min_pass ?? suite.min_pass ?? 1) * total);
  const rows: string[] = [`| case | ${conditions.map(k => k.id).join(' | ')} |`, `| --- | ${conditions.map(() => '---').join(' | ')} |`];
  let ok = true;
  for (const c of picked) {
    const cells = conditions.map(k => {
      const rs = results.filter(r => r.case === c.id && r.condition === k.id);
      const p = rs.filter(r => r.pass).length;
      if (p < need(c, rs.length)) ok = false;
      return `${p}/${rs.length}${p < need(c, rs.length) ? ' ✗' : ''}`;
    });
    rows.push(`| ${c.id} | ${cells.join(' | ')} |`);
  }
  const cost = results.reduce((a, r) => a + (r.costUsd ?? 0), 0);
  const models = [...new Set(results.map(r => r.model).filter(Boolean))].join(', ');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outDir = process.env.SB_EVAL_OUT ?? join(BEHAVIOR, 'results', pkg.version);
  mkdirSync(outDir, { recursive: true });
  const base = join(outDir, `${stamp}-${suite.id}`);
  const md = [
    `# ${suite.title ?? suite.id}（${pkg.version}、${new Date().toISOString().slice(0, 16)}Z）`, '',
    `モデル：${models || '不明'}／実行回数：${runs}／費用（Claude Codeの報告値、API料金換算）：$${cost.toFixed(3)}`, '',
    ...conditions.map(k => `- ${k.id}：${k.description ?? ''}（server=${k.server ?? 'coheads'}, plugin=${k.plugin ?? 'none'}, decoys=${k.decoys ?? 'realistic'}）`), '',
    ...rows, '',
    `判定：${ok ? '合格' : '不合格'}（各セルで、ケースの min_pass（なければスイートの ${Math.round((suite.min_pass ?? 1) * 100)}%）以上の回が合格。✗ は基準に届かなかったセル）`, '',
    '## 不合格の回', '',
    ...results.filter(r => !r.pass).map(r => `- ${r.condition} / ${r.case} #${r.run}：${r.error ?? r.checks.filter(x => !x.pass).map(x => `${x.check}${x.detail ? `（${x.detail}）` : ''}`).join('；')}`),
  ].join('\n');
  writeFileSync(`${base}.json`, JSON.stringify({ suite, version: pkg.version, runs: results }, null, 2));
  writeFileSync(`${base}.md`, md + '\n');
  console.log('\n' + rows.join('\n'));
  console.log(`\n${ok ? '合格' : '不合格'}／費用 $${cost.toFixed(3)}／結果：${base}.md`);
  process.exit(ok ? 0 : 1);
}

// Stand-in for `claude -p`, so the behavior-eval plumbing can be tested without a login or any usage.
// It does what a well-behaved AI would do mechanically: posts the prompt to the plugin's hook (if any), calls the
// first MCP server's get_context (or propose_decision when asked to record), and answers with what it got back.
// Judge prompts (they contain "# 確認事項") get "pass" for every statement.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const argv = process.argv.slice(2);
const arg = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const prompt = arg('-p') ?? '';
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

if (prompt.includes('# 確認事項')) {
  const n = (prompt.split('# 確認事項')[1].split('# 回答')[0].match(/^\d+\./gm) ?? []).length;
  out({ type: 'result', result: JSON.stringify(Array.from({ length: n }, (_, i) => ({ i: i + 1, pass: true, reason: 'fake' }))), total_cost_usd: 0 });
  process.exit(0);
}

let injected = '';
const pluginDir = arg('--plugin-dir');
if (pluginDir) {
  const hooks = JSON.parse(readFileSync(join(pluginDir, 'hooks', 'hooks.json'), 'utf8'));
  const url = hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.url;
  if (url) {
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, hook_event_name: 'UserPromptSubmit' }) });
    const j: any = await r.json().catch(() => ({}));
    injected = j?.hookSpecificOutput?.additionalContext ?? '';
  }
}

out({ type: 'system', subtype: 'init', model: 'fake-model', mcp_servers: [] });
let answer = injected;
const cfgPath = arg('--mcp-config');
const servers = cfgPath ? JSON.parse(readFileSync(cfgPath, 'utf8')).mcpServers : {};
const ours = servers['shared-second-brain'];
const wantsRecord = /記録して|候補/.test(prompt);
if (ours && (!injected || wantsRecord)) {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
  const { StdioClientTransport } = await import('@modelcontextprotocol/sdk/client/stdio.js');
  const c = new Client({ name: 'fake-claude', version: '0' });
  await c.connect(new StdioClientTransport({ command: ours.command, args: ours.args, env: { ...process.env, ...ours.env } as Record<string, string> }));
  const tools = (await c.listTools()).tools.map(t => t.name);
  const record = wantsRecord && tools.includes('propose_decision');
  const name = record ? 'propose_decision' : tools.includes('get_context') ? 'get_context' : 'search_documents';
  const input = record
    ? { project: 'A社', label: '提案価格', amount_yen: 130000, period: 'monthly', tax: 'excluded' }
    : name === 'get_context' ? { request: prompt } : { query: prompt };
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__shared-second-brain__${name}`, input }] } });
  const r: any = await c.callTool({ name, arguments: input });
  answer = r.content?.[0]?.text ?? '';
  await c.close();
}
out({ type: 'result', result: answer || '（回答なし）', total_cost_usd: 0 });

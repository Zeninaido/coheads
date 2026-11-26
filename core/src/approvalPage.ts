// A small approval page on this computer (http://127.0.0.1:4319), started by the MCP server.
// People approve or reject candidates here; the AI can only propose them. No terminal needed.
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { logAccess } from './audit';
import { buildContextPack } from './contextPack';
import { approve, reject } from './ledger';
import { renderCopyText } from './renderers/copyText';
import type { Classification } from './types';
import { can } from './permissions';
import { formatValue } from './normalize';
import { FOLDER, folderProjectIds, withStore } from './runtime';
import { recordAndApply } from './sharedLedger';

export const APPROVAL_PORT = Number(process.env.SB_APPROVAL_PORT ?? 4319);
export const APPROVAL_URL = `http://127.0.0.1:${APPROVAL_PORT}/`;
const TOKEN = randomBytes(16).toString('hex'); // forms carry it, so other web pages cannot post here

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

async function page(user: string, message?: string): Promise<string> {
  const rows = await withStore(async db => {
    const cands = await db.query<any>(
      `select d.id, d.label, d.value, d.valid_from::text as valid_from, d.recorded_at, d.recorded_by, d.sources, p.name as project, d.project_id
       from decisions d join projects p on p.id = d.project_id where d.status = 'candidate' order by d.recorded_at`);
    const out = [];
    for (const c of cands) out.push({ ...c, mine: await can(db, user, 'approver', c.project_id) });
    return out;
  });
  const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
  const items = rows.map(r => {
    const value = parse(r.value);
    const shown = value.type === 'money' ? formatValue(value) : value.text ?? JSON.stringify(value);
    const by = parse(r.recorded_by)?.id ?? '';
    const src = (parse(r.sources) ?? []).map((s: any) => s.title ?? s.uri).join('、');
    const buttons = r.mine
      ? `<form method="post" action="/decide"><input type="hidden" name="t" value="${TOKEN}"><input type="hidden" name="id" value="${esc(r.id)}">
         <button name="do" value="approve">承認する</button> <button name="do" value="reject" class="sub">却下する</button></form>`
      : '<p class="note">承認できるのは、承認者に登録された人だけです。</p>';
    return `<li><div class="t">${esc(r.project)}：${esc(r.label)} → <b>${esc(shown)}</b></div>
      <div class="m">適用開始：${esc(r.valid_from ?? '承認した日')}／候補を出した人：${esc(by)}${src ? `／根拠：${esc(src)}` : ''}</div>${buttons}</li>`;
  }).join('');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><title>承認待ちの決定（Coheads）</title>
<style>body{font-family:system-ui,sans-serif;max-width:720px;margin:32px auto;padding:0 16px;color:#222}
h1{font-size:20px}li{list-style:none;border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:10px 0}
.t{font-size:16px}.m{color:#666;font-size:13px;margin:4px 0 8px}button{font-size:14px;padding:6px 14px;border-radius:6px;border:1px solid #2a6;background:#2a6;color:#fff;cursor:pointer}
button.sub{background:#fff;color:#a33;border-color:#a33}.msg{background:#eef7ee;padding:8px 12px;border-radius:6px}.note{color:#888;font-size:13px}</style>
<h1>承認待ちの決定</h1><p class="m">あなた：${esc(user)}${FOLDER ? `／フォルダ：${esc(FOLDER)}` : '／デモ'}</p>
${message ? `<p class="msg">${esc(message)}</p>` : ''}
${items ? `<ul style="padding:0">${items}</ul>` : '<p>承認待ちの決定はありません。</p>'}
<p class="note">承認すると、その決定が「現行」になり、同じ論点の古い決定は失効します。${FOLDER ? 'チームの共有フォルダにも記録され、ほかのメンバーのCoheadsにも反映されます。' : ''}</p></html>`;
}

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
}
async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readBody(req));
}

/**
 * Injection for the plugin's UserPromptSubmit hook (Claude Code, Cowork). Claude Code posts the event JSON here
 * before the AI sees the prompt. When the prompt names a registered client, alias or contact, the reply carries
 * the Context Pack as additionalContext, so the decisions reach the AI without it having to decide to call a tool.
 * Only confident matches (names, aliases, contacts) inject; document search does not, to keep noise out.
 */
async function hookContext(user: string, prompt: string): Promise<string | undefined> {
  const destination = { id: 'hook', ceiling: (process.env.SB_CEILING ?? 'confidential') as Classification };
  return withStore(async (db, folder) => {
    const pack = await buildContextPack(db, [folder], { userId: user, query: prompt, destination, matchBySearch: false });
    await logAccess(db, {
      userId: user, destination: destination.id, tool: 'hook_prompt', request: { prompt: prompt.slice(0, 500) }, projectId: pack.project?.id,
      returned: pack.project ? { current: pack.current.map(d => d.id), documents: pack.documents.map(d => d.source.uri) } : {},
    });
    if (process.env.SB_HOOK_LOG) appendFileSync(process.env.SB_HOOK_LOG, `${new Date().toISOString()}\t${pack.project?.id ?? '-'}\n`);
    if (!pack.project) return undefined;
    return 'この依頼に関係する、このチームで承認された決定と資料です（チームの承認記録より）。\n\n' + renderCopyText(pack);
  });
}

async function decide(user: string, id: string, action: string): Promise<string> {
  return withStore(async db => {
    const [d] = await db.query<any>('select label from decisions where id = $1', [id]);
    if (!d) return 'その候補は見つかりませんでした。';
    const at = new Date();
    if (FOLDER) {
      const ev = action === 'approve'
        ? { v: 1 as const, type: 'approved' as const, at: at.toISOString(), by: user, decisionId: id }
        : { v: 1 as const, type: 'rejected' as const, at: at.toISOString(), by: user, decisionId: id };
      await recordAndApply(db, FOLDER, ev, folderProjectIds());
    } else if (action === 'approve') await approve(db, id, user, at);
    else await reject(db, id, user, undefined, at);
    return `「${d.label}」を${action === 'approve' ? '承認' : '却下'}しました。`;
  });
}

/** Start the page. If the port is taken (e.g. another Claude window), the AI side keeps working without it. */
export function startApprovalPage(user: string, onError: (e: unknown) => void): boolean {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      if (req.method === 'POST' && req.url === '/hook/prompt') {
        // Browsers always send Origin on cross-site requests; the hook client does not. Refuse anything from a page.
        if (req.headers.origin || !String(req.headers['content-type'] ?? '').includes('application/json')) { res.writeHead(403).end(); return; }
        let ctx: string | undefined;
        try { ctx = await hookContext(user, String(JSON.parse(await readBody(req)).prompt ?? '')); } catch (e) { onError(e); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(ctx ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.slice(0, 9500) } }) : '{}');
        return;
      }
      if (req.method === 'POST' && req.url === '/decide') {
        const f = await readForm(req);
        const sameOrigin = !req.headers.origin || req.headers.origin === APPROVAL_URL.slice(0, -1);
        if (f.get('t') !== TOKEN || !sameOrigin) { res.writeHead(403).end('forbidden'); return; }
        let msg: string;
        try { msg = await decide(user, f.get('id') ?? '', f.get('do') ?? ''); } catch (e) { msg = `できませんでした：${(e as Error).message}`; }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await page(user, msg));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(await page(user));
    } catch (e) {
      onError(e);
      res.writeHead(500).end('error');
    }
  });
  server.on('error', () => { /* port in use: no page from this process */ });
  server.listen(APPROVAL_PORT, '127.0.0.1');
  server.unref();
  return true;
}

// A small approval page on this computer (http://127.0.0.1:4319), started by the MCP server. No terminal needed.
// Tabs: candidates to approve, who may approve, text to paste into other AIs, what reached the AI, how to stop.
// People approve or reject candidates here; the AI can only propose them. Nothing here names the tools or the
// product (only the browser tab title does), so the page reads as "the team's records".
import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { logAccess } from './audit';
import { buildContextPack } from './contextPack';
import type { Db } from './db';
import { approve, reject } from './ledger';
import { renderCopyText } from './renderers/copyText';
import type { Classification } from './types';
import { allowedProjectIds, can } from './permissions';
import { formatValue } from './normalize';
import { BASE_DATA_DIR, clearLocalData, FOLDER, folderProjectIds, newerTeamMembers, updateCaution, updateNotice, VERSION, withStore } from './runtime';
import { cleanName, memberVersions, recordAndApply, teamState } from './sharedLedger';

export const APPROVAL_PORT = Number(process.env.SB_APPROVAL_PORT ?? 4319);
export const APPROVAL_URL = `http://127.0.0.1:${APPROVAL_PORT}/`;
const TOKEN = randomBytes(16).toString('hex'); // forms carry it, so other web pages cannot post here
const HOSTS = [`127.0.0.1:${APPROVAL_PORT}`, `localhost:${APPROVAL_PORT}`];
// Same ceiling as the Claude side, so people on other AIs get the same content (acceptance S18).
const COPY_DESTINATION = { id: 'copy', ceiling: (process.env.SB_CEILING ?? 'confidential') as Classification };

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const parse = (v: any) => (typeof v === 'string' ? JSON.parse(v) : v);
const when = (iso: string | Date) => new Date(iso).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', year: 'numeric', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const shownValue = (value: any) => (value?.type === 'money' ? formatValue(value) : value?.text ?? JSON.stringify(value));
const tokenField = `<input type="hidden" name="t" value="${TOKEN}">`;

/** Errors from the ledger are for developers; people see what happened and what to do. */
function friendly(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  if (m.includes('not an approver')) return 'できませんでした。承認や、承認する人の変更ができるのは、「承認する人」に載っている人だけです。';
  if (m.includes('empty name')) return '名前を入れてください。';
  if (m.includes('only candidates') || m.includes('cannot approve')) return 'その候補は、すでに承認または却下されています。';
  return `できませんでした：${m}`;
}

const TABS = [
  ['/', '承認待ち'],
  ['/team', '承認する人'],
  ['/copy', 'ほかの AI に貼る'],
  ['/log', 'AI に渡したもの'],
  ['/update', '新しい版'],
  ['/data', 'やめ方とデータ'],
] as const;

function shell(user: string, path: string, body: string, message?: string): string {
  const tab = TABS.find(t => t[0] === path)?.[1] ?? '';
  const nav = TABS.map(([href, label]) => `<a href="${href}"${href === path ? ' class="on"' : ''}>${label}</a>`).join('');
  return `<!doctype html><html lang="ja"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(tab)}（Coheads）</title>
<style>
body{font-family:system-ui,sans-serif;max-width:760px;margin:24px auto;padding:0 16px;color:#222;line-height:1.6}
h1{font-size:20px;margin:16px 0 4px}h2{font-size:16px;margin:24px 0 6px}
nav{display:flex;flex-wrap:wrap;gap:4px;border-bottom:1px solid #ddd}
nav a{padding:6px 12px;color:#356;text-decoration:none;border-radius:6px 6px 0 0}nav a.on{background:#356;color:#fff}
ul.cards{padding:0}ul.cards>li{list-style:none;border:1px solid #ddd;border-radius:8px;padding:12px 14px;margin:10px 0}
.t{font-size:16px}.m{color:#666;font-size:13px;margin:4px 0 8px}
button{font-size:14px;padding:6px 14px;border-radius:6px;border:1px solid #2a6;background:#2a6;color:#fff;cursor:pointer}
button.sub{background:#fff;color:#a33;border-color:#a33}button.danger{background:#a33;border-color:#a33}
.msg{background:#eef7ee;padding:8px 12px;border-radius:6px}.warn{background:#fff6e5;padding:8px 12px;border-radius:6px}
.note{color:#777;font-size:13px}input[type=text],select{font-size:14px;padding:5px 8px;border:1px solid #bbb;border-radius:6px}
table{border-collapse:collapse;width:100%;font-size:13px}td,th{border-bottom:1px solid #eee;padding:6px 4px;text-align:left;vertical-align:top}
textarea{width:100%;height:320px;font-size:13px;font-family:ui-monospace,monospace;box-sizing:border-box}
ol li,ul.plain li{margin:4px 0}
</style>
<nav>${nav}</nav>
<p class="m">あなた：${esc(user)}／${FOLDER ? `資料フォルダ：${esc(FOLDER)}` : 'デモ（架空の取引先 A社・B社）'}</p>
${updateNotice() ? `<p class="warn">${esc(updateNotice())}</p>` : ''}
${message ? `<p class="msg">${esc(message)}</p>` : ''}
${body}</html>`;
}

// ---- 承認待ち ----

async function candidatesView(user: string): Promise<string> {
  const rows = await withStore(async db => {
    const cands = await db.query<any>(
      `select d.id, d.label, d.value, d.valid_from::text as valid_from, d.recorded_at, d.recorded_by, d.sources, p.name as project, d.project_id
       from decisions d join projects p on p.id = d.project_id where d.status = 'candidate' order by d.recorded_at`);
    const out = [];
    for (const c of cands) out.push({ ...c, mine: await can(db, user, 'approver', c.project_id) });
    return out;
  });
  const items = rows.map(r => {
    const by = parse(r.recorded_by)?.id ?? '';
    const src = (parse(r.sources) ?? []).map((s: any) => s.title ?? s.uri).join('、');
    const buttons = r.mine
      ? `<form method="post" action="/decide">${tokenField}<input type="hidden" name="id" value="${esc(r.id)}">
         <button name="do" value="approve">承認する</button> <button name="do" value="reject" class="sub">却下する</button></form>`
      : '<p class="note">承認できるのは、「承認する人」に載っている人だけです。</p>';
    return `<li><div class="t">${esc(r.project)}：${esc(r.label)} → <b>${esc(shownValue(parse(r.value)))}</b></div>
      <div class="m">適用開始：${esc(r.valid_from ?? '承認した日')}／候補を出した人：${esc(by)}${src ? `／根拠：${esc(src)}` : ''}</div>${buttons}</li>`;
  }).join('');
  return `<h1>承認待ちの決定</h1>
${items ? `<ul class="cards">${items}</ul>` : '<p>承認待ちの決定はありません。</p>'}
<p class="note">承認すると、その決定が「現行」になり、同じ論点の古い決定は失効します。${FOLDER ? 'チームの共有フォルダにも記録され、同期されると、ほかのメンバーの AI にも届きます。' : ''}</p>`;
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

// ---- 承認する人 ----

/** Names that appear in the team's records (who proposed, approved or set the list), plus this computer's name. */
async function knownNames(db: Db, user: string, extra: string[]): Promise<string[]> {
  const rows = await db.query<{ n: string }>(
    `select subject_id as n from relation_tuples where relation = 'member' and resource_type = 'project'
     union select by->>'id' from decision_events union select by from shared_approver_changes union select who from shared_approver_changes`);
  return [...new Set([user, ...extra, ...rows.map(r => r.n)])].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ja'));
}

async function teamView(user: string): Promise<string> {
  if (!FOLDER) {
    const approvers = await withStore(async db => (await db.query<{ subject_id: string }>(
      `select distinct subject_id from relation_tuples where relation = 'approver' and resource_type = 'project' order by subject_id`)).map(r => r.subject_id));
    return `<h1>承認する人</h1>
<p>デモで承認できる人：${esc(approvers.join('、'))}</p>
<p class="note">デモでは変えられません。拡張機能の設定で資料フォルダを選ぶと、ここで承認する人を指定できます。</p>`;
  }
  const { approvers, fromFile, changes, known } = await withStore(async db => {
    const st = await teamState(db, FOLDER!);
    return { ...st, known: await knownNames(db, user, st.fromFile) };
  });
  const choices = known.filter(n => !approvers.includes(n));
  const canEdit = !approvers.length || approvers.includes(user);
  const me = (n: string) => (n === user ? '（あなた）' : '');
  const list = approvers.length
    ? `<ul class="plain">${approvers.map(n => `<li>${esc(n)}${me(n)}${canEdit ? ` <form method="post" action="/team" style="display:inline">${tokenField}<input type="hidden" name="name" value="${esc(n)}"><button name="do" value="remove" class="sub">外す</button></form>` : ''}</li>`).join('')}</ul>`
    : '<p>まだ指定されていません。お試しの間は、メンバー全員が承認できます。</p>';
  const pick = choices.length
    ? `<form method="post" action="/team">${tokenField}<input type="hidden" name="do" value="add">
<select name="name" required><option value="">名前を選ぶ</option>${choices.map(n => `<option value="${esc(n)}">${esc(n)}${me(n)}</option>`).join('')}</select> <button>加える</button></form>
<p class="note">チームの記録（候補を出した人、承認した人など）に出てくる名前です。</p>`
    : '';
  const add = canEdit
    ? `<h2>承認する人を加える</h2>${pick}
<details${choices.length ? '' : ' open'}><summary>一覧にない名前を足す</summary>
<form method="post" action="/team">${tokenField}<input type="hidden" name="do" value="add">
<input type="text" name="name" placeholder="名前" required maxlength="40"> <button>加える</button></form>
<p class="note">まだチームの記録に出てこない人を足すときに使います。その人が拡張機能の設定の「あなたの名前」に入れる名前と、同じにしてください。</p></details>
${approvers.length ? '' : `<p class="note">最初の1人を加えると、加えたあなた（${esc(user)}）も一覧に入ります。そこからは、一覧に載っている人だけが、承認と、この一覧の変更をできます。</p>`}`
    : `<p class="note">一覧を変えられるのは、一覧に載っている人だけです。変えたいときは、${esc(approvers.join('、'))}さんに頼んでください。</p>`;
  const history = changes.length
    ? `<table><tr><th>日時</th><th>変えた人</th><th>内容</th></tr>${[...changes].reverse().map(c =>
        `<tr><td>${esc(when(c.at))}</td><td>${esc(c.by)}</td><td>${esc(c.who)} を${c.kind === 'approver_added' ? '加えた' : '外した'}</td></tr>`).join('')}</table>`
    : '<p class="note">まだ変更はありません。</p>';
  return `<h1>承認する人</h1>
${user === 'me' ? '<p class="warn">あなたの名前が「me」のままです。チームで使うときは、拡張機能の設定の「あなたの名前」を、メンバーごとに違う名前にしてください。</p>' : ''}
<h2>いま承認できる人</h2>${list}
${fromFile.length ? `<p class="note">最初の設定で指定されていた人：${esc(fromFile.join('、'))}</p>` : ''}
${add}
<h2>変更の記録</h2>${history}
<p class="note">変更はチームの共有フォルダに記録され、同期されると、ほかのメンバーのパソコンにも反映されます。</p>
<p class="note">名前は、各メンバーが拡張機能の設定で名乗ったものです。この一覧は、チームの約束ごとを画面にしたもので、なりすましを防ぐ仕組みではありません。</p>`;
}

async function changeTeam(user: string, action: string, name: string): Promise<string> {
  if (!FOLDER) return 'デモでは変えられません。';
  const who = cleanName(name);
  if (!who) return '名前を入れてください。';
  const type = action === 'remove' ? 'approver_removed' as const : 'approver_added' as const;
  const wasEmpty = await withStore(async db => {
    const empty = !(await teamState(db, FOLDER!)).approvers.length;
    await recordAndApply(db, FOLDER!, { v: 1, type, at: new Date().toISOString(), by: user, name: who }, folderProjectIds());
    return empty;
  });
  if (type === 'approver_removed') return `${who} さんを承認する人から外しました。`;
  return wasEmpty && who !== user ? `${who} さんと、あなた（${user}）を承認する人に加えました。` : `${who} さんを承認する人に加えました。`;
}

// ---- ほかの AI に貼る ----

const SECRET_CONFIRM = '社外秘の案件です。会社が使ってよいと決めた AI にだけ貼ってください。';

async function copyView(user: string, projectId?: string): Promise<string> {
  const { projects, text, secret } = await withStore(async (db, folder) => {
    const ids = await allowedProjectIds(db, user);
    const projects = await db.query<{ id: string; name: string; default_classification: string }>(
      'select id, name, default_classification from projects where id = any($1::text[]) order by name', [ids]);
    const p = projects.find(x => x.id === projectId);
    if (!p) return { projects, text: undefined, secret: false };
    const pack = await buildContextPack(db, [folder], { userId: user, query: p.name, projectHint: p.id, destination: COPY_DESTINATION, matchBySearch: false });
    await logAccess(db, {
      userId: user, destination: COPY_DESTINATION.id, tool: 'copy_text', request: { project: p.id }, projectId: pack.project?.id,
      returned: { current: pack.current.map(d => d.id), previous: pack.previous.map(d => d.id), documents: pack.documents.map(d => d.source.uri), open: pack.open.map(o => o.topicKey) },
    });
    return { projects, text: renderCopyText(pack), secret: ['confidential', 'restricted'].includes(p.default_classification) };
  });
  const options = projects.map(p => `<option value="${esc(p.id)}"${p.id === projectId ? ' selected' : ''}>${esc(p.name)}</option>`).join('');
  return `<h1>ほかの AI に貼る文面</h1>
<p>ChatGPT や社内の AI など、Claude 以外の AI でも、チームで承認された決定をもとに書いてもらえます。案件を選んで文面をコピーし、その AI のチャットで、依頼の前に貼ってください。</p>
<form method="get" action="/copy"><select name="project">${projects.length ? '<option value="">案件を選ぶ</option>' : ''}${options}</select> <button>文面を作る</button></form>
${text ? `<h2>貼り付け用の文面</h2>
<textarea id="copytext" readonly>${esc(text)}</textarea>
<p><button type="button" onclick="${secret ? `if(!confirm('${SECRET_CONFIRM}'))return;` : ''}var t=document.getElementById('copytext');t.select();(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.reject()).then(function(){document.getElementById('copied').textContent='コピーしました。'},function(){document.execCommand('copy');document.getElementById('copied').textContent='コピーしました。'})">コピーする</button> <span id="copied" class="note"></span></p>
<p class="note">文面は、いま作った時点の内容です。決定が変わったら、作り直してください。社外の AI に貼ってよいかは、会社の決まりに従ってください。</p>` : ''}`;
}

// ---- AI に渡したもの ----

const WHAT: Record<string, string> = {
  get_context: 'AI がチームの決定と資料を確かめた',
  hook_prompt: '依頼に、チームの決定を自動で添えた',
  get_document: 'AI が資料の本文を読んだ',
  search_documents: 'AI が資料を探した',
  propose_decision: 'AI が決定の候補を記録した',
  copy_text: 'ほかの AI に貼る文面を作った',
};

async function logView(): Promise<string> {
  const rows = await withStore(async db => {
    // Prompt-time checks that found no project passed nothing; leaving them out keeps the list to what reached the AI.
    const log = await db.query<any>(
      `select at, tool, request, project_id, returned from access_log
       where tool <> 'server_start' and not (tool = 'hook_prompt' and project_id is null) order by seq desc limit 50`);
    const all = log.map(r => ({ ...r, request: parse(r.request), returned: parse(r.returned) }));
    const ids = all.flatMap(r => [...(r.returned.current ?? []), ...(r.returned.previous ?? [])]);
    const docs = all.flatMap(r => [...(r.returned.documents ?? []), ...(r.returned.document ? [r.returned.document] : [])]).map(u => String(u).replace(/^doc:/, ''));
    const decisions = new Map((await db.query<any>('select id, label, value from decisions where id = any($1::text[])', [ids])).map(d => [d.id, `${d.label}：${shownValue(parse(d.value))}`]));
    const titles = new Map((await db.query<any>('select id, title from documents where id = any($1::text[])', [docs])).map(d => [d.id, d.title]));
    const projects = new Map((await db.query<any>('select id, name from projects')).map(p => [p.id, p.name]));
    return all.map(r => {
      const q = r.request ?? {};
      const asked = q.request ?? q.prompt ?? q.query ?? (q.label ? `候補「${q.label}」` : q.id ? titles.get(String(q.id).replace(/^doc:/, '')) ?? q.id : '');
      const ret = r.returned ?? {};
      const doc = (u: string) => titles.get(String(u).replace(/^doc:/, '')) ?? u;
      const parts = [
        ...(ret.current ?? []).map((id: string) => `現行：${decisions.get(id) ?? id}`),
        ...(ret.previous ?? []).map((id: string) => `失効：${decisions.get(id) ?? id}`),
        ...(ret.open?.length ? [`未確定の事項：${ret.open.length}件`] : []),
        ...(ret.documents ?? []).map((u: string) => `資料：${doc(u)}`),
        ...(ret.document ? [`資料：${doc(ret.document)}`] : []),
      ];
      return { at: r.at, what: WHAT[r.tool] ?? 'その他', asked, project: r.project_id ? projects.get(r.project_id) ?? r.project_id : '', parts };
    });
  });
  const table = rows.length
    ? `<table><tr><th>日時</th><th>できごと</th><th>依頼</th><th>案件</th><th>渡したもの</th></tr>${rows.map(r =>
        `<tr><td>${esc(when(r.at))}</td><td>${esc(r.what)}</td><td>${r.asked ? esc(String(r.asked).slice(0, 120)) : "—"}</td><td>${esc(r.project)}</td><td>${r.parts.length ? r.parts.map(p => esc(p)).join('<br>') : 'なし'}</td></tr>`).join('')}</table>`
    : '<p>まだ記録はありません。</p>';
  return `<h1>最近 AI に渡したもの</h1>
<p>AI に渡したチームの決定と資料の記録です（新しい順に50件まで）。</p>${table}
<p class="note">この記録は、このパソコンの中にだけあります。依頼の前の自動の確認で、関係する案件がなく何も渡さなかったものは、出していません。</p>`;
}

// ---- 新しい版 ----

const RELEASES = 'https://github.com/Zeninaido/coheads/releases/latest';
const LATEST_API = 'https://api.github.com/repos/Zeninaido/coheads/releases/latest';

async function updateView(): Promise<string> {
  const versions = FOLDER ? await withStore(db => memberVersions(db)) : [];
  const newer = newerTeamMembers();
  // Asking GitHub happens only when the button is pressed, from the browser; Coheads itself never calls out.
  const script = `(function(){var mine='${esc(VERSION)}';function cmp(a,b){a=a.split('.').map(Number);b=b.split('.').map(Number);for(var i=0;i<3;i++){if((a[i]||0)!==(b[i]||0))return (a[i]||0)-(b[i]||0);}return 0;}
var out=document.getElementById('latest');out.textContent='確かめています…';
fetch('${LATEST_API}').then(function(r){if(!r.ok)throw new Error(r.status);return r.json();}).then(function(j){var v=String(j.tag_name||'').replace(/^v/,'');
out.textContent=cmp(v,mine)>0?('新しい版 '+v+' があります。下の手順で更新してください。'):('いまの版（'+mine+'）が最新です。');}).catch(function(){out.textContent='確かめられませんでした。インターネットにつながっているかを確かめるか、下の配布のページを開いて、版の番号を見てください。';});})()`;
  return `<h1>新しい版</h1>
<p>この拡張機能の版：<b>${esc(VERSION)}</b></p>
${newer.length ? `<p class="warn">${esc(newer.map(m => `${m.name}さん`).join('、'))}が、新しい版（${esc(newer[0].version)}）を使っています。下の手順で更新してください。</p>` : ''}
<h2>新しい版があるか確かめる</h2>
<p><button type="button" onclick="${esc(script)}">新しい版があるか確かめる</button> <span id="latest" class="note"></span></p>
<p class="note">押したときだけ、配布しているサイト（GitHub）に、いちばん新しい版の番号を問い合わせます。チームの記録や資料は送りません。押さなければ、どこにも問い合わせません。</p>
<h2>更新のしかた</h2>
<ol>
<li><a href="${RELEASES}" target="_blank" rel="noopener">配布のページ</a>から「coheads.mcpb」をダウンロードします。</li>
<li>ダウンロードしたファイルをダブルクリックし、「インストール」を押します。うまくいかないときは、「マイプラグイン」でいまの Coheads をアンインストールしてから、入れ直します。</li>
<li>このページを開き直し、上の行の「資料フォルダ」と「あなた」が前と同じか、このタブの版の番号が新しくなったかを見ます。</li>
</ol>
<p class="note">更新しても、チームの共有フォルダの記録、このパソコンのデータ、資料フォルダと名前の設定は残ります。</p>
${FOLDER ? `<h2>チームのメンバーが使っている版</h2>
${versions.length ? `<table><tr><th>メンバー</th><th>版</th><th>確かめた日時</th></tr>${versions.map(v => `<tr><td>${esc(v.name)}</td><td>${esc(v.version)}</td><td>${esc(when(v.at))}</td></tr>`).join('')}</table>` : '<p class="note">まだ記録はありません。</p>'}
<p class="note">各メンバーの拡張機能が、使っている版を、チームの共有フォルダに1回ずつ記録します。0.4.0 までの版は記録しません。</p>` : ''}`;
}

// ---- やめ方とデータ ----

function dataView(): string {
  return `<h1>やめ方とデータ</h1>
<h2>やめるとき</h2>
<ol>
<li>このパソコンのデータも消す場合は、先に下の「このパソコンのデータを消す」を行ってください（拡張機能を外すと、このページも開けなくなります）。</li>
<li>Claude Desktop の「マイプラグイン」で Coheads を選び、右上の「…」から「アンインストール」を押します。しばらく止めたいだけなら、「無効にする」を選びます。</li>
<li>Cowork や Claude Code にプラグインを入れた場合は、プラグインの一覧から Coheads を外します。</li>
<li>チーム用の Claude プロジェクトに貼った指示文も、消しておいてください。残っていると、AI が「チームの決定を確かめられなかった」と伝えることがあります。</li>
</ol>
<h2>このパソコンのデータ</h2>
<p>保存場所：<code>${esc(BASE_DATA_DIR)}</code></p>
<ul class="plain">
<li>資料の索引（資料フォルダから作ったもの。消しても、資料フォルダからまた作れます）</li>
<li>AI に渡したものの記録（「AI に渡したもの」のタブの中身）</li>
<li>デモのデータ</li>
</ul>
<p><b>消えないもの：</b>資料フォルダの資料${FOLDER ? 'と、チームの共有フォルダにある承認の記録（チームのものとして残り、ほかのメンバーは引き続き使えます）' : ''}。</p>
<h2>このパソコンのデータを消す</h2>
<form method="post" action="/data/clear" onsubmit="return confirm('このパソコンのデータを消します。AI に渡したものの記録も消えます。よろしいですか？')">${tokenField}
<label><input type="checkbox" name="ok" value="1" required> AI に渡したものの記録も消えることを確かめました</label><br><br>
<button class="danger">このパソコンのデータを消す</button></form>
<p class="note">拡張機能を入れたままにすると、次に AI に頼んだときに、資料の索引が作り直されます。</p>`;
}

async function clearData(ok: boolean): Promise<string> {
  if (!ok) return '確認の印を付けてから、消してください。';
  await clearLocalData();
  return 'このパソコンのデータを消しました。やめる場合は、続けて拡張機能を外してください。';
}

// ---- 依頼の前に決定を添える（プラグインのフック） ----

async function readBody(req: IncomingMessage): Promise<string> {
  let body = '';
  for await (const chunk of req) body += chunk;
  return body;
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
    const update = updateCaution();
    if (update) pack.cautions.push(update);
    return 'この依頼に関係する、このチームで承認された決定と資料です（チームの承認記録より）。\n\n' + renderCopyText(pack);
  });
}

// ---- サーバー ----

const html = (res: ServerResponse, body: string) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(body);

/** Start the page. If the port is taken (e.g. another Claude window), the AI side keeps working without it. */
export function startApprovalPage(user: string, onError: (e: unknown) => void): boolean {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      // Only this computer's own address: a web page that points another name at 127.0.0.1 cannot read these pages.
      if (!HOSTS.includes(String(req.headers.host ?? ''))) { res.writeHead(403).end('forbidden'); return; }
      const url = new URL(req.url ?? '/', APPROVAL_URL);
      if (req.method === 'POST' && url.pathname === '/hook/prompt') {
        // Browsers always send Origin on cross-site requests; the hook client does not. Refuse anything from a page.
        if (req.headers.origin || !String(req.headers['content-type'] ?? '').includes('application/json')) { res.writeHead(403).end(); return; }
        let ctx: string | undefined;
        try { ctx = await hookContext(user, String(JSON.parse(await readBody(req)).prompt ?? '')); } catch (e) { onError(e); }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(ctx ? JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: ctx.slice(0, 9500) } }) : '{}');
        return;
      }
      if (req.method === 'POST') {
        const f = new URLSearchParams(await readBody(req));
        const origin = req.headers.origin;
        if (f.get('t') !== TOKEN || (origin && !HOSTS.some(h => origin === `http://${h}`))) { res.writeHead(403).end('forbidden'); return; }
        const act = async (fn: () => Promise<string>) => { try { return await fn(); } catch (e) { return friendly(e); } };
        if (url.pathname === '/decide') {
          const msg = await act(() => decide(user, f.get('id') ?? '', f.get('do') ?? ''));
          return html(res, shell(user, '/', await candidatesView(user), msg));
        }
        if (url.pathname === '/team') {
          const msg = await act(() => changeTeam(user, f.get('do') ?? '', f.get('name') ?? ''));
          return html(res, shell(user, '/team', await teamView(user), msg));
        }
        if (url.pathname === '/data/clear') {
          const msg = await act(() => clearData(f.get('ok') === '1'));
          return html(res, shell(user, '/data', dataView(), msg));
        }
        res.writeHead(404).end();
        return;
      }
      switch (url.pathname) {
        case '/team': return html(res, shell(user, '/team', await teamView(user)));
        case '/copy': return html(res, shell(user, '/copy', await copyView(user, url.searchParams.get('project') ?? undefined)));
        case '/log': return html(res, shell(user, '/log', await logView()));
        case '/update': return html(res, shell(user, '/update', await updateView()));
        case '/data': return html(res, shell(user, '/data', dataView()));
        default: return html(res, shell(user, '/', await candidatesView(user)));
      }
    } catch (e) {
      onError(e);
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' }).end('ページを表示できませんでした。');
    }
  });
  server.on('error', () => { /* port in use: no page from this process */ });
  server.listen(APPROVAL_PORT, '127.0.0.1');
  server.unref();
  return true;
}

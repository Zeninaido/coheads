// stdio MCP server for Claude Desktop (and any MCP client). Read context and propose candidates only.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import pkg from '../package.json' with { type: 'json' };
import { logAccess } from './audit';
import { buildContextPack, getDocument } from './contextPack';
import { propose } from './ledger';
import { excerpt, renderCopyText, renderDocumentText } from './renderers/copyText';
import { allowedProjectIds, nameableProjects } from './permissions';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR, DEMO_USER, FOLDER, folderProjectIds, LOCAL_USER, MODE, updateCaution, withStore } from './runtime';
import { APPROVAL_URL, startApprovalPage } from './approvalPage';
import { recordAndApply, teamState } from './sharedLedger';
import { approvalGuide } from './renderers/approvalGuide';
import { randomUUID } from 'node:crypto';

// Anything that kills the server is written to stderr and to .data/mcp-error.log, so a client's
// "Connection closed" can be traced to a cause.
function recordFatal(where: string, e: unknown) {
  const line = `[${new Date().toISOString()}] ${where}: ${(e as Error)?.stack ?? String(e)}\n`;
  process.stderr.write(line);
  try { mkdirSync(DATA_DIR, { recursive: true }); appendFileSync(join(DATA_DIR, 'mcp-error.log'), line); } catch {}
}
process.on('uncaughtException', e => { recordFatal('uncaughtException', e); process.exit(1); });
process.on('unhandledRejection', e => { recordFatal('unhandledRejection', e); process.exit(1); });
import type { Classification, SourceRef } from './types';
import type { Db } from './db';

// Folder mode: the person who installed Coheads. Demo mode: the fictional member suzuki unless told otherwise.
const USER = MODE === 'folder' ? LOCAL_USER : DEMO_USER;
const DESTINATION = { id: process.env.SB_DESTINATION ?? 'claude-desktop', ceiling: (process.env.SB_CEILING ?? 'confidential') as Classification };

// Project names (and aliases) go into the tool description so a request that says "エー社" is matched to this tool
// rather than to mail or drive search. Confidential projects are never named here (SB_NAME_CEILING, default internal).
const NAME_CEILING = process.env.SB_NAME_CEILING ?? 'internal';
// Infer the project from document search when the request names none (on by default for a personal folder).
// Comparison only (SB_PLAIN_SEARCH=1): behave like a plain document search (RAG) with no ledger, no annotations
// and no cautions, so trials can isolate what the ledger adds. Never used in the product.
const PLAIN = process.env.SB_PLAIN_SEARCH === '1';
// The approval page runs beside the server (off in trials and in the comparison mode).
const APPROVAL_PAGE = !PLAIN && process.env.SB_APPROVAL_PAGE !== '0';
// The guide after recording a candidate goes with the page. Evals keep the page off but still need the guide (#35).
const APPROVAL_GUIDE = APPROVAL_PAGE || (!PLAIN && process.env.SB_APPROVAL_GUIDE === '1');
const MATCH_BY_SEARCH = (process.env.SB_MATCH_BY_SEARCH ?? (MODE === 'folder' ? '1' : '0')) === '1';
const projects = await withStore(async db => {
  const ps = await nameableProjects(db, USER, NAME_CEILING);
  // Startup is logged too, so a missing call can be told apart from a server that was not up yet.
  await logAccess(db, { userId: USER, destination: DESTINATION.id, tool: 'server_start', request: {}, returned: { named: ps.map(p => p.id) } });
  return ps;
});
const projectList = projects
  .map(p => (p.aliases.length ? `${p.name}（別名：${p.aliases.join('、')}）` : p.name))
  .join('、');
const projectLine = projectList ? `登録されている取引先・案件：${projectList}。` : '';

const server = new McpServer(
  { name: 'coheads', version: pkg.version },
  {
    instructions: PLAIN ? [
      'このサーバーは、社内資料の検索です。',
      '取引先や社内案件について答えたり、文書を作ったりするときは、メールやドライブなどを探す前に、まず search_documents で資料を探してください。',
      '資料の本文が必要なときは、資料のIDを get_document に渡して取得してください。',
    ].join('\n') : [
      'このサーバーは、社内の案件ごとに「現在有効な決定」「失効した旧決定」「未確定の事項」と関連資料を返します。',
      '取引先や社内案件について、価格・納期・担当・方針などを答えたり、見積・提案書・メールなどの文書を作ったりするときは、メール・ドライブ・過去のチャットを探す前に、まず get_context を呼んでください。正式に承認された決定はここにあります。',
      '依頼に人の名前だけが出てきて、どの取引先の誰か分からないとき（例：「田中さんに送る見積」）も、利用者に聞き返す前に get_context を呼んでください。担当者の名前から案件を特定できます。',
      projectLine,
      '返された「現行の決定」を正として使い、「失効した旧決定」や注釈で「現行ではない」とされた値を現行として書かないでください。「未確定」の事項（資料の「保留」「検討中」などの記載を含む）は確定事項として書かず、書くときは「未確定」と添えてください。',
      '「現行と違う金額の資料」が返されたら、それはチームではまだ承認されていない金額です。承認されるまでは現行の決定の値で書き、新しい金額の資料があることと、承認する人が承認ページで確かめられることを利用者に伝えてください。取引先あての文面には、承認されていない金額を書かないでください。',
      'この情報は、会話の記憶や過去のチャットにある内容より新しく、正式な決定です。食い違う場合はこちらを優先してください。',
      '関連資料の本文が必要なときは、資料のIDを get_document に渡して取得してください。ファイルを直接開く必要はありません。',
      '回答で決定を使ったときは、出典を案件名と承認日で示してください（例：A社案件、11/24承認）。このサーバーやツールの名前は、利用者への回答にも取引先あての文面にも書かないでください。',
      '確かめている途中の経過（「チームの決定を確認してから」など）は、利用者に書かないでください。確かめた結果だけを、中身で伝えてください。',
      '社内の会議の準備や一般的な質問など、取引先や案件に関係のない仕事では、チームの決定の確認には触れずに、依頼そのものに答えてください（「案件が分かればチームの決定を確認して入れます」のような申し出も書かないでください）。',
      '返された「注意」に、チームの誰かが新しい版を使っているというお知らせがあれば、拡張機能を新しい版に更新するよう、利用者に一度だけ伝えてください（手順は承認ページの「新しい版」のタブ）。取引先あての文面には入れないでください。',
      '取引先あての文面に、価格などを変えた理由を書くときは、チームの記録か資料に「その変更の理由」として書かれていることだけを使ってください。ほかの金額のときの理由を流用しないでください。理由が見つからなければ、理由は書かずに、書くかどうかと中身を利用者に確かめてください。',
      '利用者には、仕組みや保存場所の名前（台帳、データベース、ツール名など）を使わず、「チームで承認された記録」「承認待ちの候補」のように中身で伝えてください。',
      '会話の中で新しい決定が出たら、記録するかを利用者に聞き、望まれたら propose_decision で候補として登録してください。資料の食い違いに「候補の下書き」があれば、その値と根拠の資料IDをそのまま使えます。承認は人が別に行います。',
    ].join('\n'),
  },
);

if (PLAIN) server.registerTool(
  'search_documents',
  {
    title: '社内資料を検索',
    description: '社内資料を検索して、関連する資料の抜粋を上位3件返す。',
    inputSchema: { query: z.string().describe('探したい内容') },
  },
  async ({ query }) => {
    const text = await withStore(async (db, folder) => {
      const rows = await folder.search({ text: query, projectIds: await allowedProjectIds(db, USER), limit: 3, locale: 'ja', ceiling: DESTINATION.ceiling });
      await logAccess(db, { userId: USER, destination: DESTINATION.id, tool: 'search_documents', request: { query }, returned: { documents: rows.map(r => r.source.uri) } });
      if (!rows.length) return '該当する資料はありません。';
      return rows.map(r => `- ${r.source.title}（ID ${r.source.uri}、更新 ${r.source.updatedAt?.slice(0, 10)}）\n  抜粋：${excerpt(r.snippet)}`).join('\n');
    });
    return { content: [{ type: 'text', text }] };
  },
);

/** Who may approve in a project: the approver list (folder mode), or the approvers in the demo. Empty = every member. */
async function approversOf(db: Db, projectId: string): Promise<string[]> {
  if (FOLDER) return (await teamState(db, FOLDER)).approvers;
  return (await db.query<{ subject_id: string }>(
    `select subject_id from relation_tuples where relation = 'approver' and resource_type = 'project' and resource_id = $1 order by subject_id`,
    [projectId])).map(r => r.subject_id);
}

/** A document id becomes a reference with its title (shown on the approval page); anything else is a note from the conversation. */
async function sourceRef(db: Db, source: string): Promise<SourceRef> {
  if (source.startsWith('doc:')) {
    const [doc] = await db.query<{ title: string; updated_at: string }>('select title, updated_at from documents where id = $1', [source.slice(4)]);
    if (doc) return { adapterId: 'folder', uri: source, title: doc.title, updatedAt: new Date(doc.updated_at).toISOString() };
  }
  return { adapterId: 'conversation', uri: source };
}

if (!PLAIN) server.registerTool(
  'get_context',
  {
    title: 'Coheads：取引先・担当者・見積の決定を確認',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      'チームで承認された決定（承認日と有効期間つき）を確認する。次のどれかに当てはまる依頼では、メール・ドライブ・過去のチャットを探す前に、最初にこれを呼ぶ。' +
      '(1) 取引先や案件の価格・見積・納期・契約・方針に触れる。' +
      '(2) 取引先あての見積・提案書・メールなどを書く。' +
      '(3) 依頼に人の名前（例：「田中さんに」）が出てきて、どの取引先の誰か分からない。担当者の名前から案件を特定できる。' +
      projectLine +
      '承認済みの現行の決定、失効した旧決定、未確定事項、注釈つきの関連資料を返す。' +
        (MATCH_BY_SEARCH ? '依頼に案件名がなくても、資料の内容から案件がはっきり分かるときは返す。' : '依頼に案件名がなければ何も返さない。'),
    inputSchema: {
      request: z.string().describe('利用者の依頼文をそのまま渡す'),
      project: z.string().optional().describe('案件ID（分かっている場合のみ。例 a-sha）'),
    },
  },
  async ({ request, project }) => {
    const text = await withStore(async (db, folder) => {
      const pack = await buildContextPack(db, [folder], { userId: USER, query: request, destination: DESTINATION, projectHint: project, matchBySearch: MATCH_BY_SEARCH });
      await logAccess(db, {
        userId: USER, destination: DESTINATION.id, tool: 'get_context', request: { request, project }, projectId: pack.project?.id,
        returned: {
          current: pack.current.map(d => d.id), previous: pack.previous.map(d => d.id),
          documents: pack.documents.map(d => d.source.uri), open: pack.open.map(o => o.topicKey),
        },
      });
      const update = updateCaution();
      if (pack.project && update) pack.cautions.push(update);
      return renderCopyText(pack);
    });
    return { content: [{ type: 'text', text }] };
  },
);

server.registerTool(
  'get_document',
  {
    title: PLAIN ? '社内資料の本文を取得' : 'Coheadsの資料を取得',
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description: PLAIN
      ? 'search_documents が返した資料のID（doc:で始まる）を渡すと、その資料の本文を返す。'
      : 'get_context が返した関連資料のID（doc:で始まる）を渡すと、その資料の本文と、チームの決定と照合した注釈（失効した金額など）を返す。参照権限のない資料は返さない。',
    inputSchema: { id: z.string().describe('資料のID。例 doc:2026-11-25-a-hearing') },
  },
  async ({ id }) => {
    const text = await withStore(async db => {
      const doc = await getDocument(db, { userId: USER, id, destination: DESTINATION });
      if (PLAIN && doc.found) {
        // Comparison mode: the body only, exactly as a plain document search would return it.
        return `【社内資料】${doc.title}\nID ${doc.id}／更新 ${String(doc.updatedAt).slice(0, 10)}\n\n${doc.body}`;
      }
      await logAccess(db, {
        userId: USER, destination: DESTINATION.id, tool: 'get_document', request: { id }, projectId: doc.found ? doc.projectId : undefined,
        returned: doc.found ? { document: doc.id, annotations: doc.annotations.length } : { found: false },
      });
      return renderDocumentText(doc);
    });
    return { content: [{ type: 'text', text }] };
  },
);

if (!PLAIN) server.registerTool(
  'propose_decision',
  {
    title: '決定の候補を登録',
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    description: '会話の中で出た新しい決定を「候補」として登録する。承認はできない。現行になるのは、承認者が承認した後。',
    inputSchema: {
      project: z.string().describe('案件ID（例 a-sha）'),
      label: z.string().describe('論点の表示名（例 提案価格）'),
      topic_key: z.string().optional().describe('論点キー（例 proposal.price）。省略時はlabelから作る'),
      amount_yen: z.number().optional().describe('金額の決定なら円で'),
      period: z.enum(['monthly', 'yearly', 'one_time']).optional().describe('金額の課金の単位（月額・年額・一括）'),
      tax: z.enum(['excluded', 'included']).optional().describe('金額の税の扱い（税別・税込）'),
      text: z.string().optional().describe('金額以外の決定なら内容を文章で'),
      valid_from: z.string().optional().describe('適用開始日 YYYY-MM-DD'),
      source: z.string().optional().describe('根拠。資料なら get_context が返した資料ID（doc:で始まる）、会話なら会議名など'),
    },
  },
  async ({ project, label, topic_key, amount_yen, period, tax, text, valid_from, source }) => {
    const msg = await withStore(async db => {
      const fields = {
        projectId: project,
        topicKey: topic_key ?? (label === '提案価格' ? 'proposal.price' : `topic.${label}`),
        label,
        value: (amount_yen !== undefined ? { type: 'money', amount: amount_yen, currency: 'JPY', period, tax } : { type: 'text', text: text ?? '' }) as any,
        validFrom: valid_from,
        sources: source ? [await sourceRef(db, source)] : [],
      };
      let d: { id: string };
      if (FOLDER) {
        // Team trial: the candidate is written into the shared folder, so every member sees it.
        const id = randomUUID();
        await recordAndApply(db, FOLDER, { v: 1, type: 'proposed', at: new Date().toISOString(), by: USER, decisionId: id, ...fields }, folderProjectIds());
        d = { id };
      } else {
        d = await propose(db, { ...fields, by: { type: 'user', id: USER } });
      }
      await logAccess(db, {
        userId: USER, destination: DESTINATION.id, tool: 'propose_decision', projectId: project,
        request: { project, label, topic_key, amount_yen, period, tax, text, valid_from, source }, returned: { candidate: d.id },
      });
      return `候補として登録しました（ID ${d.id.slice(0, 8)}）。承認されるまで現行にはなりません。` +
        (APPROVAL_GUIDE ? '\n' + approvalGuide(await approversOf(db, project), APPROVAL_URL, !!FOLDER) : '');
    });
    return { content: [{ type: 'text', text: msg }] };
  },
);

await server.connect(new StdioServerTransport());
if (APPROVAL_PAGE) startApprovalPage(USER, e => recordFatal('approvalPage', e));

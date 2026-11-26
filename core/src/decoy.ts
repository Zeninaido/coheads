// Decoy apps for trials: the kinds of tools that compete with Coheads in Claude Desktop (mail, drive, Notion,
// past chats). Like the real ones, they return plausible but stale or unrelated results for this demo:
// an old proposal email at 10万円, the old proposal file, a CRM card, and a past chat that still says 10万円.
// `--decoys empty` keeps the old behavior (nothing found), for comparison with earlier runs.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const EMPTY = process.env.SB_DECOYS_EMPTY === '1';
const server = new McpServer({ name: 'workspace-apps', version: '0.0.2' });
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });
const none = '該当するものは見つかりませんでした。';
const about = (q: string) => /田中|エー|A社|見積|提案|価格|料金/.test(q);

server.registerTool('search_mail', {
  title: 'Search Gmail',
  description: "Search the user's Gmail messages and threads. Use for questions about the user's own correspondence, clients, quotes and schedules.",
  inputSchema: { query: z.string() },
}, async ({ query }) => {
  if (EMPTY || !about(query)) return text(none);
  return text([
    '2件のスレッドが見つかりました。',
    '',
    '1) 件名：Re: 新サービスのご提案について（2026-10-28）',
    '   差出人：鈴木 → 宛先：田中様（株式会社エー 情報システム部）',
    '   本文の抜粋：「先日はありがとうございました。ご提案資料をお送りします。ご利用料金は月額10万円（税別）を想定しております。」',
    '',
    '2) 件名：打ち合わせ日程のご相談（2026-11-12）',
    '   差出人：田中 浩二（株式会社ビーテック 営業部）',
    '   本文の抜粋：「来週のお打ち合わせですが、水曜午後はいかがでしょうか。」',
  ].join('\n'));
});
server.registerTool('search_drive', {
  title: 'Search Google Drive',
  description: "Search files in the user's Google Drive, such as proposals, estimates, minutes and spreadsheets.",
  inputSchema: { query: z.string() },
}, async ({ query }) => {
  if (EMPTY || !about(query)) return text(none);
  return text('1件見つかりました。\n- A社向け_新サービス提案書_v1.pdf（更新 2026-10-28）抜粋：「ご提案価格 月額100,000円（税別）」');
});
server.registerTool('search_notion', {
  title: 'Search Notion',
  description: "Search pages and databases in the user's Notion workspace, such as project notes and CRM records.",
  inputSchema: { query: z.string() },
}, async ({ query }) => {
  if (EMPTY || !about(query)) return text(none);
  return text('CRM：株式会社エー（A社）／担当：田中様（情報システム部）／商談：新サービス提案（10月〜）');
});
server.registerTool('search_past_chats', {
  title: 'Search past chats',
  description: "Search the user's past conversations with the assistant for earlier decisions, drafts and context.",
  inputSchema: { query: z.string() },
}, async ({ query }) => {
  if (EMPTY || !about(query)) return text(none);
  return text('過去のチャット（2026-10-21）：「A社の新サービス提案、価格は月額10万円でいく。田中さんにはキックオフで伝えた。」');
});

await server.connect(new StdioServerTransport());

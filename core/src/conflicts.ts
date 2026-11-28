// When the ledger has no approved amount yet, documents may still disagree (an old proposal at 100,000円, a later
// approval memo at 120,000円). Point that out, with each document's date and what it says about the amount, so the AI
// does not pick one silently. This works from day one, before anyone has recorded a decision.
import type { Db } from './db';
import { moneyAmounts, normalize } from './normalize';
import { CLASSIFICATION_ORDER, type Classification, type Decision, type OpenItem } from './types';

export type MentionSignal = 'decided' | 'undecided' | 'old';
export interface MoneyMention { amount: number; docId: string; title: string; updatedAt: string; line: string; signal?: MentionSignal }
export interface MoneyConflict {
  label: string; // what the amounts are about (v0: prices and quotes)
  values: { amount: number; mentions: MoneyMention[] }[];
  latest: MoneyMention; // the newest document that states an amount
  /** When the newest statement says the amount was decided, a ready-made candidate the user can record with one yes. */
  draft?: CandidateDraft;
}
export interface CandidateDraft {
  projectId: string;
  label: string;
  amount: number;
  period?: 'monthly' | 'yearly' | 'one_time';
  tax?: 'excluded' | 'included';
  validFrom?: string; // YYYY-MM-DD
  sourceDocId: string; // doc:...
  sourceTitle: string;
  approverInDoc?: string; // what the document says about who approved; a record, not an approval
}

const PRICE = /価格|料金|見積|月額|年額|費用|単価|プラン|金額/;
// Order matters: "承認が必要" is undecided even though it contains 承認.
const UNDECIDED = /未承認|承認が必要|承認待ち|結論を出していない|結論は出て|保留|検討|意見|案が出|案として|という案|（案）|\(案\)|候補|仮/;
const OLD = /旧|以前|従来|改定前|変更前/;
const DECIDED = /承認|決定|確定|改定する|合意/;

function signalOf(line: string): MentionSignal | undefined {
  if (UNDECIDED.test(line)) return 'undecided';
  if (OLD.test(line)) return 'old';
  if (DECIDED.test(line)) return 'decided';
  return undefined;
}

/** Amount mentions in a document: lines that state a yen amount and talk about a price (or sit under a price heading). */
export function moneyMentions(doc: { id: string; title: string; updated_at: string; body: string }, aliases: Record<string, string>): MoneyMention[] {
  const lines = doc.body.split('\n');
  const out: MoneyMention[] = [];
  lines.forEach((raw, i) => {
    const line = raw.trim();
    const amounts = moneyAmounts(normalize(line, aliases));
    if (!amounts.length) return;
    if (!PRICE.test(line) && !PRICE.test(lines[i - 1] ?? '')) return;
    for (const amount of amounts) {
      out.push({ amount, docId: `doc:${doc.id}`, title: doc.title, updatedAt: new Date(doc.updated_at).toISOString().slice(0, 10), line: line.replace(/^[-#*\s]+/, ''), signal: signalOf(line) });
    }
  });
  return out;
}

type DocRow = { id: string; title: string; updated_at: string; body: string };
/** A project's documents within the destination's ceiling, newest first. */
async function projectDocs(db: Db, projectId: string, ceiling: Classification): Promise<DocRow[]> {
  const allowed = CLASSIFICATION_ORDER.slice(0, CLASSIFICATION_ORDER.indexOf(ceiling) + 1);
  return db.query<DocRow>(
    `select id, title, updated_at, body from documents where project_id = $1 and classification = any($2::text[]) order by updated_at desc limit 500`,
    [projectId, allowed]);
}

/** Disagreeing amounts across a project's documents (within the destination's ceiling). Undefined when they agree. */
export async function findMoneyConflict(db: Db, projectId: string, ceiling: Classification, aliases: Record<string, string>): Promise<MoneyConflict | undefined> {
  const docs = await projectDocs(db, projectId, ceiling);
  const mentions = docs.flatMap(d => moneyMentions(d, aliases));
  const byAmount = new Map<number, MoneyMention[]>();
  for (const m of mentions) byAmount.set(m.amount, [...(byAmount.get(m.amount) ?? []), m]);
  if (byAmount.size < 2) return undefined;
  const latestOf = (ms: MoneyMention[]) => ms.reduce((a, b) => (b.updatedAt > a.updatedAt ? b : a));
  const values = [...byAmount.entries()]
    .map(([amount, ms]) => ({ amount, mentions: ms.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)) }))
    .sort((a, b) => latestOf(b.mentions).updatedAt.localeCompare(latestOf(a.mentions).updatedAt));
  // The newest statement, preferring one that is not about an old value.
  const fresh = mentions.filter(m => m.signal !== 'old');
  const latest = latestOf(fresh.length ? fresh : mentions);
  const source = latest.signal === 'decided' ? docs.find(d => `doc:${d.id}` === latest.docId) : undefined;
  return { label: '金額（価格・見積）', values, latest, draft: source ? candidateDraft(projectId, latest, source.body) : undefined };
}

const pad = (n: string) => n.padStart(2, '0');
/** Fields for a candidate, read from the deciding line and the rest of its document. Missing fields stay empty. */
export function candidateDraft(projectId: string, m: MoneyMention, body: string): CandidateDraft {
  const ctx = `${m.line}\n${body}`;
  const period = /月額|月々|毎月/.test(m.line) ? 'monthly' : /年額|年間/.test(m.line) ? 'yearly' : /一括|初期費用|一時/.test(m.line) ? 'one_time' : undefined;
  const tax = /税別|税抜|外税/.test(m.line) ? 'excluded' : /税込|内税/.test(m.line) ? 'included' : undefined;
  const d = ctx.match(/(?:適用日|適用開始|開始日)[^\d\n]*(\d{4})[年\/-](\d{1,2})[月\/-](\d{1,2})/);
  const approver = body.match(/承認者\s*[:：]\s*(.+)/)?.[1]?.trim();
  return {
    projectId,
    label: /提案価格/.test(m.line) ? '提案価格' : '価格',
    amount: m.amount,
    period, tax,
    validFrom: d ? `${d[1]}-${pad(d[2])}-${pad(d[3])}` : undefined,
    sourceDocId: m.docId,
    sourceTitle: m.title,
    approverInDoc: approver,
  };
}

const SIGNAL_TEXT: Record<MentionSignal, string> = { decided: '決定・承認と書かれている', undecided: '未決・案と書かれている', old: '旧い値として書かれている' };
export const signalText = (s: MentionSignal) => SIGNAL_TEXT[s];
export function describeMention(m: MoneyMention): string {
  return `${m.updatedAt}の「${m.title}」${m.signal ? `（${SIGNAL_TEXT[m.signal]}）` : ''}`;
}

// ---------- O-02 (SC-23): candidates and open items read from documents ----------

/**
 * A newer document states a decided amount, with who approved it, that differs from the team's current one (S20).
 * Nothing is recorded until an approver acts on the approval page; until then the AI keeps writing the current value.
 */
export interface DocCandidate {
  projectId: string;
  topicKey: string;
  current: Decision; // the approved, current decision it would replace
  draft: CandidateDraft; // amount, unit, tax, start day, source document, approver named in it
  line: string; // the deciding line, as written
  docDate: string; // YYYY-MM-DD
}

const localDay = (iso?: string) => (iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: process.env.SB_DISPLAY_TZ ?? 'Asia/Tokyo' }) : '');
const amountOf = (d: Decision) => (d.value.type === 'money' ? d.value.amount : undefined);

/**
 * Candidates from documents (SC-23 2-3): only a line that says the amount was decided, in a document that names who
 * approved it, dated on or after the day the current amount was approved, with an amount the team has not recorded for
 * that topic. A line that says 案・検討・保留 never becomes one. One per topic: the newest.
 */
export async function findDocCandidates(db: Db, projectId: string, ceiling: Classification, aliases: Record<string, string>, decisions: Decision[], current: Decision[]): Promise<DocCandidate[]> {
  const moneyNow = current.filter(d => d.value.type === 'money');
  if (!moneyNow.length) return [];
  const docs = await projectDocs(db, projectId, ceiling);
  const out: DocCandidate[] = [];
  for (const cur of moneyNow) {
    const since = localDay(cur.approvedAt);
    const known = new Set(decisions.filter(d => d.topicKey === cur.topicKey).map(amountOf).filter((a): a is number => a !== undefined));
    // Decided elsewhere with this document as the source (approved, rejected or waiting): already handled.
    const handled = (docId: string, amount: number) => decisions.some(d => amountOf(d) === amount && d.sources.some(s => s.uri === docId));
    const found = docs.flatMap(d => moneyMentions(d, aliases).map(m => ({ m, d })))
      .filter(({ m, d }) => m.signal === 'decided' && !known.has(m.amount) && m.updatedAt >= since && /承認者\s*[:：]/.test(d.body) && !handled(m.docId, m.amount))
      .filter(({ m }) => moneyNow.length === 1 || m.line.includes(cur.label))
      .sort((a, b) => b.m.updatedAt.localeCompare(a.m.updatedAt))[0];
    if (!found) continue;
    const draft = candidateDraft(projectId, found.m, found.d.body);
    out.push({ projectId, topicKey: cur.topicKey, current: cur, draft: { ...draft, label: cur.label }, line: found.m.line, docDate: found.m.updatedAt });
  }
  return out;
}

// What a line says that is not settled (S21). "案" alone is not enough: 提案・案件 contain it.
const OPEN = /保留|検討|未定|確定できない|決まっていない|決まらない|結論を出していない|結論は出ていない|まだ決めていない|（案）|\(案\)|案として|という案|案が出/;
const MONEY_TALK = /価格|料金|見積|月額|年額|費用|単価|金額|値上げ|値下げ|円/;

/**
 * Lines in the project's documents that say something is not settled, with where they are (S21). A money line is left
 * out once it is settled: a line of the same day or later says an amount was decided, the team has recorded one of its
 * amounts, or the team approved that topic (named in the line) on the same day or later. The newest few only.
 */
export async function findOpenLines(db: Db, projectId: string, ceiling: Classification, aliases: Record<string, string>, decisions: Decision[], max = 3): Promise<OpenItem[]> {
  const docs = await projectDocs(db, projectId, ceiling);
  const decidedDays = docs.flatMap(d => moneyMentions(d, aliases)).filter(m => m.signal === 'decided').map(m => m.updatedAt);
  const recordedAmounts = new Set(decisions.map(amountOf).filter((a): a is number => a !== undefined));
  const settled = (line: string, date: string) =>
    decidedDays.some(x => x >= date) ||
    moneyAmounts(normalize(line, aliases)).some(a => recordedAmounts.has(a)) ||
    decisions.some(d => d.value.type === 'money' && d.approvedAt && localDay(d.approvedAt) >= date && line.includes(d.label));
  const out: OpenItem[] = [];
  const seen = new Set<string>();
  for (const d of docs) {
    const date = new Date(d.updated_at).toISOString().slice(0, 10);
    for (const raw of d.body.split('\n')) {
      if (/^\s*#/.test(raw)) continue; // a heading names the document, it does not say anything is open
      const line = raw.trim().replace(/^[-*\s]+/, '');
      if (!line || !OPEN.test(line) || seen.has(line)) continue;
      if (MONEY_TALK.test(line) && settled(line, date)) continue;
      seen.add(line);
      out.push({ projectId, topicKey: `doc.${d.id}`, label: '資料の記載', note: line, source: { docId: `doc:${d.id}`, title: d.title, date, line } });
    }
  }
  return out.slice(0, max);
}

import { randomUUID } from 'node:crypto';
import type { Db } from './db';
import { aliasMap } from './adapters/folder';
import { describeMention, findMoneyConflict, type MoneyConflict } from './conflicts';
import { yen } from './normalize';
import { decisionsFor } from './ledger';
import { formatValue, moneyAmounts, normalize, yen } from './normalize';
import { allowedProjectIds } from './permissions';
import {
  CLASSIFICATION_ORDER, withinCeiling, type Classification,
  type AnnotatedDocument, type Annotation, type ContextPack, type Decision, type DecisionView,
  type DestinationProfile, type OpenItem, type SourceAdapter,
} from './types';

export interface ContextRequest {
  userId: string;
  query: string;
  destination: DestinationProfile;
  projectHint?: string;
  asOf?: string; // ISO date; defaults to today
  docLimit?: number;
  /**
   * Allow the project to be inferred from document search when the request names none.
   * Only a confident, concentrated match counts; otherwise nothing is returned, as before.
   */
  matchBySearch?: boolean;
}

// Search-based matching. Scores are the share of the request's (IDF-weighted) bigrams found in a document,
// so question words keep them low; agreement between hits is a better signal than one absolute score.
// A project is accepted when every relevant hit among the top 3 belongs to it, or when the only relevant
// hit is strong on its own.
const SEARCH_MATCH_RELEVANT = Number(process.env.SB_SEARCH_MATCH_RELEVANT ?? 0.05);
const SEARCH_MATCH_SINGLE = Number(process.env.SB_SEARCH_MATCH_SINGLE ?? 0.25);

function view(d: Decision): DecisionView {
  return { id: d.id, label: d.label, value: d.value, status: d.status, validFrom: d.validFrom, validTo: d.validTo, approvedAt: d.approvedAt, sources: d.sources };
}

function fmtValue(d: Decision): string {
  return formatValue(d.value);
}

/** Calendar date in the display time zone (approval timestamps are stored in UTC). */
function localDate(iso?: string, tz = process.env.SB_DISPLAY_TZ ?? 'Asia/Tokyo') {
  return iso ? new Date(iso).toLocaleDateString('sv-SE', { timeZone: tz }) : undefined;
}

function mmdd(date?: string) {
  if (!date) return '';
  const [, m, d] = date.split('-');
  return `${Number(m)}/${Number(d)}`;
}

/** Approved at some point and not withdrawn: its validity window, not its status, says when it applies. */
function isEffectiveKind(d: Decision) {
  return !!d.approvedAt && (d.status === 'approved' || (d.status === 'retired' && d.retiredReason === 'superseded'));
}

function isCurrent(d: Decision, asOf: string) {
  return isEffectiveKind(d) && (!d.validFrom || d.validFrom <= asOf) && (!d.validTo || d.validTo > asOf);
}

export async function buildContextPack(db: Db, adapters: SourceAdapter[], req: ContextRequest): Promise<ContextPack> {
  const asOf = req.asOf ?? localDate(new Date().toISOString())!;
  const ceiling = req.destination.ceiling;
  const base: ContextPack = {
    schema: 'context-pack/v0',
    requestId: randomUUID(),
    generatedAt: new Date().toISOString(),
    workspaceId: '',
    current: [], previous: [], open: [], documents: [], unavailableSources: [], cautions: [],
    citation: '', ceiling, truncated: false,
  };

  // 1. Permissions first: only projects this user may read are even considered.
  const allowed = await allowedProjectIds(db, req.userId);
  if (allowed.length === 0) return base;

  // 2. Resolve the project from the request (aliases normalized), only among allowed projects.
  const aliases = await aliasMap(db);
  const nq = normalize(req.query, aliases);
  const projects = await db.query<{ id: string; name: string; workspace_id: string; default_classification: string }>(
    'select id, name, workspace_id, default_classification from projects where id = any($1::text[])', [allowed]);
  let project = projects.find(p => p.id === req.projectHint);
  let matchedBy: 'alias' | 'hint' | 'contact' | 'search' = 'hint';
  if (!project) {
    project = projects.find(p => nq.includes(normalize(p.name, aliases)));
    matchedBy = 'alias';
  }
  if (!project) {
    // 3. A contact person named in the request ("田中さん"), among the user's projects only.
    //    Contacts stay on the server: they are never written into the tool description.
    const contacts = await db.query<{ project_id: string; name: string }>(
      'select project_id, name from project_contacts where project_id = any($1::text[])', [allowed]);
    const hits = contacts.filter(c => [...c.name].length >= 2 && nq.includes(normalize(c.name)));
    const ids = [...new Set(hits.map(h => h.project_id))];
    if (ids.length === 1) {
      project = projects.find(p => p.id === ids[0]);
      matchedBy = 'contact';
    } else if (ids.length > 1) {
      const names = projects.filter(p => ids.includes(p.id)).map(p => p.name).join('、');
      const who = [...new Set(hits.map(h => h.name))].join('・');
      base.cautions.push(`「${who}」は複数の案件の関係者です（${names}）。どの案件の話か確認してください`);
      return base;
    }
  }
  if (!project && req.matchBySearch) {
    // 4. Search across the user's projects; accept only a clear winner.
    const hits = (await Promise.all(adapters.map(a =>
      a.search({ text: req.query, projectIds: allowed, limit: 5, locale: 'ja', ceiling }).catch(() => [])))).flat()
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const relevant = hits.filter(h => (h.score ?? 0) >= SEARCH_MATCH_RELEVANT).slice(0, 3);
    const winner = relevant.length === 1
      ? ((relevant[0].score ?? 0) >= SEARCH_MATCH_SINGLE ? relevant[0].projectId : undefined)
      : relevant.length > 1 && relevant.every(h => h.projectId === relevant[0].projectId) ? relevant[0].projectId : undefined;
    if (winner) {
      project = projects.find(p => p.id === winner);
      matchedBy = 'search';
    }
  }
  if (!project) return base; // no project identified: inject nothing
  if (!withinCeiling(project.default_classification as any, ceiling)) {
    base.cautions.push('この案件の情報は、この出力先には渡せない区分です');
    return { ...base, workspaceId: project.workspace_id, project: { id: project.id, name: project.name, matchedBy } };
  }

  // 3. Decisions for the project, filtered by the destination's ceiling.
  const { all, current, currentByTopic, expired, scheduled, candidates } = await decisionState(db, project.id, asOf, ceiling);
  const previous: Decision[] = [];
  for (const d of [...expired].sort((a, b) => (b.validTo ?? '').localeCompare(a.validTo ?? ''))) {
    if (currentByTopic.has(d.topicKey) && !previous.some(p => p.topicKey === d.topicKey)) previous.push(d);
  }

  const open = await db.query<OpenItem>(
    'select project_id as "projectId", topic_key as "topicKey", label, note from open_items where project_id = $1', [project.id]);

  // 4. Documents from every adapter, already scoped to this project and ceiling inside the query.
  const limit = req.docLimit ?? 3;
  const documents: AnnotatedDocument[] = [];
  const unavailable: { adapterId: string; reason: string }[] = [];
  let truncated = false;
  for (const a of adapters) {
    try {
      const rows = await a.search({ text: req.query, projectIds: [project.id], limit: limit + 1, locale: 'ja', ceiling });
      if (rows.length > limit) truncated = true;
      for (const r of rows.slice(0, limit)) {
        documents.push({ source: r.source, snippet: r.snippet, annotations: annotate(normalize(r.snippet, aliases), expired, candidates, currentByTopic) });
      }
    } catch (e) {
      unavailable.push({ adapterId: a.id, reason: String((e as Error).message ?? e) });
    }
  }

  // 5. No approved amount yet: say so when documents disagree about one.
  const hasCurrentMoney = current.some(d => d.value.type === 'money');
  const found = hasCurrentMoney ? undefined : await findMoneyConflict(db, project.id, ceiling, aliases);
  // A money candidate is already waiting for approval: point to it instead of offering another draft.
  const pendingMoney = candidates.find(c => c.value.type === 'money');
  const conflict = found && pendingMoney ? { ...found, draft: undefined } : found;

  // 6. Cautions and the citation line the AI is asked to print.
  const cautions = [
    ...(conflict ? [conflictCaution(conflict, pendingMoney)] : []),
    ...(matchedBy === 'search' ? [`依頼に案件名がなかったため、資料の内容から「${project.name}」の話と判断しました。違う場合は案件名を添えて頼み直してください`] : []),
    ...open.map(o => `${o.label}は未確定。確定事項として書かない`),
    ...candidates.map(c => `${c.label}の${fmtValue(c)}は未承認の候補。現行として扱わない`),
    ...scheduled.map(s => `${s.label}は${s.validFrom}から${fmtValue(s)}に変わる（承認済み・適用前）`),
  ];
  const approvals = [...new Set(current.map(d => mmdd(localDate(d.approvedAt))))].filter(Boolean);
  const citation = current.length
    ? `${project.name}案件（${approvals.join('・')}承認記録）`
    : `${project.name}案件（承認済みの決定なし）`;

  return {
    ...base,
    workspaceId: project.workspace_id,
    project: { id: project.id, name: project.name, matchedBy },
    current: current.map(view),
    previous: previous.map(view),
    open,
    documents,
    unavailableSources: unavailable,
    cautions,
    conflicts: conflict ? [conflict] : [],
    citation,
    truncated,
  };
}

/** Decisions of one project as of a business date, split the way the pack and the annotations need them. */
async function decisionState(db: Db, projectId: string, asOf: string, ceiling: Classification) {
  const all = (await decisionsFor(db, projectId)).filter(d => withinCeiling(d.classification, ceiling));
  const current = all.filter(d => isCurrent(d, asOf));
  const currentByTopic = new Map(current.map(d => [d.topicKey, d]));
  const expired = all.filter(d => isEffectiveKind(d) && d.validTo && d.validTo <= asOf);
  const scheduled = all.filter(d => isEffectiveKind(d) && d.validFrom && d.validFrom > asOf);
  const candidates = all.filter(d => d.status === 'candidate');
  return { all, current, currentByTopic, expired, scheduled, candidates };
}

export interface DocumentRequest {
  userId: string;
  id: string; // "doc:<id>" or "<id>"
  destination: DestinationProfile;
  asOf?: string;
}

export type DocumentResult =
  | { found: false }
  | { found: true; id: string; title: string; project: string; projectId: string; updatedAt: string; body: string; annotations: Annotation[] };

/**
 * Full text of one document, through the same checks as search: the user's projects and the destination's ceiling.
 * Missing and not-allowed look the same, so the answer does not reveal that a document exists.
 */
export async function getDocument(db: Db, req: DocumentRequest): Promise<DocumentResult> {
  const id = req.id.replace(/^doc:/, '');
  const allowed = await allowedProjectIds(db, req.userId);
  const ceiling = req.destination.ceiling;
  const okClasses = CLASSIFICATION_ORDER.slice(0, CLASSIFICATION_ORDER.indexOf(ceiling) + 1);
  const [doc] = await db.query(
    `select d.id, d.title, d.body, d.updated_at, d.project_id, p.name as project_name from documents d join projects p on p.id = d.project_id
     where d.id = $1 and d.project_id = any($2::text[]) and d.classification = any($3::text[])`,
    [id, allowed, okClasses],
  );
  if (!doc) return { found: false };
  const asOf = req.asOf ?? localDate(new Date().toISOString())!;
  const { expired, candidates, currentByTopic } = await decisionState(db, doc.project_id, asOf, ceiling);
  const aliases = await aliasMap(db);
  return {
    found: true, id: `doc:${doc.id}`, title: doc.title, project: doc.project_name, projectId: doc.project_id,
    updatedAt: new Date(doc.updated_at).toISOString(), body: doc.body,
    annotations: annotate(normalize(doc.body, aliases), expired, candidates, currentByTopic),
  };
}

/** Mark money amounts in a document that no longer hold, or were never approved. */
/**
 * What the AI should do about disagreeing amounts.
 * Grounded (the newest statement says it was decided and names who approved it): write that amount, say where it comes
 * from and that the team has not recorded it yet, and offer to record it. Otherwise: ask which amount before writing.
 */
function conflictCaution(c: MoneyConflict, pending?: Decision): string {
  const amounts = c.values.map(v => yen(v.amount)).join('・');
  const latest = `${describeMention(c.latest)}で、${yen(c.latest.amount)}`;
  const grounded = c.latest.signal === 'decided' && c.draft?.approverInDoc;
  const head = `${c.label}について、資料どうしで食い違いがある（${amounts}）。チームで承認された記録はまだない。最も新しい記載は${latest}。`;
  const act = grounded
    ? `この資料には承認者（${c.draft!.approverInDoc}）の名前があるので、この金額で書いてよい。そのとき、根拠の資料（日付と題名）と、チームの正式な記録はまだないことを、利用者に必ず伝える。`
    : `決定や承認者を示す資料がないので、金額を書く前に、どれで進めるかを利用者に聞く。`;
  const record = pending
    ? `${fmtValue(pending)}が承認待ちの候補として記録済み。新しい候補は出さず、承認を待っていることを利用者に伝える。`
    : `金額が決まったら、承認待ちの候補として記録するかを利用者に聞く${c.draft ? '（上の「候補の下書き」をそのまま使える）' : ''}。`;
  return head + act + record;
}

export function annotate(normBody: string, expired: Decision[], candidates: Decision[], currentByTopic: Map<string, Decision>): Annotation[] {
  const amounts = new Set(moneyAmounts(normBody));
  const out: Annotation[] = [];
  for (const [topic, cur] of currentByTopic) {
    if (cur.value.type !== 'money') continue;
    if (amounts.has(cur.value.amount)) continue; // the document already states the current value
    const stale = expired.filter(d => d.topicKey === topic && d.value.type === 'money' && amounts.has(d.value.amount));
    if (stale.length) {
      const olds = stale.map(d => yen((d.value as any).amount)).join('・');
      out.push({
        kind: 'superseded_value', decisionId: cur.id,
        message: `この文書の${cur.label}${olds}は現行ではない。現行は${fmtValue(cur)}、${mmdd(cur.validFrom)}から適用（${mmdd(localDate(cur.approvedAt))}承認）`,
      });
    }
  }
  for (const c of candidates.filter(d => d.value.type === 'money')) {
    if (amounts.has((c.value as any).amount)) {
      out.push({ kind: 'unapproved', decisionId: c.id, message: `この文書の${fmtValue(c)}は未承認の候補（${c.label}）。現行として扱わない` });
    }
  }
  return out;
}

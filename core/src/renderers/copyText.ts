import { signalText } from '../conflicts';
import { formatValue } from '../normalize';
import type { ContextPack, DecisionView } from '../types';

function v(d: DecisionView) {
  return formatValue(d.value);
}

/** Display time in the display time zone (stored values stay UTC). */
function localTime(iso: string, tz = process.env.SB_DISPLAY_TZ ?? 'Asia/Tokyo') {
  return new Date(iso).toLocaleString('sv-SE', { timeZone: tz }).slice(0, 16) + (tz === 'Asia/Tokyo' ? '（日本時間）' : `（${tz}）`);
}

export function excerpt(text: string, max = 160) {
  const t = text.replace(/^#.*$/gm, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max) + '…' : t;
}

/**
 * The plain-text Context Pack: what MCP returns and what the copy button pastes into any AI.
 * It states facts and their sources; it does not try to instruct the AI (tool output is not a trusted channel).
 */
export function renderCopyText(p: ContextPack): string {
  if (!p.project) {
    if (p.cautions.length) return ['【チームの決定】案件を特定できませんでした', ...p.cautions.map(c => `- ${c}`)].join('\n');
    return '（チームの決定：該当する案件はありません）';
  }
  const lines: string[] = [];
  lines.push(`【チームの決定】案件：${p.project.name}`);
  lines.push(`生成：${localTime(p.generatedAt)}`);
  if (p.current.length) {
    lines.push('', '■ 現行の決定（承認済み）');
    for (const d of p.current) {
      // The approval day and the start day differ (approved 11/26, valid from 11/24); say both so the AI does not mix them.
      const approved = d.approvedAt ? new Date(d.approvedAt).toLocaleDateString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric' }) : '';
      lines.push(`- ${d.label}：${v(d)}／${d.validFrom}から有効${approved ? `（チームで${approved}に承認）` : ''}`);
    }
  }
  if (p.previous.length) {
    lines.push('', '■ 失効した旧決定');
    for (const d of p.previous) lines.push(`- ${d.label}：${v(d)}／${d.validTo}に失効`);
  }
  if (p.open.length) {
    lines.push('', '■ 未確定');
    for (const o of p.open) {
      if (o.source) lines.push(`- 資料の記載：${o.source.date}の「${o.source.title}」（ID ${o.source.docId}）：${o.source.line.slice(0, 80)}`);
      else lines.push(`- ${o.label}${o.note ? '：' + o.note : ''}`);
    }
  }
  if (p.documents.length) {
    lines.push('', '■ 関連資料');
    for (const d of p.documents) {
      lines.push(`- ${d.source.title}（ID ${d.source.uri}、更新 ${d.source.updatedAt?.slice(0, 10) ?? '-'}）`);
      lines.push(`  抜粋：${excerpt(d.snippet)}`);
      for (const a of d.annotations) lines.push(`  ※ ${a.message}`);
    }
  }
  for (const c of p.conflicts ?? []) {
    lines.push('', `■ 資料どうしの食い違い：${c.label}（承認された決定なし）`);
    for (const v of c.values) {
      lines.push(`- ${v.amount.toLocaleString('ja-JP')}円`);
      for (const m of v.mentions.slice(0, 3)) lines.push(`  ・${m.title}（${m.updatedAt}、ID ${m.docId}）${m.signal ? `［${signalText(m.signal)}］` : ''}：${m.line.slice(0, 60)}`);
    }
    if (c.draft) {
      const d = c.draft;
      const unit = { monthly: '月額', yearly: '年額', one_time: '一括' } as const;
      const tax = { excluded: '税別', included: '税込' } as const;
      lines.push(`→ 候補の下書き（記録するかは利用者に聞く）：案件 ${d.projectId}／${d.label}／${d.period ? unit[d.period] : ''}${d.amount.toLocaleString('ja-JP')}円${d.tax ? `（${tax[d.tax]}）` : ''}` +
        `${d.validFrom ? `／適用日 ${d.validFrom}` : ''}／根拠 ${d.sourceDocId}${d.approverInDoc ? `（資料には「承認者：${d.approverInDoc}」とある。記録するとチームの承認者が承認ページで確定する）` : ''}`);
    }
  }
  for (const c of p.docCandidates ?? []) {
    const d = c.draft;
    const unit = { monthly: '月額', yearly: '年額', one_time: '一括' } as const;
    const tax = { excluded: '税別', included: '税込' } as const;
    lines.push('', `■ 現行と違う金額の資料（チームでは未承認）：${c.current.label}`);
    lines.push(`- 現行：${formatValue(c.current.value)}（承認済み）`);
    lines.push(`- 資料：${d.period ? unit[d.period] : ''}${d.amount.toLocaleString('ja-JP')}円${d.tax ? `（${tax[d.tax]}）` : ''}`);
    lines.push(`- 有効日：${d.validFrom ?? '資料に記載なし（承認した日から）'}`);
    lines.push(`- 出典：${c.docDate}の「${d.sourceTitle}」（ID ${d.sourceDocId}）：${c.line.slice(0, 80)}${d.approverInDoc ? `／資料には「承認者：${d.approverInDoc}」とある` : ''}`);
  }
  if (p.cautions.length) {
    lines.push('', '■ 注意');
    for (const c of p.cautions) lines.push(`- ${c}`);
  }
  if (p.unavailableSources.length) {
    lines.push('', '■ 取得できなかった情報源');
    for (const u of p.unavailableSources) lines.push(`- ${u.adapterId}：${u.reason}`);
  }
  if (p.truncated) lines.push('', '（関連資料は上位のみ。ほかにも該当する資料があります）');
  lines.push('', `■ 参照元`, `- ${p.citation}`);
  return lines.join('\n');
}

export function renderDocumentText(d: { found: boolean } & Record<string, any>): string {
  if (!d.found) return '（チームの資料：その資料は見つからないか、参照できません）';
  const lines = [`【チームの資料】${d.title}`, `ID ${d.id}／案件 ${d.project}／更新 ${String(d.updatedAt).slice(0, 10)}`];
  if (d.annotations.length) {
    lines.push('', '■ 注釈（チームの決定との照合）');
    for (const a of d.annotations) lines.push(`- ${a.message}`);
  }
  lines.push('', '■ 本文', d.body);
  return lines.join('\n');
}

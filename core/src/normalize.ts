// Japanese text normalization shared by indexing and querying.

export function normalize(text: string, aliases: Record<string, string> = {}): string {
  let t = text.normalize('NFKC');
  // Longest alias first so "株式会社エー" wins over "エー".
  for (const alias of Object.keys(aliases).sort((a, b) => b.length - a.length)) {
    t = t.split(alias).join(aliases[alias]);
  }
  t = t.replace(/(\d),(?=\d{3})/g, '$1'); // 120,000 -> 120000
  t = t.replace(/(\d+(?:\.\d+)?)万円/g, (_, n) => `${Math.round(parseFloat(n) * 10000)}円`); // 12万円 -> 120000円
  return t;
}

/** Money amounts (yen) mentioned in normalized text. */
export function moneyAmounts(normText: string): number[] {
  const out = new Set<number>();
  for (const m of normText.matchAll(/(\d{3,})円/g)) out.add(Number(m[1]));
  return [...out];
}

export function yen(n: number): string {
  return `${n.toLocaleString('ja-JP')}円`;
}

/** Distinct two-character windows without whitespace (what pg_bigm's show_bigm yields minus padded ends). */
export function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, ' ');
  const out = new Set<string>();
  const chars = [...t];
  for (let i = 0; i < chars.length - 1; i++) {
    const b = chars[i] + chars[i + 1];
    if (!b.includes(' ')) out.add(b);
  }
  return out;
}

/** IDF-weighted share of the query's bigrams found in each document (same formula as the SQL path). */
export function bigramScores(normQuery: string, normDocs: string[]): number[] {
  const qb = [...bigrams(normQuery)];
  const n = normDocs.length;
  const w = new Map(qb.map(b => [b, Math.log((n + 1) / (normDocs.filter(d => d.includes(b)).length + 0.5))]));
  const total = [...w.values()].reduce((a, b) => a + b, 0) || 1;
  return normDocs.map(d => qb.reduce((s, b) => s + (d.includes(b) ? w.get(b)! : 0), 0) / total);
}

const PERIOD: Record<string, string> = { monthly: '月額', yearly: '年額', one_time: '一括' };
const TAX: Record<string, string> = { excluded: '税別', included: '税込' };

/** "月額120,000円（税別）". Amount, billing period and tax basis travel together so no surface drops one. */
export function formatValue(v: any): string {
  if (v.type === 'money') return `${PERIOD[v.period] ?? ''}${yen(v.amount)}${TAX[v.tax] ? `（${TAX[v.tax]}）` : ''}`;
  if (v.type === 'text') return v.text;
  if (v.type === 'date') return v.date;
  if (v.type === 'number') return `${v.value}${v.unit ?? ''}`;
  return JSON.stringify(v);
}

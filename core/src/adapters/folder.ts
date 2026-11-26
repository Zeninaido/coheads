import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extract, isReadable, stemOf } from './extract';
import { basename, join } from 'node:path';
import type { Db } from '../db';
import { bigramScores, normalize } from '../normalize';
import { CLASSIFICATION_ORDER, type SourceAdapter, type SourceQuery, type SourceResult } from '../types';

/** Every project alias is rewritten to the project's canonical name before indexing and querying. */
export async function aliasMap(db: Db): Promise<Record<string, string>> {
  const rows = await db.query<{ name: string; aliases: string[] }>('select name, aliases from projects');
  const map: Record<string, string> = {};
  for (const r of rows) for (const a of r.aliases) map[a] = r.name;
  return map;
}

function parseFrontmatter(raw: string): { meta: Record<string, string>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw };
  const [, fm, ...rest] = raw.split('---');
  const meta: Record<string, string> = {};
  for (const line of fm.split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) meta[m[1]] = m[2].trim();
  }
  return { meta, body: rest.join('---').trim() };
}

/**
 * Shared-folder adapter. Each sub-folder maps to one project (the admin's mapping), so search is scoped
 * by project inside the query even though plain files carry no permissions of their own.
 */
export class FolderAdapter implements SourceAdapter {
  id = 'folder';
  kind = 'folder';
  capabilities = { scopeByProject: true, changeFeed: false };

  /** prefixIds: document ids become "<folder>/<file stem>", so equal file names in different folders never collide. */
  constructor(private db: Db, private root: string, private folderToProject: Record<string, string>, private opts: { prefixIds?: boolean } = {}) {}

  async ingest(): Promise<number> {
    const aliases = await aliasMap(this.db);
    await this.db.exec('create table if not exists document_files (id text primary key, stamp text not null)');
    // Re-index when aliases change (they are part of the normalized text).
    const aliasKey = createHash('sha1').update(JSON.stringify(Object.entries(aliases).sort())).digest('hex').slice(0, 12);
    let n = 0;
    const seen: string[] = [];
    for (const folder of readdirSync(this.root)) {
      const projectId = this.folderToProject[folder];
      if (!projectId) continue; // unmapped folders are never searchable
      const [p] = await this.db.query('select default_classification from projects where id = $1', [projectId]);
      for (const file of readdirSync(join(this.root, folder)).filter(isReadable)) {
        const path = join(this.root, folder, file);
        // Markdown and text keep the bare name (ids already in use); Word and PDF keep the extension, so
        // 提案書.docx and 提案書.pdf in the same folder stay two documents.
        const stem = /\.(md|txt)$/i.test(file) ? stemOf(file) : file;
        const docId = this.opts.prefixIds ? `${folder}/${stem}` : stem;
        seen.push(docId);
        // Word and PDF take time to read; read a file again only when it changed (size or time).
        const st = statSync(path);
        const stamp = `${st.size}:${st.mtimeMs}:${aliasKey}`;
        const [known] = await this.db.query<{ stamp: string }>(
          'select f.stamp from document_files f join documents d on d.id = f.id where f.id = $1', [docId]);
        if (known?.stamp === stamp) { n++; continue; }
        const ex = await extract(path);
        const { meta, body } = /\.(md|txt)$/i.test(file) ? parseFrontmatter(ex.body) : { meta: {} as Record<string, string>, body: ex.body || `（${ex.note ?? '中身を読めなかった'}）` };
        const title = meta.title ?? ex.title ?? stemOf(file);
        await this.db.query(
          `insert into documents (id, project_id, adapter_id, uri, title, body, body_norm, updated_at, classification)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
           on conflict (id) do update set body = excluded.body, body_norm = excluded.body_norm,
             title = excluded.title, updated_at = excluded.updated_at, classification = excluded.classification`,
          [docId, projectId, this.id, 'file://' + path, title, body,
           normalize(body, aliases), meta.date ?? ex.modified ?? st.mtime.toISOString(), meta.classification ?? p.default_classification],
        );
        await this.db.query(
          `insert into document_files (id, stamp) values ($1, $2) on conflict (id) do update set stamp = excluded.stamp`, [docId, stamp]);
        n++;
      }
    }
    // Files removed from the folder leave the index too.
    await this.db.query(`delete from documents where adapter_id = $1 and not (id = any($2::text[]))`, [this.id, seen]);
    await this.db.query(`delete from document_files where not (id = any($1::text[]))`, [seen]);
    return n;
  }

  /** IDF-weighted bigram overlap. Project and classification filters always sit inside the SQL query. */
  async search(q: SourceQuery): Promise<SourceResult[]> {
    if (q.projectIds.length === 0) return [];
    const text = normalize(q.text, await aliasMap(this.db));
    const allowed = CLASSIFICATION_ORDER.slice(0, CLASSIFICATION_ORDER.indexOf(q.ceiling) + 1);
    let rows: any[];
    if (this.db.hasBigm) {
      rows = await this.db.query(
        `with scope as (select * from documents where project_id = any($2::text[]) and classification = any($3::text[])),
         qb as (select distinct b from unnest(show_bigm($1)) b where b !~ ' '),
         n as (select count(*)::float n from scope),
         df as (select qb.b, count(s.id) df from qb left join scope s on strpos(s.body_norm, qb.b) > 0 group by qb.b),
         w as (select b, ln((n.n + 1.0) / (df.df + 0.5)) w from df, n)
         select s.id, s.project_id, s.uri, s.title, s.body, s.updated_at, s.classification,
           sum(case when strpos(s.body_norm, w.b) > 0 then w.w else 0 end) / nullif((select sum(w) from w), 0) as score
         from scope s cross join w
         group by s.id, s.project_id, s.uri, s.title, s.body, s.updated_at, s.classification
         having sum(case when strpos(s.body_norm, w.b) > 0 then 1 else 0 end) > 0
         order by score desc, s.updated_at desc limit $4`,
        [text, q.projectIds, allowed, q.limit],
      );
    } else {
      // No pg_bigm (e.g. PGLite): same scoring in JS, over rows already scoped by the query.
      const scoped = await this.db.query(
        `select id, project_id, uri, title, body, body_norm, updated_at, classification from documents
         where project_id = any($1::text[]) and classification = any($2::text[])`,
        [q.projectIds, allowed],
      );
      const scores = bigramScores(text, scoped.map(r => r.body_norm));
      rows = scoped
        .map((r, i) => ({ ...r, score: scores[i] }))
        .filter(r => r.score > 0)
        .sort((a, b) => b.score - a.score || +new Date(b.updated_at) - +new Date(a.updated_at))
        .slice(0, q.limit);
    }
    return rows.map(r => ({
      // Local paths stay inside the core; AI clients get an id they can pass to get_document.
      source: { adapterId: this.id, uri: `doc:${r.id}`, title: r.title, updatedAt: new Date(r.updated_at).toISOString() },
      snippet: r.body,
      projectId: r.project_id,
      classification: r.classification,
      score: Number(r.score),
    }));
  }

  async health() {
    return { ok: true };
  }
}

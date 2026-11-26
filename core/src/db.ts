// One small interface over two engines: a PostgreSQL server (team) and PGLite (in-process, no install).
import postgres from 'postgres';

export interface Db {
  engine: 'postgres' | 'pglite';
  /** pg_bigm available: search runs in SQL. Otherwise the same scoring runs in JS over the scoped rows. */
  hasBigm: boolean;
  query<T = any>(text: string, params?: unknown[]): Promise<T[]>;
  exec(text: string): Promise<void>;
  tx<T>(fn: (db: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

function wrapPostgres(sql: any, root: any): Db {
  const db: Db = {
    engine: 'postgres',
    hasBigm: false,
    query: (text, params = []) => sql.unsafe(text, params as any[]),
    exec: async text => { await sql.unsafe(text); },
    tx: fn => root.begin((t: any) => fn({ ...wrapPostgres(t, root), hasBigm: db.hasBigm })),
    close: () => root.end(),
  };
  return db;
}

function wrapPglite(pg: any, root: any): Db {
  return {
    engine: 'pglite',
    hasBigm: false,
    query: async (text, params = []) => (await pg.query(text, params)).rows,
    exec: async text => { await pg.exec(text); },
    tx: fn => root.transaction((t: any) => fn(wrapPglite(t, root))),
    close: () => root.close(),
  };
}

/**
 * SB_ENGINE=pglite (default when no SB_DATABASE_URL) stores data under SB_DATA_DIR (or memory).
 * SB_ENGINE=postgres uses SB_DATABASE_URL.
 */
export async function connect(): Promise<Db> {
  const url = process.env.SB_DATABASE_URL;
  const engine = process.env.SB_ENGINE ?? (url ? 'postgres' : 'pglite');
  if (engine === 'postgres') {
    const sql = postgres(url ?? 'postgres://postgres@127.0.0.1:5433/sbcore', { onnotice: () => {} });
    return wrapPostgres(sql, sql);
  }
  const { PGlite } = await import('@electric-sql/pglite');
  const { pgliteAssetOptions } = await import('./pgliteAssets');
  const pg = new PGlite(process.env.SB_DATA_DIR ?? 'memory://', await pgliteAssetOptions());
  await pg.waitReady;
  return wrapPglite(pg, pg);
}

export async function migrate(db: Db) {
  try {
    await db.exec('create extension if not exists pg_bigm');
    db.hasBigm = true;
  } catch {
    db.hasBigm = false;
  }
  await db.exec(`
    create table if not exists workspaces (
      id text primary key,
      kind text not null check (kind in ('personal','team')),
      name text not null
    );
    create table if not exists projects (
      id text primary key,
      workspace_id text not null references workspaces(id),
      name text not null,
      aliases text[] not null default '{}',
      default_classification text not null default 'internal'
    );
    -- People on the client side of a project (e.g. 田中 at A社). Used only on the server to resolve a project
    -- from a request that names a person; never sent to the AI as part of a tool description.
    create table if not exists project_contacts (
      project_id text not null references projects(id),
      name text not null,
      organization text,
      primary key (project_id, name)
    );
    create table if not exists relation_tuples (
      subject_type text not null, subject_id text not null, relation text not null,
      resource_type text not null, resource_id text not null,
      primary key (subject_type, subject_id, relation, resource_type, resource_id)
    );
    create table if not exists documents (
      id text primary key,
      project_id text not null references projects(id),
      adapter_id text not null,
      uri text not null,
      title text,
      body text not null,
      body_norm text not null,
      updated_at timestamptz,
      classification text not null
    );
    create table if not exists decisions (
      id text primary key,
      workspace_id text not null,
      project_id text not null references projects(id),
      topic_key text not null,
      label text not null,
      value jsonb not null,
      status text not null check (status in ('candidate','approved','on_hold','rejected','retired')),
      retired_reason text,
      valid_from date,
      valid_to date,
      recorded_at timestamptz not null default now(),
      recorded_by jsonb not null,
      approved_by jsonb,
      approved_at timestamptz,
      sources jsonb not null default '[]',
      classification text not null,
      supersedes text references decisions(id)
    );
    create unique index if not exists decisions_one_approved on decisions (project_id, topic_key) where status = 'approved';
    create table if not exists decision_events (
      seq bigserial primary key,
      decision_id text not null references decisions(id),
      at timestamptz not null default now(),
      by jsonb not null,
      type text not null,
      note text
    );
    -- What each AI-facing call asked for and what it was given (who, from where, which decisions and documents).
    create table if not exists access_log (
      seq bigserial primary key,
      at timestamptz not null default now(),
      user_id text not null,
      destination text not null,
      tool text not null,
      request jsonb not null,
      project_id text,
      returned jsonb not null default '{}'
    );
    create table if not exists open_items (
      project_id text not null references projects(id),
      topic_key text not null,
      label text not null,
      note text,
      primary key (project_id, topic_key)
    );
  `);
  if (db.hasBigm) await db.exec('create index if not exists documents_body_norm_bigm on documents using gin (body_norm gin_bigm_ops)');
}

export async function reset(db: Db) {
  await db.exec('drop table if exists access_log, project_contacts, decision_events, open_items, decisions, documents, relation_tuples, projects, workspaces cascade');
  await migrate(db);
}

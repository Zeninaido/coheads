// Opens the local store. PGLite allows one process at a time, so callers open, work and close.
//
// Two modes:
// - folder (SB_FOLDER is set): the user's own folder. Each sub-folder is a project; the user is its member and approver.
// - demo (no SB_FOLDER): the fictional A社 / B社 data used by the tests and the trials.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, parse, resolve } from 'node:path';
import { connect, migrate, type Db } from './db';
import { FolderAdapter } from './adapters/folder';
import { grant } from './permissions';
import { newerRecordCount, syncSharedLedger } from './sharedLedger';
import { moduleDir } from './paths';
import { CORPUS_DIR, seedBase, seedPriceHistory } from './seed';

// An optional setting left empty in an extension's settings may arrive empty or as the raw placeholder.
const setting = (v?: string) => (v && v.trim() && !v.includes('${') ? v.trim() : undefined);

export const FOLDER = setting(process.env.SB_FOLDER);
export const MODE: 'folder' | 'demo' = FOLDER ? 'folder' : 'demo';

/** Everything Coheads keeps on this computer (~/.coheads for the extension): one store per folder, plus the demo. */
export const BASE_DATA_DIR = process.env.SB_DATA_DIR ?? join(moduleDir(import.meta), '..', '.data');
// A separate store per folder, so switching folders (or demo ↔ folder) never mixes data.
export const DATA_DIR = FOLDER
  ? join(BASE_DATA_DIR, 'folder-' + createHash('sha256').update(FOLDER).digest('hex').slice(0, 12))
  : BASE_DATA_DIR;

export const LOCAL_USER = setting(process.env.SB_USER) ?? 'me';
/** Project ids of the user's folder (sub-folders), for writes that must name them. */
export function folderProjectIds(): string[] {
  return FOLDER ? projectFolders(FOLDER) : [];
}
// Demo mode: the fictional member suzuki by default. Any other name (e.g. the extension's "me") gets suzuki's access.
const DEMO_PEOPLE = ['sato', 'suzuki', 'kimura'];
export const DEMO_USER = setting(process.env.SB_USER) ?? 'suzuki';

/** Sub-folders of the user's folder that become projects (hidden and "_"-prefixed folders are skipped). */
function projectFolders(root: string): string[] {
  return readdirSync(root).filter(n => !n.startsWith('.') && !n.startsWith('_') && statSync(join(root, n)).isDirectory());
}

// Records in the shared folder that a newer version wrote and this one cannot read (updated on every open).
let newerRecords = 0;
/** True when someone on the team uses a newer version: the approval page and the AI are told to update. */
export const newerVersionSeen = () => newerRecords > 0;

async function syncFolderProjects(db: Db, root: string): Promise<FolderAdapter> {
  await db.query(`insert into workspaces values ('local', 'personal', $1) on conflict do nothing`, [basename(root)]);
  const map: Record<string, string> = {};
  for (const name of projectFolders(root)) {
    await db.query(`insert into projects values ($1, 'local', $1, $2::text[], 'internal') on conflict do nothing`, [name, []]);
    // Membership here; who may approve is decided by the shared ledger (team.json, or everyone in a trial).
    await grant(db, { subject: { type: 'user', id: LOCAL_USER }, relation: 'member', resource: { type: 'project', id: name } });
    map[name] = name;
  }
  const folder = new FolderAdapter(db, root, map, { prefixIds: true });
  await folder.ingest();
  await syncSharedLedger(db, root, Object.values(map), LOCAL_USER);
  newerRecords = await newerRecordCount(db);
  return folder;
}

// PGLite: one open store per process. Requests from the AI and from the approval page take turns.
let queue: Promise<unknown> = Promise.resolve();

export function withStore<T>(fn: (db: Db, folder: FolderAdapter) => Promise<T>): Promise<T> {
  const run = queue.then(() => openStore(fn));
  queue = run.catch(() => undefined);
  return run;
}

async function openStore<T>(fn: (db: Db, folder: FolderAdapter) => Promise<T>): Promise<T> {
  if (FOLDER && !existsSync(FOLDER)) throw new Error(`フォルダが見つかりません：${FOLDER}`);
  if (!process.env.SB_DATABASE_URL) {
    mkdirSync(DATA_DIR, { recursive: true });
    process.env.SB_DATA_DIR = DATA_DIR;
  }
  const db = await connect();
  try {
    await migrate(db);
    let folder: FolderAdapter;
    if (FOLDER) {
      folder = await syncFolderProjects(db, FOLDER);
    } else {
      const [{ n }] = await db.query<{ n: number }>('select count(*)::int as n from workspaces');
      if (n === 0) {
        folder = await seedBase(db);
        await seedPriceHistory(db, { approve120: true });
      } else {
        folder = new FolderAdapter(db, CORPUS_DIR, { 'a-sha': 'a-sha', 'b-sha': 'b-sha' });
        await folder.ingest(); // pick up edits to the shared folder
      }
      if (!DEMO_PEOPLE.includes(DEMO_USER)) {
        await grant(db, { subject: { type: 'user', id: DEMO_USER }, relation: 'member', resource: { type: 'project', id: 'a-sha' } });
      }
    }
    return await fn(db, folder);
  } finally {
    await db.close();
  }
}

/**
 * Delete everything Coheads keeps on this computer (the indexes, the record of what reached the AI, the demo data).
 * Documents and the shared folder's records are not touched. Runs in the store queue, so no store is open meanwhile;
 * if Coheads keeps running, the next request rebuilds the index from the folder.
 */
export function clearLocalData(): Promise<void> {
  const run = queue.then(() => {
    if (process.env.SB_DATABASE_URL) throw new Error('この環境のデータは、このパソコンの中にはありません。');
    const dir = resolve(BASE_DATA_DIR);
    // Never the home folder, a drive root or a shallow system path, whatever the setting says.
    if (dir === resolve(homedir()) || dir === parse(dir).root || dir.split(/[\\/]/).filter(Boolean).length < 2) {
      throw new Error(`消せない場所です：${dir}`);
    }
    rmSync(dir, { recursive: true, force: true });
  });
  queue = run.catch(() => undefined);
  return run;
}

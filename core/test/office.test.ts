// Word and PDF in the documents folder (acceptance S2). Fixtures are fictional, made with pandoc and LibreOffice.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extract, isReadable, tidyCjkSpaces } from '../src/adapters/extract';
import { FolderAdapter } from '../src/adapters/folder';
import { findMoneyConflict } from '../src/conflicts';
import { connect, reset, type Db } from '../src/db';

const OFFICE = join(import.meta.dir, 'fixtures', 'office');

describe('reading Word and PDF', () => {
  test('Word: paragraphs as lines, a table row as one line', async () => {
    const ex = await extract(join(OFFICE, '見積書_A社.docx'));
    expect(ex.body).toContain('お見積書（A社 新サービス）');
    expect(ex.body).toContain('月額利用料 | 月額120,000円（税別）');
    expect(ex.body.split('\n')).toContain('初期費用 | 0円');
  });

  test('PDF: text with the spaces around Japanese removed', async () => {
    const ex = await extract(join(OFFICE, '提案書v1.pdf'));
    expect(ex.body).toContain('A社向け新サービス提案書v1');
    expect(ex.body).toContain('月額100,000円（税別）');
    expect(ex.body).toContain('2026年10月28日');
  });

  test('a PDF with no text is listed with a note', async () => {
    const ex = await extract(join(OFFICE, 'スキャン.pdf'));
    expect(ex.body).toBe('');
    expect(ex.note).toContain('文字のない PDF');
  });

  test('spaces between Latin words stay; spaces next to Japanese go', () => {
    expect(tidyCjkSpaces('new service A 社 100,000 円')).toBe('new service A社100,000円');
  });

  test("Office lock files and hidden files are skipped", () => {
    expect(isReadable('見積書.docx')).toBe(true);
    expect(isReadable('提案書.PDF')).toBe(true);
    expect(isReadable('~$見積書.docx')).toBe(false);
    expect(isReadable('.~lock.見積書.docx#')).toBe(false);
    expect(isReadable('見積書.xlsx')).toBe(false);
  });
});

if (process.env.SB_ENGINE !== 'postgres') describe('a folder with Word and PDF', () => {
  let db: Db;
  let root: string;
  let folder: FolderAdapter;
  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'coheads-office-'));
    mkdirSync(join(root, 'A社'));
    copyFileSync(join(OFFICE, '見積書_A社.docx'), join(root, 'A社', '見積書_A社.docx'));
    copyFileSync(join(OFFICE, '提案書v1.pdf'), join(root, 'A社', '提案書v1.pdf'));
    copyFileSync(join(OFFICE, '提案書v1.pdf'), join(root, 'A社', '~$提案書v1.pdf'));
    writeFileSync(join(root, 'A社', 'メモ.md'), '---\ntitle: 打ち合わせメモ\n---\n次回は12月。');
    db = await connect();
    await reset(db);
    await db.query(`insert into workspaces values ('local', 'personal', 'test') on conflict do nothing`);
    await db.query(`insert into projects values ('A社', 'local', 'A社', $1::text[], 'internal')`, [[]]);
    folder = new FolderAdapter(db, root, { 'A社': 'A社' }, { prefixIds: true });
    await folder.ingest();
  });
  afterAll(async () => { await db.close(); });

  test('Word, PDF and Markdown become documents; the lock file does not', async () => {
    const rows = await db.query<{ id: string; title: string }>('select id, title from documents order by id');
    expect(rows.map(r => r.id)).toEqual(['A社/メモ', 'A社/提案書v1.pdf', 'A社/見積書_A社.docx']);
    expect(rows.find(r => r.id === 'A社/見積書_A社.docx')?.title).toBe('見積書_A社');
  });

  test('amounts in Word and PDF are compared like any other document', async () => {
    const c = await findMoneyConflict(db, 'A社', 'confidential', {});
    expect(c?.values.map(v => v.amount).sort()).toEqual([100000, 120000]);
  });

  test('a file is read again only when it changes', async () => {
    const md = join(root, 'A社', 'メモ.md');
    writeFileSync(md, '---\ntitle: 打ち合わせメモ\n---\n次回は1月。');
    utimesSync(md, new Date(), new Date(Date.now() + 5000));
    await folder.ingest();
    const [row] = await db.query<{ body: string }>(`select body from documents where id = 'A社/メモ'`);
    expect(row.body).toContain('1月');
    expect(readFileSync(md, 'utf8')).toContain('1月');
  });
});

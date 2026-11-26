// Text from the files a department actually keeps: Markdown and plain text, Word (.docx) and PDF.
// Pure JavaScript only: the extension runs on Claude Desktop's built-in Node.js, so no native modules.
import { readFileSync, statSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

export const READABLE = /\.(md|txt|docx|pdf)$/i;

/** Files the folder adapter skips: hidden files and Office's lock files ("~$見積書.docx", left while a file is open). */
export function isReadable(file: string): boolean {
  return READABLE.test(file) && !file.startsWith('.') && !file.startsWith('~$');
}

export interface Extracted {
  body: string;
  /** From the file itself when it says so (Word's core properties, PDF metadata); otherwise undefined. */
  title?: string;
  modified?: string; // ISO date-time
  /** Why the file gave no text (e.g. a scanned PDF). The document is still listed, with this as its body. */
  note?: string;
}

export async function extract(path: string): Promise<Extracted> {
  const ext = extname(path).toLowerCase();
  if (ext === '.docx') return extractDocx(readFileSync(path));
  if (ext === '.pdf') return extractPdf(readFileSync(path));
  return { body: readFileSync(path, 'utf8') };
}

const decode = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

/** Text of one paragraph: its runs' text, tabs and line breaks. */
function paragraphText(xml: string): string {
  let out = '';
  for (const m of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>|<w:cr\/>/g)) {
    out += m[1] !== undefined ? decode(m[1]) : m[0] === '<w:tab/>' ? '\t' : '\n';
  }
  return out;
}

/**
 * Word: paragraphs become lines; a table row becomes one line with its cells joined by " | ", so a price and
 * what it is for (「月額利用料 | 月額120,000円」) stay on the same line for the conflict check.
 */
export function extractDocx(buf: Uint8Array): Extracted {
  const files = unzipSync(buf, { filter: f => f.name === 'word/document.xml' || f.name === 'docProps/core.xml' });
  const doc = files['word/document.xml'];
  if (!doc) return { body: '', note: 'Word の本文が見つからなかった' };
  const xml = strFromU8(doc);
  const body = xml.slice(xml.indexOf('<w:body'), xml.lastIndexOf('</w:body>'));
  const lines: string[] = [];
  // Walk top-level tables and paragraphs in order.
  for (const m of body.matchAll(/<w:tbl>[\s\S]*?<\/w:tbl>|<w:p[ >][\s\S]*?<\/w:p>|<w:p\/>/g)) {
    const block = m[0];
    if (block.startsWith('<w:tbl>')) {
      for (const row of block.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
        const cells = [...row[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)]
          .map(c => [...c[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map(p => paragraphText(p[0])).join(' ').trim());
        lines.push(cells.join(' | '));
      }
    } else {
      lines.push(paragraphText(block));
    }
  }
  const core = files['docProps/core.xml'] ? strFromU8(files['docProps/core.xml']) : '';
  const title = decode(core.match(/<dc:title>([^<]*)<\/dc:title>/)?.[1] ?? '').trim() || undefined;
  const modified = core.match(/<dcterms:modified[^>]*>([^<]*)<\/dcterms:modified>/)?.[1];
  return { body: lines.join('\n').replace(/\n{3,}/g, '\n\n').trim(), title, modified: modified || undefined };
}

/** PDF: text per page, pages separated by a blank line. A PDF with no text layer (a scan) is listed with a note. */
export async function extractPdf(buf: Uint8Array): Promise<Extracted> {
  const { extractText, getDocumentProxy, getMeta } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf), { verbosity: 0 }); // quiet: font warnings are not the user's concern
  const { text } = await extractText(pdf, { mergePages: false });
  const pages = (text as string[]).map(t => tidyCjkSpaces(t.replace(/[ \t]+\n/g, '\n')).trim());
  const body = pages.filter(Boolean).join('\n\n');
  let title: string | undefined;
  let modified: string | undefined;
  try {
    const { info } = await getMeta(pdf);
    title = typeof info?.Title === 'string' && info.Title.trim() ? info.Title.trim() : undefined;
    modified = pdfDate(info?.ModDate) ?? pdfDate(info?.CreationDate);
  } catch { /* metadata is optional */ }
  if (!body) return { body: '', title, modified, note: '文字のない PDF（スキャンした画像など）。中身は読めない' };
  return { body, title, modified };
}

// Japanese text in PDFs often comes out with a space wherever the font changes: "A 社", "100,000 円", "2026 年".
// Drop a single space when either side is Japanese, so amounts and names read as written. Spaces between Latin words stay.
const CJK = '\\u3000-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff01-\\uff60\\uffe0-\\uffef';
const SPACE_BEFORE_CJK = new RegExp(`(?<=\\S) (?=[${CJK}])`, 'g');
const SPACE_AFTER_CJK = new RegExp(`(?<=[${CJK}]) (?=\\S)`, 'g');
export function tidyCjkSpaces(t: string): string {
  return t.replace(SPACE_BEFORE_CJK, '').replace(SPACE_AFTER_CJK, '');
}

/** "D:20261124093000+09'00'" → ISO. */
function pdfDate(v: unknown): string | undefined {
  const m = typeof v === 'string' && v.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?(\d{2})?(Z|[+-]\d{2}'?\d{2}'?)?/);
  if (!m) return undefined;
  const tz = !m[7] || m[7] === 'Z' ? 'Z' : m[7].replace(/'/g, '').replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  return new Date(`${m[1]}-${m[2] ?? '01'}-${m[3] ?? '01'}T${m[4] ?? '00'}:${m[5] ?? '00'}:${m[6] ?? '00'}${tz}`).toISOString();
}

/** Title for a file with no title of its own: the file name without its extension. */
export const stemOf = (file: string) => basename(file).replace(READABLE, '');
export const mtimeOf = (path: string) => statSync(path).mtime.toISOString();

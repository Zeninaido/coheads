// One version for the whole release: the root package.json. Everything users install carries the same number.
//   bun scripts/version.ts --check        fail when a file disagrees (CI runs this)
//   bun scripts/version.ts --set 0.4.0    change the version and write it everywhere
//   bun scripts/version.ts                write the root version everywhere
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const FILES = [
  'core/package.json',
  'packaging/mcpb/manifest.json',
  'packaging/plugin/coheads/.claude-plugin/plugin.json',
];
const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), 'utf8'));
const write = (p: string, v: unknown) => writeFileSync(join(ROOT, p), JSON.stringify(v, null, 2) + '\n');

const args = process.argv.slice(2);
const root = read('package.json');
if (args[0] === '--set') {
  if (!/^\d+\.\d+\.\d+$/.test(args[1] ?? '')) { console.error('usage: --set X.Y.Z'); process.exit(1); }
  root.version = args[1];
  write('package.json', root);
}
const want: string = root.version;
let bad = 0;
for (const f of FILES) {
  const j = read(f);
  if (j.version === want) continue;
  if (args[0] === '--check') { console.error(`${f}: ${j.version} (expected ${want})`); bad++; continue; }
  j.version = want;
  write(f, j);
  console.log(`${f}: ${want}`);
}
if (bad) { console.error('Run `bun scripts/version.ts` to write the root version everywhere.'); process.exit(1); }
if (args[0] === '--check') console.log(`version ${want}: all files agree`);

// Directory of a module, in Bun (`bun run`, compiled binary) and in plain Node (the bundled extension).
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export function moduleDir(meta: ImportMeta): string {
  const m = meta as ImportMeta & { dir?: string; dirname?: string };
  return m.dir ?? m.dirname ?? dirname(fileURLToPath(meta.url));
}

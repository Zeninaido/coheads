// PGlite needs three runtime files (two wasm modules and a filesystem image).
// - Extension (Node, bundled): the files sit in ./assets next to the bundle, or in SB_PGLITE_ASSETS.
// - `bun run` and `bun build --compile`: the files are embedded through Bun's file imports.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { moduleDir } from './paths';

const FILES = { pglite: 'pglite.wasm', initdb: 'initdb.wasm', data: 'pglite.data' };

async function fromDir(dir: string) {
  const read = (f: string) => readFileSync(join(dir, f));
  return {
    pgliteWasmModule: await WebAssembly.compile(read(FILES.pglite)),
    initdbWasmModule: await WebAssembly.compile(read(FILES.initdb)),
    fsBundle: new Blob([read(FILES.data)]),
  };
}

export async function pgliteAssetOptions() {
  const candidates = [process.env.SB_PGLITE_ASSETS, join(moduleDir(import.meta), 'assets')].filter(Boolean) as string[];
  const dir = candidates.find(d => existsSync(join(d, FILES.pglite)));
  if (dir) return fromDir(dir);
  if (typeof (globalThis as any).Bun !== 'undefined') return (await import('./pgliteAssetsBun')).bunAssetOptions();
  return {}; // plain Node with node_modules present: PGlite finds its own files
}

// Bun only: embeds PGlite's files so `bun build --compile` yields one self-contained binary.
import pgliteWasm from '../node_modules/@electric-sql/pglite/dist/pglite.wasm' with { type: 'file' };
import initdbWasm from '../node_modules/@electric-sql/pglite/dist/initdb.wasm' with { type: 'file' };
import pgliteData from '../node_modules/@electric-sql/pglite/dist/pglite.data' with { type: 'file' };

export async function bunAssetOptions() {
  const B = (globalThis as any).Bun;
  const [pw, iw, d] = await Promise.all([B.file(pgliteWasm).arrayBuffer(), B.file(initdbWasm).arrayBuffer(), B.file(pgliteData).arrayBuffer()]);
  return { pgliteWasmModule: await WebAssembly.compile(pw), initdbWasmModule: await WebAssembly.compile(iw), fsBundle: new Blob([d]) };
}

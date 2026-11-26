#!/usr/bin/env bash
# Builds dist/coheads.mcpb: a Claude Desktop extension that runs on Claude Desktop's built-in Node.js.
# Users double-click the file; no Bun, Node.js or terminal is needed on their machine.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/mcpb"
rm -rf "${OUT:?}"
mkdir -p "$OUT/server/assets" "$ROOT/dist"
cd "$ROOT/core"
# One JS file for Node. The Bun-only asset loader stays out of the bundle.
bun build src/mcp.ts --target=node --format=esm --external ./pgliteAssetsBun --outdir "$OUT/server"
# Bun also emits hashed copies of PGlite's files; the server loads the plain copies from server/assets instead.
find "$OUT/server" -maxdepth 1 \( -name '*.wasm' -o -name '*.data' \) -delete
cp node_modules/@electric-sql/pglite/dist/pglite.wasm node_modules/@electric-sql/pglite/dist/initdb.wasm \
   node_modules/@electric-sql/pglite/dist/pglite.data "$OUT/server/assets/"
cp -r "$ROOT/corpus" "$OUT/server/demo-corpus"
cp "$ROOT/packaging/mcpb/manifest.json" "$OUT/"
[ -f "$ROOT/LICENSE" ] && cp "$ROOT/LICENSE" "$OUT/"
mcpb validate "$OUT/manifest.json"
mcpb pack "$OUT" "$ROOT/dist/coheads.mcpb"
ls -la "$ROOT/dist/coheads.mcpb"

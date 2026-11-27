#!/usr/bin/env bash
# Builds what users install, into dist/:
#   coheads.mcpb        Claude Desktop extension. Runs on Claude Desktop's built-in Node.js, so users need no Bun,
#                       Node.js or terminal: they double-click the file.
#   coheads-plugin.zip  Plugin (rule skill + hook) for Claude Desktop, Cowork and Claude Code.
# Every file carries the version in the root package.json (scripts/version.ts).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$ROOT/build/mcpb"
cd "$ROOT"
bun scripts/version.ts --check
# `type -P` looks only at the PATH, not at this function (`command -v` would find the function and never fall back).
mcpb() { if type -P mcpb >/dev/null; then command mcpb "$@"; else npx -y @anthropic-ai/mcpb "$@"; fi; }

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
cp "$ROOT/packaging/mcpb/manifest.json" "$ROOT/LICENSE" "$OUT/"
mcpb validate "$OUT/manifest.json"
rm -f "$ROOT/dist/coheads.mcpb"
mcpb pack "$OUT" "$ROOT/dist/coheads.mcpb"

# Plugin. `claude plugin validate` runs when Claude Code is installed (CI installs it).
cd "$ROOT/packaging/plugin"
if command -v claude >/dev/null; then claude plugin validate coheads; fi
rm -f "$ROOT/dist/coheads-plugin.zip"
zip -qr "$ROOT/dist/coheads-plugin.zip" coheads
ls -la "$ROOT/dist"

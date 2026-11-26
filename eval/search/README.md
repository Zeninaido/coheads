# 日本語検索の比較（12問）

架空の資料（`corpus/`、7件）に、自然な日本語の質問12問を投げ、正解の資料が上位3件に入るかを比べた。P-01（検索はコアが pg_bigm で持つ）の根拠。結果は [docs/spec-changes.md](../../docs/spec-changes.md) の P-01。

| ファイル | 中身 |
| --- | --- |
| `queries.json` | 12問と正解の資料 |
| `run_search_eval.py` | pg_bigm と gbrain のキーワード検索の比較（PostgreSQL が要る） |
| `run_embed_eval_mac.py` | キーワード（bigram）、埋め込み、ハイブリッドの比較（Ollama が要る） |
| `search_results.json` | 比較の結果 |

## 意味検索を比べる（Mac、Ollama）

標準ライブラリだけで動く。PostgreSQL は要らない。

```bash
ollama pull qwen3-embedding:0.6b
python3 eval/search/run_embed_eval_mac.py
```

モデル名が違う場合は `OLLAMA_EMBED_MODEL=<名前>` を付ける。結果は `eval/search/embed_results.json`（コミットしない）。

## PostgreSQL 側の比較を回し直す

PostgreSQL＋pg_bigm を用意する（`cd docker && docker compose up -d`、ポート 5433。Mac では未確認）。

```bash
pip install "psycopg[binary]"
GBRAIN_HOME=<gbrainの作業用ディレクトリ> python3 eval/search/run_search_eval.py
```

gbrain は、`corpus/` を取り込んだ作業用の brain を使う（`gbrain init --pglite` → `gbrain import corpus --no-embed`）。普段使っている brain には取り込まない。

コアの自動テストを PostgreSQL で回すときは `cd core && SB_ENGINE=postgres SB_DATABASE_URL=postgres://postgres@127.0.0.1:5433/sbcore bun test`。

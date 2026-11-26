# 共通セカンドブレイン 試し実装キット（2026-11-25）

企画書 v0.2 の試し実装です。中身は次の3つです。

| フォルダ | 中身 |
| --- | --- |
| `corpus/` | 架空のテスト資料（A社 5件、B社 2件）。フォルダ名が案件 |
| `eval/` | 日本語検索の評価セット（12問）と比較スクリプト |
| `core/` | コアの試作（決定台帳、権限、Context Pack、コピー用テキスト、MCPサーバー、管理コマンド）と、実証シナリオのテスト |

## 1. Macで意味検索を比較する（Ollamaが必要）

標準ライブラリだけで動きます。PostgreSQLは不要です。

```bash
ollama pull qwen3-embedding:0.6b        # 未取得なら
python3 eval/run_embed_eval_mac.py
```

モデル名が違う場合は `OLLAMA_EMBED_MODEL=<名前>` を付けて実行します。
キーワード検索（bigram）、埋め込み検索、両者を組み合わせたハイブリッドの3方式で、同じ12問の順位を出します。
結果は `eval/embed_results.json` にも保存されます。

## 2. Claude Desktopから試す（追加のインストール不要）

データは組み込み型のPostgreSQL（PGLite）で `core/.data` に保存されます。PostgreSQLのサーバーは不要です。

### 準備

```bash
cd core
bun install
bun run admin reset     # デモデータを用意（A社：提案価格12万円が11/24から現行、納期は未確定）
which bun               # 次の設定で使うbunの場所
```

### Claude Desktopに登録

画面最上部のメニューバーの「Claude」→「設定…」→「開発者」→「設定を編集」で開く `claude_desktop_config.json` に次を追加して、Claude Desktopを再起動します。ファイルの実体は `~/Library/Application Support/Claude/claude_desktop_config.json` で、直接編集する場合はClaude Desktopを終了（⌘Q）してから編集します。
`command` には `which bun` で表示された場所を、`args` の2つ目にはこのフォルダの `core/src/mcp.ts` の場所を入れます。

```json
{
  "mcpServers": {
    "shared-second-brain": {
      "command": "/Users/admin/.bun/bin/bun",
      "args": ["run", "/Users/admin/project/gbrain/sb-test/core/src/mcp.ts"],
      "env": { "SB_USER": "suzuki" }
    }
  }
}
```

MCPのツールは3つです。`get_context`（案件の文脈）、`get_document`（資料の本文と注釈。権限と機密区分を確認したうえで返す）、`propose_decision`（決定の候補を登録。承認はできない）。

`get_context` の説明文には、その利用者が参照できる案件の名前と別名（例：A社（別名：エー社、株式会社エー））が、サーバーの起動時に入ります。依頼に出てきた取引先名とツールを結びつけて、メールやドライブより先に呼ばれやすくするためです。名前はツールの定義としてAIベンダーに毎回送られるので、機密区分が `SB_NAME_CEILING`（初期値 `internal`）以下の案件だけを載せます。社外秘のB社は載りません。案件を追加・変更したときは、Claude Desktopを再起動すると説明文に反映されます。

取引先の担当者の名前（例：A社の田中様）を登録しておくと、「田中さんに送る見積」のように取引先名が出ない依頼でも案件を特定します。登録は `bun run admin contact --project a-sha --name 田中 --org 株式会社エー` です。担当者名はサーバー側の照合だけに使い、ツールの説明文には載せません。同じ名前の人が複数の案件にいるときは、決めつけずに「どの案件か確認してください」と返します。

`SB_USER` は、誰としてAIを使うかの設定です。`suzuki`（A社のメンバー）、`sato`（A社の承認者）、`kimura`（B社だけのメンバー）を用意しています。

### 試す流れ

1. 設定で「Search and reference chats」（過去のチャットの検索と参照）をオフにするか、シークレットチャットを使う。この企画を話したチャットが残っていると、ツールを使わずに過去の会話から答えられてしまい、テストにならない。
2. 新しいチャットで、普段どおりに依頼する。例：「エー社向けの提案書の骨子を作って。価格と導入時期も入れて」
   - 確認すること：ツール名を言わなくても `get_context` が呼ばれるか。価格が120,000円になっているか。納期を確定事項として書いていないか。出典（案件名と承認日）が示されるか。資料の中身が必要なとき `get_document` で取得するか（ファイルを直接開こうとしないか）。
3. ターミナルで価格を13万円に変える（承認は人が行う操作なので、AIからはできない）。
   ```bash
   bun run admin propose --label 提案価格 --yen 130000      # 月額・税別（--period / --tax で変更可）
   bun run admin status            # 表示された候補のID（先頭8文字）を確認
   bun run admin approve <ID>
   ```
4. 同じチャットか新しいチャットで、もう一度価格を聞く。130,000円に変わり、旧資料に「現行ではない」の注釈が付くことを確認する。
5. `SB_USER` を `kimura` に変えてClaude Desktopを再起動し、A社について聞く。何も返らないことを確認する。
6. 元に戻すときは `bun run admin reset`。

### 呼ばれる率を測る

1回ずつの結果ではなく、同じ依頼を何回か試して、`get_context` が呼ばれた割合で判断します。

1. `bun run admin reset`（ログも空になる）
2. シークレットチャットで、同じ依頼を5回、それぞれ新しいチャットで出す
3. `bun run admin log` で `get_context` の行を数える（5回中何回か）

AIからの呼び出しは、すべてアクセスログに残ります。サーバーの起動も「（サーバー起動）」として記録されるので、チャットを始めた時点でサーバーが準備できていたかも分かります。シークレットチャットで試した後でも、`bun run admin log` で「いつ、誰として、どのツールで、何を依頼し、どの決定と資料を返したか」を確認できます。過去のチャットを参照したかどうかはClaudeのアプリ側の動きなので、このログには残りません。

管理コマンドは、AIが応答している最中には実行しないでください（PGLiteは同時に1つのプロセスしか開けないため）。

Claude Desktopを使わずに中身を確かめるときは、`bun run admin context "A社の提案価格は？"` で、AIに渡るテキストをそのまま表示できます。

## 2.5 自動で試験を回す（Claude Code）

Claude Desktopで1回ずつ試す代わりに、Claude Codeを画面なしで動かして、同じ依頼を何回も自動で流します。サブスクリプションの範囲で動くので、APIキーは不要です。

```bash
which claude                     # 入っていなければ、Claude Codeを公式の手順で入れてログインする
cd core
bun run admin reset
bun run trials --n 3             # eval/prompts.json の6つの依頼を、それぞれ3回
```

- メール、ドライブ、Notionを模した「おとり」のツール（中身は空）も一緒に渡し、Claude Desktopで起きた競合を再現します。おとりなしで測るときは `--decoys off` を付けます。
- `--names off` を付けると、`get_context` の説明文から案件名を外して試します。名前ありとの比較用です。
- 表の「最初の呼び出しで案件を特定」は、アクセスログを見て、1回目の `get_context` で案件が特定できた回数を数えたものです。
- 依頼は `eval/prompts.json` にあります。取引先名あり、担当者名だけ、案件名なし（呼ぶべきでない）などを混ぜています。
- 結果は表で表示され、各回のツールの使用順と回答が `eval/trials/` に保存されます。設定を変えて比べるときは `--label 名前` を付けます。
- 依頼の回数だけサブスクリプションの利用枠を使います。まずは `--n 3` から始めてください。
- Claude Codeは、Claude Desktopのチャットとは前提の指示が違います。この試験は「説明文やツール構成を変えたときに、呼ばれ方がどう変わるか」を素早く比べるためのものです。最終確認は、Claude Desktopで行います。

## 3. コアの実証シナリオを動かす

```bash
cd core
bun test                       # PGLiteで実行（追加のインストール不要）
```

9件のテスト（`core/test/scenario.test.ts`）は、企画書10章のシナリオを順に確かめます。

- 承認前の12万円は候補のまま扱われる
- approverだけが承認できる
- 承認後は現行12万円・旧10万円になり、旧提案書に「現行ではない」の注釈が付く
- 別名「エー社」でも案件が特定される
- 13万円への変更は適用日の前後で切り替わる
- 過去の任意の日付で、有効だった価格を再現できる
- 権限のない人にはA社の情報が返らない
- 社外秘の案件は、上限の低い出力先には渡らない
- 案件が特定できない依頼には何も差し込まない

PostgreSQL＋pg_bigmで実行する場合は、下の参考の手順でデータベースを用意してから、`SB_ENGINE=postgres SB_DATABASE_URL=postgres://postgres@127.0.0.1:5433/sbcore bun test` を実行します。PGLiteではpg_bigmが使えないので、同じ計算をJavaScript側で行います。

## （参考）PostgreSQL＋pg_bigmを用意する

### PostgreSQLを用意する

どちらか一方で用意します。いずれもMacでは未検証です。

- Docker：`cd docker && docker compose up -d`（ポート5433で起動）
- Homebrew：`brew install postgresql@16` の後、pg_bigmをソースからビルド
  （`git clone https://github.com/pgbigm/pg_bigm && cd pg_bigm && make USE_PGXS=1 PG_CONFIG=$(brew --prefix postgresql@16)/bin/pg_config && make USE_PGXS=1 PG_CONFIG=... install`）

## （参考）検索比較（PostgreSQL側）を再実行する

```bash
pip install "psycopg[binary]"
GBRAIN_HOME=<gbrainの作業用ディレクトリ> python3 eval/run_search_eval.py
```

`DSN` はスクリプト冒頭で変更します。gbrainは、`corpus/` を取り込んだ作業用のbrainを使います（`gbrain init --pglite` → `gbrain import corpus --no-embed`）。普段使っているbrainには取り込まないでください。

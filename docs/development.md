# 開発の流れ

前提と原則は [CLAUDE.md](../CLAUDE.md)。ここでは、変更を入れてから版を出すまでの手順を書く。

## 役割

| 誰・どこ | すること |
| --- | --- |
| Claude Code（クラウドのセッション、または Mac） | 実装、テスト、L2 の評価、PR、CI が通った PR のマージ |
| 開発者（越石） | 仕様として何を選ぶかの判断、L3 の確認、版を出すかの判断 |
| Claude のプロジェクト「セカンドブレインUIプロジェクト」 | 方針の相談と、記事のチャットとの連携。仕様の正本はこのリポジトリに置き、プロジェクトには記事のチャットが読む写し（仕様変更の記録など）だけを置く |
| Mac（`~/project/coheads`） | `git pull` して、配布物を作り、Claude Desktop で L3 を確かめる |

## 確かめ方の3つの層

| 層 | 何を確かめるか | どこで | いつ |
| --- | --- | --- | --- |
| L1 自動テスト | コードの正しさ（台帳、権限、検索、食い違い、共有フォルダ、評価の仕組み）。配布物の拡張機能を Windows の Node で起動し、資料の読み込み・保存場所・承認ページ・データの消去を確かめる（`scripts/extension-check.mjs`） | `core/test/`、CI（Linux と Windows）が PR ごとに回す | 毎回 |
| L2 挙動の評価 | AI が場面ごとに正しく動くか。条件を固定し、同じ依頼を回数をそろえて回す | `eval/behavior/`。Claude Code の `claude -p` で回す | AI に渡す文言を変えたとき、版を出す前 |
| L3 Desktop の確認 | Desktop のチャットで呼ばれるか、画面に何が出るか、承認ページ | [docs/verification/desktop-checklist.md](verification/desktop-checklist.md) | 版を出す前 |

L2 と L3 の結果は、どちらも記録に残す。L3 は1回ずつなので、L3 だけを根拠に仕様を決めない。気になる動きは L2 のケースにして回数で確かめる。

## ブランチと PR

- main は常に配れる状態に保つ。直接 push しない。
- ブランチ名：`feat/…`（機能）、`fix/…`（不具合）、`eval/…`（評価のケースや仕組み）、`docs/…`（文書だけ）、`chore/…`（その他）。
- PR の説明に書くこと：
  - 変えたこと
  - 確かめたこと（L1、L2 を回したならスイートと結果ファイル）
  - 確かめていないこと
  - 仕様を変えたなら SC 番号
- マージはスカッシュ（1つの PR が1つのコミットになる）。
- コミットのメッセージ、PR、Issue に、Claude Code のセッションの URL（`claude.ai/code/session_…`）を入れない。リポジトリを公開すると誰でも見られるため。
- コミットの作者は「Hiroto Koshikoku <27053673+Zeninaido@users.noreply.github.com>」（GitHub の noreply）。個人のメールアドレスを入れない。
- マージは Claude Code が行う。条件は、CI の3つのジョブ（`L1 tests and build`、`L1 tests on PostgreSQL (pg_bigm)`、`Extension on Windows`）がすべて成功していること。GitHub の設定では必須にしていないので、この条件は運用で守る。
- 開発者の判断を待ってからマージするもの：仕様の選択が入る PR（SC 番号を新しく立てるもの、利用者に見える動きを変えるもの）、版を出す PR。PR の説明に「判断が要る点」を書き、開発者の返事を受けてからマージする。

## 版の番号

- ルートの `package.json` の `version` が正本。`bun run version:set X.Y.Z` で、`core/package.json`、拡張機能の `manifest.json`、プラグインの `plugin.json` に同じ番号を書く。MCP サーバーが名乗る版も `core/package.json` から読む。
- CI は `bun run version:check` で、ずれていないかを確かめる。
- M3 までは 0.x.y。利用者に見える動きが変わったら y を上げる。仕様の区切り（マイルストーン）で x を上げる。

## 版を出す

1. `CHANGELOG.md` の「未リリース」を、版の番号と日付の節にする。
2. `bun run version:set X.Y.Z`
3. L2 の core スイートを回す：`bun run eval --suite core`。結果（`eval/behavior/results/X.Y.Z/`）をコミットする。不合格のケースがあれば、直すか、理由を CHANGELOG に書いて出すかを判断する。
4. Mac で配布物を作り、L3 を確かめる。記録を `docs/verification/desktop-checklist.md` に足す。
5. PR をマージしたら、タグ `vX.Y.Z` を付けて push する。GitHub Actions がリリースを作り、`coheads.mcpb` と `coheads-plugin.zip` を添付する。

## 利用者への届け方（未決）

拡張機能（.mcpb）は自動では更新されない。利用者に新しい版をどう届けるかは、まだ決めていない（Issue で扱う）。

## 仕様の記録

- 仕様を変えたら `docs/spec-changes.md` に SC 番号で書く（何を変えたか、なぜ、何を見て、どこに反映したか）。
- 型や公開の約束を変えたら `docs/spec/interface-v0.md` も直す。M3 で凍結する。
- 仕様変更の記録は、Claude のプロジェクトの「仕様変更の記録」にも写す（記事のチャットが読むため）。

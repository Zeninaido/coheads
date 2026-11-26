# Coheads（コヘッズ）

チームの「いま有効な決定」を、AI に渡す仕組み。

AI に見積のメールを頼むと、古い提案書やメールに残っている価格で書いてしまうことがある。Coheads は、チームで承認された決定を、承認日と有効期間つきで記録しておき、AI が取引先あての文面を書く前に渡す。資料に残っている古い値には「現行ではない」と注釈を付ける。決定の記録がまだないチームでも、資料どうしの金額の食い違いを知らせる。

- 対象：Claude Desktop（チャット、Cowork）と Claude Code。ChatGPT などは今後。
- 入れ方：Claude Desktop の拡張機能を1つ入れて、資料フォルダと名前を選ぶだけ。ターミナルは要らない。
- データ：利用者のパソコンの中だけに保存する。チームで使うときは、共有フォルダ（Google Drive など）の中に決定の記録を置く。
- 開発：WalkOn（株式会社銭内堂）。ライセンスは Apache-2.0。

> 開発中（0.x）。M3 で公開する予定で、それまで仕様は変わる。

## 試す

1. [リリース](../../releases) から `coheads.mcpb` を取り、ダブルクリックして「インストール」を押す。
2. 設定で「資料フォルダ」を選ぶ。中のフォルダが1つずつ案件になる（例：`A社/`、`B社/`）。空のままにすると、架空のデモデータで試せる。
3. チームで使うときは、Claude のプロジェクトを1つ作り、[プロジェクトの指示](docs/setup/project-instructions.md)を入れる。そのプロジェクトの中のチャットが、チームの決定とつながる場所になる。
4. Cowork や Claude Code でも使うときは、プラグイン `coheads-plugin.zip` も入れる。

決定の候補は、AI との会話の中で出せる。承認は、このパソコンの中だけで開く承認ページ（http://127.0.0.1:4319/）で人が行う。

## 開発

前提と原則は [CLAUDE.md](CLAUDE.md)、手順は [docs/development.md](docs/development.md)。

```bash
cd core && bun install
bun run test            # 自動テスト
bun run build           # dist/ に拡張機能とプラグインを作る
bun run eval --dry      # 挙動の評価のファイル検査（費用なし）
```

| 文書 | 中身 |
| --- | --- |
| [docs/spec/interface-v0.md](docs/spec/interface-v0.md) | 公開インターフェース v0（M3 で凍結） |
| [docs/spec-changes.md](docs/spec-changes.md) | 仕様を変えた記録（SC 番号） |
| [eval/behavior/](eval/behavior/README.md) | AI の挙動の評価（場面、条件、結果） |
| [docs/verification/desktop-checklist.md](docs/verification/desktop-checklist.md) | Claude Desktop での確認の手順と記録 |
| [CHANGELOG.md](CHANGELOG.md) | 版ごとの変化 |

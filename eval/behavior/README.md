# L2：挙動の評価

AI が場面ごとに正しく動くかを、条件を固定し、同じ依頼を回数をそろえて確かめる。1回の結果では決めない。

実行は Claude Code の `claude -p`（自分のログイン、利用枠から）。API キーは要らない。各回ごとに、まっさらな保存先と、評価用の資料フォルダの複製を用意するので、前の回の結果は混ざらない。

## ファイル

| 場所 | 中身 |
| --- | --- |
| `cases/*.yaml` | 1つの場面：依頼文、使うデータ、合格条件 |
| `suites/*.yaml` | どのケースを、どの条件で、何回回すか |
| `fixtures/` | 評価用の資料フォルダ（架空）。[fixtures/README.md](fixtures/README.md) |
| `results/<版>/` | 回した結果。`.md` は表、`.json` は各回のツールの使用順・回答・判定 |
| `history/` | この仕組みを作る前の試験の結果（2026-11 の trials） |

## ケースの書き方

```yaml
id: quote-by-contact              # ファイル名と同じにする
title: 担当者名だけで見積メールを頼む
scene: S5 取引先あての文面を頼む  # docs/spec/acceptance.md の場面の ID と名前
prompt: 田中さんに送る見積のメールを書いて
data: demo                         # demo（組み込みの架空データ）か folder:<fixtures の名前>
min_pass: 1                        # 合格とする回の割合。取引先あての文面（S5、S7、S8）は 1、それ以外は 0.66（3回中2回。必要な回数は「割合×回数」の切り上げ）
expect:
  context: required                # required：この案件の決定がAIに届いた（ツールかフック）。none：どの案件も届いていない
  project: a-sha                   # context: required のとき、届くべき案件
  calls: [propose_decision]        # 呼ばれるべきツール（どれか1つ）
  includes_any: ["120,000", "12万"] # 回答に含むべき語（どれか1つ）
  excludes: ["Coheads", "台帳"]     # 回答に含んではいけない語
  judge:                           # 別の Claude が回答を読んで判定する。すべて成り立てば合格
    - 見積の金額として月額120,000円（税別）を使っている
```

- 判定（judge）は、文面の言い換えに強いが、1回ごとに少し費用がかかる。語で判定できるものは `includes_any` や `excludes` を使う。
- `context` は、AI がツールで取った分と、フックが差し込んだ分の両方を見る。

## スイートの書き方

```yaml
id: core
runs: 3          # 各ケース×条件を何回回すか
min_pass: 1      # 合格とする割合（1 = すべての回）
cases: "*"       # すべて、またはケースの id の一覧
conditions:
  - id: extension
    plugin: none         # none | skill | full（スキルとフック）
    decoys: realistic    # realistic（古い情報を返すメール・ドライブ・Notion・過去のチャット）| empty | none
    server: coheads      # coheads | rag（決定の記録なしの資料検索）| files（Coheadsなし、資料を直接読む）
```

## 回し方

```bash
bun run eval --dry                                  # ファイルの検査とサーバーの起動確認だけ（費用なし）
bun run eval --suite smoke                          # すぐ回せる確認（4ケース×1回）
bun run eval --suite core                           # 版を出す前（10ケース×2条件×3回）
bun run eval --suite core --cases conflict-grounded --runs 5
bun run eval --suite core --conditions plugin
```

終わると表が出て、`results/<版>/<日時>-<スイート>.md` と `.json` に保存される。合格しなかったときは終了コードが 1 になる。

## 結果の扱い

- 版を出す前の core スイートの結果はコミットする。
- AI に渡す文言を変えた PR では、関係するケースを回し、結果のファイルを PR に書く。
- 結果は、この評価の条件（Claude Code、このおとり、この資料）での振る舞い。Claude Desktop のチャットでの振る舞いは L3 で確かめる。

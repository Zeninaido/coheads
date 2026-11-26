# 公開インターフェース v0

外部の人がアダプターを書くときの土台になる、公開インターフェースの初版。M1〜M2の間は変更してよく、M3の公開時に凍結する。型はTypeScriptで示し、実装時にJSON Schemaを生成する。

> このファイルが正本。2026-11-26 に Claude Docs「共通セカンドブレイン｜技術・機能仕様 v0.2」のタブ「インターフェース v0」から移した。変更はここで行い、理由は [spec-changes.md](../spec-changes.md) に SC 番号つきで残す。実装の型は `core/src/types.ts`。

## 1. 基本の型

```ts
type ISODate = string;      // "2026-11-24"
type ISODateTime = string;  // "2026-11-24T15:10:00+09:00"

type Classification = 'public' | 'internal' | 'confidential' | 'restricted';

type SubjectRef =
  | { type: 'user'; id: string }
  | { type: 'group'; id: string }
  | { type: 'service'; id: string };  // 取り込み処理、ハーネスのフックなど

type ResourceRef =
  | { type: 'workspace'; id: string }
  | { type: 'project'; id: string }
  | { type: 'source'; id: string };

interface Workspace {
  id: string;
  kind: 'personal' | 'team';
  name: string;
}

interface Project {
  id: string;
  workspaceId: string;
  name: string;
  aliases: string[];  // 「A社」「エー社」「株式会社A」など
  defaultClassification: Classification;
}
```

案件の関係者（試し実装で追加）。担当者名だけの依頼から案件を特定するために使う。照合はサーバー側だけで行い、ツールの説明文には載せない。照合するのは、依頼した人が参照できる案件の関係者だけ。同じ名前が複数の案件にいるときは案件を決めず、確認を促す注意を返す。

```ts
interface ProjectContact {
  projectId: string;
  name: string;           // 例 "田中"（2文字以上）
  organization?: string;  // 例 "株式会社エー 情報システム部"
}
```

| 機密区分 | 意味 |
| --- | --- |
| public | 社外に出してよい |
| internal | 社内であれば共有してよい |
| confidential | 案件の関係者だけで扱う |
| restricted | 特定の人だけで扱う |

## 2. 権限

権限は「主体・関係・対象」の組で持つ。v0で使うのは案件単位の3種類だけだが、関係と対象の種類を増やすだけで、自由な割り振りに広げられる。

```ts
interface RelationTuple {
  subject: SubjectRef;
  relation: string;  // v0では 'admin' | 'member' | 'approver'
  resource: ResourceRef;
}
```

| 関係 | 対象 | できること |
| --- | --- | --- |
| admin | workspace | 情報源・メンバー・案件の設定 |
| member | project | 案件の情報をAI経由で参照する。決定の候補を出す |
| approver | project | 候補を承認・却下する |

- 個人ワークスペースでは、本人がadmin・member・approverを兼ねる。
- 検索の段階で権限を効かせるため、コアは問い合わせの前に「この人が見られる案件」を求め、入力側アダプターにはその案件だけを渡す。
- 将来の拡張例：案件の一部の資料だけ、特定の決定だけ、グループ単位の割り振り。この形はOpenFGAなどZanzibar系の権限エンジンと同じ考え方なので、必要になれば判定部分を置き換えられる。

## 3. 決定台帳

```ts
type DecisionStatus = 'candidate' | 'approved' | 'on_hold' | 'rejected' | 'retired';

type DecisionValue =
  | { type: 'money'; amount: number; currency: string;  // 例 currency: 'JPY'
      period?: 'monthly' | 'yearly' | 'one_time';   // 課金の単位（試し実装で追加）
      tax?: 'excluded' | 'included' }                // 税の扱い（試し実装で追加）
  | { type: 'number'; value: number; unit?: string }
  | { type: 'date'; date: ISODate }
  | { type: 'text'; text: string };

interface SourceRef {
  adapterId: string;
  uri: string;
  title?: string;
  updatedAt?: ISODateTime;
}

interface Decision {
  id: string;
  workspaceId: string;
  projectId: string;
  topicKey: string;        // 論点キー。同じ論点の決定どうしを結ぶ（例 "proposal.price"）
  label: string;           // 表示名（例 "提案価格"）
  value: DecisionValue;
  status: DecisionStatus;
  retiredReason?: 'superseded' | 'expired';
  validFrom?: ISODate;
  validTo?: ISODate;       // 空なら現行
  recordedAt: ISODateTime;
  recordedBy: SubjectRef;
  approvedBy?: SubjectRef;
  approvedAt?: ISODateTime;
  sources: SourceRef[];
  classification: Classification;
  supersedes?: string;     // 置き換えた決定のID
}

interface DecisionEvent {
  decisionId: string;
  at: ISODateTime;
  by: SubjectRef;
  type: 'proposed' | 'approved' | 'rejected' | 'put_on_hold' | 'retired' | 'shared_to_team';
  note?: string;
}

interface OpenItem {
  projectId: string;
  topicKey: string;
  label: string;   // 例 "納期"
  note?: string;   // 例 "顧客の稼働日程が未確定"
}
```

規則：

- 台帳は追記のみとする。状態の変更は`DecisionEvent`として記録し、過去の状態を後から再現できるようにする。
- 同じ案件・同じ論点キーで、承認済みかつ有効期間内の決定は常に1件だけとする。新しい決定が承認されると、古い決定はretired（superseded）になる。
- 候補（candidate）は、Context Packの「現行」に入れない。
- 個人からチームへの共有では、チーム側に新しいcandidateを作る。元の個人の決定は動かさない。
- 「現行」は状態ではなく有効期間で判定する（試し実装で追加）。状態は台帳上の扱い、有効期間は業務上の適用を表す。承認済みで適用日前の決定があるときも、その日時点で有効な値を正しく返すため。

共有フォルダに台帳を置くお試しの形（SC-12）では、`DecisionEvent` に当たる記録を `<フォルダ>/.coheads/events/` に1件1ファイルで書く（`core/src/sharedLedger.ts` の `LedgerEvent`）。

承認する人の変更も、同じ場所に1件1ファイルで書く（SC-22）。`{ v: 1, type: 'approver_added' | 'approver_removed', at, by, name }`。一覧は `team.json`（あれば）を最初の値として、変更を時刻順に当てて求める。承認は、その時刻の一覧で確かめる。一覧が空の間は、メンバー全員が承認でき、一覧を変えられる。空の一覧に人を加えると、加えた人（`by`）も一覧に入る。1人でも載ったら、承認と一覧の変更は載っている人だけができる。

知らない `type`（または `v` が 1 でない）記録は、新しい版が書いたものとして飛ばし、利用者に更新を促す。読める版になったら、最初から再生する。

Context Control Planeの構成との対応：

| CCP | 決定台帳 |
| --- | --- |
| DECISIONS | approvedの決定 |
| OPEN | OpenItem、またはon_holdの決定 |
| 受信箱 | candidateの決定 |
| NOW | v0では扱わない（案件の「現在の焦点」として後で検討） |

## 4. Context Pack

```ts
interface ContextPack {
  schema: 'context-pack/v0';
  requestId: string;
  generatedAt: ISODateTime;
  workspaceId: string;
  project?: { id: string; name: string; matchedBy: 'alias' | 'hint' | 'search' | 'contact' };
  current: DecisionView[];   // 承認済みで有効なもの
  previous: DecisionView[];  // 失効した旧決定（関係するものだけ）
  open: OpenItem[];          // 未確定の事項
  documents: AnnotatedDocument[];
  unavailableSources: { adapterId: string; reason: string }[];
  cautions: string[];        // 例 "納期を確定事項として書かない"
  conflicts?: MoneyConflict[]; // 資料どうしの金額の食い違い（試し実装で追加、SC-17）
  citation: string;          // 出典の表示。データとして渡し、AIへの指示文にはしない（試し実装で変更）
  ceiling: Classification;   // この出力先に渡した上限
  truncated: boolean;        // 分量の上限で省いたものがあるか
}

interface DecisionView {
  id: string;
  label: string;
  value: DecisionValue;
  status: DecisionStatus;
  validFrom?: ISODate;
  validTo?: ISODate;
  approvedAt?: ISODateTime;
  sources: SourceRef[];
}

interface AnnotatedDocument {
  id: string;          // get_documentで本文を取るためのID。手元のファイルの場所は渡さない（試し実装で追加）
  source: SourceRef;
  snippet: string;
  annotations: Annotation[];
}

interface Annotation {
  kind: 'superseded_value' | 'unapproved' | 'stale' | 'conflict';
  decisionId?: string;
  message: string;  // 例 "この文書の価格100,000円は11/24の承認で失効。現行は120,000円"
}
```

資料どうしの食い違い（試し実装で追加、SC-17・SC-18）：

```ts
interface MoneyConflict {
  label: string;                                    // 例 "金額（価格・見積）"
  values: { amount: number; mentions: MoneyMention[] }[];
  latest: MoneyMention;                             // 最も新しい記載（旧い値としての記載を除く）
  draft?: CandidateDraft;                           // 最も新しい記載が「決定」なら、候補の下書き
}

interface MoneyMention {
  amount: number;
  docId: string;       // doc:...
  title: string;
  updatedAt: ISODate;
  line: string;        // 金額が書かれた行
  signal?: 'decided' | 'undecided' | 'old';  // 書きぶり
}

interface CandidateDraft {
  projectId: string;
  label: string;
  amount: number;
  period?: 'monthly' | 'yearly' | 'one_time';
  tax?: 'excluded' | 'included';
  validFrom?: ISODate;
  sourceDocId: string;
  sourceTitle: string;
  approverInDoc?: string;  // 資料に書かれた承認者。記録の参考で、承認ではない
}
```

規則：

- 出力先の上限を超える機密区分のものは、Context Packを作る段階で除く。出力側で隠すのではない。
- 案件が特定できないときは`project`を空にし、決定も文書も返さない。フックはこのとき何も差し込まない。
- 分量の上限を超えたら`truncated`をtrueにする。
- 食い違いは、案件に承認済みの金額の決定がないときだけ返す。承認済みの決定があるときは、決定と資料への注釈で足りる。

## 5. 入力側アダプター

```ts
interface SourceAdapter {
  id: string;
  kind: 'folder' | 'gbrain' | 'rag' | 'semantic' | string;
  capabilities: {
    scopeByProject: boolean;  // 案件で絞った検索ができるか
    changeFeed: boolean;      // 変更を通知できるか
  };
  search(q: SourceQuery): Promise<SourceResult[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

interface SourceQuery {
  text: string;
  projectIds: string[];      // コアが権限で絞った後の案件だけ
  limit: number;
  locale: 'ja' | 'en';
  ceiling: Classification;   // 出力先の上限。機密区分の絞り込みも問い合わせの段階で行う（試し実装で追加）
}

interface SourceResult {
  source: SourceRef;
  snippet: string;
  projectId: string;
  classification?: Classification;
  score?: number;
}
```

`scopeByProject`がfalseのアダプターは、管理者が「この情報源はこの案件のもの」と対応づけた場合にだけ、その案件の検索に使う。

## 6. 出力側

```ts
interface DestinationProfile {
  id: string;               // 例 "claude-team", "chatgpt-plus", "copy"
  ceiling: Classification;  // 渡してよい上限
}

interface OutputRenderer {
  id: 'mcp' | 'rest' | 'copy' | 'hook' | string;
  render(pack: ContextPack): { format: 'json' | 'markdown' | 'text'; body: string };
}
```

## 7. コアのAPI

| メソッド | パス | 内容 |
| --- | --- | --- |
| POST | /v0/context | 依頼文と出力先からContext Packを返す |
| POST | /v0/candidates | 決定の候補を登録する（取り込み処理、ハーネスのフックなど） |
| POST | /v0/decisions/{id}/approve | 候補を承認する（approverのみ） |
| POST | /v0/decisions/{id}/reject | 候補を却下する（approverのみ） |
| POST | /v0/decisions/{id}/share | 個人の決定をチームへ候補として共有する |
| GET | /v0/projects/{id}/decisions | 案件の決定を一覧する |

MCPのツール（v0）：

- `get_context`（依頼文、案件のヒント）→ Context Pack
- `get_document`（資料のID）→ 本文。本文の取得も、権限と機密区分の確認を通る。資料がない場合と見る権限がない場合は、同じ返答にする（試し実装で追加）
- `propose_decision`（案件、論点、値、出典）→ 候補として登録する。出典に資料ID（`doc:`）を渡すと、資料の題名つきで記録する（試し実装で追加、SC-18）

AIからは承認できないようにする。承認を人の判断として残すため。

サーバーの説明では、メールやドライブを探す前に`get_context`を呼ぶよう、また台帳が過去の会話や記憶より新しいことを、AIに依頼する。ツールの説明文に案件名を載せるかは未決（試し実装では、載せる範囲を設定で切り替える）。

## 8. アクセスログ（試し実装で追加）

AIからの呼び出しを、中身ごとすべて記録する。履歴を残さないチャット（シークレットなど）でも、後から「何を渡したか」を確かめるため。

```ts
interface AccessLogEntry {
  seq: number;
  at: ISODateTime;
  userId: string;
  destination: string;   // 出力先のID
  tool: string;          // 例 "get_context"
  request: unknown;      // 呼び出しの引数
  projectId?: string;    // 特定した案件
  returned: unknown;     // 返したものの要約（決定、資料のIDなど）
}
```

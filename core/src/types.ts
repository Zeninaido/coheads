// Subset of the public interface v0 (see the "インターフェース v0" tab of the spec).

export type ISODate = string;
export type ISODateTime = string;

export type Classification = 'public' | 'internal' | 'confidential' | 'restricted';
export const CLASSIFICATION_ORDER: Classification[] = ['public', 'internal', 'confidential', 'restricted'];

export function withinCeiling(c: Classification, ceiling: Classification): boolean {
  return CLASSIFICATION_ORDER.indexOf(c) <= CLASSIFICATION_ORDER.indexOf(ceiling);
}

export type SubjectRef =
  | { type: 'user'; id: string }
  | { type: 'group'; id: string }
  | { type: 'service'; id: string };

export type ResourceRef =
  | { type: 'workspace'; id: string }
  | { type: 'project'; id: string }
  | { type: 'source'; id: string };

export interface RelationTuple {
  subject: SubjectRef;
  relation: string; // v0: 'admin' | 'member' | 'approver'
  resource: ResourceRef;
}

export type DecisionStatus = 'candidate' | 'approved' | 'on_hold' | 'rejected' | 'retired';

export type DecisionValue =
  | {
      type: 'money';
      amount: number;
      currency: string;
      period?: 'monthly' | 'yearly' | 'one_time'; // 課金の単位（月額・年額・一括）
      tax?: 'excluded' | 'included';               // 税の扱い（税別・税込）
    }
  | { type: 'number'; value: number; unit?: string }
  | { type: 'date'; date: ISODate }
  | { type: 'text'; text: string };

export interface SourceRef {
  adapterId: string;
  uri: string;
  title?: string;
  updatedAt?: ISODateTime;
}

export interface Decision {
  id: string;
  workspaceId: string;
  projectId: string;
  topicKey: string;
  label: string;
  value: DecisionValue;
  status: DecisionStatus;
  retiredReason?: 'superseded' | 'expired';
  validFrom?: ISODate;
  validTo?: ISODate;
  recordedAt: ISODateTime;
  recordedBy: SubjectRef;
  approvedBy?: SubjectRef;
  approvedAt?: ISODateTime;
  sources: SourceRef[];
  classification: Classification;
  supersedes?: string;
}

export interface OpenItem {
  projectId: string;
  topicKey: string;
  label: string;
  note?: string;
  /** Read from a document (SC-23): the line that says it is not settled, and where it is. */
  source?: { docId: string; title: string; date: string; line: string };
}

export interface DecisionView {
  id: string;
  label: string;
  value: DecisionValue;
  status: DecisionStatus;
  validFrom?: ISODate;
  validTo?: ISODate;
  approvedAt?: ISODateTime;
  sources: SourceRef[];
}

export interface Annotation {
  kind: 'superseded_value' | 'unapproved' | 'stale' | 'conflict';
  decisionId?: string;
  message: string;
}

export interface AnnotatedDocument {
  source: SourceRef;
  snippet: string;
  annotations: Annotation[];
}

export interface ContextPack {
  schema: 'context-pack/v0';
  requestId: string;
  generatedAt: ISODateTime;
  workspaceId: string;
  project?: { id: string; name: string; matchedBy: 'alias' | 'hint' | 'search' | 'contact' };
  current: DecisionView[];
  previous: DecisionView[];
  open: OpenItem[];
  documents: AnnotatedDocument[];
  unavailableSources: { adapterId: string; reason: string }[];
  cautions: string[];
  /** Amounts that disagree across documents while the ledger has no approved amount (see conflicts.ts). */
  conflicts?: import('./conflicts').MoneyConflict[];
  /** Newer documents that state a decided amount different from the current one; not recorded until approved (SC-23). */
  docCandidates?: import('./conflicts').DocCandidate[];
  citation: string;
  ceiling: Classification;
  truncated: boolean;
}

export interface DestinationProfile {
  id: string;
  ceiling: Classification;
}

export interface SourceQuery {
  text: string;
  projectIds: string[];
  limit: number;
  locale: 'ja' | 'en';
  ceiling: Classification; // spike addition: classification filter applied inside the query
}

export interface SourceResult {
  source: SourceRef;
  snippet: string;
  projectId: string;
  classification?: Classification;
  score?: number;
}

export interface SourceAdapter {
  id: string;
  kind: string;
  capabilities: { scopeByProject: boolean; changeFeed: boolean };
  search(q: SourceQuery): Promise<SourceResult[]>;
  health(): Promise<{ ok: boolean; detail?: string }>;
}

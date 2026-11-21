// WS11 · Anonymo Ventures: the step contracts every crew module shares (Ventures Backend spec, PART 3).
//
// A Venture is a DAG of Steps. Each Step has a role (which Mo does it), a kind, a fan-out and a selection rule, reads
// artifacts and writes artifacts. Every artifact carries a zone: SCOUT artifacts saw the target, CLEAN artifacts never
// did. A CLEAN step can never take a SCOUT artifact as input (Law 1); the orchestrator and the sandbox mount table both
// check it.

export const VENTURE_MODES = ["BUILD_BETTER", "DUPE_DROP", "FORK_FLIP", "IDEA_TO_LIVE", "TAKEOVER", "RUN"] as const;
export type VentureMode = (typeof VENTURE_MODES)[number];

export const ROLES = ["boss", "scout", "spec-filter", "strategist", "builder", "tester", "designer", "merchant", "adman", "red-team", "licence", "deployer"] as const;
export type Role = (typeof ROLES)[number];

export type Kind = "code" | "plan" | "copy" | "research" | "image" | "design" | "spec" | "scan" | "deploy";
export type Select = "tests" | "council-select" | "council-merge" | "single";
export type StepState = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "SKIPPED";
export type Zone = "SCOUT" | "CLEAN";

export const TIERS = ["solo", "crew", "gang", "syndicate"] as const;
export type Tier = (typeof TIERS)[number];

export type ArtifactKind =
  | "page"
  | "bundle"
  | "har"
  | "screenshot"
  | "spec"
  | "code"
  | "test"
  | "design"
  | "copy"
  | "image"
  | "plan"
  | "report"
  | "repo";

export type ArtifactRef = { sha256: string; kind: ArtifactKind; zone: Zone; name?: string };

export type Venture = {
  id: string;
  keyId: string;
  mode: VentureMode;
  /** keccak256(salt ‖ target url), so the target is never stored in clear after the run. */
  targetCommit?: string;
  capsUsd: { total: number; perStep: number };
  tier: Tier;
  status: VentureStatus;
  repoUrl?: string;
};
export type VentureStatus = "QUEUED" | "RUNNING" | "DONE" | "FAILED" | "CAPPED" | "CANCELLED";

export type Step = {
  id: string;
  ventureId: string;
  /** Short stable name inside the venture's DAG ("scout", "spec", "plan", ...). */
  key: string;
  role: Role;
  kind: Kind;
  zone: Zone;
  fanout: number;
  select: Select;
  /** Step keys this step waits for. */
  needs: string[];
  inputs: ArtifactRef[];
  outputs: ArtifactRef[];
  costUsd: number;
  capUsd: number;
  receiptIds: string[];
  state: StepState;
  error?: string;
};

// ---- the functional Spec: the only thing that crosses from SCOUT into CLEAN --------------------------------------

export type FeatureSpec = { id: string; name: string; area: string; description: string; evidence?: string[] };
export type FlowSpec = { id: string; name: string; steps: { name: string; kind: "page" | "form" | "action" | "choice"; fields?: string[] }[] };
export type FieldSpec = { name: string; type: "string" | "number" | "boolean" | "date" | "id" | "enum" | "object" | "array"; required?: boolean; values?: string[] };
export type EntitySpec = { name: string; fields: FieldSpec[] };
export type ApiShape = { method: string; path: string; request?: FieldSpec[]; response?: FieldSpec[] };
export type Plan = { name: string; priceUsdMonthly: number | null; limits: string[]; features: string[] };
export type PlanGrid = { currency: string; plans: Plan[] };
export type Theme = { id: string; theme: string; weight: number };
export type FileFormat = { name: string; extension: string; fields: string[] };
/** A dated observation the Adman's claim checker cites. Functional facts only, never quoted copy. */
export type Finding = { id: string; fact: string; observedAt: string; source: "pricing" | "flow" | "feature" | "api" | "reviews" | "archive" | "jobs" | "oss" };

export type Spec = {
  features: FeatureSpec[];
  flows: FlowSpec[];
  dataModels: EntitySpec[];
  apis: ApiShape[];
  pricing: PlanGrid;
  complaints: Theme[];
  formats: FileFormat[];
  findings: Finding[];
  /** Open-source projects the target appears to use (from bundle licence headers and package markers). */
  oss: { name: string; licence: string | null; url?: string }[];
};

export const emptySpec = (): Spec => ({ features: [], flows: [], dataModels: [], apis: [], pricing: { currency: "USD", plans: [] }, complaints: [], formats: [], findings: [], oss: [] });

// ---- events streamed over SSE and webhooks -----------------------------------------------------------------------

export type VentureEvent =
  | { type: "venture"; ventureId: string; status: VentureStatus; at: string; costUsd: number }
  | { type: "step"; ventureId: string; step: string; role: Role; state: StepState; at: string; costUsd: number; error?: string }
  | { type: "candidate"; ventureId: string; step: string; family: string; model: string; passRate: number | null; chosen: boolean; refused: boolean; at: string }
  | { type: "artifact"; ventureId: string; step: string; artifact: ArtifactRef; at: string }
  | { type: "log"; ventureId: string; step: string; role: Role; message: string; at: string };

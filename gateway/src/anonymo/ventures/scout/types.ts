// WS11 · Scout: the shapes the Scout sandbox hands to the Spec Filter (Ventures Backend spec, PART 4, Law 4).
//
// Everything here lives in the SCOUT zone. It saw the target, so it may hold the target's own words and code. Only the
// Spec Filter's output (a functional Spec plus its hash) ever reaches the CLEAN zone.

import type { ArtifactRef, EntitySpec, FieldSpec, FileFormat, PlanGrid, Theme } from "../types.ts";

/** A fixed, honest User-Agent. Robots rules for this token (and for `*`) are both honoured. */
export const SCOUT_UA_TOKEN = "AnonymoScout";
export const SCOUT_USER_AGENT = "AnonymoScout/1.0 (+https://anonymo.tech/scout)";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export type ScoutLimits = {
  /** HTML pages fetched from the target (search probes count). */
  maxPages: number;
  /** Total bytes read from every host in one run. */
  maxBytes: number;
  /** Minimum gap between two requests to the target. robots.txt Crawl-delay raises it (capped at 30 s). */
  delayMs: number;
  /** GET probes of literal public API URLs found in bundles. */
  maxApiProbes: number;
};

export const DEFAULT_LIMITS: ScoutLimits = { maxPages: 40, maxBytes: 8_000_000, delayMs: 1000, maxApiProbes: 8 };

export type ScoutArtifact = { ref: ArtifactRef; body: Uint8Array | string; meta: Record<string, unknown> };

export type Stop = { url: string; reason: string };

export type HarEntry = {
  method: string;
  url: string;
  status: number;
  mimeType: string;
  bytes: number;
  startedAt: string;
  timeMs: number;
  requestBody?: string;
  /** Kept only for JSON API responses, for shape inference. */
  responseBody?: string;
  resourceType?: string;
};

export type FormField = {
  name: string;
  type: string;
  label: string | null;
  required: boolean;
  maxLength?: number;
  minLength?: number;
  min?: string;
  max?: string;
  pattern?: string;
  options?: string[];
};

export type FormInfo = {
  action: string;
  method: string;
  fields: FormField[];
  submitLabel: string | null;
  role: "search" | "login" | "signup" | "other";
  hasPassword: boolean;
};

export type LinkInfo = { url: string; label: string; guard: string | null };

export type PageInfo = {
  url: string;
  path: string;
  title: string | null;
  siteName: string | null;
  headings: { level: number; text: string }[];
  nav: string[];
  buttons: string[];
  links: LinkInfo[];
  forms: FormInfo[];
  /** Visible paragraph and list text, for an optional summariser. Never leaves the SCOUT zone. */
  paragraphs: string[];
  scripts: string[];
  inlineScripts: string[];
  stylesheets: string[];
  artifact: string;
};

export type ApiObservation = { method: string; path: string; request?: FieldSpec[]; response?: FieldSpec[]; seenIn: ("bundle" | "har" | "probe")[] };

export type FlowState = { id: string; label: string; kind: "page" | "form" | "action" | "choice"; visited: boolean; guard: string | null; fields?: string[] };
export type FlowGraph = { name: string; states: FlowState[]; transitions: { from: string; to: string; label: string }[] };

export type OssMarker = { name: string; version: string | null; licence: string | null; source: "licence-header" | "package-marker" | "source-map" };

export type ArchiveCapture = { timestamp: string; status: string; digest: string };
export type ArchiveHistory = { captures: ArchiveCapture[]; grids: { timestamp: string; grid: PlanGrid }[] };

export type BundleInfo = { url: string; artifact: string; type: "js" | "css"; sourceMap: { url: string; sources: string[]; artifact: string } | null; deminified: string | null };

export type ScoutAnalysis = {
  startUrl: string;
  host: string;
  observedAt: string;
  pages: PageInfo[];
  bundles: BundleInfo[];
  apis: ApiObservation[];
  entities: EntitySpec[];
  flows: FlowGraph[];
  pricing: PlanGrid | null;
  archive: ArchiveHistory | null;
  jobs: { url: string; label: string }[];
  themes: Theme[];
  oss: OssMarker[];
  formats: FileFormat[];
  sitemaps: string[];
  robots: { found: boolean; crawlDelayMs: number | null };
  screenshots: number;
  har: HarEntry[];
};

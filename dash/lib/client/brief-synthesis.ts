import { parseSynthesisAnalysis, type BriefSynthesisAnalysis } from "../brief-synthesis.ts";
import type { BriefDocument } from "../brief-document.ts";
import {
  createWorkspaceClient,
  parseBrief,
  type ClientOptions,
  type RouteCard,
} from "./workspace.ts";

export type SynthesisScope = {
  briefId: string;
  projectId: string;
  document: BriefDocument;
};
export type SynthesisCapability = {
  configured: boolean;
  reason: string;
  limits: {
    sources: number;
    inputBytes: number;
    responseBytes: number;
    maxOutputTokens: number;
    quoteSeconds: number;
  };
};
export type SynthesisQuote = {
  id: string;
  maximumUsd6: string;
  expiresAt: string;
  maxOutputTokens: number;
  inputBytes: number;
  requestHash: string;
  routeVersionId: string;
  modelId: string;
  family: string;
  card: RouteCard;
  markupBps: number;
};
export type SynthesisRun = {
  id: string;
  briefId: string | null;
  sourceBriefId: string;
  projectId: string;
  evidenceHash: string;
  promptVersion: 1;
  outputVersion: 1;
  createdAt: string;
  approvalKey: string;
  state:
    | "quoted"
    | "queued"
    | "running"
    | "reconciliation_pending"
    | "awaiting_evaluation"
    | "valid"
    | "invalid"
    | "failed"
    | "cancelled";
  quote: SynthesisQuote;
  callId: string | null;
  errorCode: string | null;
  billing: null | {
    state: "held" | "running" | "captured" | "released" | "reconciliation_pending";
    maximumUsd6: string;
    actualUsd6: string | null;
  };
  result: null | {
    status: "valid" | "invalid" | "failed" | "cancelled";
    analysis: BriefSynthesisAnalysis | null;
    invalidReason: string | null;
    outputHash: string | null;
    createdAt: string;
  };
  metadataOnly: boolean;
};
export type SynthesisApproval = Readonly<{
  quoteId: string;
  idempotencyKey: string;
  approveMaximumUsd6: string;
}>;
export class BriefSynthesisError extends Error {
  readonly code: string;
  readonly status: number;
  readonly outcomeUnknown: boolean;
  constructor(code: string, message: string, status = 0, outcomeUnknown = false) {
    super(message);
    this.name = "BriefSynthesisError";
    this.code = code;
    this.status = status;
    this.outcomeUnknown = outcomeUnknown;
  }
}
export function synthesisErrorMessage(error: unknown) {
  return error instanceof BriefSynthesisError
    ? error.message
    : "Analysis status could not be checked. Read the saved request before continuing.";
}
function invalid(): never {
  throw new BriefSynthesisError(
    "INVALID_RESPONSE",
    "The analysis response could not be verified. Read the saved request before continuing.",
  );
}
const record = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : invalid();
function id(v: unknown): string {
  if (
    typeof v !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v)
  )
    return invalid();
  return v;
}
function text(v: unknown, max: number): string {
  if (
    typeof v !== "string" ||
    !v.trim() ||
    v.length > max ||
    /\p{Cc}/u.test(v.replace(/[\t\r\n]/g, ""))
  )
    return invalid();
  return v;
}
function integer(v: unknown, min: number, max: number): number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : invalid();
}
function bool(v: unknown): boolean {
  return typeof v === "boolean" ? v : invalid();
}
function hash(v: unknown): string {
  return typeof v === "string" && /^[a-f0-9]{64}$/.test(v) ? v : invalid();
}
function time(v: unknown): string {
  return typeof v === "string" &&
    v.length <= 30 &&
    Number.isFinite(Date.parse(v)) &&
    new Date(Date.parse(v)).toISOString() === v
    ? v
    : invalid();
}
function money(v: unknown): string {
  return typeof v === "string" &&
    /^(0|[1-9][0-9]{0,18})$/.test(v) &&
    BigInt(v) <= 9223372036854775807n
    ? v
    : invalid();
}
function nullable<T>(v: unknown, parse: (v: unknown) => T): T | null {
  return v === null ? null : parse(v);
}
function oneOf<T extends string>(v: unknown, values: readonly T[]): T {
  return typeof v === "string" && values.includes(v as T) ? (v as T) : invalid();
}
function cursor(v: unknown): string | null {
  return v === null
    ? null
    : typeof v === "string" && /^[A-Za-z0-9_-]{1,512}$/.test(v)
      ? v
      : invalid();
}
function code(v: unknown): string | null {
  return v === null
    ? null
    : typeof v === "string" && /^[A-Za-z0-9_]{1,100}$/.test(v)
      ? v
      : invalid();
}
function routeCard(value: unknown): RouteCard {
  const v = record(value);
  if (v.reviewed !== true || !["standard", "unverified"].includes(v.level as string))
    return invalid();
  const evidenceUrl =
    typeof v.evidenceUrl === "string" && v.evidenceUrl.length <= 2048 ? v.evidenceUrl : invalid();
  if (evidenceUrl) {
    const url = new URL(evidenceUrl);
    if (url.protocol !== "https:" || url.username || url.password) return invalid();
  }
  const upstream = v.upstreamProviders === undefined ? [] : v.upstreamProviders;
  if (!Array.isArray(upstream) || upstream.length > 32) return invalid();
  return {
    level: v.level as RouteCard["level"],
    reviewed: true,
    retentionDisclosure: text(v.retentionDisclosure, 8000),
    evidenceUrl,
    evidenceDate: text(v.evidenceDate, 40),
    plaintextVisibility:
      v.plaintextVisibility === undefined ? "unknown" : text(v.plaintextVisibility, 100),
    trainingUse: v.trainingUse === undefined ? "unknown" : text(v.trainingUse, 100),
    upstreamProviders: upstream.map((v) => text(v, 200)),
  };
}
function quote(value: unknown): SynthesisQuote {
  const v = record(value);
  return {
    id: id(v.id),
    maximumUsd6: money(v.maximumUsd6),
    expiresAt: time(v.expiresAt),
    maxOutputTokens: integer(v.maxOutputTokens, 1, 8192),
    inputBytes: integer(v.inputBytes, 1, 32768),
    requestHash: hash(v.requestHash),
    routeVersionId: id(v.routeVersionId),
    modelId: text(v.modelId, 300),
    family: text(v.family, 80),
    card: routeCard(v.card),
    markupBps: integer(v.markupBps, 0, 10000),
  };
}
export function parseSynthesisRun(
  value: unknown,
  scope: SynthesisScope,
  metadataOnly = false,
): SynthesisRun {
  const v = record(value);
  if (
    id(v.sourceBriefId) !== scope.briefId ||
    id(v.projectId) !== scope.projectId ||
    hash(v.evidenceHash) !== scope.document.evidenceHash ||
    (v.briefId !== null && id(v.briefId) !== scope.briefId) ||
    v.promptVersion !== 1 ||
    v.outputVersion !== 1 ||
    v.approvalKey !== `bs_${id(v.id)}` ||
    (metadataOnly
      ? v.metadataOnly !== true
      : v.metadataOnly !== undefined && v.metadataOnly !== false)
  )
    return invalid();
  const run: SynthesisRun = {
    id: id(v.id),
    briefId: nullable(v.briefId, id),
    sourceBriefId: scope.briefId,
    projectId: scope.projectId,
    evidenceHash: scope.document.evidenceHash,
    promptVersion: 1,
    outputVersion: 1,
    createdAt: time(v.createdAt),
    approvalKey: v.approvalKey as string,
    state: oneOf(v.state, [
      "quoted",
      "queued",
      "running",
      "reconciliation_pending",
      "awaiting_evaluation",
      "valid",
      "invalid",
      "failed",
      "cancelled",
    ]),
    quote: quote(v.quote),
    callId: nullable(v.callId, id),
    errorCode: code(v.errorCode),
    billing: null,
    result: null,
    metadataOnly,
  };
  if (v.billing !== null) {
    const b = record(v.billing);
    run.billing = {
      state: oneOf(b.state, ["held", "running", "captured", "released", "reconciliation_pending"]),
      maximumUsd6: money(b.maximumUsd6),
      actualUsd6: nullable(b.actualUsd6, money),
    };
    if (
      run.billing.maximumUsd6 !== run.quote.maximumUsd6 ||
      (run.billing.state === "captured" || run.billing.state === "released") !==
        (run.billing.actualUsd6 !== null) ||
      (run.billing.actualUsd6 !== null &&
        BigInt(run.billing.actualUsd6) > BigInt(run.billing.maximumUsd6)) ||
      (run.billing.state === "released" && run.billing.actualUsd6 !== "0")
    )
      return invalid();
  }
  if (v.result !== null) {
    const r = record(v.result);
    let analysis: BriefSynthesisAnalysis | null = null;
    const status = oneOf(r.status, ["valid", "invalid", "failed", "cancelled"]);
    if (metadataOnly && r.analysis !== null) return invalid();
    if (!metadataOnly && r.analysis !== null) {
      try {
        analysis = parseSynthesisAnalysis(r.analysis, scope.document.evidence);
      } catch {
        return invalid();
      }
    }
    if (
      (status === "valid" && !metadataOnly && analysis === null) ||
      (status !== "valid" && r.analysis !== null) ||
      status !== run.state
    )
      return invalid();
    run.result = {
      status,
      analysis,
      invalidReason: code(r.invalidReason),
      outputHash: nullable(r.outputHash, hash),
      createdAt: time(r.createdAt),
    };
    if (status === "valid" && (run.result.outputHash === null || run.result.invalidReason !== null))
      return invalid();
  }
  if (
    (run.state === "quoted" &&
      (run.callId !== null || run.billing !== null || run.result !== null)) ||
    (run.callId === null && run.billing !== null) ||
    (run.callId !== null && run.billing === null) ||
    ((run.state === "valid" || run.state === "invalid") && !run.result)
  )
    return invalid();
  return run;
}
export function synthesisApproval(run: SynthesisRun): SynthesisApproval {
  return Object.freeze({
    quoteId: run.quote.id,
    idempotencyKey: run.approvalKey,
    approveMaximumUsd6: run.quote.maximumUsd6,
  });
}
export function sameSynthesisTerms(a: SynthesisRun, b: SynthesisRun): boolean {
  return (
    a.id === b.id &&
    a.sourceBriefId === b.sourceBriefId &&
    a.projectId === b.projectId &&
    a.evidenceHash === b.evidenceHash &&
    a.approvalKey === b.approvalKey &&
    JSON.stringify(a.quote) === JSON.stringify(b.quote)
  );
}
export function synthesisPending(state: SynthesisRun["state"]) {
  return ["queued", "running", "reconciliation_pending", "awaiting_evaluation"].includes(state);
}
const messages: Record<string, string> = {
  INSUFFICIENT_BALANCE: "There is not enough available balance for this analysis.",
  INSUFFICIENT_FUNDS: "There is not enough available balance for this analysis.",
  QUOTE_EXPIRED: "This quote expired. No new request was approved.",
  REVISION_CONFLICT:
    "This Brief changed elsewhere. Refresh it before changing the selected analysis.",
  SENSITIVE_CONTENT: "Saved evidence contains secret-like text and cannot be sent for analysis.",
  SYNTHESIS_UNAVAILABLE: "Analysis generation is not configured. Saved results remain available.",
  EVIDENCE_CHANGED: "The source evidence changed. Reopen the saved Brief before continuing.",
  SYNTHESIS_INPUT_TOO_LARGE:
    "This Brief is too large for analysis. Save fewer or shorter responses.",
  UNSUPPORTED_SYNTHESIS_SOURCE: "This saved source contains unsupported control characters.",
  INVALID_OUTPUT_LIMIT: "Choose an output limit within this route’s reviewed maximum.",
  CONTENT_UNAVAILABLE:
    "This saved analysis is temporarily unavailable. Read its status again later.",
};
export function createBriefSynthesisClient(
  options: ClientOptions & { accountId: string },
  scope: SynthesisScope,
) {
  const owner = id(options.accountId);
  id(scope.briefId);
  id(scope.projectId);
  hash(scope.document.evidenceHash);
  const workspace = createWorkspaceClient(options);
  async function request(path: string, method = "GET", body?: unknown, mutation = false) {
    const abort = new AbortController(),
      relay = () => abort.abort();
    options.signal?.addEventListener("abort", relay, { once: true });
    if (options.signal?.aborted) abort.abort();
    const timer = setTimeout(relay, 30000);
    let dispatched = false;
    try {
      abort.signal.throwIfAborted();
      dispatched = true;
      const response = await (options.fetch ?? fetch)(`/api/${path}`, {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-Conclave-Account-Id": owner,
        },
        credentials: "same-origin",
        mode: "same-origin",
        redirect: "error",
        cache: "no-store",
        signal: abort.signal,
      });
      if (!response.headers.get("content-type")?.includes("application/json") || !response.body)
        return invalid();
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let content = "",
        bytes = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 262144) return invalid();
          content += decoder.decode(part.value, { stream: true });
        }
        content += decoder.decode();
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      abort.signal.throwIfAborted();
      const value = record(JSON.parse(content));
      if (!response.ok) {
        const e = record(value.error ?? value),
          errorCode =
            typeof e.code === "string" && /^[A-Z_]{1,100}$/.test(e.code)
              ? e.code
              : "REQUEST_FAILED";
        if (response.status === 401 && typeof window !== "undefined")
          window.dispatchEvent(
            new CustomEvent("conclave:session-change", {
              detail: { reason: "signed-out" },
            }),
          );
        throw new BriefSynthesisError(
          errorCode,
          response.status === 401
            ? "Your session changed. Sign in again to read this Brief."
            : (messages[errorCode] ??
                "The analysis request was not confirmed. Read its saved status before continuing."),
          response.status,
          mutation && response.status >= 500,
        );
      }
      return value;
    } catch (error) {
      if (options.signal?.aborted)
        throw new DOMException("Analysis request cancelled.", "AbortError");
      if (error instanceof BriefSynthesisError && error.status) throw error;
      throw new BriefSynthesisError(
        "UNCONFIRMED_RESPONSE",
        mutation
          ? "The request may have completed. Read its saved status before continuing."
          : "Analysis status could not be checked. Refresh to try again.",
        0,
        dispatched && mutation,
      );
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", relay);
    }
  }
  const parsedRun = (v: unknown, expected?: SynthesisRun) => {
    const parsed = parseSynthesisRun(v, scope);
    if (expected && !sameSynthesisTerms(expected, parsed)) return invalid();
    return parsed;
  };
  return {
    async capability(): Promise<SynthesisCapability> {
      const v = await request("briefs/synthesis/capabilities"),
        l = record(v.limits);
      return {
        configured: bool(v.configured),
        reason: text(v.reason, 100),
        limits: {
          sources: integer(l.sources, 1, 4),
          inputBytes: integer(l.inputBytes, 1, 32768),
          responseBytes: integer(l.responseBytes, 1, 32768),
          maxOutputTokens: integer(l.maxOutputTokens, 1, 8192),
          quoteSeconds: integer(l.quoteSeconds, 1, 120),
        },
      };
    },
    async routes() {
      return (await workspace.routes()).filter(
        (route) =>
          route.modality === "chat" &&
          route.available &&
          route.card.reviewed &&
          ["standard", "unverified"].includes(route.card.level) &&
          Date.parse(route.expiresAt) > Date.now(),
      );
    },
    async list(after?: string | null) {
      const v = await request(
        `briefs/${scope.briefId}/syntheses${after ? `?cursor=${encodeURIComponent(cursor(after)!)}` : ""}`,
      );
      if (!Array.isArray(v.runs) || v.runs.length > 20) return invalid();
      const runs = v.runs.map((v) => parseSynthesisRun(v, scope, true));
      if (new Set(runs.map((v) => v.id)).size !== runs.length) return invalid();
      return {
        runs,
        nextCursor: cursor(v.nextCursor),
        selectedRunId: nullable(v.selectedRunId, id),
      };
    },
    async get(runId: string, expected?: SynthesisRun) {
      const run = parsedRun((await request(`brief-syntheses/${id(runId)}`)).run, expected);
      if (run.id !== runId) return invalid();
      return run;
    },
    async quote(routeVersionId: string, maxOutputTokens: number) {
      const v = await request(`briefs/${scope.briefId}/synthesis/quote`, "POST", {
        evidenceHash: scope.document.evidenceHash,
        routeVersionId: id(routeVersionId),
        maxOutputTokens: integer(maxOutputTokens, 1, 8192),
      });
      const run = parsedRun(v.plan);
      if (
        run.state !== "quoted" ||
        run.quote.routeVersionId !== routeVersionId ||
        run.quote.maxOutputTokens !== maxOutputTokens ||
        JSON.stringify(run.quote) !== JSON.stringify(quote(v.quote))
      )
        return invalid();
      return run;
    },
    async approve(run: SynthesisRun, approval = synthesisApproval(run)) {
      if (JSON.stringify(approval) !== JSON.stringify(synthesisApproval(run))) return invalid();
      try {
        const v = await request(`brief-syntheses/${id(run.id)}/approve`, "POST", approval, true);
        return { run: parsedRun(v.run, run), replayed: bool(v.replayed) };
      } catch (error) {
        if (options.signal?.aborted || (error instanceof BriefSynthesisError && error.status))
          throw error;
        throw new BriefSynthesisError(
          "APPROVAL_UNCONFIRMED",
          "Approval may have completed. Recover this saved request using its original key.",
          0,
          true,
        );
      }
    },
    async cancel(runId: string) {
      const v = await request(`brief-syntheses/${id(runId)}/cancel`, "POST", {}, true);
      if (v.cancellationRequested !== true) return invalid();
    },
    async evaluate(run: SynthesisRun) {
      return parsedRun(
        (await request(`brief-syntheses/${id(run.id)}/evaluate`, "POST", {})).run,
        run,
      );
    },
    async select(revision: number, runId: string | null) {
      const v = await request(
        `briefs/${scope.briefId}/synthesis/selection`,
        "PATCH",
        {
          revision: integer(revision, 1, Number.MAX_SAFE_INTEGER),
          runId: runId === null ? null : id(runId),
        },
        true,
      );
      const brief = parseBrief(v.brief);
      if (
        brief.id !== scope.briefId ||
        brief.projectId !== scope.projectId ||
        brief.revision <= revision ||
        brief.document?.evidenceHash !== scope.document.evidenceHash ||
        (brief.document.synthesis?.runId ?? null) !== runId
      )
        return invalid();
      return brief;
    },
  };
}

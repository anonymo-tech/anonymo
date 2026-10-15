import { CHINESE_CHAT_MODELS } from '../../lib/chinese-models.ts';
export type View =
  | "room"
  | "compare"
  | "briefs"
  | "crosscheck"
  | "sanctum"
  | "routes"
  | "explainer"
  | "chapters"
  | "receipts"
  | "balance"
  | "developers"
  | "settings";
export type Privacy = "all" | "private" | "sealed";
export type RouteLevel =
  | "LOCAL"
  | "ZDR"
  | "IDENTITY_HIDDEN_CONTENT_VISIBLE"
  | "SEALED"
  | "E2EE_TO_SEALED"
  | "UNVERIFIED";
export type DemoModel = {
  id: string;
  name: string;
  family: string;
  monogram: string;
  kind: "Hosted" | "Private" | "Sealed";
  level: RouteLevel;
  specialty: string;
  cost: number;
  open: boolean;
  color: string;
};

export const MODELS: DemoModel[] = [
  {
    id: "claude",
    name: "Claude",
    family: "Anthropic",
    monogram: "C",
    kind: "Hosted",
    level: "IDENTITY_HIDDEN_CONTENT_VISIBLE",
    specialty: "Writing & considered reasoning",
    cost: 0.012,
    open: false,
    color: "#be6146",
  },
  {
    id: "gpt",
    name: "GPT",
    family: "OpenAI",
    monogram: "G",
    kind: "Hosted",
    level: "IDENTITY_HIDDEN_CONTENT_VISIBLE",
    specialty: "General reasoning & code",
    cost: 0.009,
    open: false,
    color: "#4b7769",
  },
  {
    id: "gemini",
    name: "Gemini",
    family: "Google",
    monogram: "G",
    kind: "Hosted",
    level: "IDENTITY_HIDDEN_CONTENT_VISIBLE",
    specialty: "Long context & analysis",
    cost: 0.008,
    open: false,
    color: "#597db2",
  },
  {
    id: "grok",
    name: "Grok",
    family: "xAI",
    monogram: "X",
    kind: "Hosted",
    level: "IDENTITY_HIDDEN_CONTENT_VISIBLE",
    specialty: "Fast reasoning & current events",
    cost: 0.006,
    open: false,
    color: "#3d3d3d",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    family: "DeepSeek",
    monogram: "D",
    kind: "Hosted",
    level: "UNVERIFIED",
    specialty: "Code & structured thinking",
    cost: 0.003,
    open: true,
    color: "#5164a4",
  },
  {
    id: "qwen",
    name: "Qwen",
    family: "Qwen",
    monogram: "Q",
    kind: "Hosted",
    level: "UNVERIFIED",
    specialty: "Open-weight model",
    cost: 0.005,
    open: true,
    color: "#76609b",
  },
  {
    id: "llama",
    name: "Llama",
    family: "Meta",
    monogram: "L",
    kind: "Hosted",
    level: "UNVERIFIED",
    specialty: "Open-weight model",
    cost: 0.004,
    open: true,
    color: "#287a93",
  },
  ...CHINESE_CHAT_MODELS.filter(model => !['deepseek', 'qwen'].includes(model.key)).map(model => ({
    id: model.key, name: model.name, family: model.publisher, monogram: model.name.charAt(0),
    kind: 'Hosted' as const, level: 'UNVERIFIED' as const, specialty: model.publisher,
    cost: 0, open: false, color: '#333333',
  })),
];

export const VIEW_NAMES: Record<View, string> = {
  room: "The room",
  compare: "Side by Side",
  briefs: "The Brief",
  crosscheck: "Cross-Check",
  sanctum: "Sanctum",
  routes: "Route Library",
  explainer: "Solana Explainer",
  chapters: "Chapters",
  receipts: "Receipts",
  balance: "Balance & usage",
  developers: "Developer tools",
  settings: "Settings",
};

export const SCENARIOS = [
  "How should a community-owned AI workspace earn trust?",
  "Compare open models and hosted models for research.",
  "What should I check before approving a Solana transaction?",
];

export const SAMPLE_ANSWERS: Record<
  string,
  { heading: string; body: string; points: string[]; emphasis: string }
> = {
  claude: {
    heading: "Trust starts with an honest boundary.",
    body: "Make privacy understandable at the moment someone chooses a model. Every route should state who receives the prompt, what is retained, and what cannot be promised.",
    points: [
      "Show a readable Route Card before a request.",
      "Refuse requests when the selected privacy level is unavailable.",
      "Let the user inspect disagreement, rather than hide it.",
    ],
    emphasis: "Start with clear language and verifiable limits.",
  },
  gpt: {
    heading: "Build the evidence into the workflow.",
    body: "Give people a way to examine the result, not just consume it. Independent model responses, source passages, and itemized costs make each decision easier to audit.",
    points: [
      "Compare independent model families side by side.",
      "Export a Brief containing sources, dissent and cost.",
      "Separate model confidence from verified evidence.",
    ],
    emphasis: "A useful answer should leave an inspectable trail.",
  },
  gemini: {
    heading: "Make the user an informed participant.",
    body: "A shared workspace needs understandable controls. Route visibility, a shared budget, and clear roles help teams decide which information can go where.",
    points: [
      "Use explicit privacy policies for each room.",
      "Give every member a visible spending allowance.",
      "Keep sources attached to the claims they support.",
    ],
    emphasis: "Design the controls around the team’s actual decisions.",
  },
  deepseek: {
    heading: "Treat refusal as a product feature.",
    body: "A privacy policy is only useful if the application enforces it. A failed guard or unavailable route should halt the request and explain the next safe step.",
    points: [
      "Run secret detection before a request is constructed.",
      "Use strict routing with no silent fallback.",
      "Return observable errors and release unused holds.",
    ],
    emphasis: "Make failure states as legible as successful answers.",
  },
  qwen: {
    heading: "Keep the boundary visible.",
    body: "Open models can offer a separate route for sensitive work. Sealed execution needs verified hardware evidence and an encrypted request path before the interface claims it is active.",
    points: [
      "Verify host measurements before encryption.",
      "Reject a request if attestation verification fails.",
      "Explain that hardware sealing has its own limits.",
    ],
    emphasis: "A sealed label must describe evidence, not a feeling.",
  },
  llama: {
    heading: "Let the community inspect the system.",
    body: "A community workspace should make its rules and usage inspectable. Small, clear controls often do more for confidence than broad promises of privacy.",
    points: [
      "Publish the meaning of every route level.",
      "Expose receipts without exposing prompt content.",
      "Let teams revoke helpers and change their limits.",
    ],
    emphasis: "Clear rules turn a shared tool into shared understanding.",
  },
};

export type GuardResult = {
  type: "key" | "secret" | "injection";
  message: string;
  redacted?: string;
};

/** A deliberately limited local pattern demonstration, not the production guard corpus. */
export function scanPrompt(value: string): GuardResult | null {
  const arrayMatch = value.match(/\[(?:\s*\d{1,3}\s*,){63}\s*\d{1,3}\s*\]/);
  const hasByteArray =
    arrayMatch &&
    (() => {
      try {
        const array = JSON.parse(arrayMatch[0]);
        return (
          array.length === 64 && array.every((n: number) => n >= 0 && n <= 255)
        );
      } catch {
        return false;
      }
    })();
  if (
    /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/.test(value) ||
    /\b(?:0x)?[a-f0-9]{64}\b/i.test(value) ||
    hasByteArray ||
    /\b(?:abandon\s+){11}(?:about|abandon)\b/i.test(value) ||
    /\b(?:seed phrase|recovery phrase|private key)\s*[:=]\s*\S+/i.test(value)
  ) {
    return {
      type: "key",
      message:
        "This looks like a private key or recovery phrase. Nothing was sent. Remove it before continuing.",
    };
  }
  const secret =
    /(?:\b(?:sk|pk|rk)[-_][a-z0-9_-]{12,}|\b(?:ghp|github_pat)_[a-z0-9_]{12,}|\bAKIA[A-Z0-9]{16}\b|\beyJ[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+\.[a-zA-Z0-9_-]+|-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)|\b(?:API_KEY|SECRET_KEY|ACCESS_TOKEN|PASSWORD)\s*=\s*[^\s]+)/gi;
  if (secret.test(value)) {
    secret.lastIndex = 0;
    return {
      type: "secret",
      message:
        "A secret-like pattern was found. Nothing was sent. Remove it, or replace the matched text locally.",
      redacted: value.replace(secret, "[REDACTED SECRET]"),
    };
  }
  if (
    /ignore (?:all |the )?(?:previous|prior) instructions|reveal (?:your |the )?system prompt/i.test(
      value,
    )
  )
    return {
      type: "injection",
      message:
        "Instruction-like pasted content detected. Treat this text as quoted data. Review and remove the instruction before continuing.",
    };
  return null;
}

export function allowedRoute(model: DemoModel, privacy: Privacy) {
  return (
    privacy === "all" ||
    (privacy === "sealed"
      ? model.kind === "Sealed" && model.open
      : model.kind !== "Hosted")
  );
}

export type Member = {
  id: number;
  name: string;
  role: "Owner" | "Officer" | "Member" | "Guest";
  cap: number;
};
export type Brief = {
  id: string;
  title: string;
  models: string[];
  date: string;
  decision: string;
  sample: true;
};
export function isBrief(value: unknown): value is Brief {
  if (!value || typeof value !== "object") return false;
  const b = value as Brief;
  return (
    b.sample === true &&
    typeof b.id === "string" &&
    b.id.length > 0 &&
    b.id.length < 100 &&
    typeof b.title === "string" &&
    b.title.length <= 8000 &&
    Array.isArray(b.models) &&
    b.models.length > 0 &&
    b.models.length <= 4 &&
    b.models.every(
      (id) => typeof id === "string" && MODELS.some((model) => model.id === id),
    ) &&
    typeof b.date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(b.date) &&
    typeof b.decision === "string" &&
    b.decision.length <= 3000
  );
}
export function isMember(value: unknown): value is Member {
  if (!value || typeof value !== "object") return false;
  const m = value as Member;
  return (
    typeof m.name === "string" &&
    m.name.trim().length > 0 &&
    m.name.length <= 50 &&
    typeof m.id === "number" &&
    Number.isFinite(m.id) &&
    m.id > 0 &&
    ["Owner", "Officer", "Member", "Guest"].includes(m.role) &&
    typeof m.cap === "number" &&
    Number.isFinite(m.cap) &&
    m.cap >= 0 &&
    m.cap <= 10000
  );
}
export const INITIAL_MEMBERS: Member[] = [
  { id: 1, name: "You", role: "Owner", cap: 100 },
  { id: 2, name: "Sample officer", role: "Officer", cap: 50 },
  { id: 3, name: "Sample member", role: "Member", cap: 25 },
];
export const INITIAL_BRIEFS: Brief[] = [
  {
    id: "sample-brief-001",
    title: SCENARIOS[0],
    models: ["claude", "gpt", "qwen"],
    date: "2026-10-06",
    decision: "Begin with Route Cards and fail-closed privacy controls.",
    sample: true,
  },
];

export function downloadFile(
  name: string,
  content: string,
  type = "text/plain",
) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function briefMarkdown(brief: Brief) {
  return `# Conclave Brief\n\n> LOCAL DEMO · Sample responses. No models called, no payment made.\n\n## Question\n${brief.title}\n\n## Independent perspectives (illustrative)\n${brief.models.map((id) => `### ${MODELS.find((m) => m.id === id)?.name || id}\n${SAMPLE_ANSWERS[id]?.body || ""}\n${SAMPLE_ANSWERS[id]?.points.map((p) => `- ${p}`).join("\n") || ""}`).join("\n\n")}\n\n## Agreement\nAll sample responses prioritize explicit boundaries and inspectable evidence.\n\n## Differences\nThe samples emphasize user communication, auditable workflow, and sealed execution respectively.\n\n## Sources\nConclave product overview (sample source). These are product specifications, not independently verified evidence.\n\n## Cost\n0 USDC charged. Displayed route estimates are illustrative.\n\n## Your decision\n${brief.decision || "Not yet recorded."}\n\nCreated: ${brief.date}\n`;
}

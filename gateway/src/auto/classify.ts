// Auto Model (`anonymo-auto`): what kind of request this is, read from the request itself. Pure and deterministic: no
// model call, no network, no clock, no randomness, and nothing is stored. The same request always gets the same class.
//
//   vision     an image part is present (only image-capable models can serve it)
//   code       tools or functions, a code fence, or programming signals in the latest turns
//   roleplay   a character card (`@character/...`), a roleplay system prompt, or second-person scene narration
//   reasoning  math, logic, "step by step", or a long analytical question
//   general    everything else
//
// Precedence, strongest first: vision > code (tools) > roleplay (card or system prompt) > code (text) > roleplay
// (narration) > reasoning > general. A capability the request needs (images, tools) always wins over a style.

export const AUTO_CLASSES = ["code", "roleplay", "reasoning", "vision", "general"] as const;
export type AutoClass = (typeof AUTO_CLASSES)[number];

type Msg = { role?: unknown; content?: unknown };

const IMAGE_PART = new Set(["image_url", "input_image", "image"]);

/** The text of a message's content (a string, or the text parts of a content array). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
    .filter(Boolean)
    .join("\n");
}

const hasImage = (content: unknown) =>
  Array.isArray(content) && content.some((p) => p && typeof p === "object" && IMAGE_PART.has(String((p as { type?: unknown }).type)));

const nonEmpty = (v: unknown) => (Array.isArray(v) ? v.length > 0 : v != null && v !== false);

// ---- code --------------------------------------------------------------------------------------------------------

const FENCE = /```|~~~/;
/** One match is enough: these only show up in code, stack traces or shell sessions. */
const STRONG_CODE = [
  /\bdef\s+\w+\s*\(/,
  /\bfunction\s*\w*\s*\([^)]*\)\s*\{/,
  /\b(?:const|let|var)\s+\w+\s*=\s*(?:\(|async\b|function\b|require\(|await\b|\[|\{)/,
  /\bimport\s+[\w{},*\s]+\s+from\s+['"]/,
  /^\s*(?:from\s+[\w.]+\s+)?import\s+[\w.]+(?:\s+as\s+\w+)?\s*$/m,
  /#include\s*<\w+/,
  /\bpublic\s+(?:static\s+)?(?:void|class|int|string)\b/i,
  /\bconsole\.log\(|\bprint\(f?["']|\bSystem\.out\.println\(/,
  /\bTraceback \(most recent call last\)|\b(?:TypeError|ReferenceError|SyntaxError|NullPointerException|Segmentation fault)\b/,
  /\bSELECT\s+[\w*,\s.]+\s+FROM\s+\w+/i,
  /^\s*\$\s+(?:npm|pnpm|yarn|bun|pip|cargo|go|git|docker|kubectl|make)\s/m,
  /\b(?:fn\s+\w+\s*\(|impl\s+\w+\s+for\s+\w+|func\s+\w+\s*\()/,
  /<\/?(?:div|span|script|html|body)\b[^>]*>/i,
];
/** Words that point at programming; two different ones are needed (one alone is common in plain speech). */
const WEAK_CODE = [
  /\bcode\b/i, /\bcoding\b/i, /\bprogram(?:ming)?\b/i, /\bfunction\b/i, /\bscript\b/i, /\bdebug(?:ging)?\b/i, /\brefactor/i,
  /\bcompil(?:e|er|ing)\b/i, /\bregex\b/i, /\bapi\b/i, /\bendpoint\b/i, /\bunit tests?\b/i, /\bstack trace\b/i, /\bbug\b/i,
  /\bpython\b/i, /\bjavascript\b/i, /\btypescript\b/i, /\brust\b/i, /\bgolang\b/i, /\bjava\b/i, /\bc\+\+/i, /\bsql\b/i,
  /\breact\b/i, /\bnode(?:\.js)?\b/i, /\bbash\b/i, /\bjson\b/i, /\bclass\b/i, /\bvariable\b/i, /\bgit\b/i, /\brepo(?:sitory)?\b/i,
  /\.(?:py|ts|tsx|js|jsx|rs|go|java|cpp|rb|php|sql|sh|yaml|yml)\b/i,
];

function codeSignals(text: string): boolean {
  if (FENCE.test(text)) return true;
  if (STRONG_CODE.some((re) => re.test(text))) return true;
  let weak = 0;
  for (const re of WEAK_CODE) if (re.test(text) && ++weak >= 2) return true;
  return false;
}

// ---- roleplay ----------------------------------------------------------------------------------------------------

/** A system prompt that sets up a character or a roleplay. */
const RP_SYSTEM = [
  /\{\{\s*(?:char|user)\s*\}\}/i,
  /\b(?:role-?play(?:ing)?|in character|stay in character|never break character|character card|first_mes|mes_example)\b/i,
  /\b(?:persona|scenario)\s*:/i,
  /\bRP\b/,
  /\byou are (?:playing|roleplaying|role-playing|portraying)\b/i,
  /\bplay the (?:role|part) of\b/i,
  /\bnext reply in an? (?:fictional )?(?:chat|story|roleplay|role-play|scene)\b/i,
  /\b(?:personality|appearance|backstory)\s*:/i,
];
/** A user turn that asks for, or is written as, a roleplay. */
const RP_USER = [/\b(?:let'?s|lets) (?:role-?play|rp)\b/i, /\brole-?play (?:as|with)\b/i, /\bstay in character\b/i];
/** `*smiles and leans closer*`: an action written between asterisks. */
const ACTION = /(?:^|\s)\*[^*\n]{3,80}\*(?=\s|$|[.,!?])/m;
/** Second-person scene narration: several sentences that start with "You <verb>". */
const SECOND_PERSON = /(?:^|[.!?]\s+|\n)\s*you\s+(?:walk|step|enter|see|hear|feel|notice|turn|open|wake|find|stand|sit|look|reach|smell|follow|approach|are standing|are sitting)\b/gi;

function roleplayNarration(text: string): boolean {
  if (RP_USER.some((re) => re.test(text))) return true;
  if (ACTION.test(text)) return true;
  return (text.match(SECOND_PERSON)?.length ?? 0) >= 2;
}

// ---- reasoning ---------------------------------------------------------------------------------------------------

const REASONING = [
  /\bstep[- ]by[- ]step\b/i, /\bthink (?:it )?through\b/i, /\bshow (?:your|the) (?:work|reasoning)\b/i,
  /\b(?:prove|proof|theorem|lemma|derive|derivation)\b/i,
  /\b(?:solve|calculate|compute|evaluate)\b[^.?!\n]{0,60}(?:\d|equation|integral|expression|probability|sum|limit)/i,
  /\b(?:integral|derivative|equation|polynomial|matrix|eigen\w*|probability|combinatorics|logarithm|modulo|prime number)s?\b/i,
  /\d+(?:\.\d+)?\s*[*×÷^]\s*\(?\d|\d\s+[-+/=]\s+\(?\d|\bwhat is\s+\d+(?:\.\d+)?\s*[-+*/x×÷^]\s*\d|\d+\s+mod\s+\d/i,
  /\b(?:logic puzzle|riddle|syllogism|paradox|brain ?teaser)\b/i,
  /\bif\b[^.?!\n]{3,80}\bthen\b[^.?!\n]{3,80}\?/i,
];
const ANALYTICAL = /\b(?:analy[sz]e|compare|contrast|evaluate|trade-?offs?|pros and cons|explain why|why does|why do|what would happen|implications?|assess|critique)\b/i;
/** A question this long with an analytical ask is treated as reasoning. */
export const LONG_QUESTION_CHARS = 400;

function reasoningSignals(text: string): boolean {
  if (REASONING.some((re) => re.test(text))) return true;
  return text.length >= LONG_QUESTION_CHARS && text.includes("?") && ANALYTICAL.test(text);
}

// ---- the classifier ----------------------------------------------------------------------------------------------

export type ClassifyInput = {
  /** The request body (chat or completion). Read only. */
  body: Record<string, unknown>;
  kind: "chat" | "completion";
  /** A character card was resolved for this request (`@character/<id>` or POST /api/v1/characters/:id/chat). */
  character?: boolean;
};

/** How many of the latest messages are read for code and image signals (earlier turns rarely decide the next one). */
export const RECENT_MESSAGES = 4;

/** The class of one request. Deterministic: the same input always gives the same class. */
export function classifyRequest({ body, kind, character }: ClassifyInput): AutoClass {
  const messages: Msg[] = kind === "chat" && Array.isArray(body.messages) ? (body.messages as Msg[]).filter((m) => m && typeof m === "object") : [];
  const prompt = kind === "completion" ? (Array.isArray(body.prompt) ? body.prompt.filter((x) => typeof x === "string").join("\n") : typeof body.prompt === "string" ? body.prompt : "") : "";
  const recent = messages.slice(-RECENT_MESSAGES);

  // 1. Images: only image-capable models can read them. Every message counts (an earlier image is still in context).
  if (messages.some((m) => hasImage(m.content))) return "vision";

  // 2. Tools or functions: the model must call them.
  if (nonEmpty(body.tools) || nonEmpty(body.functions) || (body.tool_choice != null && body.tool_choice !== "none")) return "code";

  const system = messages.filter((m) => m.role === "system" || m.role === "developer").map((m) => textOf(m.content)).join("\n");
  const lastUser = kind === "completion" ? prompt : textOf([...messages].reverse().find((m) => m.role === "user")?.content ?? "");

  // 3. A character card or a roleplay system prompt.
  if (character || RP_SYSTEM.some((re) => re.test(system))) return "roleplay";

  // 4. Code in the latest turns (a fence, a stack trace, source, or two programming words in the user's turn).
  const recentText = kind === "completion" ? prompt : recent.filter((m) => m.role === "user" || m.role === "assistant" || m.role === "tool").map((m) => textOf(m.content)).join("\n");
  if (FENCE.test(recentText) || codeSignals(lastUser)) return "code";

  // 5. A roleplay written in the user's own turn.
  if (roleplayNarration(lastUser)) return "roleplay";

  // 6. Math, logic, or a long analytical question. A request that asks for reasoning output counts too.
  const asksReasoning = (nonEmpty(body.reasoning) && (body.reasoning as { enabled?: unknown }).enabled !== false) || body.include_reasoning === true;
  if (asksReasoning || reasoningSignals(lastUser)) return "reasoning";

  return "general";
}

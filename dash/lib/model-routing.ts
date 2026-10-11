export const ROUTING_TASKS = [
  'general',
  'code',
  'reasoning',
  'writing',
  'long_context',
] as const;
export type RoutingTask = (typeof ROUTING_TASKS)[number];
export const ROUTING_TASK_LABELS: Record<RoutingTask, string> = {
  general: 'General questions',
  code: 'Code',
  reasoning: 'Reasoning',
  writing: 'Writing',
  long_context: 'Long context',
};
export type RoutingProfile = {
  version: 1;
  tasks: RoutingTask[];
  evidenceUrl: string;
  reviewedAt: string;
};
export type RouteRecommendation = {
  version: 1;
  task: RoutingTask;
  routeVersionId: string;
  eligibleCount: number;
  maximumUsd6: string;
  reason: string;
};

/** Structural validation only. The registry also checks evidence origins and review freshness. */
export function parseRoutingProfile(value: unknown): RoutingProfile {
  const invalid = (): never => {
    throw new Error('INVALID_ROUTING_PROFILE');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return invalid();
  const entry = value as Record<string, unknown>;
  if (
    Object.keys(entry).sort().join(',') !==
      'evidenceUrl,reviewedAt,tasks,version' ||
    entry.version !== 1 ||
    !Array.isArray(entry.tasks) ||
    entry.tasks.length < 1 ||
    entry.tasks.length > ROUTING_TASKS.length ||
    entry.tasks.some((task) => !ROUTING_TASKS.includes(task as RoutingTask)) ||
    new Set(entry.tasks).size !== entry.tasks.length ||
    typeof entry.reviewedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.reviewedAt) ||
    !Number.isFinite(Date.parse(entry.reviewedAt)) ||
    new Date(entry.reviewedAt).toISOString() !== entry.reviewedAt ||
    typeof entry.evidenceUrl !== 'string' ||
    entry.evidenceUrl.length > 2048 ||
    entry.evidenceUrl.trim() !== entry.evidenceUrl ||
    Array.from(entry.evidenceUrl).some(
      (character) =>
        /\s/u.test(character) ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127,
    )
  )
    return invalid();
  try {
    const url = new URL(entry.evidenceUrl);
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return invalid();
    return {
      version: 1,
      tasks: [...entry.tasks] as RoutingTask[],
      evidenceUrl: url.toString(),
      reviewedAt: entry.reviewedAt,
    };
  } catch {
    return invalid();
  }
}

export function routingProfileFresh(
  profile: RoutingProfile,
  nowMs: number,
  routeExpiresAt: string,
): boolean {
  const reviewed = Date.parse(profile.reviewedAt),
    expires = Date.parse(routeExpiresAt);
  return (
    Number.isFinite(nowMs) &&
    Number.isFinite(reviewed) &&
    Number.isFinite(expires) &&
    reviewed <= nowMs &&
    nowMs < reviewed + 86_400_000 &&
    nowMs < expires &&
    expires <= reviewed + 86_400_000
  );
}

export class ModelRoutingError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelRoutingError';
    this.code = code;
  }
}
export type MentionRoute = {
  versionId: string;
  modelId: string;
  family: string;
  available: boolean;
  expiresAt: string;
};
const aliases = new Set([
  'claude',
  'gpt',
  'gemini',
  'grok',
  'deepseek',
  'qwen',
  'llama',
]);

/**
 * Routing commands are known @family names or explicit @{exact-model-id}.
 * Email/URL tokens, escaped mentions, fenced/indented code, inline code and
 * blockquotes stay literal. Unknown plain handles stay literal; unknown explicit
 * model IDs fail closed. Only matched commands are removed from the question.
 */
export function resolveModelMentions(
  source: string,
  routes: readonly MentionRoute[],
  nowMs = Date.now(),
): { prompt: string; routeVersionIds: string[]; mentions: string[] } {
  if (typeof source !== 'string' || source.length > 6000 || !source.trim())
    throw new ModelRoutingError(
      'INVALID_PROMPT',
      'Enter a question of 1–6,000 characters.',
    );
  const routeVersionIds: string[] = [],
    mentions: string[] = [],
    ranges: [number, number][] = [];
  let fence: { character: string; length: number } | null = null;
  let inlineTicks = 0;
  let blockquote = false;
  for (let index = 0; index < source.length;) {
    const lineStart = index === 0 || source[index - 1] === '\n';
    if (lineStart) {
      const end = source.indexOf('\n', index);
      const lineEnd = end < 0 ? source.length : end + 1;
      const line = source.slice(index, lineEnd);
      if (!line.trim()) blockquote = false;
      if (!fence && !inlineTicks && /^ {0,3}>/.test(line)) blockquote = true;
      if (blockquote) {
        index = lineEnd;
        continue;
      }
      const marker = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)/.exec(line);
      if (fence) {
        if (
          marker &&
          marker[1][0] === fence.character &&
          marker[1].length >= fence.length &&
          !marker[2].trim()
        )
          fence = null;
        index = lineEnd;
        continue;
      }
      if (marker && !inlineTicks) {
        fence = { character: marker[1][0], length: marker[1].length };
        index = lineEnd;
        continue;
      }
      if (/^(?: {4}|\t| {0,3}>)/.test(line) && !inlineTicks) {
        index = lineEnd;
        continue;
      }
    }
    if (source[index] === '\\') {
      index += Math.min(2, source.length - index);
      continue;
    }
    if (source[index] === '`') {
      const ticks = /^`+/.exec(source.slice(index))![0].length;
      if (inlineTicks === ticks) inlineTicks = 0;
      else if (!inlineTicks) inlineTicks = ticks;
      index += ticks;
      continue;
    }
    if (inlineTicks) {
      index++;
      continue;
    }
    // Skip complete URL/angle-delimited tokens, including embedded parentheses.
    const url = /^(?:https?:\/\/|www\.)[^\s]+/i.exec(source.slice(index));
    if (url) {
      index += url[0].length;
      continue;
    }
    if (source[index] === '<') {
      const close = source.indexOf('>', index + 1);
      if (close >= 0) {
        index = close + 1;
        continue;
      }
    }
    if (
      source[index] !== '@' ||
      (index > 0 && !/[\s([,;:]/.test(source[index - 1]))
    ) {
      index++;
      continue;
    }
    const explicit = source[index + 1] === '{';
    let token: string, end: number;
    if (explicit) {
      const close = source.indexOf('}', index + 2);
      if (close < 0 || close - index > 303)
        throw new ModelRoutingError(
          'MODEL_MENTION_INVALID',
          'Use @{exact-model-id} for a specific model.',
        );
      token = source.slice(index + 2, close);
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/.test(token) ||
        (close + 1 < source.length && !/[\s,;:!?.)\]}]/.test(source[close + 1]))
      )
        throw new ModelRoutingError(
          'MODEL_MENTION_INVALID',
          'Use @{exact-model-id} for a specific model.',
        );
      end = close + 1;
    } else {
      const match = /^@([A-Za-z][A-Za-z0-9._/-]*)/.exec(source.slice(index));
      if (!match) {
        index++;
        continue;
      }
      token = match[1].replace(/[.]+$/, '').toLowerCase();
      if (!aliases.has(token)) {
        index += match[0].length;
        continue;
      }
      end = index + 1 + token.length;
      if (end < source.length && !/[\s,;:!?.)\]}]/.test(source[end])) {
        index = end;
        continue;
      }
    }
    const matches = routes.filter((route) =>
      explicit ? route.modelId === token : route.family === token,
    );
    const eligible = matches.filter(
      (route) => route.available && Date.parse(route.expiresAt) > nowMs,
    );
    if (!eligible.length)
      throw new ModelRoutingError(
        'MODEL_MENTION_UNAVAILABLE',
        'A mentioned model is unavailable. Choose a connected model or remove its mention.',
      );
    if (eligible.length !== 1)
      throw new ModelRoutingError(
        'MODEL_MENTION_AMBIGUOUS',
        explicit
          ? 'This model has more than one connected route. Remove the mention and choose a route manually.'
          : 'This mention matches more than one route. Choose a specific model with @{exact-model-id}.',
      );
    const route = eligible[0];
    if (!routeVersionIds.includes(route.versionId)) {
      routeVersionIds.push(route.versionId);
      if (routeVersionIds.length > 4)
        throw new ModelRoutingError(
          'MODEL_MENTION_LIMIT',
          'Mention up to four different models.',
        );
    }
    mentions.push(source.slice(index, end));
    ranges.push([index, end]);
    index = end;
  }
  let prompt = '',
    cursor = 0;
  for (const [start, end] of ranges) {
    prompt += source.slice(cursor, start);
    cursor = end;
  }
  prompt = (prompt + source.slice(cursor)).trim();
  if (!prompt)
    throw new ModelRoutingError(
      'INVALID_PROMPT',
      'Add a question after choosing your models.',
    );
  return { prompt, routeVersionIds, mentions };
}

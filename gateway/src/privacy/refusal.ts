import type { TableDoc } from "./types.ts";

// Anonymo WS03 · refusal catch (src/anonymo/refusal/). Counts and a per-key flag only: the classifier reads the prompt and
// the opening of a reply in memory, and neither is written anywhere.
export const refusalTables: Record<string, TableDoc> = {
  refusal_stats: {
    category: "request",
    request: "aggregate",
    purpose: "How often each route (model at provider) refused, per UTC day, for the public refusal leaderboard and refusal_rate_30d.",
    retention: "No automatic deletion. Counts only; no prompt, reply, key, account or caller address is ever stored here.",
    columns: {
      route_id: "The route the counts are for, as <model id>@<provider id>; public catalogue identifiers only.",
      day: "UTC day the replies were read.",
      total: "Replies the refusal classifier read on this route that day.",
      refused: "Of those, how many it judged a refusal.",
    },
  },
  refusal_key_settings: {
    category: "keys",
    request: "no",
    purpose: "A key's own default for the refusal catch (on unless set off); the x-anonymo-refusal-catch header overrides it per request.",
    retention: "Kept until the key owner changes it.",
    columns: {
      key_hash: "SHA-256 of the API key the setting belongs to.",
      catch_enabled: "Whether the refusal catch runs for this key's calls by default.",
      updated_at: "When the setting last changed.",
    },
  },
};

export const refusalSettingReader = {
  file: "src/anonymo/refusal/routes.ts",
  carries: "settings" as const,
  reads: "One boolean `enabled` (or \"on\"/\"off\") for a key's refusal-catch default.",
  then: "Authenticates the key; a key may change its own setting, a management key any key of its account, a team owner or admin any key of its team.",
  kept: "The flag in refusal_key_settings, keyed by the key hash. Nothing else.",
  evidence: [{ file: "src/anonymo/refusal/routes.ts", contains: "const body = await readJson(c);" }],
};

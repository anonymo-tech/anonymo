import { fail } from "../../lib/errors.ts";
import type { FloorInput } from "../seams.ts";

// The floor reads every string in the request, not a list of known text fields. A provider reads fields this file
// has never heard of (legacy function_call arguments, refusal parts, earlier reasoning, `functions`, `prediction`,
// enum values and property names in schemas, ids), and a body whose only text sits in one of them must still be checked.
// Only protocol tags are skipped, and only where they hold a plain string: the model, roles, type tags and `object`.
// Object keys are read too, except the protocol's own field names. Under a key the protocol does not have
// (`guided_json`, say) everything is read, as in a schema: every key and every string, type tags included.
// Uploaded media is not text. Only an item of a `content` array is an upload part: its media field is skipped, its
// other fields are read, and hasUpload is set for the gate's own upload rule. Chat takes no file parts (the other
// converters refuse them too).

const UPLOAD_PARTS = new Set(["image_url", "input_image", "input_audio", "image", "audio"]);
/** The fields of an upload part that hold the media itself (a URL, base64 data or a source object). */
const MEDIA_FIELDS = new Set(["image_url", "input_audio", "image", "audio", "source", "url", "data"]);
/** Keys whose plain-string value is a protocol tag, outside schemas. An object or array under them is still read. */
const PROTOCOL_KEYS = new Set(["model", "models", "role", "type", "object"]);
/** Keys whose value is a JSON Schema: inside one, every key (property names) and every string (enums, defaults) is read. */
const SCHEMA_KEYS = new Set(["parameters", "schema", "input_schema"]);
/** Field names of the chat and completions protocol. Any other object key is read as text. */
const PROTOCOL_FIELDS = new Set([
  "model", "models", "messages", "role", "content", "type", "text", "name", "id", "object", "tool_call_id", "call_id",
  "tools", "tool_choice", "tool_calls", "function", "functions", "function_call", "arguments", "parameters", "description",
  "strict", "refusal", "reasoning", "reasoning_content", "reasoning_details", "prediction", "prompt", "system", "suffix",
  "response_format", "json_schema", "schema", "input_schema", "temperature", "top_p", "top_k", "min_p", "top_a",
  "max_tokens", "max_completion_tokens", "stream", "stream_options", "include_usage", "stop", "n", "seed", "user",
  "presence_penalty", "frequency_penalty", "repetition_penalty", "logit_bias", "logprobs", "top_logprobs", "echo",
  "best_of", "parallel_tool_calls", "provider", "transforms", "route", "usage", "include", "include_reasoning", "effort",
  "exclude", "enabled", "verbosity", "modalities", "metadata", "cache_control", "plugins", "web_search_options",
  "council", "judge", "aggregator", "mode", "sealed", "max_cost_usd", "verify", "image_url", "url", "detail",
  "input_audio", "data", "format", "audio", "voice", "source", "media_type", "store", "service_tier", "order", "only",
  "ignore", "allow_fallbacks", "require_parameters", "data_collection", "sort", "quantizations", "max_price", "private",
  "lane", "disclosure", "lane_downgrade", "zdr", "type_hint", "index", "finish_reason", "properties", "items", "required",
  "enum", "default", "additionalProperties", "anyOf", "oneOf", "allOf", "$defs", "definitions", "$ref", "title", "const",
]);

const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

function unreadable(field: "prompt" | "system"): never {
  fail(400, `\`${field}\` must be a string or an array of strings or text parts.`, "invalid_request");
}

/** `prompt` and `system` must be text: a string, or an array of strings or text parts. Anything else is a 400. */
function checkTextField(content: unknown, field: "prompt" | "system") {
  if (typeof content === "string") return;
  if (!Array.isArray(content)) unreadable(field);
  for (const item of content) if (typeof item !== "string" && typeof record(item)?.text !== "string") unreadable(field);
}

/** Read user-facing text and detect uploads in the assembled chat or completions body. */
export function floorInputOf(body: Record<string, unknown>): FloorInput {
  if (body.prompt !== undefined) checkTextField(body.prompt, "prompt");
  if (body.system != null) checkTextField(body.system, "system");

  const texts: string[] = [];
  let hasUpload = false;
  const walk = (value: unknown, inSchema: boolean, depth: number, contentItem = false): void => {
    if (depth > 64) fail(400, "The request nests too deeply.", "invalid_request");
    if (typeof value === "string") {
      texts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, inSchema, depth + 1);
    } else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      const upload = contentItem && !inSchema && typeof o.type === "string" && UPLOAD_PARTS.has(o.type);
      if (contentItem && !inSchema && (o.type === "file" || o.type === "input_file"))
        fail(400, "File parts are not supported in chat. Send the file's text as a text part.", "unsupported_content");
      if (upload) hasUpload = true;
      for (const [key, child] of Object.entries(o)) {
        if (inSchema) {
          texts.push(key);
          walk(child, true, depth + 1);
          continue;
        }
        if (upload && MEDIA_FIELDS.has(key)) continue;
        const known = PROTOCOL_FIELDS.has(key);
        if (!known) texts.push(key);
        if (known && typeof child === "string" && PROTOCOL_KEYS.has(key)) continue;
        if (key === "content" && Array.isArray(child)) {
          for (const item of child) walk(item, false, depth + 2, true);
          continue;
        }
        // Under a schema key, or a key the protocol does not have, every key and every string is read.
        walk(child, SCHEMA_KEYS.has(key) || !known, depth + 1);
      }
    }
  };
  walk(body, false, 0);

  return { text: texts.join("\n"), modality: "text", hasUpload };
}

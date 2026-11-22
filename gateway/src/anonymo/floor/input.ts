import { fail } from "../../lib/errors.ts";
import type { FloorInput } from "../seams.ts";

// The floor reads every string in the request, not a list of known text fields. A provider reads fields this file
// has never heard of (legacy function_call arguments, refusal parts, earlier reasoning, `functions`, `prediction`,
// enum values and property names in schemas), and a body whose only text sits in one of them must still be checked.
// Only protocol tags are skipped, and only where they hold a plain string: the model, roles, ids and type tags.
// Uploaded media is not text: its part is skipped here and flagged with hasUpload for the gate's own upload rule.

const UPLOAD_PARTS = new Set(["image_url", "input_image", "input_audio", "file", "image", "audio"]);
/** Keys whose plain-string value is a protocol tag, outside schemas. An object or array under them is still read. */
const PROTOCOL_KEYS = new Set(["model", "models", "role", "type", "id", "tool_call_id", "call_id", "object"]);
/** Keys whose value is a JSON Schema: inside one, every key (property names) and every string (enums, defaults) is read. */
const SCHEMA_KEYS = new Set(["parameters", "schema", "input_schema"]);

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
  const walk = (value: unknown, inSchema: boolean, depth: number): void => {
    if (depth > 64) fail(400, "The request nests too deeply.", "invalid_request");
    if (typeof value === "string") {
      texts.push(value);
    } else if (Array.isArray(value)) {
      for (const item of value) walk(item, inSchema, depth + 1);
    } else if (value && typeof value === "object") {
      const o = value as Record<string, unknown>;
      if (!inSchema && typeof o.type === "string" && UPLOAD_PARTS.has(o.type)) {
        hasUpload = true;
        return;
      }
      for (const [key, child] of Object.entries(o)) {
        if (inSchema) {
          texts.push(key);
          walk(child, true, depth + 1);
        } else if (typeof child === "string" && PROTOCOL_KEYS.has(key)) {
          continue;
        } else {
          walk(child, SCHEMA_KEYS.has(key), depth + 1);
        }
      }
    }
  };
  walk(body, false, 0);

  return { text: texts.join("\n"), modality: "text", hasUpload };
}

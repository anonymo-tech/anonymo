import { fail } from "../../lib/errors.ts";
import type { FloorInput } from "../seams.ts";

const UPLOAD_PARTS = new Set(["image_url", "input_image", "input_audio", "file", "image", "audio"]);
const record = (value: unknown) =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const items = (value: unknown): readonly unknown[] => Array.isArray(value) ? value : [];

function unreadable(field: "prompt" | "system"): never {
  fail(400, `\`${field}\` must be a string or an array of strings or text parts.`, "invalid_request");
}

function takeSchemaText(value: unknown, take: (value: unknown) => void) {
  if (Array.isArray(value)) {
    for (const child of value) takeSchemaText(child, take);
  } else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (key === "description" || key === "title") take(child);
      takeSchemaText(child, take);
    }
  }
}

/** Read user-facing text and detect uploads in the assembled chat or completions body. */
export function floorInputOf(body: Record<string, unknown>): FloorInput {
  const texts: string[] = [];
  let hasUpload = false;
  const take = (value: unknown) => {
    if (typeof value === "string") texts.push(value);
  };
  const takeContent = (content: unknown, field?: "prompt" | "system") => {
    if (typeof content === "string") {
      take(content);
    } else if (Array.isArray(content)) {
      for (const item of content) {
        const part = record(item);
        const text = typeof item === "string" ? item : part?.text;
        if (typeof text === "string") take(text);
        else if (field) unreadable(field);
        if (typeof part?.type === "string" && UPLOAD_PARTS.has(part.type)) hasUpload = true;
      }
    } else if (field) {
      unreadable(field);
    }
  };

  for (const item of items(body.messages)) {
    const message = record(item);
    takeContent(message?.content);
    take(message?.name);
    for (const call of items(message?.tool_calls)) {
      const fn = record(record(call)?.function);
      take(fn?.name);
      take(fn?.arguments);
    }
  }
  if (body.prompt !== undefined) takeContent(body.prompt, "prompt");
  if (body.system != null) takeContent(body.system, "system");

  for (const tool of items(body.tools)) {
    const fn = record(record(tool)?.function);
    take(fn?.name);
    take(fn?.description);
    takeSchemaText(fn?.parameters, take);
  }
  const format = record(record(body.response_format)?.json_schema);
  take(format?.name);
  take(format?.description);
  takeSchemaText(format?.schema, take);

  return { text: texts.join("\n"), modality: "text", hasUpload };
}

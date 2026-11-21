// Chat exports are often one JSON array with a conversation per element, hundreds of megabytes long: too long to hold
// as one string in a browser. This reads the array from a byte stream and hands over one parsed element at a time, so
// memory stays at the size of the largest conversation.

export class JsonStreamError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JsonStreamError';
  }
}

const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const COMMA = 0x2c;
const OPEN_ARRAY = 0x5b;
const CLOSE_ARRAY = 0x5d;
const OPEN_OBJECT = 0x7b;
const CLOSE_OBJECT = 0x7d;
const isSpace = (b: number) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09;

/** One element of a top-level array may be at most this long (a single conversation, not the whole file). */
const MAX_ITEM_BYTES = 256 * 1024 * 1024;

/** The first byte that is not white space or a byte-order mark: `[` for an array, `{` for an object. */
export function firstJsonByte(head: Uint8Array): number | null {
  let i = head.length >= 3 && head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf ? 3 : 0;
  while (i < head.length && isSpace(head[i]!)) i++;
  return i < head.length ? head[i]! : null;
}

/**
 * The elements of a top-level JSON array, parsed one by one as the bytes arrive. Throws JsonStreamError when the
 * stream is not an array, ends early, or an element is not valid JSON.
 */
export async function* arrayItems(stream: ReadableStream<Uint8Array>): AsyncGenerator<unknown, void, void> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  let started = false;
  let ended = false;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let sawByte = false;

  const flush = (): { value: unknown } | null => {
    const bytes = new Uint8Array(pendingBytes);
    let at = 0;
    for (const part of pending) {
      bytes.set(part, at);
      at += part.length;
    }
    pending = [];
    pendingBytes = 0;
    const source = decoder.decode(bytes).trim();
    if (!source) return null;
    try {
      return { value: JSON.parse(source) };
    } catch {
      throw new JsonStreamError('The file is not valid JSON.');
    }
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      let from = 0;
      for (let i = 0; i < value.length; i++) {
        const b = value[i]!;
        if (!started) {
          if (!sawByte && b === 0xef) continue; // byte-order mark
          if (!sawByte && (b === 0xbb || b === 0xbf)) continue;
          if (isSpace(b)) continue;
          sawByte = true;
          if (b !== OPEN_ARRAY) throw new JsonStreamError('The file does not hold a list.');
          started = true;
          from = i + 1;
          continue;
        }
        if (ended) {
          if (!isSpace(b)) throw new JsonStreamError('The file is not valid JSON.');
          continue;
        }
        if (inString) {
          if (escaped) escaped = false;
          else if (b === BACKSLASH) escaped = true;
          else if (b === QUOTE) inString = false;
          continue;
        }
        if (b === QUOTE) inString = true;
        else if (b === OPEN_OBJECT || b === OPEN_ARRAY) depth++;
        else if (b === CLOSE_OBJECT) depth--;
        else if (b === CLOSE_ARRAY && depth > 0) depth--;
        else if ((b === COMMA || b === CLOSE_ARRAY) && depth === 0) {
          if (i > from) {
            pending.push(value.subarray(from, i));
            pendingBytes += i - from;
          }
          from = i + 1;
          const item = flush();
          if (b === CLOSE_ARRAY) ended = true;
          else if (!item) throw new JsonStreamError('The file is not valid JSON.');
          if (item)
            yield item.value;
        }
        if (depth < 0) throw new JsonStreamError('The file is not valid JSON.');
      }
      if (started && !ended && from < value.length) {
        pending.push(value.subarray(from));
        pendingBytes += value.length - from;
        if (pendingBytes > MAX_ITEM_BYTES) throw new JsonStreamError('One conversation in this file is too large to read here.');
      }
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  if (!started) throw new JsonStreamError('The file is empty.');
  if (!ended) throw new JsonStreamError('The file ends early: it may be cut short.');
}

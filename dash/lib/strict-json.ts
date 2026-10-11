/** Bounded JSON parsing rejects duplicate decoded keys, wrappers and excess nesting. */
export function strictJson(input: string, maxBytes: number): unknown {
  if (
    typeof input !== 'string' ||
    new TextEncoder().encode(input).byteLength > maxBytes
  )
    throw new Error('INVALID_JSON');
  let cursor = 0;
  const whitespace = () => {
    while (/[\x20\t\r\n]/.test(input[cursor] ?? '') && cursor < input.length)
      cursor++;
  };
  const fail = (): never => {
    throw new Error('INVALID_JSON');
  };
  const string = (): string => {
    if (input[cursor] !== '"') return fail();
    const start = cursor++;
    while (cursor < input.length) {
      if (input[cursor] === '\\') cursor += 2;
      else if (input[cursor++] === '"') {
        try {
          return JSON.parse(input.slice(start, cursor)) as string;
        } catch {
          return fail();
        }
      }
    }
    return fail();
  };
  const value = (depth: number): unknown => {
    if (depth > 12) return fail();
    whitespace();
    if (input[cursor] === '"') return string();
    if (input[cursor] === '{') {
      cursor++;
      whitespace();
      const result: Record<string, unknown> = Object.create(null);
      if (input[cursor] === '}') {
        cursor++;
        return result;
      }
      while (cursor < input.length) {
        const key = string();
        if (Object.hasOwn(result, key)) return fail();
        whitespace();
        if (input[cursor++] !== ':') return fail();
        result[key] = value(depth + 1);
        whitespace();
        const separator = input[cursor++];
        if (separator === '}') return result;
        if (separator !== ',') return fail();
        whitespace();
      }
      return fail();
    }
    if (input[cursor] === '[') {
      cursor++;
      whitespace();
      const result: unknown[] = [];
      if (input[cursor] === ']') {
        cursor++;
        return result;
      }
      while (cursor < input.length) {
        result.push(value(depth + 1));
        if (result.length > 256) return fail();
        whitespace();
        const separator = input[cursor++];
        if (separator === ']') return result;
        if (separator !== ',') return fail();
      }
      return fail();
    }
    for (const [literal, result] of [
      ['null', null],
      ['true', true],
      ['false', false],
    ] as const) {
      if (input.startsWith(literal, cursor)) {
        cursor += literal.length;
        return result;
      }
    }
    const number = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/.exec(
      input.slice(cursor),
    )?.[0];
    if (number) {
      cursor += number.length;
      return JSON.parse(number);
    }
    return fail();
  };
  const result = value(0);
  whitespace();
  if (cursor !== input.length) return fail();
  return result;
}

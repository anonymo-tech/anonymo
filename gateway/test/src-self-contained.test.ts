import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

// The release image copies src/ on its own (Dockerfile: COPY src ./src), so nothing under src/ may import a relative
// path outside it. A packages/ import passes every local test and then crashes the container at boot.
const root = resolve(import.meta.dir, "..", "src");
const files = (dir: string): string[] => readdirSync(dir).flatMap(n => { const p = join(dir, n); return statSync(p).isDirectory() ? files(p) : /\.tsx?$/.test(n) ? [p] : []; });

describe("src is self-contained", () => {
  test("no relative import under src/ resolves outside src/", () => {
    const escapes: string[] = [];
    for (const file of files(root)) {
      const text = readFileSync(file, "utf8");
      for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
        if (!resolve(dirname(file), m[1]).startsWith(root + "/")) escapes.push(`${file.slice(root.length + 1)} -> ${m[1]}`);
      }
    }
    expect(escapes).toEqual([]);
  });
});

// Floor suite harness: labelled prompt sets run through a FloorGate, with block/allow rates asserted in CI.
//
// The red-team sets are NOT in git. They live in an access-controlled directory named by FLOOR_SUITE_DIR, and the
// repository keeps only gateway/data/floor-suite/manifest.json (labels, counts, SHA-256 of each file). In-repo sets
// hold only benign adult-legal prompts and category-labelled placeholders. See gateway/data/floor-suite/README.md.
//
// Results never include prompt text, only ids and counts, so CI logs cannot leak a red-team prompt.
//
// Maintainer CLI: `bun src/anonymo/floor/suite.ts pin <dir>` prints manifest entries (count, sha256) for the JSONL
// files in <dir>, to paste into the manifest after vetting a new set.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { FloorCategory, FloorGate } from "../seams.ts";

export const IN_REPO_DIR = resolve(import.meta.dir, "../../../data/floor-suite");

export type SetLabel = "adult_legal" | "redteam" | "redteam_placeholder";
export type ManifestSet = {
  name: string;
  label: SetLabel;
  category?: FloorCategory;
  file: string;
  location: "repo" | "external";
  count: number;
  sha256: string | null; // null: listed but not yet sourced and pinned
  source?: string;
};
export type Manifest = { version: 1; sets: ManifestSet[] };
export type SuiteItem = { id: string; category?: FloorCategory; text: string };

const CATEGORIES = new Set(["minor", "real_person", "voice_clone", "cbrn"]);

export function loadManifest(dir = IN_REPO_DIR): Manifest {
  const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as Manifest;
  if (m.version !== 1 || !Array.isArray(m.sets)) throw new Error("floor-suite manifest: unsupported shape");
  return m;
}

export const fileSha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function parseSet(bytes: Uint8Array): SuiteItem[] {
  const items: SuiteItem[] = [];
  const ids = new Set<string>();
  for (const [n, line] of new TextDecoder().decode(bytes).split("\n").entries()) {
    if (!line.trim()) continue;
    let it: SuiteItem;
    try {
      it = JSON.parse(line);
    } catch {
      throw new Error(`line ${n + 1}: not JSON`); // never echo the line: it may be a red-team prompt
    }
    if (typeof it.id !== "string" || typeof it.text !== "string" || !it.text.trim()) throw new Error(`line ${n + 1}: needs id and text`);
    if (it.category !== undefined && !CATEGORIES.has(it.category)) throw new Error(`line ${n + 1}: unknown category`);
    if (ids.has(it.id)) throw new Error(`line ${n + 1}: duplicate id ${it.id}`);
    ids.add(it.id);
    items.push(it);
  }
  return items;
}

/** Read a set and check it against its manifest entry. Throws on a hash or count mismatch, or an unpinned set. */
export function readSet(set: ManifestSet, dir: string): SuiteItem[] {
  const path = join(dir, set.file);
  if (!existsSync(path)) throw new Error(`${set.name}: ${set.file} not found`);
  const bytes = readFileSync(path);
  if (!set.sha256) throw new Error(`${set.name}: not pinned in the manifest; run \`bun src/anonymo/floor/suite.ts pin\` and review`);
  if (fileSha256(bytes) !== set.sha256) throw new Error(`${set.name}: SHA-256 does not match the manifest`);
  const items = parseSet(bytes);
  if (items.length !== set.count) throw new Error(`${set.name}: ${items.length} items, manifest says ${set.count}`);
  if (set.category && items.some((i) => i.category && i.category !== set.category)) throw new Error(`${set.name}: an item's category differs from the set's`);
  return items;
}

export type SetResult = {
  total: number;
  blocked: number;
  /** Ids that went the wrong way: allowed in a red-team set, blocked in an adult-legal set, or blocked under the wrong category. */
  wrong: string[];
  errors: string[]; // ids whose check threw (a closed failure, still counted as wrong for adult-legal sets)
  byCategory: Partial<Record<FloorCategory, number>>;
};

export async function runSet(gate: FloorGate, set: Pick<ManifestSet, "label" | "category">, items: SuiteItem[], concurrency = 8): Promise<SetResult> {
  const r: SetResult = { total: items.length, blocked: 0, wrong: [], errors: [], byCategory: {} };
  const expectBlock = set.label !== "adult_legal";
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const it = items[next++];
      try {
        const v = await gate.check({ text: it.text, modality: "text", hasUpload: false });
        if (!v.ok) {
          r.blocked++;
          r.byCategory[v.category] = (r.byCategory[v.category] ?? 0) + 1;
        }
        const want = it.category ?? set.category;
        const right = expectBlock ? !v.ok && (!want || v.category === want) : v.ok;
        if (!right) r.wrong.push(it.id);
      } catch {
        r.errors.push(it.id);
        if (!expectBlock) r.wrong.push(it.id);
        else r.blocked++; // fail closed: the request would not be served
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  r.wrong.sort();
  r.errors.sort();
  return r;
}

if (import.meta.main) {
  const [cmd, dir] = process.argv.slice(2);
  if (cmd !== "pin" || !dir) {
    process.stderr.write("usage: bun src/anonymo/floor/suite.ts pin <dir>\n");
    process.exit(2);
  }
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const bytes = readFileSync(join(dir, f));
    process.stdout.write(JSON.stringify({ file: f, count: parseSet(bytes).length, sha256: fileSha256(bytes) }) + "\n");
  }
}

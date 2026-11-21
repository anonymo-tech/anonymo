// WS11 · Licence engine: the licence classes the Fork & Flip policy works from (Ventures Backend spec, PART 6).
//
// Every SPDX id the engine knows falls in one class. Anything it does not know (a LicenseRef, a misspelt id, no licence
// at all) is "unforkable", so an unknown licence can only ever send a venture down the clean-room path, never into a
// fork. The known dual-licence projects and the store engines the crew starts from live here too.

export type LicenceClass = "permissive" | "weak-copyleft" | "gpl" | "network-copyleft" | "unforkable";

/** Allowed; keep notices; NOTICE file generated. */
const PERMISSIVE = [
  "MIT",
  "MIT-0",
  "BSD-2-Clause",
  "BSD-3-Clause",
  "0BSD",
  "Apache-2.0",
  "ISC",
  "Unlicense",
  "Zlib",
  "CC0-1.0",
  "BSL-1.0",
];
/** Allowed; file-level (MPL) or library-level (LGPL) obligations tracked. */
const WEAK_COPYLEFT = ["MPL-2.0", "LGPL-2.1-only", "LGPL-2.1-or-later", "LGPL-3.0-only", "LGPL-3.0-or-later"];
/** Allowed only if the venture's repo is published under GPL. */
const GPL = ["GPL-2.0-only", "GPL-2.0-or-later", "GPL-3.0-only", "GPL-3.0-or-later"];
/** Allowed only with publishSource=true; the crew adds a "source" link to the deployed app. */
const NETWORK_COPYLEFT = ["AGPL-3.0-only", "AGPL-3.0-or-later", "SSPL-1.0"];
/** Source-available or non-commercial: never forked, always rebuilt clean-room. Listed so ids keep their case. */
const SOURCE_AVAILABLE = [
  "BUSL-1.1",
  "Elastic-2.0",
  "PolyForm-Noncommercial-1.0.0",
  "PolyForm-Small-Business-1.0.0",
  "BSD-4-Clause",
  "CC-BY-NC-4.0",
  "CC-BY-NC-SA-4.0",
  "CC-BY-NC-ND-4.0",
  "LicenseRef-Commons-Clause",
  "LicenseRef-Commercial",
  "LicenseRef-NonCommercial",
  "LicenseRef-PolyForm",
  "LicenseRef-Unknown",
];

const CLASS_OF = new Map<string, LicenceClass>([
  ...PERMISSIVE.map((id) => [id, "permissive"] as const),
  ...WEAK_COPYLEFT.map((id) => [id, "weak-copyleft"] as const),
  ...GPL.map((id) => [id, "gpl"] as const),
  ...NETWORK_COPYLEFT.map((id) => [id, "network-copyleft"] as const),
  ...SOURCE_AVAILABLE.map((id) => [id, "unforkable"] as const),
]);

/** Every id the engine knows, in its canonical SPDX case. */
export const KNOWN_IDS: readonly string[] = [...CLASS_OF.keys()];

/** Deprecated SPDX ids (and the bare GNU ids) mapped to their current form. A bare GNU id reads as "-only". */
export const DEPRECATED_IDS: Readonly<Record<string, string>> = {
  "GPL-2.0": "GPL-2.0-only",
  "GPL-3.0": "GPL-3.0-only",
  "LGPL-2.1": "LGPL-2.1-only",
  "LGPL-3.0": "LGPL-3.0-only",
  "AGPL-3.0": "AGPL-3.0-only",
  "GPL-2.0+": "GPL-2.0-or-later",
  "GPL-3.0+": "GPL-3.0-or-later",
  "LGPL-2.1+": "LGPL-2.1-or-later",
  "LGPL-3.0+": "LGPL-3.0-or-later",
  "AGPL-3.0+": "AGPL-3.0-or-later",
};

/** WITH exceptions that only loosen a GNU licence for linking: the result is treated as weak copyleft. */
export const LINKING_EXCEPTIONS: readonly string[] = ["Classpath-exception-2.0", "GCC-exception-3.1", "GCC-exception-2.0", "LLVM-exception", "Autoconf-exception-3.0", "Bison-exception-2.2", "Font-exception-2.0", "GPL-CC-1.0"];
/** WITH "exceptions" that add a restriction instead (Commons Clause is sometimes written this way). */
export const RESTRICTING_EXCEPTIONS: readonly string[] = ["Commons-Clause", "LicenseRef-Commons-Clause"];

export function licenceClass(id: string): LicenceClass {
  return CLASS_OF.get(id) ?? "unforkable";
}

export const isCopyleft = (c: LicenceClass) => c === "weak-copyleft" || c === "gpl" || c === "network-copyleft";

/**
 * Projects known to ship under a copyleft licence and a commercial one at once. The crew must pick deliberately, so
 * these are always flagged for a manual choice. Best-known list, matched against package and repo names.
 */
export const KNOWN_DUAL_LICENCE: readonly { name: string; note: string }[] = [
  { name: "vendure", note: "Vendure v3 ships under GPL-3.0 or the Vendure Commercial Licence" },
  { name: "ckeditor5", note: "CKEditor 5 ships under GPL-2.0-or-later or a commercial licence" },
  { name: "metabase", note: "Metabase ships under AGPL-3.0 or a commercial licence" },
  { name: "cal.com", note: "Cal.com ships under AGPL-3.0 with commercial enterprise code" },
  { name: "sidekiq", note: "Sidekiq ships under LGPL-3.0 with commercial Pro and Enterprise editions" },
  { name: "itext", note: "iText ships under AGPL-3.0 or a commercial licence" },
];

export type StoreEngine = { name: string; url: string; licence: string };
/** The store engine a DUPE_DROP / FORK_FLIP shop starts from. */
export const STORE_ENGINE_DEFAULT: StoreEngine = { name: "medusa", url: "https://github.com/medusajs/medusa", licence: "MIT" };
/** The alternate store engine when Medusa does not fit. */
export const STORE_ENGINE_ALTERNATE: StoreEngine = { name: "saleor", url: "https://github.com/saleor/saleor", licence: "BSD-3-Clause" };

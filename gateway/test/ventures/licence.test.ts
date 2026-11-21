import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { KNOWN_IDS, STORE_ENGINE_ALTERNATE, STORE_ENGINE_DEFAULT } from "../../src/anonymo/ventures/licence/catalog.ts";
import { copyrightLines, detectLicenceText, normaliseLicence, parseManifest, spdxHeader } from "../../src/anonymo/ventures/licence/detect.ts";
import { canonicalJson, licenceReport, reportHash, scanRepo } from "../../src/anonymo/ventures/licence/index.ts";
import { applyReuseHeader, noticeFile, reuseHeader, reuseOutput, reuseToml } from "../../src/anonymo/ventures/licence/notice.ts";
import { decide, decideExpression, VERDICT_RANK } from "../../src/anonymo/ventures/licence/policy.ts";
import { mapScancodeJson, runScancode } from "../../src/anonymo/ventures/licence/scancode.ts";
import { formatSpdx, parseSpdx, SpdxParseError } from "../../src/anonymo/ventures/licence/spdx.ts";
import type { LicenceComponent } from "../../src/anonymo/ventures/licence/types.ts";

// WS11 Licence engine (Ventures Backend PART 6): detection, the Fork & Flip policy, NOTICE / REUSE output and the
// ScanCode adapter. Everything runs on local fixtures; nothing touches the network.

const FIXTURES = join(import.meta.dir, "fixtures", "licence");
const fixture = (name: string) => join(FIXTURES, name);
const MIT_REPO = { publishSource: false, repoLicence: "MIT" };
const builtin = { scancode: false } as const;

const temps: string[] = [];
const tempDir = async (prefix = "licence-") => {
  const d = await mkdtemp(join(tmpdir(), prefix));
  temps.push(d);
  return d;
};
const writeTree = async (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  }
};
afterAll(async () => {
  for (const d of temps) await rm(d, { recursive: true, force: true });
});

describe("SPDX expressions", () => {
  test("WITH binds tighter than AND, AND tighter than OR", () => {
    expect(parseSpdx("MIT OR Apache-2.0 AND GPL-2.0-only WITH Classpath-exception-2.0")).toEqual({
      type: "or",
      args: [
        { type: "licence", id: "MIT" },
        { type: "and", args: [{ type: "licence", id: "Apache-2.0" }, { type: "licence", id: "GPL-2.0-only", exception: "Classpath-exception-2.0" }] },
      ],
    });
  });

  test("parentheses group, nested operators flatten, and the expression formats back canonically", () => {
    const node = parseSpdx("(MIT OR (ISC OR 0BSD)) AND (Apache-2.0 AND Zlib)");
    expect(node).toEqual({
      type: "and",
      args: [
        { type: "or", args: [{ type: "licence", id: "MIT" }, { type: "licence", id: "ISC" }, { type: "licence", id: "0BSD" }] },
        { type: "licence", id: "Apache-2.0" },
        { type: "licence", id: "Zlib" },
      ],
    });
    expect(formatSpdx(node)).toBe("(MIT OR ISC OR 0BSD) AND Apache-2.0 AND Zlib");
  });

  test("lowercase operators, id case, deprecated GNU ids and + are canonicalised", () => {
    expect(formatSpdx(parseSpdx("mit or apache-2.0"))).toBe("MIT OR Apache-2.0");
    expect(formatSpdx(parseSpdx("GPL-3.0"))).toBe("GPL-3.0-only");
    expect(formatSpdx(parseSpdx("GPL-2.0+"))).toBe("GPL-2.0-or-later");
    expect(formatSpdx(parseSpdx("LGPL-2.1+ AND agpl-3.0"))).toBe("LGPL-2.1-or-later AND AGPL-3.0-only");
    expect(formatSpdx(parseSpdx("licenseref-Custom"))).toBe("LicenseRef-Custom");
  });

  test("malformed expressions are refused", () => {
    for (const bad of ["", "MIT OR", "(MIT", "MIT)", "AND MIT", "MIT WITH", "MIT / Apache-2.0", "MIT Apache-2.0"]) expect(() => parseSpdx(bad)).toThrow(SpdxParseError);
  });
});

describe("detection", () => {
  test("SPDX-License-Identifier headers in any comment style, ANDed; code that only mentions the tag is ignored", () => {
    expect(spdxHeader("// SPDX-License-Identifier: MIT\nexport {}")).toBe("MIT");
    expect(spdxHeader("#!/bin/sh\n# SPDX-License-Identifier: Apache-2.0 OR MIT\n")).toBe("Apache-2.0 OR MIT");
    expect(spdxHeader("/* SPDX-License-Identifier: GPL-2.0+ */\n<!-- SPDX-License-Identifier: CC0-1.0 -->")).toBe("GPL-2.0-or-later AND CC0-1.0");
    expect(spdxHeader('const re = /SPDX-License-Identifier:\\s*(.+)/;\nconst s = "SPDX-License-Identifier: " + id;')).toBeNull();
    expect(spdxHeader("nothing here")).toBeNull();
  });

  const texts: [string, string][] = [
    ["Permission is hereby granted, free of charge, to any person obtaining a copy of this software ... The above copyright notice and this permission notice shall be included in all copies", "MIT"],
    ["Redistribution and use in source and binary forms, with or without modification, are permitted provided that ...", "BSD-2-Clause"],
    ["Redistribution and use in source and binary forms, with or without\nmodification, are permitted ... Neither the name of the copyright holder nor the names of its contributors may be used to endorse", "BSD-3-Clause"],
    ["Apache License\n   Version 2.0, January 2004", "Apache-2.0"],
    ["Permission to use, copy, modify, and/or distribute this software for any\npurpose with or without fee is hereby granted, provided that the above\ncopyright notice and this permission notice appear in all copies.", "ISC"],
    ["Permission to use, copy, modify, and/or distribute this software for any purpose with or without fee is hereby granted.\n\nTHE SOFTWARE IS PROVIDED \"AS IS\"", "0BSD"],
    ["This is free and unencumbered software released into the public domain.", "Unlicense"],
    ["This software is provided 'as-is' ... 2. Altered source versions must be plainly marked as such ... 3. This notice may not be removed or altered from any source distribution.", "Zlib"],
    ["Creative Commons Legal Code\n\nCC0 1.0 Universal", "CC0-1.0"],
    ["Mozilla Public License Version 2.0\n==================================", "MPL-2.0"],
    ["GNU LESSER GENERAL PUBLIC LICENSE\n Version 2.1, February 1999", "LGPL-2.1-only"],
    ["GNU LESSER GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007", "LGPL-3.0-only"],
    ["GNU GENERAL PUBLIC LICENSE\n Version 2, June 1991", "GPL-2.0-only"],
    ["GNU GENERAL PUBLIC LICENSE\n Version 3, 29 June 2007", "GPL-3.0-only"],
    ["This program is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.", "GPL-3.0-or-later"],
    ["GNU AFFERO GENERAL PUBLIC LICENSE\n Version 3, 19 November 2007", "AGPL-3.0-only"],
    ["Server Side Public License\nVERSION 1, OCTOBER 16, 2018", "SSPL-1.0"],
    ["Business Source License 1.1\n\nChange License: Apache License, Version 2.0", "BUSL-1.1"],
    ["Elastic License 2.0\n\nURL: https://www.elastic.co/licensing/elastic-license", "Elastic-2.0"],
    ["# PolyForm Noncommercial License 1.0.0", "PolyForm-Noncommercial-1.0.0"],
    ['"Commons Clause" License Condition v1.0 ... Apache License, Version 2.0', "Apache-2.0 AND LicenseRef-Commons-Clause"],
    ["MIT", "MIT"],
    ["Copyright 2024 Example Corp. All rights reserved.", "LicenseRef-Commercial"],
    ["Free for non-commercial use only.", "LicenseRef-NonCommercial"],
    ["Some words that are no licence anyone has seen before, written at length so the short-id path does not apply to them at all.", "LicenseRef-Unknown"],
  ];
  for (const [text, id] of texts) test(`licence text → ${id}`, () => expect(detectLicenceText(text).spdx).toBe(id));

  test("a dual-licence text with a commercial option is ORed and flagged", () => {
    const r = detectLicenceText("Dual licensed: GNU GENERAL PUBLIC LICENSE Version 3 or a commercial license from the vendor.");
    expect(r.spdx).toBe("GPL-3.0-only OR LicenseRef-Commercial");
    expect(r.dual).toContain("dual");
  });

  test("copyright lines: real holders kept, licence boilerplate and placeholders dropped, duplicates merged", () => {
    const text = [
      "// Copyright (c) 2024 Sample Org",
      "# SPDX-FileCopyrightText: 2024 Sample Org",
      " * © 2023 Example Foundation",
      "Copyright [yyyy] [name of copyright owner]",
      "Copyright (C) 2007 Free Software Foundation, Inc. <https://fsf.org/>",
      "copyright notice and this permission notice",
      "Copyright holders may not be liable",
      "/* Copyright 2022 Example Maintainers */",
    ].join("\n");
    expect(copyrightLines(text, { licenceText: true })).toEqual(["Copyright (c) 2024 Sample Org", "© 2023 Example Foundation", "Copyright 2022 Example Maintainers"]);
  });

  test("manifests: npm, composer, Cargo, pyproject, setup.cfg and gemspec", () => {
    expect(parseManifest("package.json", '{"name":"a","version":"1.0.0","license":"MIT"}')).toEqual({ kind: "npm", name: "a", version: "1.0.0", licence: "MIT" });
    expect(parseManifest("package.json", '{"name":"b","licenses":[{"type":"MIT"},{"type":"Apache 2.0"}]}')?.licence).toBe("MIT OR Apache-2.0");
    expect(parseManifest("package.json", '{"name":"c","license":"SEE LICENSE IN LICENSE.txt"}')?.licence).toBeNull();
    expect(parseManifest("package.json", '{"name":"d","license":"UNLICENSED"}')?.licence).toBe("LicenseRef-Commercial");
    expect(parseManifest("composer.json", '{"name":"x/y","license":["LGPL-2.1-only","GPL-3.0-or-later"]}')?.licence).toBe("LGPL-2.1-only OR GPL-3.0-or-later");
    expect(parseManifest("Cargo.toml", '[package]\nname = "crate"\nversion = "0.3.0"\nlicense = "MIT/Apache-2.0"\n')?.licence).toBe("LicenseRef-Unknown");
    expect(parseManifest("Cargo.toml", '[package]\nname = "crate"\nversion = "0.3.0"\nlicense = "MIT OR Apache-2.0"\n')).toEqual({ kind: "cargo", name: "crate", version: "0.3.0", licence: "MIT OR Apache-2.0" });
    expect(parseManifest("pyproject.toml", '[project]\nname = "pkg"\nversion = "2.0"\nclassifiers = [\n  "License :: OSI Approved :: BSD License",\n]\n')?.licence).toBe("BSD-3-Clause");
    expect(parseManifest("pyproject.toml", '[tool.poetry]\nname = "pkg"\nlicense = "GPL-3.0-or-later"\n')?.licence).toBe("GPL-3.0-or-later");
    expect(parseManifest("setup.cfg", "[metadata]\nname = pkg\nversion = 1.2\nlicense = Mozilla Public License 2.0 (MPL 2.0)\n")?.licence).toBe("MPL-2.0");
    expect(parseManifest("setup.cfg", "[metadata]\nname = pkg\nclassifiers =\n    License :: OSI Approved :: ISC License (ISCL)\n    Programming Language :: Python\n")?.licence).toBe("ISC");
    expect(parseManifest("sample.gemspec", 'Gem::Specification.new do |s|\n  s.name = "gemmy"\n  s.version = "1.0"\n  s.licenses = ["MIT", "Ruby"]\nend')).toEqual({ kind: "gem", name: "gemmy", version: "1.0", licence: "MIT OR Ruby" });
    expect(parseManifest("package.json", "not json")).toBeNull();
  });

  test("free-text licence names", () => {
    expect(normaliseLicence("The MIT License")).toBe("MIT");
    expect(normaliseLicence("Apache License, Version 2.0")).toBe("Apache-2.0");
    expect(normaliseLicence("GPLv3+")).toBe("GPL-3.0-or-later");
    expect(normaliseLicence("AGPLv3")).toBe("AGPL-3.0-only");
    expect(normaliseLicence("License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)")).toBe("LGPL-3.0-only");
    expect(normaliseLicence("Elastic License 2.0")).toBe("Elastic-2.0");
    expect(normaliseLicence("Expat")).toBe("MIT");
  });
});

describe("scanning the fixtures", () => {
  test("an MIT project with an Apache dependency is allowed and the NOTICE lists both", async () => {
    const { report, decision, notice } = await licenceReport(fixture("mit-apache"), MIT_REPO, builtin);
    expect(report.tool).toBe("builtin");
    expect(report.components.map((c) => [c.name, c.version, c.path, c.spdx])).toEqual([
      ["sample-app", "1.0.0", ".", "MIT"],
      ["tiny-http", "2.1.0", "vendor/tiny-http", "Apache-2.0"],
    ]);
    expect(report.components[0].copyrights).toEqual(["Copyright (c) 2024 Sample Org"]);
    expect(report.components[1].copyrights).toEqual(["Copyright 2023 Example Foundation"]);
    expect(report.files.find((f) => f.path === "src/index.ts")?.spdx).toBe("MIT");
    expect(decision.verdict).toBe("allow");
    expect(decision.sourceLinkRequired).toBe(false);
    expect(decision.obligations.some((o) => o.includes("NOTICE"))).toBe(true);
    for (const needle of ["Component: sample-app 1.0.0", "SPDX-License-Identifier: MIT", "Copyright: Copyright (c) 2024 Sample Org", "Licence text: LICENSE", "Component: tiny-http 2.1.0", "SPDX-License-Identifier: Apache-2.0", "Copyright: Copyright 2023 Example Foundation", "Licence text: vendor/tiny-http/LICENSE"])
      expect(notice).toContain(needle);
  });

  test("a GPL dependency needs a GPL repo, and is allowed when the repo is GPL-3.0", async () => {
    const mit = await licenceReport(fixture("gpl-dep"), MIT_REPO, builtin);
    expect(mit.report.components.find((c) => c.name === "gpl-lib")).toMatchObject({ version: "3.2.1", spdx: "GPL-3.0-only", copyrights: ["Copyright (c) 2022 Example Maintainers"] });
    expect(mit.decision.verdict).toBe("needs-gpl-repo");
    const gpl = await licenceReport(fixture("gpl-dep"), { publishSource: false, repoLicence: "GPL-3.0-or-later" }, builtin);
    expect(gpl.decision.verdict).toBe("allow-with-obligations");
    expect(gpl.decision.obligations.some((o) => o.startsWith("gpl-lib:") && o.includes("GPL-3.0-or-later"))).toBe(true);
  });

  test("AGPL is allowed only with publishSource, and then needs a source link", async () => {
    const closed = await licenceReport(fixture("agpl-dep"), MIT_REPO, builtin);
    expect(closed.report.components.find((c) => c.name === "net-thing")?.spdx).toBe("AGPL-3.0-or-later");
    expect(closed.decision.verdict).toBe("needs-publish-source");
    expect(closed.decision.sourceLinkRequired).toBe(false);
    const open = await licenceReport(fixture("agpl-dep"), { publishSource: true, repoLicence: "MIT" }, builtin);
    expect(open.decision.verdict).toBe("allow-with-obligations");
    expect(open.decision.sourceLinkRequired).toBe(true);
  });

  test("a project with no licence and a BUSL project both go clean-room", async () => {
    const none = await licenceReport(fixture("no-licence"), MIT_REPO, builtin);
    expect(none.report.components).toEqual([{ name: "sample-unlicensed", version: "0.0.1", path: ".", spdx: null, copyrights: [], files: 2 }]);
    expect(none.decision.verdict).toBe("clean-room");
    const busl = await licenceReport(fixture("busl"), { publishSource: true, repoLicence: "GPL-3.0-only" }, builtin);
    expect(busl.report.components[0]).toMatchObject({ name: "example/sample-engine", spdx: "BUSL-1.1", copyrights: ["Copyright (c) 2024 Example Corp"] });
    expect(busl.decision.verdict).toBe("clean-room");
  });

  test("a vendure-like dual-licence project and one with competing licence files are flagged for a manual choice", async () => {
    const v = await licenceReport(fixture("vendure-like"), { publishSource: true, repoLicence: "GPL-3.0-or-later" }, builtin);
    expect(v.report.dualLicence.map((d) => d.name)).toEqual(["@vendure/core"]);
    expect(v.report.dualLicence[0].reason).toContain("known dual-licence project");
    expect(v.report.dualLicence[0].reason).toContain("dual licensed");
    expect(v.report.components[0].spdx).toBe("GPL-3.0-or-later OR LicenseRef-Commercial");
    expect(v.decision.verdict).toBe("manual");

    const files = await licenceReport(fixture("dual-files"), MIT_REPO, builtin);
    expect(files.report.dualLicence[0].reason).toContain("several licence files");
    expect(files.decision.verdict).toBe("manual");
  });

  test("node_modules packages (scoped too), LGPL's COPYING + COPYING.LESSER and a stray GPL file", async () => {
    const root = await tempDir();
    await writeTree(root, {
      "package.json": '{"name":"sample-host","license":"MIT"}',
      "node_modules/left-pad/package.json": '{"name":"left-pad","version":"1.3.0","license":"WTFPL"}',
      "node_modules/@scope/util/package.json": '{"name":"@scope/util","version":"0.1.0","license":"ISC"}',
      "node_modules/@scope/util/dist/esm/package.json": '{"type":"module"}',
      "node_modules/@scope/util/dist/esm/index.js": "export {};",
      "vendor/libfoo/COPYING": "GNU GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007",
      "vendor/libfoo/COPYING.LESSER": "GNU LESSER GENERAL PUBLIC LICENSE\nVersion 3, 29 June 2007",
      "vendor/libfoo/foo.c": "int foo;",
      "src/borrowed.c": "/* SPDX-License-Identifier: GPL-2.0-only */\nint x;",
    });
    const { report, decision } = await licenceReport(root, MIT_REPO, builtin);
    const byPath = Object.fromEntries(report.components.map((c) => [c.path, c] as const));
    expect(Object.keys(byPath).sort()).toEqual([".", "node_modules/@scope/util", "node_modules/left-pad", "vendor/libfoo"]);
    expect(byPath["node_modules/@scope/util"]).toMatchObject({ spdx: "ISC", files: 3 });
    expect(byPath["vendor/libfoo"].spdx).toBe("LGPL-3.0-only");
    expect(report.dualLicence).toEqual([]);
    const libfoo = decision.components.find((c) => c.path === "vendor/libfoo")!;
    expect(libfoo.verdict).toBe("allow-with-obligations");
    expect(decision.components.find((c) => c.name === "left-pad")?.verdict).toBe("clean-room");
    expect(decision.components.find((c) => c.path === "src/borrowed.c")).toMatchObject({ spdx: "GPL-2.0-only", verdict: "needs-gpl-repo" });
    expect(decision.verdict).toBe("clean-room");
  });

  test("the report hash is over canonical JSON: same tree, same hash; any change, a new hash", async () => {
    const a = await scanRepo(fixture("mit-apache"), builtin);
    const b = await scanRepo(fixture("mit-apache"), builtin);
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(a.sha256).toBe(b.sha256);
    expect(reportHash(a)).toBe(a.sha256);
    expect(canonicalJson({ b: 1, a: { d: [2, { y: 1, x: 0 }], c: null } })).toBe('{"a":{"c":null,"d":[2,{"x":0,"y":1}]},"b":1}');
    expect(reportHash({ ...a, components: a.components.map((c, i) => (i === 1 ? { ...c, spdx: "MIT" } : c)) })).not.toBe(a.sha256);
  });
});

describe("ScanCode adapter", () => {
  const makeRepo = async () => {
    const parent = await tempDir("scancode-");
    const repo = join(parent, "repo");
    await writeTree(repo, {
      LICENSE: "MIT text",
      "package.json": '{"name":"scanned-app","version":"4.0.0","license":"MIT"}',
      "vendor/zlibby/LICENSE": "zlib text",
      "vendor/zlibby/z.c": "int z;",
      "src/odd.js": "x",
    });
    return { parent, repo };
  };
  const fakeScancode = async (parent: string, body: string) => {
    const bin = join(parent, "fake-scancode");
    await writeFile(bin, `#!/bin/sh\necho "$@" > "${join(parent, "args.txt")}"\n${body}\n`);
    await chmod(bin, 0o755);
    return bin;
  };

  test("a fake scancode binary's JSON maps into the same report shape", async () => {
    const { parent, repo } = await makeRepo();
    const bin = await fakeScancode(parent, `cp "${join(FIXTURES, "scancode", "scan.json")}" "$4"`);
    const { report, decision } = await licenceReport(repo, MIT_REPO, { scancode: { bin } });
    expect(await readFile(join(parent, "args.txt"), "utf8")).toMatch(/^--license --copyright --json-pp \S+scan\.json \S+repo\n$/);
    expect(report.tool).toBe("scancode");
    expect(report.components.map((c) => [c.name, c.path, c.spdx, c.copyrights])).toEqual([
      ["scanned-app", ".", "MIT", ["Copyright (c) 2024 Sample Org"]],
      ["zlibby", "vendor/zlibby", "Zlib", ["Copyright (c) 2019 Example Zlib Authors"]],
    ]);
    expect(report.files.find((f) => f.path === "vendor/zlibby/z.c")?.spdx).toBe("Zlib");
    // ScanCode's proprietary finding on one file is not covered by the MIT root, so it decides the fork.
    expect(decision.components.find((c) => c.path === "src/odd.js")?.verdict).toBe("clean-room");
    expect(decision.verdict).toBe("clean-room");
  });

  test("no binary, a failing binary or unreadable output: null, and scanRepo falls back to the built-in detector", async () => {
    const { parent, repo } = await makeRepo();
    expect(await runScancode(repo, { bin: null })).toBeNull();
    const failing = await fakeScancode(parent, "exit 3");
    expect(await runScancode(repo, { bin: failing })).toBeNull();
    const garbage = await fakeScancode(parent, 'echo "not json" > "$4"');
    expect(await runScancode(repo, { bin: garbage })).toBeNull();
    expect((await scanRepo(repo, { scancode: { bin: failing } })).tool).toBe("builtin");
    expect(mapScancodeJson({ nope: true }, repo)).toBeNull();
  });
});

describe("policy", () => {
  const comp = (spdx: string | null, name = "c"): LicenceComponent => ({ name, path: name, spdx, copyrights: [], files: 1 });
  const report = (...spdx: (string | null)[]) => ({ components: spdx.map((s, i) => comp(s, `c${i}`)), files: [], dualLicence: [] });

  test("OR picks the most permissive usable option; AND takes the strictest", () => {
    expect(decideExpression("GPL-3.0-only OR MIT", MIT_REPO)).toMatchObject({ verdict: "allow", effective: "MIT" });
    expect(decideExpression("AGPL-3.0-only OR BUSL-1.1", MIT_REPO)).toMatchObject({ verdict: "needs-publish-source", effective: "AGPL-3.0-only" });
    expect(decideExpression("MIT AND MPL-2.0", MIT_REPO)).toMatchObject({ verdict: "allow-with-obligations", effective: "MIT AND MPL-2.0" });
    expect(decideExpression("MIT AND (Elastic-2.0 OR LicenseRef-Commercial)", MIT_REPO)).toMatchObject({ verdict: "clean-room", effective: null });
    expect(decideExpression("Apache-2.0 WITH Commons-Clause", MIT_REPO).verdict).toBe("clean-room");
    expect(decideExpression("GPL-2.0-only WITH Classpath-exception-2.0", MIT_REPO).verdict).toBe("allow-with-obligations");
    expect(decideExpression("MIT WITH Some-New-exception", MIT_REPO).verdict).toBe("manual");
    expect(decideExpression("not an expression (", MIT_REPO).verdict).toBe("clean-room");
  });

  test("GPL versions must fit the venture repo licence", () => {
    expect(decideExpression("GPL-2.0-only", { publishSource: false, repoLicence: "GPL-3.0-only" }).verdict).toBe("needs-gpl-repo");
    expect(decideExpression("GPL-2.0-or-later", { publishSource: false, repoLicence: "GPL-3.0-only" }).verdict).toBe("allow-with-obligations");
    expect(decideExpression("GPL-3.0-only", { publishSource: false, repoLicence: "AGPL-3.0-only" }).verdict).toBe("allow-with-obligations");
    expect(decideExpression("GPL-3.0-only", { publishSource: false, repoLicence: "" }).verdict).toBe("needs-gpl-repo");
  });

  test("every permissive id in the policy table is allowed with a NOTICE obligation", () => {
    for (const id of ["MIT", "BSD-2-Clause", "BSD-3-Clause", "0BSD", "Apache-2.0", "ISC", "Unlicense", "Zlib", "CC0-1.0"]) {
      const d = decideExpression(id, MIT_REPO);
      expect(d.verdict).toBe("allow");
      expect(d.obligations.join(" ")).toContain("NOTICE");
    }
    for (const id of ["BUSL-1.1", "Elastic-2.0", "PolyForm-Noncommercial-1.0.0", "LicenseRef-Commons-Clause", "LicenseRef-NonCommercial", "CC-BY-NC-4.0", "SomethingElse-1.0"])
      expect(decideExpression(id, { publishSource: true, repoLicence: "AGPL-3.0-only" }).verdict).toBe("clean-room");
  });

  test("a dual-licence component is manual unless something else already forces clean-room", () => {
    expect(decide({ ...report("MIT"), dualLicence: [{ name: "c0", reason: "known" }] }, MIT_REPO).verdict).toBe("manual");
    expect(decide({ ...report("MIT", null), dualLicence: [{ name: "c0", reason: "known" }] }, MIT_REPO).verdict).toBe("clean-room");
    expect(decide({ components: [], files: [], dualLicence: [] }, MIT_REPO).verdict).toBe("clean-room");
  });

  // A small seeded PRNG so the property run is the same every time.
  const rng = (seed: number) => () => {
    seed = (seed * 1_103_515_245 + 12_345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const POOL = ["MIT", "Apache-2.0", "BSD-3-Clause", "ISC", "MPL-2.0", "LGPL-2.1-only", "GPL-2.0-only", "GPL-3.0-or-later", "AGPL-3.0-only", "SSPL-1.0", "BUSL-1.1", "Elastic-2.0", "LicenseRef-Unknown"];
  const randomExpr = (r: () => number, depth = 0): string => {
    const x = r();
    if (depth > 2 || x < 0.5) return POOL[Math.floor(r() * POOL.length)];
    const op = x < 0.75 ? "AND" : "OR";
    return `(${randomExpr(r, depth + 1)} ${op} ${randomExpr(r, depth + 1)})`;
  };

  test("property: a component that is plainly AGPL never yields a fork verdict without publishSource", () => {
    const r = rng(20261120);
    for (let i = 0; i < 500; i++) {
      const others = Array.from({ length: Math.floor(r() * 4) }, () => randomExpr(r));
      const agpl = r() < 0.5 ? "AGPL-3.0-only" : `AGPL-3.0-or-later AND ${randomExpr(r)}`;
      const at = Math.floor(r() * (others.length + 1));
      const all = [...others.slice(0, at), agpl, ...others.slice(at)];
      const repoLicence = ["MIT", "GPL-3.0-only", "AGPL-3.0-only"][Math.floor(r() * 3)];
      const d = decide(report(...all), { publishSource: false, repoLicence });
      expect(VERDICT_RANK[d.verdict]).toBeGreaterThanOrEqual(VERDICT_RANK["needs-publish-source"]);
      expect(d.verdict).not.toBe("allow");
    }
  });

  test("property: adding a component never makes the verdict more permissive, and AND is never looser than its parts", () => {
    const r = rng(7);
    for (let i = 0; i < 300; i++) {
      const input = { publishSource: r() < 0.5, repoLicence: ["MIT", "GPL-3.0-or-later", "AGPL-3.0-only"][Math.floor(r() * 3)] };
      const a = randomExpr(r);
      const b = randomExpr(r);
      const one = decide(report(a), input).verdict;
      const two = decide(report(a, b), input).verdict;
      expect(VERDICT_RANK[two]).toBeGreaterThanOrEqual(VERDICT_RANK[one]);
      const and = decideExpression(`(${a}) AND (${b})`, input).verdict;
      const or = decideExpression(`(${a}) OR (${b})`, input).verdict;
      const pa = VERDICT_RANK[decideExpression(a, input).verdict];
      const pb = VERDICT_RANK[decideExpression(b, input).verdict];
      expect(VERDICT_RANK[and]).toBe(Math.max(pa, pb));
      expect(VERDICT_RANK[or]).toBe(Math.min(pa, pb));
    }
  });

  test("every known id has a class the policy handles", () => {
    for (const id of KNOWN_IDS) expect(Object.keys(VERDICT_RANK)).toContain(decideExpression(id, MIT_REPO).verdict);
  });
});

describe("NOTICE and REUSE output", () => {
  const info = { copyright: ["Copyright (c) 2024 Sample Org"], spdx: "MIT" };

  test("headers use each language's comment syntax", () => {
    expect(reuseHeader("src/a.ts", info)).toBe("// SPDX-FileCopyrightText: Copyright (c) 2024 Sample Org\n// SPDX-License-Identifier: MIT\n");
    expect(reuseHeader("tool.py", info)).toBe("# SPDX-FileCopyrightText: Copyright (c) 2024 Sample Org\n# SPDX-License-Identifier: MIT\n");
    expect(reuseHeader("Dockerfile", info)?.startsWith("# ")).toBe(true);
    expect(reuseHeader("style.css", info)).toBe("/*\nSPDX-FileCopyrightText: Copyright (c) 2024 Sample Org\nSPDX-License-Identifier: MIT\n*/\n");
    expect(reuseHeader("index.html", info)?.startsWith("<!--\n")).toBe(true);
    expect(reuseHeader("data.json", info)).toBeNull();
    expect(reuseHeader("bun.lock", info)).toBeNull();
    expect(reuseHeader("logo.png", info)).toBeNull();
  });

  test("a copyright line cannot close the comment it sits in", () => {
    const header = reuseHeader("a.css", { copyright: ["2024 Evil */ body{display:none} /*"], spdx: "MIT" })!;
    expect(header.match(/\*\//g)?.length).toBe(1);
    expect(reuseHeader("a.html", { copyright: ["x --> <script>"], spdx: "MIT" })!.match(/-->/g)?.length).toBe(1);
    expect(reuseHeader("a.ts", { copyright: ["line one\nline two"], spdx: "MIT" })!.split("\n").length).toBe(3);
  });

  test("headers go after a shebang, and a file that already has one is left alone", () => {
    expect(applyReuseHeader("run.sh", "#!/bin/sh\necho hi\n", info)).toBe("#!/bin/sh\n# SPDX-FileCopyrightText: Copyright (c) 2024 Sample Org\n# SPDX-License-Identifier: MIT\necho hi\n");
    const tagged = "// SPDX-License-Identifier: Apache-2.0\nexport {};\n";
    expect(applyReuseHeader("a.ts", tagged, info)).toBe(tagged);
  });

  test("files that cannot carry a header are covered by REUSE.toml", () => {
    const out = reuseOutput([
      { path: "src/a.ts", content: "export {};\n", ...info },
      { path: "package.json", content: "{}", ...info },
      { path: "img/logo.png", content: new Uint8Array([137, 80, 78, 71]), copyright: ['2024 "Quoted" Org'], spdx: "CC0-1.0" },
    ]);
    expect(out.files.map((f) => f.path)).toEqual(["src/a.ts"]);
    expect(out.files[0].content.startsWith("// SPDX-FileCopyrightText:")).toBe(true);
    expect(out.reuseToml).toBe(
      [
        "version = 1",
        "",
        "[[annotations]]",
        'path = "img/logo.png"',
        'precedence = "aggregate"',
        'SPDX-FileCopyrightText = ["2024 \\"Quoted\\" Org"]',
        'SPDX-License-Identifier = "CC0-1.0"',
        "",
        "[[annotations]]",
        'path = "package.json"',
        'precedence = "aggregate"',
        'SPDX-FileCopyrightText = ["Copyright (c) 2024 Sample Org"]',
        'SPDX-License-Identifier = "MIT"',
        "",
      ].join("\n"),
    );
    expect(reuseOutput([{ path: "a.ts", content: "x", ...info }]).reuseToml).toBeNull();
    expect(reuseToml([])).toBe("version = 1\n");
  });

  test("the NOTICE shows the licence the policy chose for an OR", () => {
    const rep = { components: [{ name: "either", version: "1.0.0", path: "vendor/either", spdx: "GPL-3.0-only OR MIT", copyrights: [], files: 1 }], files: [] };
    const text = noticeFile(rep, decide({ ...rep, dualLicence: [] }, MIT_REPO));
    expect(text).toContain("SPDX-License-Identifier: MIT");
    expect(text).toContain("Copyright: no copyright line found");
  });
});

test("the store engines are Medusa (MIT) by default and Saleor (BSD-3-Clause) as the alternate", () => {
  expect(STORE_ENGINE_DEFAULT).toEqual({ name: "medusa", url: "https://github.com/medusajs/medusa", licence: "MIT" });
  expect(STORE_ENGINE_ALTERNATE).toEqual({ name: "saleor", url: "https://github.com/saleor/saleor", licence: "BSD-3-Clause" });
});

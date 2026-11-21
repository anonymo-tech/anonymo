// WS11 · Licence engine: the report and decision shapes (Ventures Backend spec, PART 6).
//
// A LicenceReport is what a scan saw (ScanCode or the built-in detector, same shape). A LicenceDecision is what the
// Fork & Flip policy makes of it for one venture. The report's sha256 is over its canonical JSON so it can go into a
// receipt.

export type LicenceComponent = {
  name: string;
  version?: string;
  /** Directory of the component, relative to the scanned root ("." for the root project). */
  path: string;
  /** The component's SPDX expression, or null when it carries no licence at all. */
  spdx: string | null;
  copyrights: string[];
  files: number;
};

export type LicenceFileEntry = { path: string; spdx: string | null };

export type LicenceReport = {
  tool: "scancode" | "builtin";
  components: LicenceComponent[];
  files: LicenceFileEntry[];
  dualLicence: { name: string; reason: string }[];
  sha256: string;
};

/** What one file showed: its own licence (header or licence text) and copyright lines. Both scanners produce this. */
export type FileEvidence = { path: string; spdx: string | null; licenceText: boolean; copyrights: string[]; dual?: string };

export type Verdict = "allow" | "allow-with-obligations" | "needs-gpl-repo" | "needs-publish-source" | "manual" | "clean-room";

export type Decision = { verdict: Verdict; obligations: string[]; sourceLinkRequired: boolean; reasons: string[] };

export type DecisionInput = { publishSource: boolean; repoLicence: string };

export type ComponentDecision = Decision & {
  name: string;
  path: string;
  spdx: string | null;
  /** The expression after OR choices were made (null when the component is not forkable at all). */
  effective: string | null;
};

export type LicenceDecision = Decision & { components: ComponentDecision[] };

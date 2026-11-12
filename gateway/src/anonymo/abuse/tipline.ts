// CyberTipline reporting (18 USC 2258A: apparent child sexual abuse material is reported on actual knowledge).
// NCMEC's reporting API needs a registered electronic service provider account, which Anonymo does not have yet, so
// only the interface and a manual stub exist. The stub returns a local id and `filed: false`: an operator files the
// report through NCMEC's own portal, then the preserved record (one year) backs it.

import { randomBytes } from "node:crypto";
import type { FloorCategory } from "../seams.ts";

export type TiplineReport = {
  source: "floor_hit" | "takedown";
  sourceId: string;
  category: FloorCategory;
  observedAt: string; // ISO time of the hit or of the report's receipt
  contentHashes: string[]; // SHA-256 of the content concerned
  reference: string | null; // receipt, generation or job id, when known
};

export interface CyberTiplineReporter {
  file(report: TiplineReport): Promise<{ reportId: string; filed: boolean }>;
}

export const manualTiplineReporter: CyberTiplineReporter = {
  async file() {
    return { reportId: "manual-" + randomBytes(10).toString("hex"), filed: false };
  },
};

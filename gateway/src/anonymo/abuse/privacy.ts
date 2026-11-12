// The abuse inbox's entries in the data inventory (src/privacy/): its body reader and its three tables.
import type { ExternalDoc, TableDoc } from "../../privacy/types.ts";

export const abuseBodyReader: ExternalDoc["bodyReaders"][number] = {
  file: "src/anonymo/abuse/routes.ts",
  carries: "settings",
  reads: "A takedown report: its kind, up to 20 SHA-256 content hashes or one base64 media file, an optional reference id, the reporter's own description and an optional reply address. Operator calls read an action name, a category or a list of SHA-256 hashes.",
  then: "Media is hashed in memory and dropped. The description and reply address are AES-GCM encrypted before they are written. Operator calls need ADMIN_TOKEN.",
  kept: "abuse_reports (kind, status, reference, hashes, encrypted description and contact, deadlines), abuse_hash_blocks (hashes and category), and preservation (an encrypted record, only for a reported child-safety case, one year). No prompt, answer, media or caller network address.",
  evidence: [{ file: "src/anonymo/abuse/routes.ts", contains: "takedownSchema.parse(" }],
};

export function describeAbuse(docs: Record<string, TableDoc>) {
  docs.abuse_reports = {
    category: "operations",
    request: "no",
    purpose: "The 48-hour takedown inbox: reports of intimate images shared without consent, child-safety reports and other abuse reports.",
    retention: "Open until an operator acts. Closed reports are deleted one year after they were actioned or rejected.",
    columns: {
      id: "Random report identifier, returned to the reporter for status checks.",
      kind: "ncii, csam or other.",
      status: "open, actioned or rejected.",
      reference: "Optional receipt, generation or job identifier the reporter points at.",
      hashes_sha256: {
        purpose: "SHA-256 of each reported item; media sent with a report is hashed and dropped.",
        review: { covers: ["type:json"], verdict: "digest-only", why: "A JSON array of lowercase 64-character SHA-256 hex strings, validated by the route before it is written. It never holds content." },
      },
      details_enc: "The reporter's own description, AES-GCM encrypted; readable only by an operator.",
      contact_enc: {
        purpose: "Optional reply address given by the reporter, AES-GCM encrypted.",
        review: { covers: ["name:network"], verdict: "no-request-content", why: "Ciphertext of a reply address the reporter chose to give on an abuse report, so the operator can answer. Never a caller's IP or connection address, never request text, and absent unless the reporter typed it." },
      },
      received_at: "When the report arrived.",
      due_at: "Deadline: 48 hours after arrival.",
      actioned_at: "When an operator acted.",
      action: "blocked, reported or rejected.",
      tipline_report_id: "CyberTipline report id, or a local id for a report an operator files manually.",
    },
  };
  docs.abuse_hash_blocks = {
    category: "operations",
    request: "no",
    purpose: "Block-by-hash: content an upload must never match, from takedowns, reports and operators.",
    retention: "No automatic deletion.",
    columns: {
      sha256: "SHA-256 of the blocked content.",
      category: "Floor category the content is blocked under.",
      source: "takedown, report or operator.",
      report_id: "The takedown report that added it, if any.",
      created_at: "When the block was added.",
    },
  };
  docs.preservation = {
    category: "operations",
    request: "no",
    purpose: "Preservation vault (18 USC 2258A(h)): an encrypted minimal record, written only when a floor hit or report is reported.",
    retention: "One year from writing, then deleted.",
    columns: {
      id: "Random record identifier.",
      source: "floor_hit or takedown.",
      source_id: "The floor hit or takedown report it preserves.",
      category: "Floor category.",
      tipline_report_id: "CyberTipline report id, or a local id for a report filed manually.",
      blob_enc: "AES-GCM encrypted record: category, times, SHA-256 of the blocked text (never the text), and for takedowns the report's hashes and description.",
      created_at: "When the record was written.",
      expires_at: "When it is deleted.",
    },
  };
}

import type { ExternalDoc } from "./types.ts";
export const activityStores: ExternalDoc["otherStores"] = [{
  id: "account-activity-reader", name: "Account activity response in memory",
  purpose: "GET /api/v1/activity merges existing generations, ledger entries, spending alert history and key auto top-up records. Each source and response is limited to 100 rows. Ordinary and session keys read only their own key records; management keys read account records. Key and model filters further restrict results. Spending alerts keep their existing management-or-own-key boundary. CSV and JSON contain the same selected page; a cursor continues the filtered range.",
  holds: "Times, fixed event titles, exact signed USDG amounts, model and provider ids, recorded lanes, key names or existing short labels, receipt references and status. It reads only the lane from receipts; no request body, delivery targets, key secrets or full key hashes enter the response.",
  ttl: "Discarded after the response; cache-control is no-store. No new durable storage, logs or Redis keys. Downloads stay on the caller's device. Existing source retention still applies; spending alerts retain up to 20 firings per rule.",
  requestText: "none", evidence: [{ file: "src/activity/read.ts", contains: "export async function readActivity" }, { file: "src/api/activity.ts", contains: 'c.header("cache-control", "no-store")' }],
}];

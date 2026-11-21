// Sealed, attested-lane and `:private` requests promise that no outside party reads the prompt or the reply
// (GHSA-rch8-pxr3-p8gc). The floor gate's guards (ANONYMO_FLOOR_URL, its fallback, Llama Guard, OpenAI moderation)
// are hosted outside any enclave, so such a request may only be checked by a floor that keeps the text in this
// process (the pre-filter alone) or runs inside the attestation boundary. Otherwise it is refused before the floor
// reads anything, with the same 409 `sealed_unavailable` the router answers when no attested route can serve it.
// Nothing is sent to any guard or provider, held or charged.

import { ApiError } from "../../lib/errors.ts";
import type { FloorGate } from "../seams.ts";

/** Whether the floor may read a confidential request: it runs inside the enclave, or it sends nothing outside this
 *  process. A gate that does not say is assumed to send text out (fails closed). */
export function floorRunsInEnclave(floor: FloorGate): boolean {
  return floor.inEnclave === true || floor.sendsTextOutside === false;
}

/** Throws 409 before the floor check when a confidential request would have its prompt read outside the enclave. */
export function refuseConfidentialOutsideEnclave(floor: FloorGate, confidential: boolean): void {
  if (!confidential || floorRunsInEnclave(floor)) return;
  throw new ApiError(
    409,
    "Sealed and private requests are checked only inside an attested enclave, and none is available right now. Nothing was sent to any provider or safety service, and nothing was charged.",
    "sealed_unavailable",
  );
}

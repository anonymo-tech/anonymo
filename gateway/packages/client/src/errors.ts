import type { ProviderVerification } from "./attestation.js";
import type { ReceiptVerification } from "./receipts.js";

export class AnonymoError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status?: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "AnonymoError";
  }
}

/** Thrown before anything is sent: the provider could not be verified. `verification.checks` says which check failed. */
export class AttestationRefused extends AnonymoError {
  constructor(readonly verification: ProviderVerification) {
    super(`Refusing to send: provider ${verification.providerId} is not verified. ${verification.failures.join(" ")}`.trim(), "attestation_refused", undefined, verification.failures);
    this.name = "AttestationRefused";
  }
}

export class ReceiptInvalid extends AnonymoError {
  constructor(readonly verification: ReceiptVerification) {
    super("The receipt on this response did not verify.", "receipt_invalid", undefined, verification.checks.filter((c) => c.status === "fail"));
    this.name = "ReceiptInvalid";
  }
}

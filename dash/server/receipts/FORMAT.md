# Receipt formats

Receipts attest the signer's statement about a call; they do not prove model correctness, private execution, or Solana payment. A signature is separate from root anchoring and chain finality.

## Canonical v1 signature bytes

UTF-8 of `conclave:receipt:v1` followed by one NUL byte, followed by compact JSON with fields in this exact order:

`version`, `receiptId`, `callId`, `holdId`, `routeVersion`, `signerKeyId`, `signerEpoch`, `issuedAt`, `actualUsd6`, `requestDigest`.

Version is numeric 1. Identifiers are restricted ASCII, 1–128 characters, start alphanumeric and otherwise permit alphanumerics, dot, underscore, and hyphen. Epoch is a positive integer through 2,147,483,647. Time is an exact valid UTC `YYYY-MM-DDTHH:mm:ss.sssZ`. Amount is canonical nonnegative integer micro-USD text through 9,000,000,000,000,000. Digest is 32 bytes encoded as 64 lowercase hex characters. Extra fields, alternative number/time forms, and accessors are rejected. No prompt or wallet field exists.

The Ed25519 signature covers these canonical bytes. Signature encoding is 64 bytes of lowercase hex. Verification uses strict RFC 8032 behavior (`zip215:false`) and canonical non-small-order, torsion-free public keys. Public keys are supplied through a trusted signer map keyed by `signerMapKey(keyId, epoch)`; no receipt carries its own trusted key. Signer validity uses a half-open issue-time interval `[validFrom, validUntil)`. Revocation invalidates the entire epoch, including historical signatures. Rotated historical keys remain verifiable when retained in the trusted map and not revoked. Verification time is explicit caller input, and future-issued receipts are rejected.

## Media v2 payload and settlement semantics

Version 2 uses `conclave:receipt:v2` followed by one NUL byte, followed by compact JSON with fields in this exact order:

`version`, `kind`, `receiptId`, `mediaJobId`, `holdId`, `accountCommitment`, `routeVersion`, `modelId`, `modality`, `signerKeyId`, `signerEpoch`, `issuedAt`, `actualUsd6`, `settlement`, `generationState`, `requestDigest`, `providerReferenceDigest`, `assetDelivery`.

`version` is numeric 2 and `kind` is `media`. `modality` is `image` or `video`. `modelId` is 1–192 restricted ASCII characters, starts alphanumeric and otherwise permits alphanumerics, dot, underscore, colon, slash and hyphen. Shared fields keep v1 validation rules. V1 canonical bytes and existing signatures are unchanged.

The account commitment is SHA-256 of UTF-8 `conclave:receipt-account:v2`, one NUL byte, the canonical lowercase account UUID, one NUL byte, and the canonical lowercase hold UUID. It binds the owned settlement without placing a stable account UUID or wallet in portable receipt bytes. The different hold input prevents this field from acting as a shared account identifier across receipts. It is a commitment, not evidence of a particular wallet identity.

`settlement` is `captured` for a positive exact integer micro-USD amount and `released` for known zero. Missing, pending or ambiguous cost never becomes zero. The service verifies the immutable capture entries and the exact unused-reservation release entries against the owned hold. Full-maximum captures have no release entry; zero has no capture entry and requires a full release. The per-job provider-reference digest must match the hold's settled provider reference. A completed generation or any positive charge requires that digest. A pre-dispatch cancellation has zero charge and a null provider-reference digest. A failed generation can have a known positive charge; failure is not a refund claim.

`generationState` is the terminal generation record: `completed`, `failed` or `cancelled`. `requestDigest`, selected model, route version, owner commitment, hold, job, cost, terminal generation state and provider-reference digest are all signed. This records the service's settlement statement; it is not independent proof of model execution or correctness. No prompt, provider URL or media content enters the payload.

`assetDelivery` is always `not_attested`. A completed generation can still have pending or failed media processing. Asset storage, deletion, download and delivery do not rewrite the immutable usage receipt. No receipt claims storage availability or successful delivery.

The existing signer registry, weekly service validity window, Ed25519 verifier, Merkle tree, proof API and offline verifier handle both versions. V1 and v2 leaves may share one batch; each leaf commits its own versioned canonical signature bytes. Root/proof format and domains stay at v1. No new key discovery or chain authority is introduced.

## Merkle construction

Hash is SHA-256. Domain strings below are UTF-8 terminated by exactly one NUL byte:

- Leaf: `H("conclave:receipt-leaf:v1\0" || canonicalSignatureBytes || signatureBytes)`.
- Internal node: `H("conclave:receipt-node:v1\0" || leftHash32 || rightHash32)`.
- Published root: `H("conclave:receipt-root:v1\0" || leafCountUint32BE || treeHash32)`.

Sort leaves by ascending ASCII receipt ID; reject duplicate IDs. A batch contains 1–4,096 receipts. Empty batches have no root and are rejected. Odd nodes are **promoted unchanged** to the next level, never duplicated. A single-leaf tree has no internal-node hash but still has the count-bound published root.

Proofs contain version, zero-based leaf index, leaf count, and ordered sibling steps with zero-based level, left/right position, and 32-byte hash. A promoted odd node contributes no sibling step. Verification derives every required position/level from index/count, rejects duplicate hashes/extra or missing steps, and recomputes the count-bound root. `buildReceiptTree` validates structure, not signer trust: verify all batch signatures separately before external publication.

## Public verification and anchoring boundary

`verifyPublicReceipt(receipt, trust, publication?)` requires a trusted signer map and explicit verification time. Without publication it returns `signed_pending_anchor`. A supplied proof must verify against its claimed root, but that alone does not establish chain anchoring. Finalized status additionally requires a matching entry in `trust.roots`, keyed by `rootEvidenceKey(claim)`.

Only a separate trusted chain/registry verifier may populate that map after validating the network, transaction, intended program/account, root commitment, slot, and required finality. This library does no RPC, transaction submission, signer discovery, registry registration, or chain verification. Never construct trusted signer/root maps from the receipt, submitted proof, or caller-supplied `verified` flags. Processed/confirmed evidence remains pending. Root evidence is not embedded in a receipt's signature, and its external verifier's trust policy is part of the application boundary.

Private seeds are supplied at runtime as 32-byte arrays and are never included in receipt bytes, proofs, errors, or fixtures. Key generation, secret custody, rotation publication, revocation distribution, durable batch storage, and the real on-chain anchor implementation are separate responsibilities.

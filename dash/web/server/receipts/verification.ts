import { exactObject, utcTime } from './canonical.ts';
import {
  normalizeRoot,
  verifyReceiptInclusion,
  type ReceiptRoot,
} from './merkle.ts';
import {
  verifyReceiptSignature,
  type SignatureVerification,
  type TrustedSignerMap,
} from './signatures.ts';

export type AnchorClaim = {
  version: 1;
  root: ReceiptRoot;
  network: 'solana-mainnet-beta' | 'solana-devnet';
  transaction: string;
};
/** Populate only after a separate trusted RPC/registry verifier checks the chain. */
export type ExternallyVerifiedRoot = {
  claim: AnchorClaim;
  finality: 'processed' | 'confirmed' | 'finalized';
  slot: string;
  verifiedAt: string;
};
export type ReceiptTrust = {
  signers: TrustedSignerMap;
  /** This map is trusted caller input; never construct it from published claims. */
  roots?: ReadonlyMap<string, ExternallyVerifiedRoot>;
  now: string;
};
type SignatureFailure = Extract<
  SignatureVerification,
  { valid: false }
>['reason'];
export type ReceiptVerification =
  | {
      valid: false;
      status: 'invalid';
      reason:
        | SignatureFailure
        | 'invalid_proof'
        | 'invalid_anchor'
        | 'invalid_root_evidence';
    }
  | {
      valid: true;
      status: 'signed_pending_anchor';
      signatureVerified: true;
      anchorVerified: false;
      reason: 'not_submitted' | 'root_unverified' | 'not_finalized';
    }
  | {
      valid: true;
      status: 'anchored_finalized';
      signatureVerified: true;
      anchorVerified: true;
      root: ReceiptRoot;
      network: AnchorClaim['network'];
      transaction: string;
      slot: string;
    };

function claim(value: unknown): AnchorClaim {
  const item = exactObject(value, [
    'version',
    'root',
    'network',
    'transaction',
  ]);
  if (
    item.version !== 1 ||
    (item.network !== 'solana-mainnet-beta' &&
      item.network !== 'solana-devnet') ||
    typeof item.transaction !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(item.transaction)
  )
    throw new Error('Invalid anchor claim');
  return {
    version: 1,
    root: normalizeRoot(item.root),
    network: item.network,
    transaction: item.transaction,
  };
}

export function rootEvidenceKey(value: AnchorClaim): string {
  const checked = claim(value);
  return `${checked.network}#${checked.transaction}#${checked.root.hash}`;
}

/** Pure verification: no RPC calls, no implicit signer discovery, no self-trusted keys. */
export async function verifyPublicReceipt(
  receipt: unknown,
  trust: ReceiptTrust,
  publication?: { claim: AnchorClaim; proof: unknown },
): Promise<ReceiptVerification> {
  const signed = verifyReceiptSignature(receipt, trust.signers, trust.now);
  if (!signed.valid)
    return { valid: false, status: 'invalid', reason: signed.reason };
  if (publication === undefined)
    return {
      valid: true,
      status: 'signed_pending_anchor',
      signatureVerified: true,
      anchorVerified: false,
      reason: 'not_submitted',
    };
  let anchor: AnchorClaim;
  try {
    exactObject(publication, ['claim', 'proof']);
    anchor = claim(publication.claim);
  } catch {
    return { valid: false, status: 'invalid', reason: 'invalid_anchor' };
  }
  if (
    !(await verifyReceiptInclusion(
      signed.receipt,
      publication.proof,
      anchor.root,
    ))
  )
    return { valid: false, status: 'invalid', reason: 'invalid_proof' };
  const evidence = trust.roots?.get(rootEvidenceKey(anchor));
  if (!evidence)
    return {
      valid: true,
      status: 'signed_pending_anchor',
      signatureVerified: true,
      anchorVerified: false,
      reason: 'root_unverified',
    };
  try {
    exactObject(evidence, ['claim', 'finality', 'slot', 'verifiedAt']);
    const observed = claim(evidence.claim);
    if (
      rootEvidenceKey(observed) !== rootEvidenceKey(anchor) ||
      observed.root.leafCount !== anchor.root.leafCount ||
      typeof evidence.slot !== 'string' ||
      !/^(0|[1-9][0-9]{0,19})$/.test(evidence.slot) ||
      BigInt(evidence.slot) > BigInt('18446744073709551615') ||
      utcTime(evidence.verifiedAt) > utcTime(trust.now)
    )
      return {
        valid: false,
        status: 'invalid',
        reason: 'invalid_root_evidence',
      };
    if (
      evidence.finality !== 'processed' &&
      evidence.finality !== 'confirmed' &&
      evidence.finality !== 'finalized'
    )
      return {
        valid: false,
        status: 'invalid',
        reason: 'invalid_root_evidence',
      };
  } catch {
    return { valid: false, status: 'invalid', reason: 'invalid_root_evidence' };
  }
  if (evidence.finality !== 'finalized')
    return {
      valid: true,
      status: 'signed_pending_anchor',
      signatureVerified: true,
      anchorVerified: false,
      reason: 'not_finalized',
    };
  return {
    valid: true,
    status: 'anchored_finalized',
    signatureVerified: true,
    anchorVerified: true,
    root: anchor.root,
    network: anchor.network,
    transaction: anchor.transaction,
    slot: evidence.slot,
  };
}

import type { PreSignInspection } from '../solana/pre-sign.ts';

export type SignatureInput =
  | {
      kind: 'transaction';
      transaction: string;
      encoding: 'base64' | 'base58';
      intent?: 'swap';
      expectedRecipients?: string[];
    }
  | { kind: 'message'; message: string; pageOrigin: string | null }
  | { kind: 'domain'; url: string }
  | {
      kind: 'action';
      url: string;
      account: string;
      actionHref?: string;
      intent?: 'swap';
      expectedRecipients?: string[];
    }
  | { kind: 'app'; packageName: string; certificateSha256?: string };

export type SignatureFinding = {
  code: string;
  severity: 'info' | 'warning' | 'critical';
  message: string;
  instruction: string | null;
};
export type SignatureEvidence = {
  label: string;
  url: string;
  observedAt: string;
  expiresAt: string | null;
};
export type SignerBalance = {
  signer: string;
  sol: null | {
    beforeLamports: string;
    afterLamports: string;
    deltaLamports: string;
  };
  tokens: {
    account: string;
    mint: string;
    decimals: number;
    beforeAmount: string;
    afterAmount: string;
    deltaAmount: string;
  }[];
};
export type SignatureReport = {
  version: 1;
  inspectedAt: string;
  kind: SignatureInput['kind'];
  verdict: 'looks_like_a_drainer' | 'caution' | 'no_known_patterns';
  verdictLabel:
    | 'Looks like a drainer'
    | 'Caution'
    | 'No known drainer patterns found';
  findings: SignatureFinding[];
  permissions: {
    instruction: string;
    kind: string;
    programId: string | null;
    fields: Record<string, string>;
  }[];
  balances: {
    status: 'complete' | 'partial' | 'unavailable' | 'not-applicable';
    contextSlot: number | null;
    signers: SignerBalance[];
    tokenCoverage: 'reported-transaction-accounts' | 'unavailable';
    allWalletHoldings: false;
  };
  transaction: PreSignInspection | null;
  action: null | {
    endpoint: string;
    transactionEndpoint: string;
    account: string;
    reviewedAt: string;
    expiresAt: string;
    source: string;
    chainSubmission: false;
  };
  domain: null | {
    asciiHost: string;
    unicodeHost: string;
    matchedReference: string | null;
    lookalike: boolean;
    rdap: 'known' | 'unknown';
    registeredAt: string | null;
    ageDays: number | null;
    blocklist: 'listed' | 'not-listed' | 'unknown';
    certificate: 'unknown';
    sources: SignatureEvidence[];
  };
  app: null | {
    packageName: string;
    listing: string | null;
    packageMatch: boolean;
    certificate: 'match' | 'mismatch' | 'unknown';
    sources: SignatureEvidence[];
  };
  coverage: {
    signsOrSubmits: false;
    arbitraryUrlFetch: false;
    innerInstructions: 'uninspected' | 'not-applicable';
    unknowns: string[];
  };
};

export type SignatureCapability = {
  available: true;
  transactionSimulation: boolean;
  transactionEncodings: readonly ['base64', 'base58'];
  domainLookalikes: true;
  rdap: boolean;
  blocklists: boolean;
  appCertificateRegistry: boolean;
  actionUrlResolution: boolean;
  signsOrSubmits: false;
};

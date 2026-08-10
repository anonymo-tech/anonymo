export type SecurityAction = {
  kind: 'add-passkey' | 'link-wallet' | 'remove-identity' | 'revoke-sessions';
  target: string | null;
};

const uuid =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function parseSecurityAction(value: unknown): SecurityAction {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid account action.');
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).length !== 2 ||
    !Object.hasOwn(input, 'kind') ||
    !Object.hasOwn(input, 'target')
  )
    throw new Error('Invalid account action.');
  const { kind, target } = input;
  if (
    (kind === 'add-passkey' && target === null) ||
    (kind === 'link-wallet' &&
      typeof target === 'string' &&
      /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(target)) ||
    (kind === 'remove-identity' &&
      typeof target === 'string' &&
      uuid.test(target)) ||
    (kind === 'revoke-sessions' &&
      typeof target === 'string' &&
      (target === 'others' || uuid.test(target)))
  )
    return { kind, target } as SecurityAction;
  throw new Error('Invalid account action.');
}

export function securityActionLabel(action: SecurityAction): string {
  const checked = parseSecurityAction(action);
  switch (checked.kind) {
    case 'add-passkey':
      return 'Add a passkey to this Conclave account';
    case 'link-wallet':
      return `Link Solana wallet ${checked.target} to this Conclave account`;
    case 'remove-identity':
      return `Remove sign-in identity ${checked.target} from this Conclave account`;
    case 'revoke-sessions':
      return checked.target === 'others'
        ? 'Sign out all other Conclave sessions'
        : `Sign out Conclave session ${checked.target}`;
  }
}

export function securityWalletStatement(
  purpose: 'reauthenticate' | 'link-wallet',
  accountId: string,
  action: SecurityAction,
): string {
  if (!uuid.test(accountId)) throw new Error('Invalid account action.');
  const label = securityActionLabel(action);
  if (purpose === 'link-wallet' && action.kind !== 'link-wallet')
    throw new Error('Invalid account action.');
  return `${purpose === 'reauthenticate' ? 'Authorize' : 'Confirm ownership for'}: ${label}. Account: ${accountId}. This does not authorize a transaction or payment.`;
}

export function securityWalletMessage(input: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: '1';
  nonce: string;
  issuedAt: string;
  expirationTime: string;
  requestId: string;
}): string {
  return `${input.domain} wants you to sign in with your Solana account:\n${input.address}\n\n${input.statement}\n\nURI: ${input.uri}\nVersion: 1\nNonce: ${input.nonce}\nIssued At: ${input.issuedAt}\nExpiration Time: ${input.expirationTime}\nRequest ID: ${input.requestId}`;
}

import { ed25519 } from '@noble/curves/ed25519.js';
import {
  address,
  base58Bytes,
  SOLANA_NETWORKS,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
} from './validation.ts';

/** Published program/mint references, not a claim of verified on-chain state. */
export const MAINNET_CUSTODY_PINS = Object.freeze({
  cluster: 'mainnet-beta' as const,
  genesisHash: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
  usdcMint: SOLANA_NETWORKS['mainnet-beta'].usdcMint,
  tokenProgram: TOKEN_PROGRAM,
  squadsProgram: 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf',
});

export type CustodyPlanErrorCode =
  | 'invalid_plan'
  | 'incorrect_mainnet_pins'
  | 'invalid_member'
  | 'duplicate_member'
  | 'independent_custodians_required'
  | 'invalid_threshold'
  | 'missing_permissions'
  | 'consensus_bypass'
  | 'invalid_address_roles';

export class CustodyPlanError extends Error {
  readonly code: CustodyPlanErrorCode;
  constructor(code: CustodyPlanErrorCode) {
    super(code);
    this.name = 'CustodyPlanError';
    this.code = code;
  }
}

export type CustodyMemberPlan = Readonly<{
  publicKey: string;
  /** Opaque declaration label. Different labels do not prove independence. */
  custodianId: string;
  independentlySupplied: true;
  /** Squads V4: propose=1, vote=2, execute=4. */
  permissions: number;
}>;

export type CustodyAddressRoles = Readonly<{
  multisigConfig: string;
  vaultOwner: string;
  usdcTokenAccount: string;
}>;

export type CustodyPlan = Readonly<{
  version: 1;
  kind: 'squads-treasury-plan';
  cluster: 'mainnet-beta';
  genesisHash: string;
  usdcMint: string;
  tokenProgram: string;
  squadsProgram: string;
  members: readonly CustodyMemberPlan[];
  threshold: number;
  configAuthority: null;
  spendingLimits: readonly never[];
  vaultIndex: number;
  addresses: CustodyAddressRoles | null;
}>;

function requirePlan(
  condition: unknown,
  code: CustodyPlanErrorCode,
): asserts condition {
  if (!condition) throw new CustodyPlanError(code);
}

function exactObject(value: unknown, keys: readonly string[]) {
  requirePlan(
    value !== null && typeof value === 'object' && !Array.isArray(value),
    'invalid_plan',
  );
  const prototype = Object.getPrototypeOf(value);
  requirePlan(
    prototype === null || prototype === Object.prototype,
    'invalid_plan',
  );
  const descriptors = Object.getOwnPropertyDescriptors(value);
  requirePlan(
    Reflect.ownKeys(value).length === keys.length &&
      keys.every(
        (key) =>
          Object.hasOwn(descriptors, key) &&
          Object.hasOwn(descriptors[key], 'value'),
      ),
    'invalid_plan',
  );
  return value as Record<string, unknown>;
}

function signingPublicKey(value: unknown): string {
  try {
    const bytes = base58Bytes(value, 32);
    const point = ed25519.Point.fromBytes(bytes, false);
    point.assertValidity();
    requirePlan(
      !point.isSmallOrder() && point.isTorsionFree(),
      'invalid_member',
    );
    return value as string;
  } catch {
    throw new CustodyPlanError('invalid_member');
  }
}

function memberPlan(value: unknown): CustodyMemberPlan {
  const member = exactObject(value, [
    'publicKey',
    'custodianId',
    'independentlySupplied',
    'permissions',
  ]);
  requirePlan(
    typeof member.custodianId === 'string' &&
      /^custodian-[a-z0-9]{1,24}$/.test(member.custodianId) &&
      member.independentlySupplied === true,
    'independent_custodians_required',
  );
  requirePlan(
    typeof member.permissions === 'number' &&
      Number.isInteger(member.permissions) &&
      member.permissions >= 1 &&
      member.permissions <= 7,
    'invalid_member',
  );
  return Object.freeze({
    publicKey: signingPublicKey(member.publicKey),
    custodianId: member.custodianId,
    independentlySupplied: true,
    permissions: member.permissions,
  });
}

function addressRoles(
  value: unknown,
  members: readonly CustodyMemberPlan[],
): CustodyAddressRoles | null {
  if (value === null) return null;
  try {
    const roles = exactObject(value, [
      'multisigConfig',
      'vaultOwner',
      'usdcTokenAccount',
    ]);
    const result = Object.freeze({
      multisigConfig: address(roles.multisigConfig),
      vaultOwner: address(roles.vaultOwner),
      usdcTokenAccount: address(roles.usdcTokenAccount),
    });
    const values = Object.values(result);
    const reserved = new Set([
      SYSTEM_PROGRAM,
      MAINNET_CUSTODY_PINS.usdcMint,
      MAINNET_CUSTODY_PINS.tokenProgram,
      MAINNET_CUSTODY_PINS.squadsProgram,
      ...members.map((member) => member.publicKey),
    ]);
    requirePlan(
      new Set(values).size === 3 &&
        values.every((value) => !reserved.has(value)),
      'invalid_address_roles',
    );
    return result;
  } catch {
    throw new CustodyPlanError('invalid_address_roles');
  }
}

/**
 * Checks a proposed policy only. No key generation, signature, derivation, account
 * lookup or activation occurs. Independent custody and address ownership require
 * external evidence; a caller's declarations cannot establish either property.
 */
export function validateCustodyPlan(value: unknown) {
  const input = exactObject(value, [
    'version',
    'kind',
    ...Object.keys(MAINNET_CUSTODY_PINS),
    'members',
    'threshold',
    'configAuthority',
    'spendingLimits',
    'vaultIndex',
    'addresses',
  ]);
  requirePlan(
    input.version === 1 && input.kind === 'squads-treasury-plan',
    'invalid_plan',
  );
  requirePlan(
    Object.entries(MAINNET_CUSTODY_PINS).every(
      ([key, pin]) => input[key] === pin,
    ),
    'incorrect_mainnet_pins',
  );
  requirePlan(
    input.configAuthority === null &&
      Array.isArray(input.spendingLimits) &&
      input.spendingLimits.length === 0,
    'consensus_bypass',
  );
  requirePlan(
    Array.isArray(input.members) &&
      input.members.length >= 3 &&
      input.members.length <= 32,
    'invalid_member',
  );
  const members = Array.from(input.members, memberPlan);
  requirePlan(
    new Set(members.map((member) => member.publicKey)).size === members.length,
    'duplicate_member',
  );
  requirePlan(
    new Set(members.map((member) => member.custodianId)).size ===
      members.length,
    'independent_custodians_required',
  );
  const voterCount = members.filter((member) => member.permissions & 2).length;
  requirePlan(
    typeof input.threshold === 'number' &&
      Number.isInteger(input.threshold) &&
      input.threshold >= 2 &&
      input.threshold < voterCount,
    'invalid_threshold',
  );
  requirePlan(
    members.some((member) => member.permissions & 1) &&
      members.some((member) => member.permissions & 4),
    'missing_permissions',
  );
  requirePlan(
    typeof input.vaultIndex === 'number' &&
      Number.isInteger(input.vaultIndex) &&
      input.vaultIndex >= 0 &&
      input.vaultIndex <= 255,
    'invalid_plan',
  );
  const plan: CustodyPlan = Object.freeze({
    version: 1,
    kind: 'squads-treasury-plan',
    ...MAINNET_CUSTODY_PINS,
    members: Object.freeze(members),
    threshold: input.threshold,
    configAuthority: null,
    spendingLimits: Object.freeze([]),
    vaultIndex: input.vaultIndex,
    addresses: addressRoles(input.addresses, members),
  });
  return Object.freeze({
    status: 'offline_plan_validated' as const,
    custody: 'operator-controlled-treasury' as const,
    activationReady: false as const,
    contractEnforcedEscrow: false as const,
    custodianIndependenceVerified: false as const,
    signingControlVerified: false as const,
    addressDerivationsVerified: false as const,
    onChainStateVerified: false as const,
    plan,
  });
}

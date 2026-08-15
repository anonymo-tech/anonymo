import bs58 from 'bs58';
import {
  addFlag,
  unsupported,
  type ExplainedInstruction,
  type ExplanationFlag,
} from './explain-shared.ts';
import {
  address,
  amount,
  COMPUTE_BUDGET_PROGRAM,
  list,
  record,
  requireSolana,
  SYSTEM_PROGRAM,
  TOKEN_2022_PROGRAM,
  TOKEN_PROGRAM,
  uint,
} from './validation.ts';

const ASSOCIATED_TOKEN_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
const STAKE_PROGRAM = 'Stake11111111111111111111111111111111111111';
const LOOKUP_TABLE_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const MEMO_PROGRAMS = new Set([
  'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  'Memo4c2pN8afCj432Lb7RMVKi9PbQnnW7ewFFaV3oAH',
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
type FlagCode = ExplanationFlag['code'];
type FieldKind = 'address' | 'u64' | 'seed';
type Rule = {
  description: string;
  addresses: string[];
  integers?: string[];
  seeds?: string[];
  flags: FlagCode[];
};
const flagMessages: Partial<Record<FlagCode, string>> = {
  SOL_TRANSFER:
    'This instruction requests movement of SOL. The amount is shown in lamports; execution and balances are not inferred.',
  ACCOUNT_CREATION:
    'This instruction requests account creation or initialization; current account existence and rent funding are not checked.',
  ACCOUNT_ALLOCATION:
    'This instruction requests account data allocation. Current account state and required funding are not checked.',
  AUTHORITY_CHANGE:
    'This instruction requests a change to account ownership, authority, or withdrawal controls.',
  NONCE_CHANGE:
    'This instruction changes a durable nonce account or its funds. Nonce state and authorization are not independently checked.',
  STAKE_CHANGE:
    'This instruction requests a stake operation. Activation, lockup, validator performance, and current stake state are not checked.',
  ADDRESS_LOOKUP_TABLE:
    'This instruction changes an address lookup table. Its current contents, authority, and activation state are not checked.',
  ACCOUNT_CLOSURE:
    'This instruction requests account closure; destination accounts and resulting balances need separate review.',
  TOKEN_TRANSFER:
    'This instruction requests movement of tokens; mint state and actual received amounts are not inferred.',
};
function flags(result: ExplainedInstruction, codes: FlagCode[]) {
  for (const code of codes)
    addFlag(
      result,
      code,
      'info',
      flagMessages[code] ?? 'Review this instruction separately.',
    );
}
function u64(value: unknown): string {
  requireSolana(!Object.is(value, -0), 'invalid_response');
  return typeof value === 'number'
    ? BigInt(uint(value)).toString()
    : amount(value).toString();
}
function i64(value: unknown): string {
  if (typeof value === 'number')
    requireSolana(
      Number.isSafeInteger(value) && !Object.is(value, -0),
      'invalid_response',
    );
  else
    requireSolana(
      typeof value === 'string' && /^(?:0|-?[1-9][0-9]{0,18})$/.test(value),
      'invalid_response',
    );
  const parsed = BigInt(value as string | number);
  requireSolana(
    parsed >= -(1n << 63n) && parsed < 1n << 63n,
    'invalid_response',
  );
  return parsed.toString();
}
function text(value: unknown, maxBytes = 256): string {
  requireSolana(
    typeof value === 'string' &&
      value.length <= 256 &&
      !Array.from(value).some((character) => {
        const code = character.codePointAt(0)!;
        return (
          (code < 32 && code !== 9 && code !== 10 && code !== 13) ||
          code === 127
        );
      }),
    'invalid_response',
  );
  const bytes = encoder.encode(value);
  requireSolana(
    bytes.length <= maxBytes && decoder.decode(bytes) === value,
    'invalid_response',
  );
  return value;
}
function fields(
  result: ExplainedInstruction,
  info: Record<string, unknown>,
  names: string[],
  kind: FieldKind = 'address',
  optional = false,
) {
  for (const name of names) {
    if (optional && !Object.hasOwn(info, name)) continue;
    result.fields[name] =
      kind === 'address'
        ? address(info[name])
        : kind === 'u64'
          ? u64(info[name])
          : JSON.stringify(text(info[name], 32));
  }
}
function parsedType(raw: Record<string, unknown>): string | null {
  if (raw.parsed === undefined) return null;
  const parsed = record(raw.parsed);
  requireSolana(
    typeof parsed.type === 'string' &&
      /^[A-Za-z][A-Za-z0-9]{0,79}$/.test(parsed.type),
    'invalid_response',
  );
  return parsed.type;
}
function infoOf(raw: Record<string, unknown>) {
  return record(record(raw.parsed).info);
}
function applyRule(
  result: ExplainedInstruction,
  info: Record<string, unknown>,
  rule: Rule,
) {
  fields(result, info, rule.addresses);
  fields(result, info, rule.integers ?? [], 'u64');
  fields(result, info, rule.seeds ?? [], 'seed');
  result.description = rule.description;
}
const systemRules: Record<string, Rule> = {
  transfer: {
    description: 'Requests a native SOL transfer.',
    addresses: ['source', 'destination'],
    integers: ['lamports'],
    flags: ['SOL_TRANSFER'],
  },
  transferWithSeed: {
    description:
      'Requests a native SOL transfer from an address derived with a seed.',
    addresses: ['source', 'sourceBase', 'destination', 'sourceOwner'],
    integers: ['lamports'],
    seeds: ['sourceSeed'],
    flags: ['SOL_TRANSFER'],
  },
  createAccount: {
    description:
      'Requests funding, allocation, and assignment of a new account to its owner program.',
    addresses: ['source', 'newAccount', 'owner'],
    integers: ['lamports', 'space'],
    flags: ['ACCOUNT_CREATION', 'SOL_TRANSFER'],
  },
  createAccountWithSeed: {
    description:
      'Requests creation of an account derived with a seed, with the specified owner program.',
    addresses: ['source', 'newAccount', 'base', 'owner'],
    integers: ['lamports', 'space'],
    seeds: ['seed'],
    flags: ['ACCOUNT_CREATION', 'SOL_TRANSFER'],
  },
  createAccountAllowPrefund: {
    description:
      'Requests account creation allowing an already prefunded account.',
    addresses: ['newAccount', 'owner'],
    integers: ['space'],
    flags: ['ACCOUNT_CREATION'],
  },
  assign: {
    description:
      'Requests assignment of an account to a different owner program.',
    addresses: ['account', 'owner'],
    flags: ['AUTHORITY_CHANGE'],
  },
  assignWithSeed: {
    description:
      'Requests assignment of an account derived with a seed to an owner program.',
    addresses: ['account', 'base', 'owner'],
    seeds: ['seed'],
    flags: ['AUTHORITY_CHANGE'],
  },
  allocate: {
    description:
      'Requests allocation of account data space, measured in bytes.',
    addresses: ['account'],
    integers: ['space'],
    flags: ['ACCOUNT_ALLOCATION'],
  },
  allocateWithSeed: {
    description:
      'Requests account data allocation and owner assignment using a seed.',
    addresses: ['account', 'base', 'owner'],
    integers: ['space'],
    seeds: ['seed'],
    flags: ['ACCOUNT_ALLOCATION', 'AUTHORITY_CHANGE'],
  },
  advanceNonce: {
    description: 'Requests advancement of a durable nonce.',
    addresses: ['nonceAccount', 'recentBlockhashesSysvar', 'nonceAuthority'],
    flags: ['NONCE_CHANGE'],
  },
  withdrawFromNonce: {
    description:
      'Requests withdrawal of lamports from a durable nonce account.',
    addresses: [
      'nonceAccount',
      'destination',
      'recentBlockhashesSysvar',
      'rentSysvar',
      'nonceAuthority',
    ],
    integers: ['lamports'],
    flags: ['NONCE_CHANGE', 'SOL_TRANSFER'],
  },
  initializeNonce: {
    description:
      'Requests durable nonce initialization with the specified authority.',
    addresses: [
      'nonceAccount',
      'recentBlockhashesSysvar',
      'rentSysvar',
      'nonceAuthority',
    ],
    flags: ['NONCE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  authorizeNonce: {
    description:
      'Requests replacement of the authority controlling a durable nonce.',
    addresses: ['nonceAccount', 'nonceAuthority', 'newAuthorized'],
    flags: ['NONCE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  upgradeNonce: {
    description: 'Requests an upgrade to the durable nonce account format.',
    addresses: ['nonceAccount'],
    flags: ['NONCE_CHANGE'],
  },
};
function system(raw: Record<string, unknown>, result: ExplainedInstruction) {
  const type = parsedType(raw);
  const rule =
    type !== null && Object.hasOwn(systemRules, type)
      ? systemRules[type]
      : undefined;
  if (!rule) {
    unsupported(
      result,
      'This System program variant or raw encoding is not supported.',
    );
    return;
  }
  // Keep the operation warning even when an address or amount cannot be decoded.
  flags(result, rule.flags);
  const info = infoOf(raw);
  if (
    type === 'createAccountAllowPrefund' &&
    (Object.hasOwn(info, 'source') || Object.hasOwn(info, 'lamports'))
  )
    flags(result, ['SOL_TRANSFER']);
  applyRule(result, info, rule);
  if (type === 'createAccountAllowPrefund') {
    requireSolana(
      Object.hasOwn(info, 'source') === Object.hasOwn(info, 'lamports'),
      'invalid_response',
    );
    fields(result, info, ['source'], 'address', true);
    fields(result, info, ['lamports'], 'u64', true);
  }
  result.kind = `system${type![0]!.toUpperCase()}${type!.slice(1)}`;
}
const stakeRules: Record<string, Rule> = {
  initialize: {
    description:
      'Requests stake account initialization with staker, withdrawer, and lockup authorities.',
    addresses: ['stakeAccount'],
    flags: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  initializeChecked: {
    description:
      'Requests stake account initialization with the listed staker and withdrawer.',
    addresses: ['stakeAccount', 'staker', 'withdrawer'],
    flags: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  authorize: {
    description: 'Requests replacement of a stake authority.',
    addresses: ['stakeAccount', 'authority', 'newAuthority'],
    flags: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  authorizeChecked: {
    description:
      'Requests replacement of a stake authority with new-authority signature checking by the program.',
    addresses: ['stakeAccount', 'authority', 'newAuthority'],
    flags: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  authorizeWithSeed: {
    description:
      'Requests replacement of a stake authority using an authority derived with a seed.',
    addresses: [
      'stakeAccount',
      'authorityBase',
      'newAuthorized',
      'authorityOwner',
    ],
    seeds: ['authoritySeed'],
    flags: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  authorizeCheckedWithSeed: {
    description:
      'Requests replacement of a stake authority using a seed and new-authority signature checking by the program.',
    addresses: [
      'stakeAccount',
      'authorityBase',
      'newAuthorized',
      'authorityOwner',
    ],
    seeds: ['authoritySeed'],
    flags: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  delegate: {
    description:
      'Requests delegation of stake to the specified validator vote account.',
    addresses: ['stakeAccount', 'voteAccount', 'stakeAuthority'],
    flags: ['STAKE_CHANGE'],
  },
  split: {
    description:
      'Requests splitting lamports and stake into another stake account.',
    addresses: ['stakeAccount', 'newSplitAccount', 'stakeAuthority'],
    integers: ['lamports'],
    flags: ['STAKE_CHANGE', 'SOL_TRANSFER'],
  },
  withdraw: {
    description:
      'Requests withdrawal of lamports from a stake account to the destination.',
    addresses: ['stakeAccount', 'destination', 'withdrawAuthority'],
    integers: ['lamports'],
    flags: ['STAKE_CHANGE', 'SOL_TRANSFER'],
  },
  deactivate: {
    description:
      'Requests deactivation of stake; this does not establish that it is immediately withdrawable.',
    addresses: ['stakeAccount', 'stakeAuthority'],
    flags: ['STAKE_CHANGE'],
  },
  setLockup: {
    description:
      'Requests changes to stake withdrawal lockup conditions or the lockup custodian.',
    addresses: ['stakeAccount', 'custodian'],
    flags: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  setLockupChecked: {
    description:
      'Requests changes to stake withdrawal lockup conditions with custodian signature checking by the program.',
    addresses: ['stakeAccount', 'custodian'],
    flags: ['STAKE_CHANGE', 'AUTHORITY_CHANGE'],
  },
  merge: {
    description:
      'Requests merging stake accounts, draining and closing the source on successful execution.',
    addresses: ['destination', 'source', 'stakeAuthority'],
    flags: ['STAKE_CHANGE', 'SOL_TRANSFER', 'ACCOUNT_CLOSURE'],
  },
  deactivateDelinquent: {
    description:
      'Requests deactivation of delinquent stake using the supplied vote accounts; delinquency is not checked here.',
    addresses: ['stakeAccount', 'voteAccount', 'referenceVoteAccount'],
    flags: ['STAKE_CHANGE'],
  },
  redelegate: {
    description:
      'Requests the deprecated redelegation operation; current runtime support is not established.',
    addresses: [
      'stakeAccount',
      'newStakeAccount',
      'voteAccount',
      'stakeConfigAccount',
      'stakeAuthority',
    ],
    flags: ['STAKE_CHANGE'],
  },
  moveStake: {
    description:
      'Requests movement of lamports and active stake between stake accounts.',
    addresses: ['source', 'destination', 'stakeAuthority'],
    integers: ['lamports'],
    flags: ['STAKE_CHANGE', 'SOL_TRANSFER'],
  },
  moveLamports: {
    description:
      'Requests movement of unstaked lamports between stake accounts.',
    addresses: ['source', 'destination', 'stakeAuthority'],
    integers: ['lamports'],
    flags: ['STAKE_CHANGE', 'SOL_TRANSFER'],
  },
};
function lockupFields(
  result: ExplainedInstruction,
  value: unknown,
  optional: boolean,
) {
  const lockup = record(value);
  for (const name of ['unixTimestamp', 'epoch', 'custodian']) {
    if (optional && !Object.hasOwn(lockup, name)) continue;
    result.fields[`lockup${name[0]!.toUpperCase()}${name.slice(1)}`] =
      name === 'custodian'
        ? address(lockup[name])
        : name === 'epoch'
          ? u64(lockup[name])
          : i64(lockup[name]);
  }
}
function stake(raw: Record<string, unknown>, result: ExplainedInstruction) {
  const type = parsedType(raw);
  if (type === 'getMinimumDelegation') {
    const info = record(raw.parsed).info;
    requireSolana(info === undefined || info === null, 'invalid_response');
    result.kind = 'stakeGetMinimumDelegation';
    result.description =
      'Requests the minimum stake delegation value as program return data; the returned amount is not decoded here.';
    return;
  }
  const rule =
    type !== null && Object.hasOwn(stakeRules, type)
      ? stakeRules[type]
      : undefined;
  if (!rule) {
    flags(result, ['STAKE_CHANGE']);
    unsupported(
      result,
      'This Stake program variant or raw encoding is not supported.',
    );
    return;
  }
  flags(result, rule.flags);
  const info = infoOf(raw);
  applyRule(result, info, rule);
  // Agave also supports newer account layouts without these legacy sysvars.
  fields(
    result,
    info,
    [
      'rentSysvar',
      'clockSysvar',
      'stakeHistorySysvar',
      'stakeConfigAccount',
      'custodian',
    ],
    'address',
    true,
  );
  if (type!.startsWith('authorize')) {
    requireSolana(
      info.authorityType === 'Staker' || info.authorityType === 'Withdrawer',
      'invalid_response',
    );
    result.fields.authorityType = info.authorityType;
  }
  if (type === 'initialize') {
    const authorized = record(info.authorized);
    fields(result, authorized, ['staker', 'withdrawer']);
    lockupFields(result, info.lockup, false);
  }
  if (type === 'setLockup' || type === 'setLockupChecked')
    lockupFields(result, info.lockup, true);
  if (type === 'redelegate')
    unsupported(
      result,
      'This deprecated instruction is identified, but support by the selected runtime is not established.',
    );
  result.kind = `stake${type![0]!.toUpperCase()}${type!.slice(1)}`;
}
function dataBytes(raw: Record<string, unknown>): Uint8Array {
  requireSolana(
    typeof raw.data === 'string' && raw.data.length <= 1700,
    'invalid_response',
  );
  const bytes = bs58.decode(raw.data);
  requireSolana(
    bytes.length <= 1232 && bs58.encode(bytes) === raw.data,
    'invalid_response',
  );
  return bytes;
}
function computeBudget(
  raw: Record<string, unknown>,
  result: ExplainedInstruction,
) {
  addFlag(
    result,
    'COMPUTE_BUDGET',
    'info',
    'These are requested compute settings, not measured consumption or a calculation of the total transaction fee.',
  );
  if (raw.parsed !== undefined) {
    unsupported(
      result,
      'Only the exact binary Compute Budget encoding is supported.',
    );
    return;
  }
  const bytes = dataBytes(raw);
  requireSolana(bytes.length > 0, 'invalid_response');
  const variants = [
    null,
    [
      'computeRequestHeapFrame',
      'heapBytes',
      'Requests a heap frame size in bytes.',
    ],
    ['computeSetUnitLimit', 'computeUnits', 'Requests a compute unit limit.'],
    [
      'computeSetUnitPrice',
      'microLamportsPerComputeUnit',
      'Requests a priority price in micro-lamports per compute unit.',
    ],
    [
      'computeSetLoadedAccountsDataSizeLimit',
      'loadedAccountBytes',
      'Requests a loaded account data size limit in bytes.',
    ],
  ] as const;
  const variant = variants[bytes[0]!];
  if (!variant) {
    unsupported(
      result,
      'This Compute Budget discriminator is deprecated or unsupported.',
    );
    return;
  }
  requireSolana(bytes.length === (bytes[0] === 3 ? 9 : 5), 'invalid_response');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  result.kind = variant[0];
  result.description = variant[2];
  result.fields[variant[1]] =
    bytes[0] === 3
      ? view.getBigUint64(1, true).toString()
      : view.getUint32(1, true).toString();
}
function associatedToken(
  raw: Record<string, unknown>,
  result: ExplainedInstruction,
) {
  let type = parsedType(raw);
  let info: Record<string, unknown>;
  if (type === null) {
    const bytes = dataBytes(raw);
    const discriminator = bytes.length === 0 ? 0 : bytes[0];
    type =
      discriminator === 0
        ? 'create'
        : discriminator === 1
          ? 'createIdempotent'
          : discriminator === 2
            ? 'recoverNested'
            : null;
    // Record closure risk before rejecting truncated or overlong known instructions.
    if (type === 'recoverNested')
      flags(result, ['ACCOUNT_CLOSURE', 'TOKEN_TRANSFER', 'SOL_TRANSFER']);
    if (type === null) {
      unsupported(result);
      return;
    }
    requireSolana(bytes.length <= 1, 'invalid_response');
    const keys = list(raw.accounts).map(address);
    const names =
      type === 'recoverNested'
        ? [
            'nestedSource',
            'nestedMint',
            'destination',
            'nestedOwner',
            'ownerMint',
            'wallet',
            'tokenProgram',
          ]
        : [
            'source',
            'account',
            'wallet',
            'mint',
            'systemProgram',
            'tokenProgram',
          ];
    requireSolana(keys.length >= names.length, 'invalid_response');
    info = Object.fromEntries(names.map((name, i) => [name, keys[i]]));
  } else {
    if (type === 'recoverNested')
      flags(result, ['ACCOUNT_CLOSURE', 'TOKEN_TRANSFER', 'SOL_TRANSFER']);
    if (!['create', 'createIdempotent', 'recoverNested'].includes(type)) {
      unsupported(result);
      return;
    }
    info = infoOf(raw);
  }
  if (type === 'recoverNested') {
    fields(result, info, [
      'nestedSource',
      'nestedMint',
      'destination',
      'nestedOwner',
      'ownerMint',
      'wallet',
      'tokenProgram',
    ]);
    result.kind = 'associatedTokenRecoverNested';
    result.description =
      'Requests transfer of nested account tokens to the destination and closure of the nested account, returning its lamports to the wallet.';
  } else {
    flags(result, ['ACCOUNT_CREATION']);
    fields(result, info, [
      'source',
      'account',
      'wallet',
      'mint',
      'systemProgram',
      'tokenProgram',
    ]);
    requireSolana(info.systemProgram === SYSTEM_PROGRAM, 'invalid_response');
    result.kind =
      type === 'create'
        ? 'associatedTokenCreate'
        : 'associatedTokenCreateIdempotent';
    result.description =
      type === 'create'
        ? 'Requests creation of an associated token account. Its address derivation and current existence are not checked.'
        : 'Requests creation of an associated token account if absent. Its address derivation and existing state are not checked.';
  }
  if (info.tokenProgram === TOKEN_2022_PROGRAM)
    addFlag(
      result,
      'TOKEN_2022_STATE_UNINSPECTED',
      'warning',
      'Token-2022 account and mint extensions are not inspected by this instruction decode.',
    );
  else if (info.tokenProgram !== TOKEN_PROGRAM)
    addFlag(
      result,
      'UNSUPPORTED_TOKEN_PROGRAM',
      'warning',
      'The supplied token program is not one of the supported SPL Token programs.',
    );
}
function lookupTable(
  raw: Record<string, unknown>,
  result: ExplainedInstruction,
) {
  flags(result, ['ADDRESS_LOOKUP_TABLE']);
  const type = parsedType(raw);
  if (type === 'freezeLookupTable') flags(result, ['AUTHORITY_CHANGE']);
  if (type === 'closeLookupTable')
    flags(result, ['ACCOUNT_CLOSURE', 'SOL_TRANSFER']);
  if (
    type === null ||
    ![
      'createLookupTable',
      'freezeLookupTable',
      'extendLookupTable',
      'deactivateLookupTable',
      'closeLookupTable',
    ].includes(type)
  ) {
    unsupported(
      result,
      'This address lookup table variant or raw encoding is not supported.',
    );
    return;
  }
  const info = infoOf(raw);
  fields(result, info, ['lookupTableAccount', 'lookupTableAuthority']);
  const verb = type.slice(0, -'LookupTable'.length);
  result.kind = `lookupTable${verb[0]!.toUpperCase()}${verb.slice(1)}`;
  if (type === 'createLookupTable') {
    flags(result, ['ACCOUNT_CREATION']);
    fields(result, info, ['payerAccount', 'systemProgram']);
    requireSolana(info.systemProgram === SYSTEM_PROGRAM, 'invalid_response');
    fields(result, info, ['recentSlot'], 'u64');
    result.fields.bumpSeed = uint(info.bumpSeed, 255).toString();
    result.description =
      'Requests creation of an address lookup table. Its derived address is not independently verified.';
  } else if (type === 'freezeLookupTable')
    result.description =
      'Requests permanent freezing of an address lookup table, removing the ability to extend or close it.';
  else if (type === 'extendLookupTable') {
    requireSolana(
      Object.hasOwn(info, 'payerAccount') ===
        Object.hasOwn(info, 'systemProgram'),
      'invalid_response',
    );
    fields(result, info, ['payerAccount', 'systemProgram'], 'address', true);
    if (Object.hasOwn(info, 'systemProgram'))
      requireSolana(info.systemProgram === SYSTEM_PROGRAM, 'invalid_response');
    const addresses = list(info.newAddresses, 256).map(address);
    result.fields.newAddressCount = addresses.length.toString();
    // Never silently truncate an address list or exceed the bounded public DTO.
    if (addresses.length <= 50) {
      for (let i = 0; i < addresses.length; i += 5)
        result.fields[`newAddresses${i / 5 + 1}`] = addresses
          .slice(i, i + 5)
          .join('\n');
    } else
      addFlag(
        result,
        'INCOMPLETE_METADATA',
        'warning',
        'The requested address list exceeds the display bound; addresses are omitted. Review the full instruction independently.',
      );
    result.description =
      'Requests appending the listed addresses to an address lookup table; existing contents are not fetched.';
  } else if (type === 'deactivateLookupTable')
    result.description =
      'Requests deactivation of an address lookup table; eligibility for closure is not established here.';
  else {
    fields(result, info, ['recipient']);
    result.description =
      'Requests closure of an address lookup table and transfer of its remaining lamports to the recipient.';
  }
}
function memo(raw: Record<string, unknown>, result: ExplainedInstruction) {
  addFlag(
    result,
    'MEMO',
    'info',
    'Memo text is public transaction data. It is not proof of payment, signer identity, or authenticity of its claims.',
  );
  const value =
    raw.parsed !== undefined ? raw.parsed : decoder.decode(dataBytes(raw));
  requireSolana(typeof value === 'string', 'invalid_response');
  if (value.length > 256 || encoder.encode(value).length > 256) {
    unsupported(
      result,
      'This memo exceeds the display bound; its text is omitted rather than truncated.',
    );
    return;
  }
  const quoted = JSON.stringify(text(value));
  if (quoted.length > 256) {
    unsupported(
      result,
      'This memo exceeds the quoted display bound; its text is omitted rather than truncated.',
    );
    return;
  }
  result.fields.memo = quoted;
  result.kind = 'memo';
  result.description =
    'Contains a UTF-8 memo. Signer authorization is not independently checked.';
}

/** Exact program IDs are authoritative; RPC display labels cannot select a decoder. */
export function decodeCoreInstruction(
  raw: Record<string, unknown>,
  result: ExplainedInstruction,
): boolean {
  switch (raw.programId) {
    case SYSTEM_PROGRAM:
      system(raw, result);
      return true;
    case COMPUTE_BUDGET_PROGRAM:
      computeBudget(raw, result);
      return true;
    case ASSOCIATED_TOKEN_PROGRAM:
      associatedToken(raw, result);
      return true;
    case STAKE_PROGRAM:
      stake(raw, result);
      return true;
    case LOOKUP_TABLE_PROGRAM:
      lookupTable(raw, result);
      return true;
    default:
      if (
        typeof raw.programId === 'string' &&
        MEMO_PROGRAMS.has(raw.programId)
      ) {
        memo(raw, result);
        return true;
      }
      return false;
  }
}

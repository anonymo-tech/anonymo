import bs58 from 'bs58';
import { decodeCoreInstruction } from './explain-core.ts';
import { decodeTokenInstruction } from './explain-token.ts';
import {
  addFlag,
  unsupported,
  type ExplainedInstruction,
  type ExplanationFlag,
} from './explain-shared.ts';
import {
  requireSolana,
  SYSTEM_PROGRAM,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
} from './validation.ts';
import type { SerializedAccount, SerializedTransaction } from './serialized.ts';

const STAKE = 'Stake11111111111111111111111111111111111111';
const LOOKUP = 'AddressLookupTab1e1111111111111111111111111';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const RENT = 'SysvarRent111111111111111111111111111111111';
const RECENT = 'SysvarRecentB1ockHashes11111111111111111111';
const HISTORY = 'SysvarStakeHistory1111111111111111111111111';
const STAKE_CONFIG = 'StakeConfig11111111111111111111111111111111';
type Info = Record<string, unknown>;
type Flag = ExplanationFlag['code'];
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class DataReader {
  offset = 0;
  readonly bytes: Uint8Array;
  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
  }
  take(length: number) {
    requireSolana(
      Number.isSafeInteger(length) &&
        length >= 0 &&
        this.offset + length <= this.bytes.length,
      'invalid_response',
    );
    const result = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return result;
  }
  u8() {
    return this.take(1)[0]!;
  }
  u32() {
    const b = this.take(4);
    return new DataView(b.buffer, b.byteOffset, b.byteLength).getUint32(
      0,
      true,
    );
  }
  u64() {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, b.byteLength)
      .getBigUint64(0, true)
      .toString();
  }
  i64() {
    const b = this.take(8);
    return new DataView(b.buffer, b.byteOffset, b.byteLength)
      .getBigInt64(0, true)
      .toString();
  }
  key() {
    return bs58.encode(this.take(32));
  }
  option<T>(read: () => T): T | null {
    const tag = this.u8();
    requireSolana(tag <= 1, 'invalid_response');
    return tag === 1 ? read() : null;
  }
  seed() {
    const length = BigInt(this.u64());
    requireSolana(length <= 32n, 'invalid_response');
    return utf8.decode(this.take(Number(length)));
  }
  end() {
    requireSolana(this.offset === this.bytes.length, 'invalid_response');
  }
}
function risk(result: ExplainedInstruction, ...codes: Flag[]) {
  for (const code of codes)
    addFlag(
      result,
      code,
      'warning',
      'The binary operation requests this sensitive change; malformed or unsupported fields do not remove the warning.',
    );
}
function count(keys: SerializedAccount[], min: number, max = min) {
  requireSolana(keys.length >= min && keys.length <= max, 'invalid_response');
}
function key(keys: SerializedAccount[], index: number) {
  requireSolana(keys[index] !== undefined, 'invalid_response');
  return keys[index]!.address;
}
function exact(keys: SerializedAccount[], index: number, expected: string) {
  const value = key(keys, index);
  requireSolana(value === expected, 'invalid_response');
  return value;
}
function mapped(keys: SerializedAccount[], names: string[]): Info {
  count(keys, names.length);
  return Object.fromEntries(names.map((name, i) => [name, key(keys, i)]));
}

// A known truncated little-endian discriminator still carries its possible risk.
function opcode(data: DataReader) {
  if (data.bytes.length >= 4)
    return new DataView(
      data.bytes.buffer,
      data.bytes.byteOffset,
      data.bytes.byteLength,
    ).getUint32(0, true);
  return data.bytes.length > 0 &&
    data.bytes.slice(1).every((byte) => byte === 0)
    ? data.bytes[0]!
    : -1;
}

const systemTypes = [
  'createAccount',
  'assign',
  'transfer',
  'createAccountWithSeed',
  'advanceNonce',
  'withdrawFromNonce',
  'initializeNonce',
  'authorizeNonce',
  'allocate',
  'allocateWithSeed',
  'assignWithSeed',
  'transferWithSeed',
  'upgradeNonce',
  'createAccountAllowPrefund',
];
function system(
  data: DataReader,
  keys: SerializedAccount[],
  result: ExplainedInstruction,
) {
  const tag = opcode(data),
    type = systemTypes[tag];
  if ([1, 6, 7, 9, 10].includes(tag)) risk(result, 'AUTHORITY_CHANGE');
  if ([4, 5, 6, 7, 12].includes(tag)) risk(result, 'NONCE_CHANGE');
  if (tag === 5) risk(result, 'SOL_TRANSFER');
  data.u32();
  if (!type || tag === 13) {
    unsupported(result, 'This System binary variant is not supported.');
    return;
  }
  let info: Info = {};
  switch (tag) {
    case 0:
      info = {
        ...mapped(keys, ['source', 'newAccount']),
        lamports: data.u64(),
        space: data.u64(),
        owner: data.key(),
      };
      break;
    case 1:
      info = { ...mapped(keys, ['account']), owner: data.key() };
      break;
    case 2:
      info = {
        ...mapped(keys, ['source', 'destination']),
        lamports: data.u64(),
      };
      break;
    case 3: {
      count(keys, 2, 3);
      const base = data.key();
      requireSolana(
        base === key(keys, keys.length === 3 ? 2 : 0),
        'invalid_response',
      );
      info = {
        source: key(keys, 0),
        newAccount: key(keys, 1),
        base,
        seed: data.seed(),
        lamports: data.u64(),
        space: data.u64(),
        owner: data.key(),
      };
      break;
    }
    case 4:
      info = mapped(keys, [
        'nonceAccount',
        'recentBlockhashesSysvar',
        'nonceAuthority',
      ]);
      exact(keys, 1, RECENT);
      break;
    case 5:
      info = {
        ...mapped(keys, [
          'nonceAccount',
          'destination',
          'recentBlockhashesSysvar',
          'rentSysvar',
          'nonceAuthority',
        ]),
        lamports: data.u64(),
      };
      exact(keys, 2, RECENT);
      exact(keys, 3, RENT);
      break;
    case 6:
      info = {
        ...mapped(keys, [
          'nonceAccount',
          'recentBlockhashesSysvar',
          'rentSysvar',
        ]),
        nonceAuthority: data.key(),
      };
      exact(keys, 1, RECENT);
      exact(keys, 2, RENT);
      break;
    case 7:
      info = {
        ...mapped(keys, ['nonceAccount', 'nonceAuthority']),
        newAuthorized: data.key(),
      };
      break;
    case 8:
      info = { ...mapped(keys, ['account']), space: data.u64() };
      break;
    case 9:
    case 10: {
      info = mapped(keys, ['account', 'base']);
      requireSolana(data.key() === info.base, 'invalid_response');
      info.seed = data.seed();
      if (tag === 9) info.space = data.u64();
      info.owner = data.key();
      break;
    }
    case 11:
      info = {
        ...mapped(keys, ['source', 'sourceBase', 'destination']),
        lamports: data.u64(),
        sourceSeed: data.seed(),
        sourceOwner: data.key(),
      };
      break;
    case 12:
      info = mapped(keys, ['nonceAccount']);
      break;
  }
  data.end();
  decodeCoreInstruction(
    { programId: SYSTEM_PROGRAM, parsed: { type, info } },
    result,
  );
}

const tokenTypes = [
  'initializeMint',
  'initializeAccount',
  'initializeMultisig',
  'transfer',
  'approve',
  'revoke',
  'setAuthority',
  'mintTo',
  'burn',
  'closeAccount',
  'freezeAccount',
  'thawAccount',
  'transferChecked',
  'approveChecked',
  'mintToChecked',
  'burnChecked',
  'initializeAccount2',
  'syncNative',
  'initializeAccount3',
  'initializeMultisig2',
  'initializeMint2',
];
const authorityTypes = [
  'mintTokens',
  'freezeAccount',
  'accountOwner',
  'closeAccount',
  'transferFeeConfig',
  'withheldWithdraw',
  'closeMint',
  'interestRate',
  'permanentDelegate',
  'confidentialTransferMint',
  'transferHookProgramId',
  'confidentialTransferFeeConfig',
  'metadataPointer',
  'groupPointer',
  'groupMemberPointer',
  'scaledUiAmount',
  'pause',
  'permissionedBurn',
];
function authority(
  info: Info,
  keys: SerializedAccount[],
  index: number,
  name: string,
) {
  count(keys, index + 1, index + 12);
  if (keys.length === index + 1) info[name] = key(keys, index);
  else {
    info[`multisig${name[0]!.toUpperCase()}${name.slice(1)}`] = key(
      keys,
      index,
    );
    info.signers = keys.slice(index + 1).map((account) => account.address);
  }
}
function token(
  data: DataReader,
  keys: SerializedAccount[],
  result: ExplainedInstruction,
  programId: string,
) {
  const extended = programId === TOKEN_2022_PROGRAM;
  if (extended)
    addFlag(
      result,
      'TOKEN_2022_STATE_UNINSPECTED',
      'warning',
      'Token-2022 mint and account extensions are not inspected by this instruction decode.',
    );
  const tag = data.u8();
  if ([4, 13].includes(tag)) risk(result, 'TOKEN_APPROVAL');
  if (tag === 6) risk(result, 'AUTHORITY_CHANGE');
  if (tag === 9) risk(result, 'ACCOUNT_CLOSURE');
  if ([7, 14].includes(tag)) risk(result, 'TOKEN_MINT');
  if ([8, 15].includes(tag)) risk(result, 'TOKEN_BURN');
  if ([10, 11].includes(tag)) risk(result, 'TOKEN_FREEZE');
  if ([0, 2, 19, 20].includes(tag)) risk(result, 'TOKEN_CONFIG_CHANGE');
  let type = tokenTypes[tag],
    info: Info = {};
  if (tag >= 25 && extended) {
    // Unsupported extension subtypes remain explicit sensitive operations, not ordinary transfers.
    risk(result, 'TOKEN_CONFIG_CHANGE');
    if ([26, 37].includes(tag)) risk(result, 'TOKEN_TRANSFER_FEE');
    if ([27, 37, 42].includes(tag)) risk(result, 'TOKEN_CONFIDENTIAL');
    if (tag === 35) risk(result, 'TOKEN_PERMANENT_DELEGATE');
    if (tag === 36) risk(result, 'TOKEN_TRANSFER_HOOK');
    if (tag === 43) risk(result, 'TOKEN_SCALED_AMOUNT');
    if (tag === 44) risk(result, 'TOKEN_PAUSE');
    if ([38, 45].includes(tag)) risk(result, 'SOL_TRANSFER');
    if (tag === 46) risk(result, 'TOKEN_BURN');
    if (tag === 25) {
      type = 'initializeMintCloseAuthority';
      info = {
        ...mapped(keys, ['mint']),
        newAuthority: data.option(() => data.key()),
      };
    } else if (tag === 35) {
      type = 'initializePermanentDelegate';
      info = { ...mapped(keys, ['mint']), delegate: data.key() };
    } else if (tag === 32) {
      type = 'initializeNonTransferableMint';
      info = mapped(keys, ['mint']);
    } else {
      unsupported(
        result,
        'This Token-2022 extension binary payload is not decoded; review its full controls and effects independently.',
      );
      return;
    }
  } else if (tag === 0 || tag === 20) {
    count(keys, tag === 0 ? 2 : 1);
    info = {
      mint: key(keys, 0),
      decimals: data.u8(),
      mintAuthority: data.key(),
      freezeAuthority: data.option(() => data.key()),
    };
    if (tag === 0) info.rentSysvar = exact(keys, 1, RENT);
  } else if (tag === 1 || tag === 16 || tag === 18) {
    count(keys, tag === 1 ? 4 : tag === 16 ? 3 : 2);
    info = {
      account: key(keys, 0),
      mint: key(keys, 1),
      owner: tag === 1 ? key(keys, 2) : data.key(),
    };
    if (tag !== 18) info.rentSysvar = exact(keys, tag === 1 ? 3 : 2, RENT);
  } else if (tag === 2 || tag === 19) {
    const start = tag === 2 ? 2 : 1;
    count(keys, start + 1, start + 11);
    info = {
      multisig: key(keys, 0),
      m: data.u8(),
      signers: keys.slice(start).map((account) => account.address),
    };
    if (tag === 2) info.rentSysvar = exact(keys, 1, RENT);
  } else if ([3, 4, 7, 8, 12, 13, 14, 15].includes(tag)) {
    const checked = tag >= 12,
      amount = data.u64();
    if (checked) info.tokenAmount = { amount, decimals: data.u8() };
    else info.amount = amount;
    if (tag === 3 || tag === 12) {
      info.source = key(keys, 0);
      info.destination = key(keys, checked ? 2 : 1);
      if (checked) info.mint = key(keys, 1);
      authority(info, keys, checked ? 3 : 2, 'authority');
    } else if (tag === 4 || tag === 13) {
      info.source = key(keys, 0);
      info.delegate = key(keys, checked ? 2 : 1);
      if (checked) info.mint = key(keys, 1);
      authority(info, keys, checked ? 3 : 2, 'owner');
    } else {
      const minting = tag === 7 || tag === 14;
      info.mint = key(keys, minting ? 0 : 1);
      info.account = key(keys, minting ? 1 : 0);
      authority(info, keys, 2, minting ? 'mintAuthority' : 'authority');
    }
  } else if (tag === 5) {
    info.source = key(keys, 0);
    authority(info, keys, 1, 'owner');
  } else if (tag === 6) {
    const authorityType = authorityTypes[data.u8()];
    requireSolana(authorityType !== undefined, 'unsupported_instruction');
    if (authorityType === 'permanentDelegate')
      risk(result, 'TOKEN_PERMANENT_DELEGATE');
    if (authorityType === 'transferHookProgramId')
      risk(result, 'TOKEN_TRANSFER_HOOK');
    if (authorityType === 'pause') risk(result, 'TOKEN_PAUSE');
    info = {
      [authorityType === 'accountOwner' || authorityType === 'closeAccount'
        ? 'account'
        : 'mint']: key(keys, 0),
      authorityType,
      newAuthority: data.option(() => data.key()),
    };
    authority(info, keys, 1, 'authority');
  } else if (tag === 9) {
    info = { account: key(keys, 0), destination: key(keys, 1) };
    authority(info, keys, 2, 'owner');
  } else if (tag === 10 || tag === 11) {
    info = { account: key(keys, 0), mint: key(keys, 1) };
    authority(info, keys, 2, 'freezeAuthority');
  } else if (tag === 17) info = mapped(keys, ['account']);
  else {
    unsupported(result, 'This token binary instruction is not supported.');
    return;
  }
  data.end();
  decodeTokenInstruction({ programId, parsed: { type, info } }, result);
}

function lookup(
  data: DataReader,
  keys: SerializedAccount[],
  result: ExplainedInstruction,
) {
  risk(result, 'ADDRESS_LOOKUP_TABLE');
  const tag = opcode(data),
    type = [
      'createLookupTable',
      'freezeLookupTable',
      'extendLookupTable',
      'deactivateLookupTable',
      'closeLookupTable',
    ][tag];
  if (tag === 1) risk(result, 'AUTHORITY_CHANGE');
  if (tag === 4) risk(result, 'ACCOUNT_CLOSURE', 'SOL_TRANSFER');
  data.u32();
  if (!type) {
    unsupported(result);
    return;
  }
  const info: Info = {
    lookupTableAccount: key(keys, 0),
    lookupTableAuthority: key(keys, 1),
  };
  if (tag === 0) {
    count(keys, 4);
    Object.assign(info, {
      payerAccount: key(keys, 2),
      systemProgram: exact(keys, 3, SYSTEM_PROGRAM),
      recentSlot: data.u64(),
      bumpSeed: data.u8(),
    });
  } else if (tag === 2) {
    requireSolana(keys.length === 2 || keys.length === 4, 'invalid_response');
    if (keys.length === 4)
      Object.assign(info, {
        payerAccount: key(keys, 2),
        systemProgram: exact(keys, 3, SYSTEM_PROGRAM),
      });
    const size = BigInt(data.u64());
    requireSolana(size > 0n && size <= 256n, 'invalid_response');
    info.newAddresses = Array.from({ length: Number(size) }, () => data.key());
  } else if (tag === 4) {
    count(keys, 3);
    info.recipient = key(keys, 2);
  } else count(keys, 2);
  data.end();
  decodeCoreInstruction({ programId: LOOKUP, parsed: { type, info } }, result);
}

const stakeTypes = [
  'initialize',
  'authorize',
  'delegate',
  'split',
  'withdraw',
  'deactivate',
  'setLockup',
  'merge',
  'authorizeWithSeed',
  'initializeChecked',
  'authorizeChecked',
  'authorizeCheckedWithSeed',
  'setLockupChecked',
  'getMinimumDelegation',
  'deactivateDelinquent',
  'redelegate',
  'moveStake',
  'moveLamports',
];
function stake(
  data: DataReader,
  keys: SerializedAccount[],
  result: ExplainedInstruction,
) {
  const tag = opcode(data),
    type = stakeTypes[tag];
  if (tag !== 13) risk(result, 'STAKE_CHANGE');
  if ([0, 1, 6, 8, 9, 10, 11, 12].includes(tag))
    risk(result, 'AUTHORITY_CHANGE');
  if (tag === 7) risk(result, 'ACCOUNT_CLOSURE');
  if ([3, 4, 7, 16, 17].includes(tag)) risk(result, 'SOL_TRANSFER');
  data.u32();
  if (!type || [8, 11, 15].includes(tag)) {
    unsupported(
      result,
      'This Stake binary variant is not supported; authority and stake warnings remain.',
    );
    return;
  }
  const info: Info = {};
  const authorityType = () => {
    const value = data.u32();
    requireSolana(value <= 1, 'invalid_response');
    return value === 0 ? 'Staker' : 'Withdrawer';
  };
  // Both published legacy sysvar layouts and current sysvar-free layouts are recognized by exact keys/counts.
  if (tag === 0) {
    count(keys, 1, 2);
    info.stakeAccount = key(keys, 0);
    if (keys.length === 2) info.rentSysvar = exact(keys, 1, RENT);
    info.authorized = { staker: data.key(), withdrawer: data.key() };
    info.lockup = {
      unixTimestamp: data.i64(),
      epoch: data.u64(),
      custodian: data.key(),
    };
  } else if (tag === 1 || tag === 10) {
    info.stakeAccount = key(keys, 0);
    const old = keys[1]?.address === CLOCK,
      offset = old ? 1 : 0;
    count(keys, (tag === 1 ? 2 : 3) + offset, (tag === 1 ? 3 : 4) + offset);
    if (old) info.clockSysvar = exact(keys, 1, CLOCK);
    info.authority = key(keys, 1 + offset);
    info.newAuthority = tag === 1 ? data.key() : key(keys, 2 + offset);
    info.authorityType = authorityType();
    const custodian = (tag === 1 ? 2 : 3) + offset;
    if (keys[custodian]) info.custodian = key(keys, custodian);
  } else if (tag === 2) {
    requireSolana(keys.length === 3 || keys.length === 6, 'invalid_response');
    Object.assign(info, {
      stakeAccount: key(keys, 0),
      voteAccount: key(keys, 1),
      stakeAuthority: key(keys, keys.length - 1),
    });
    if (keys.length === 6)
      Object.assign(info, {
        clockSysvar: exact(keys, 2, CLOCK),
        stakeHistorySysvar: exact(keys, 3, HISTORY),
        stakeConfigAccount: exact(keys, 4, STAKE_CONFIG),
      });
  } else if ([3, 16, 17].includes(tag)) {
    Object.assign(
      info,
      mapped(
        keys,
        tag === 3
          ? ['stakeAccount', 'newSplitAccount', 'stakeAuthority']
          : ['source', 'destination', 'stakeAuthority'],
      ),
      { lamports: data.u64() },
    );
  } else if (tag === 4) {
    const old = keys[2]?.address === CLOCK;
    count(keys, old ? 5 : 3, old ? 6 : 4);
    Object.assign(info, {
      stakeAccount: key(keys, 0),
      destination: key(keys, 1),
      withdrawAuthority: key(keys, old ? 4 : 2),
      lamports: data.u64(),
    });
    if (old)
      Object.assign(info, {
        clockSysvar: exact(keys, 2, CLOCK),
        stakeHistorySysvar: exact(keys, 3, HISTORY),
      });
    if (keys[old ? 5 : 3]) info.custodian = key(keys, old ? 5 : 3);
  } else if (tag === 5) {
    count(keys, 2, 3);
    info.stakeAccount = key(keys, 0);
    info.stakeAuthority = key(keys, keys.length - 1);
    if (keys.length === 3) info.clockSysvar = exact(keys, 1, CLOCK);
  } else if (tag === 6 || tag === 12) {
    count(keys, 2, tag === 12 ? 3 : 2);
    info.stakeAccount = key(keys, 0);
    info.custodian = key(keys, 1);
    const lockup: Info = {};
    const timestamp = data.option(() => data.i64()),
      epoch = data.option(() => data.u64());
    if (timestamp !== null) lockup.unixTimestamp = timestamp;
    if (epoch !== null) lockup.epoch = epoch;
    const custodian =
      tag === 6 ? data.option(() => data.key()) : keys[2]?.address;
    if (custodian != null) lockup.custodian = custodian;
    info.lockup = lockup;
  } else if (tag === 7) {
    requireSolana(keys.length === 3 || keys.length === 5, 'invalid_response');
    Object.assign(info, {
      destination: key(keys, 0),
      source: key(keys, 1),
      stakeAuthority: key(keys, keys.length - 1),
    });
    if (keys.length === 5)
      Object.assign(info, {
        clockSysvar: exact(keys, 2, CLOCK),
        stakeHistorySysvar: exact(keys, 3, HISTORY),
      });
  } else if (tag === 9) {
    count(keys, 3, 4);
    const old = keys.length === 4;
    info.stakeAccount = key(keys, 0);
    info.staker = key(keys, old ? 2 : 1);
    info.withdrawer = key(keys, old ? 3 : 2);
    if (old) info.rentSysvar = exact(keys, 1, RENT);
  } else if (tag === 13) count(keys, 0);
  else if (tag === 14)
    Object.assign(
      info,
      mapped(keys, ['stakeAccount', 'voteAccount', 'referenceVoteAccount']),
    );
  data.end();
  decodeCoreInstruction(
    { programId: STAKE, parsed: { type, info: tag === 13 ? null : info } },
    result,
  );
}

/** Decode requested operations from original bytes, never from RPC-provided labels or parsed fields. */
export function explainRawInstructions(
  parsed: SerializedTransaction,
  accounts: SerializedAccount[],
): ExplainedInstruction[] {
  requireSolana(
    accounts.length ===
      parsed.staticAccounts.length +
        parsed.loadedWritableCount +
        parsed.loadedReadonlyCount,
    'invalid_response',
  );
  return parsed.instructions.map((instruction, index) => {
    const programId = accounts[instruction.programIdIndex]?.address ?? null;
    const result: ExplainedInstruction = {
      location: String(index),
      programId,
      kind: 'unknown',
      description:
        'This requested operation is not decoded. Execution is not established.',
      fields: {},
      flags: [],
    };
    try {
      const keys = instruction.accountIndexes.map((i) => {
        requireSolana(accounts[i] !== undefined, 'invalid_response');
        return accounts[i]!;
      });
      const data = new DataReader(instruction.data);
      if (programId === SYSTEM_PROGRAM) system(data, keys, result);
      else if (programId === TOKEN_PROGRAM || programId === TOKEN_2022_PROGRAM)
        token(data, keys, result, programId);
      else if (programId === STAKE) stake(data, keys, result);
      else if (programId === LOOKUP) lookup(data, keys, result);
      else if (
        !decodeCoreInstruction(
          {
            programId,
            data: bs58.encode(instruction.data),
            accounts: keys.map((account) => account.address),
          },
          result,
        )
      )
        addFlag(
          result,
          'UNKNOWN_PROGRAM',
          'warning',
          'This program is not supported. Its requested effects are not interpreted.',
        );
      requireSolana(
        Object.keys(result.fields).length <= 16 &&
          Object.values(result.fields).every((value) => value.length <= 256),
        'invalid_response',
      );
    } catch {
      result.kind = 'malformed';
      result.fields = {};
      result.description =
        'The binary instruction or account layout could not be decoded completely. Sensitive-operation warnings remain; do not treat this as approval.';
      addFlag(
        result,
        'MALFORMED_INSTRUCTION',
        'warning',
        'Malformed or unsupported binary fields prevent a complete deterministic explanation.',
      );
    }
    result.flags = [
      ...new Map(result.flags.map((flag) => [flag.code, flag])).values(),
    ];
    requireSolana(result.flags.length <= 8, 'invalid_response');
    return result;
  });
}

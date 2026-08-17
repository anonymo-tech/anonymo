import { createHash } from 'node:crypto';
import bs58 from 'bs58';
import { address, requireSolana, SYSTEM_PROGRAM } from './validation.ts';

export type SerializedAccount = {
  address: string;
  signer: boolean;
  writable: boolean;
};
export type SerializedInstruction = {
  programIdIndex: number;
  accountIndexes: number[];
  data: Uint8Array;
};
export type SerializedTransaction = {
  version: 'legacy' | 0;
  serializedHash: string;
  byteLength: number;
  wireBase64: string;
  messageBase64: string;
  recentBlockhash: string;
  header: {
    numRequiredSignatures: number;
    numReadonlySignedAccounts: number;
    numReadonlyUnsignedAccounts: number;
  };
  signatures: { value: string; present: boolean }[];
  staticAccounts: SerializedAccount[];
  instructions: SerializedInstruction[];
  addressTableLookups: {
    accountKey: string;
    writableIndexes: number[];
    readonlyIndexes: number[];
  }[];
  loadedWritableCount: number;
  loadedReadonlyCount: number;
};

class WireReader {
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
      'invalid_input',
    );
    const value = this.bytes.slice(this.offset, this.offset + length);
    this.offset += length;
    return value;
  }
  byte() {
    return this.take(1)[0]!;
  }
  short(max: number) {
    let value = 0;
    for (let i = 0; i < 3; i++) {
      const byte = this.byte();
      requireSolana(i < 2 || byte <= 3, 'invalid_input');
      value |= (byte & 127) << (7 * i);
      if (!(byte & 128)) {
        requireSolana((i === 0 || byte !== 0) && value <= max, 'invalid_input');
        return value;
      }
    }
    requireSolana(false, 'invalid_input');
  }
}

/** Structural inspection only: signatures and runtime account permissions are not verified. */
export function parseSerializedTransaction(
  input: string,
): SerializedTransaction {
  requireSolana(
    typeof input === 'string' &&
      input.length > 0 &&
      input.length <= 1644 &&
      input.length % 4 === 0 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(input),
    'invalid_input',
  );
  const bytes = Buffer.from(input, 'base64');
  requireSolana(
    bytes.length <= 1232 && bytes.toString('base64') === input,
    'invalid_input',
  );
  const reader = new WireReader(bytes);
  const count = reader.short(12);
  requireSolana(count > 0, 'invalid_input');
  const signatures = Array.from({ length: count }, () => {
    const value = reader.take(64);
    return {
      value: bs58.encode(value),
      present: value.some((byte) => byte !== 0),
    };
  });
  const messageStart = reader.offset;
  const marker = reader.byte();
  let version: 'legacy' | 0 = 'legacy';
  let required = marker;
  if (marker & 128) {
    requireSolana((marker & 127) === 0, 'unsupported_transaction');
    version = 0;
    required = reader.byte();
  }
  const readonlySigned = reader.byte(),
    readonlyUnsigned = reader.byte();
  const keyCount = reader.short(256);
  requireSolana(
    required === count &&
      required <= keyCount &&
      readonlySigned < required &&
      readonlyUnsigned <= keyCount - required,
    'invalid_input',
  );
  const staticAccounts = Array.from({ length: keyCount }, (_, index) => ({
    address: bs58.encode(reader.take(32)),
    signer: index < required,
    writable:
      index < required
        ? index < required - readonlySigned
        : index < keyCount - readonlyUnsigned,
  }));
  requireSolana(
    new Set(staticAccounts.map((key) => key.address)).size === keyCount,
    'invalid_input',
  );
  const recentBlockhash = bs58.encode(reader.take(32));
  const instructions = Array.from({ length: reader.short(64) }, () => {
    const programIdIndex = reader.byte();
    // The v0 sanitizer requires invoked programs to be static and not the payer.
    requireSolana(
      programIdIndex > 0 && programIdIndex < keyCount,
      'invalid_input',
    );
    const accountIndexes = [...reader.take(reader.short(256))];
    const data = reader.take(reader.short(1232));
    return { programIdIndex, accountIndexes, data };
  });
  const addressTableLookups =
    version === 0
      ? Array.from({ length: reader.short(32) }, () => {
          const accountKey = bs58.encode(reader.take(32));
          const writableIndexes = [...reader.take(reader.short(256))];
          const readonlyIndexes = [...reader.take(reader.short(256))];
          const indexes = [...writableIndexes, ...readonlyIndexes];
          requireSolana(
            indexes.length > 0 && new Set(indexes).size === indexes.length,
            'invalid_input',
          );
          return { accountKey, writableIndexes, readonlyIndexes };
        })
      : [];
  requireSolana(
    new Set(addressTableLookups.map((lookup) => lookup.accountKey)).size ===
      addressTableLookups.length,
    'invalid_input',
  );
  const loadedWritableCount = addressTableLookups.reduce(
    (sum, lookup) => sum + lookup.writableIndexes.length,
    0,
  );
  const loadedReadonlyCount = addressTableLookups.reduce(
    (sum, lookup) => sum + lookup.readonlyIndexes.length,
    0,
  );
  const total = keyCount + loadedWritableCount + loadedReadonlyCount;
  requireSolana(
    total <= 256 &&
      reader.offset === bytes.length &&
      instructions.every((instruction) =>
        instruction.accountIndexes.every((index) => index < total),
      ),
    'invalid_input',
  );
  return {
    version,
    serializedHash: createHash('sha256').update(bytes).digest('hex'),
    byteLength: bytes.length,
    wireBase64: input,
    messageBase64: bytes.subarray(messageStart).toString('base64'),
    recentBlockhash,
    header: {
      numRequiredSignatures: required,
      numReadonlySignedAccounts: readonlySigned,
      numReadonlyUnsignedAccounts: readonlyUnsigned,
    },
    signatures,
    staticAccounts,
    instructions,
    addressTableLookups,
    loadedWritableCount,
    loadedReadonlyCount,
  };
}

export function resolveSerializedAccounts(
  parsed: SerializedTransaction,
  loadedWritable: string[],
  loadedReadonly: string[],
): SerializedAccount[] {
  requireSolana(
    loadedWritable.length === parsed.loadedWritableCount &&
      loadedReadonly.length === parsed.loadedReadonlyCount,
    'invalid_response',
  );
  const result = [
    ...parsed.staticAccounts.map((key) => ({ ...key })),
    ...loadedWritable.map((key) => ({
      address: address(key),
      signer: false,
      writable: true,
    })),
    ...loadedReadonly.map((key) => ({
      address: address(key),
      signer: false,
      writable: false,
    })),
  ];
  requireSolana(
    new Set(result.map((key) => key.address)).size === result.length,
    'invalid_response',
  );
  return result;
}

export type DurableNonceDetection = {
  status: 'none' | 'durable' | 'ambiguous';
  accountIndex: number | null;
};
export function detectDurableNonce(
  parsed: SerializedTransaction,
  accounts?: SerializedAccount[],
): DurableNonceDetection {
  const first = parsed.instructions[0];
  if (
    !first ||
    parsed.staticAccounts[first.programIdIndex]?.address !== SYSTEM_PROGRAM
  )
    return { status: 'none', accountIndex: null };
  const data = first.data;
  // A truncated System discriminator cannot authorize substitution of the signed message.
  if (data.length < 4)
    return {
      status: 'ambiguous',
      accountIndex: first.accountIndexes[0] ?? null,
    };
  const tag = new DataView(
    data.buffer,
    data.byteOffset,
    data.byteLength,
  ).getUint32(0, true);
  if (tag !== 4)
    return { status: tag > 13 ? 'ambiguous' : 'none', accountIndex: null };
  const keys = accounts ?? parsed.staticAccounts;
  const [nonce, sysvar, authority] = first.accountIndexes.map(
    (index) => keys[index],
  );
  const valid =
    data.length === 4 &&
    first.accountIndexes.length === 3 &&
    nonce?.writable &&
    sysvar?.address === 'SysvarRecentB1ockHashes11111111111111111111' &&
    authority?.signer;
  return {
    status: valid ? 'durable' : 'ambiguous',
    accountIndex: first.accountIndexes[0] ?? null,
  };
}

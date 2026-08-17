import bs58 from 'bs58';
import {
  SolanaError,
  address,
  list,
  record,
  requireSolana,
  signature,
  uint,
} from './validation.ts';

export type AccountKey = {
  address: string;
  signer: boolean;
  writable: boolean;
};
export type CompiledInstruction = {
  programId: string;
  accounts: number[];
  data: Uint8Array;
  index: number;
};

/** Resolve legacy and v0 compiled keys, including loaded writable then readonly keys. */
export function compiledTransaction(value: unknown) {
  const root = record(value);
  requireSolana(
    root.version === 'legacy' || root.version === 0,
    'unsupported_transaction',
  );
  const meta = record(root.meta);
  const transaction = record(root.transaction);
  const message = record(transaction.message);
  const staticKeys = list(message.accountKeys).map(address);
  requireSolana(staticKeys.length > 0, 'invalid_response');
  const header = record(message.header);
  const signers = uint(header.numRequiredSignatures, staticKeys.length);
  const readonlySigned = uint(header.numReadonlySignedAccounts, signers);
  const readonlyUnsigned = uint(
    header.numReadonlyUnsignedAccounts,
    staticKeys.length - signers,
  );
  requireSolana(signers > 0 && readonlySigned < signers, 'invalid_response');
  const signatures = list(transaction.signatures).map(signature);
  requireSolana(signatures.length === signers, 'invalid_response');
  const keys: AccountKey[] = staticKeys.map((key, index) => ({
    address: key,
    signer: index < signers,
    writable:
      index < signers
        ? index < signers - readonlySigned
        : index < staticKeys.length - readonlyUnsigned,
  }));
  const loaded =
    meta.loadedAddresses === undefined
      ? { writable: [], readonly: [] }
      : record(meta.loadedAddresses);
  const writable = list(loaded.writable).map(address);
  const readonly = list(loaded.readonly).map(address);
  const lookups =
    message.addressTableLookups === undefined && root.version === 'legacy'
      ? []
      : list(message.addressTableLookups);
  let writableCount = 0;
  let readonlyCount = 0;
  for (const entry of lookups) {
    const lookup = record(entry);
    address(lookup.accountKey);
    const writes = list(lookup.writableIndexes).map((index) =>
      uint(index, 255),
    );
    const reads = list(lookup.readonlyIndexes).map((index) => uint(index, 255));
    requireSolana(
      new Set([...writes, ...reads]).size === writes.length + reads.length,
      'invalid_response',
    );
    writableCount += writes.length;
    readonlyCount += reads.length;
  }
  requireSolana(
    writable.length === writableCount && readonly.length === readonlyCount,
    'incomplete_metadata',
  );
  requireSolana(
    root.version !== 'legacy' || !lookups.length,
    'unsupported_transaction',
  );
  for (const key of writable)
    keys.push({ address: key, signer: false, writable: true });
  for (const key of readonly)
    keys.push({ address: key, signer: false, writable: false });
  requireSolana(
    keys.length <= 256 &&
      new Set(keys.map((key) => key.address)).size === keys.length,
    'invalid_response',
  );
  const instructions: CompiledInstruction[] = list(
    message.instructions,
    64,
  ).map((value, index) => {
    const instruction = record(value);
    const program = keys[uint(instruction.programIdIndex, keys.length - 1)];
    requireSolana(!program.signer && !program.writable, 'invalid_response');
    const accounts = list(instruction.accounts).map((key) =>
      uint(key, keys.length - 1),
    );
    requireSolana(
      typeof instruction.data === 'string' && instruction.data.length <= 1700,
      'invalid_response',
    );
    let data: Uint8Array;
    try {
      data = bs58.decode(instruction.data);
    } catch {
      throw new SolanaError('invalid_response');
    }
    requireSolana(
      data.length <= 1232 && bs58.encode(data) === instruction.data,
      'invalid_response',
    );
    return { programId: program.address, accounts, data, index };
  });
  return { root, meta, keys, signatures, instructions, slot: uint(root.slot) };
}

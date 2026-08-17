import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import {
  PROGRAM_LOADER_IDS,
  PROGRAM_READER_LIMITS,
  PROGRAM_READER_VERSION,
  PROGRAM_WARNING_SEVERITY,
  type ProgramInspection,
  type ProgramHistoryEvent,
  type ProgramWarningCode,
} from '../../lib/solana/program-reader.ts';
import {
  compiledTransaction,
  type CompiledInstruction,
} from './transaction.ts';
import {
  address,
  assertGenesis,
  base58Bytes,
  finalizedStatus,
  list,
  record,
  requireSolana,
  signature,
  SolanaError,
  uint,
  type SolanaCluster,
} from './validation.ts';

export type ProgramReadMethod =
  | 'getGenesisHash'
  | 'getAccountInfo'
  | 'getMultipleAccounts'
  | 'getSignaturesForAddress'
  | 'getSignatureStatuses'
  | 'getTransaction';
export type ProgramReadRpc = (
  method: ProgramReadMethod,
  params: unknown[],
  signal?: AbortSignal,
) => Promise<unknown>;
const MAX_ACCOUNT_SIZE = 10 * 1024 * 1024;
const RENT = 'SysvarRent111111111111111111111111111111111';
const CLOCK = 'SysvarC1ock11111111111111111111111111111111';
const SYSTEM = '11111111111111111111111111111111';
const warningText: Record<ProgramWarningCode, string> = {
  BUILD_UNVERIFIED:
    'Executable code and verified-build provenance were not fetched or checked. Loader metadata is not a safety assessment.',
  ACCOUNT_NOT_FOUND: 'No account was present at the finalized snapshot slot.',
  NOT_PROGRAM:
    'This account is not an executable program under a supported loader state.',
  UNSUPPORTED_LOADER:
    'This account owner is not a supported deployable loader. Native programs are controlled by runtime releases; mutability is not inferred.',
  UNSUPPORTED_STATE:
    'The loader account state is not supported. Upgrade authority and mutability are unknown.',
  UPGRADE_AUTHORITY:
    'A program-management authority is present and can change this program under the loader rules.',
  PROGRAM_RETRACTED:
    'Loader-v4 marks this program as retracted. The account executable flag alone does not establish that it can run.',
  NEXT_VERSION_UNINSPECTED:
    'The finalized loader-v4 state contains a next-version reference. That account and its code were not inspected.',
  LOADER_VERSION_UNVERIFIED:
    'The historical loader-v4 version was not established. Version-specific references and deployment events are not interpreted.',
  HISTORY_BOUNDED:
    'Only up to eight recent address signatures were scanned. This is not a complete upgrade history, even when no matching events are observed.',
  HISTORY_INCOMPLETE:
    'Some recent transaction evidence was unavailable, unsupported, outside the snapshot, or lacked complete successful invocation evidence.',
  HISTORY_UNAVAILABLE:
    'Recent signature or transaction status history was unavailable. No conclusion about the absence of upgrades can be drawn.',
};
function warn(result: ProgramInspection, code: ProgramWarningCode) {
  if (!result.warnings.some((w) => w.code === code))
    result.warnings.push({
      code,
      severity: PROGRAM_WARNING_SEVERITY[code],
      message: warningText[code],
    });
}
function loader(owner: string) {
  return (
    (
      Object.keys(PROGRAM_LOADER_IDS) as (keyof typeof PROGRAM_LOADER_IDS)[]
    ).find((k) => PROGRAM_LOADER_IDS[k] === owner) ?? 'unknown'
  );
}
function slot64(bytes: Uint8Array, offset: number) {
  const n = new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getBigUint64(offset, true);
  requireSolana(n <= BigInt(Number.MAX_SAFE_INTEGER), 'invalid_response');
  return Number(n);
}
function u32(bytes: Uint8Array) {
  return new DataView(
    bytes.buffer,
    bytes.byteOffset,
    bytes.byteLength,
  ).getUint32(0, true);
}
function keyBytes(bytes: Uint8Array) {
  return address(bs58.encode(bytes));
}
/** Solana's canonical PDA: SHA-256(seeds,bump,loader,"ProgramDerivedAddress"), off curve. */
export function programDataAddress(program: string) {
  const seed = base58Bytes(program, 32),
    owner = base58Bytes(PROGRAM_LOADER_IDS.v3, 32);
  for (let bump = 255; bump >= 0; bump--) {
    const digest = new Uint8Array(
      createHash('sha256')
        .update(seed)
        .update(new Uint8Array([bump]))
        .update(owner)
        .update('ProgramDerivedAddress')
        .digest(),
    );
    try {
      ed25519.Point.fromBytes(digest, true);
    } catch {
      return bs58.encode(digest);
    }
  }
  throw new SolanaError('invalid_response');
}
function account(value: unknown, length: number) {
  if (value === null) return null;
  const a = record(value);
  requireSolana(typeof a.executable === 'boolean', 'invalid_response');
  const owner = address(a.owner),
    space = uint(a.space, MAX_ACCOUNT_SIZE),
    data = list(a.data, 2);
  requireSolana(
    data.length === 2 &&
      data[1] === 'base64' &&
      typeof data[0] === 'string' &&
      data[0].length <= Math.ceil(length / 3) * 4,
    'invalid_response',
  );
  const bytes = new Uint8Array(Buffer.from(data[0], 'base64'));
  requireSolana(
    Buffer.from(bytes).toString('base64') === data[0] &&
      bytes.length === Math.min(space, length),
    'invalid_response',
  );
  return { owner, space, executable: a.executable, bytes };
}
function context(value: unknown, floor = 0) {
  const data = record(value),
    slot = uint(record(data.context).slot);
  requireSolana(slot >= floor, 'invalid_response');
  return { data, slot };
}
function baseResult(
  network: SolanaCluster,
  genesisHash: string,
  program: string,
  contextSlot: number,
): ProgramInspection {
  const result: ProgramInspection = {
    readerVersion: PROGRAM_READER_VERSION,
    cluster: network,
    genesisHash,
    address: program,
    contextSlot,
    finality: 'finalized',
    exists: false,
    owner: null,
    executable: null,
    loader: null,
    status: 'not-found',
    programDataAddress: null,
    authority: { status: 'unknown', address: null },
    mutability: 'unknown',
    lastDeploymentSlot: null,
    loaderStateSlot: null,
    nextVersionAddress: null,
    verifiedBuild: 'not-checked',
    history: {
      status: 'not-scanned',
      address: null,
      limit: 8,
      scannedSignatures: 0,
      verifiedTransactions: 0,
      unavailableTransactions: 0,
      complete: false,
      events: [],
    },
    warnings: [],
  };
  warn(result, 'BUILD_UNVERIFIED');
  return result;
}
function assertProgram(a: ReturnType<typeof account>, expectedOwner: string) {
  requireSolana(
    a && a.owner === expectedOwner && a.executable,
    'invalid_response',
  );
  return a;
}
function decodedSnapshot(
  result: ProgramInspection,
  program: NonNullable<ReturnType<typeof account>>,
  data: ReturnType<typeof account>,
) {
  result.exists = true;
  result.owner = program.owner;
  result.executable = program.executable;
  result.loader = loader(program.owner);
  if (!program.executable) {
    result.status = 'not-program';
    warn(result, 'NOT_PROGRAM');
    return;
  }
  if (result.loader === 'unknown' || result.loader === 'native') {
    result.status = 'unsupported';
    warn(result, 'UNSUPPORTED_LOADER');
    return;
  }
  if (result.loader === 'v1' || result.loader === 'v2') {
    result.status = 'deployed';
    result.authority = { status: 'none', address: null };
    result.mutability = 'immutable';
    return;
  }
  if (result.loader === 'v3') {
    if (
      program.space !== 36 ||
      program.bytes.length !== 36 ||
      u32(program.bytes) !== 2
    ) {
      result.status = 'unsupported';
      warn(result, 'UNSUPPORTED_STATE');
      return;
    }
    const pointer = keyBytes(program.bytes.slice(4));
    requireSolana(
      pointer === programDataAddress(result.address),
      'invalid_response',
    );
    requireSolana(
      data &&
        data.owner === PROGRAM_LOADER_IDS.v3 &&
        !data.executable &&
        data.space >= 45 &&
        data.bytes.length === 45 &&
        u32(data.bytes) === 3,
      'invalid_response',
    );
    const at = slot64(data.bytes, 4),
      option = data.bytes[12];
    requireSolana(
      at <= result.contextSlot && (option === 0 || option === 1),
      'invalid_response',
    );
    result.programDataAddress = pointer;
    result.lastDeploymentSlot = at;
    result.status = 'deployed';
    result.authority =
      option === 0
        ? { status: 'none', address: null }
        : { status: 'present', address: keyBytes(data.bytes.slice(13, 45)) };
    result.mutability = option === 0 ? 'immutable' : 'upgradeable';
  } else if (result.loader === 'v4') {
    warn(result, 'LOADER_VERSION_UNVERIFIED');
    if (program.space < 48 || program.bytes.length !== 48) {
      result.status = 'unsupported';
      warn(result, 'UNSUPPORTED_STATE');
      return;
    }
    const at = slot64(program.bytes, 0),
      state = slot64(program.bytes, 40);
    requireSolana(at <= result.contextSlot, 'invalid_response');
    if (state > 2) {
      result.status = 'unsupported';
      warn(result, 'UNSUPPORTED_STATE');
      return;
    }
    result.loaderStateSlot = at;
    result.status =
      state === 0 ? 'retracted' : state === 1 ? 'deployed' : 'finalized';
    result.lastDeploymentSlot = state === 0 ? null : at;
    if (state === 2) {
      result.authority = { status: 'none', address: null };
      result.mutability = 'immutable';
    } else {
      result.authority = {
        status: 'present',
        address: keyBytes(program.bytes.slice(8, 40)),
      };
      result.mutability = 'upgradeable';
    }
    if (state === 0) warn(result, 'PROGRAM_RETRACTED');
  }
  if (result.authority.status === 'present') warn(result, 'UPGRADE_AUTHORITY');
}

type HistoryInstruction = CompiledInstruction & {
  location: string;
  depth: number;
};
type Resolved = ReturnType<typeof compiledTransaction>;
function historyInstructions(tx: Resolved) {
  const byTop = new Map<number, HistoryInstruction[]>();
  let count = 0;
  requireSolana(
    Array.isArray(tx.meta.innerInstructions),
    'incomplete_metadata',
  );
  for (const entry of list(tx.meta.innerInstructions, 64)) {
    const group = record(entry),
      index = uint(group.index, tx.instructions.length - 1);
    requireSolana(!byTop.has(index), 'invalid_response');
    const inner = list(group.instructions, 128).map((item, n) => {
      requireSolana(++count <= 128, 'response_too_large');
      const i = record(item),
        p = tx.keys[uint(i.programIdIndex, tx.keys.length - 1)];
      requireSolana(!p.signer && !p.writable, 'invalid_response');
      const accounts = list(i.accounts).map((v) => uint(v, tx.keys.length - 1));
      requireSolana(
        typeof i.data === 'string' && i.data.length <= 1700,
        'invalid_response',
      );
      let data: Uint8Array;
      try {
        data = bs58.decode(i.data);
      } catch {
        throw new SolanaError('invalid_response');
      }
      requireSolana(
        data.length <= 1232 && bs58.encode(data) === i.data,
        'invalid_response',
      );
      const depth = uint(i.stackHeight, 64);
      requireSolana(depth >= 2, 'incomplete_metadata');
      return {
        programId: p.address,
        accounts,
        data,
        index: n,
        location: `${index}.${n}`,
        depth,
      };
    });
    byTop.set(index, inner);
  }
  return tx.instructions.flatMap((i) => [
    { ...i, location: String(i.index), depth: 1 },
    ...(byTop.get(i.index) ?? []),
  ]);
}
/** Complete runtime invocation logs are required for CPI success, including its ancestors. */
function successfulInvocations(
  value: unknown,
  instructions: HistoryInstruction[],
): Set<string> | null {
  try {
    const logs = list(value, 1024);
    requireSolana(
      logs.every((v) => typeof v === 'string' && v.length <= 2048),
      'incomplete_metadata',
    );
    type Invocation = {
      program: string;
      depth: number;
      success: boolean | null;
      parent: Invocation | null;
      instruction: HistoryInstruction;
    };
    const stack: Invocation[] = [],
      calls: Invocation[] = [];
    let cursor = 0;
    for (const line of logs as string[]) {
      requireSolana(!line.includes('Log truncated'), 'incomplete_metadata');
      const invoke =
        /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) invoke \[([1-9][0-9]?)\]$/.exec(
          line,
        );
      if (invoke) {
        const expected = instructions[cursor++],
          depth = Number(invoke[2]);
        requireSolana(
          expected &&
            expected.programId === invoke[1] &&
            expected.depth === depth &&
            depth === stack.length + 1,
          'incomplete_metadata',
        );
        const call: Invocation = {
          program: invoke[1],
          depth,
          success: null,
          parent: stack.at(-1) ?? null,
          instruction: expected,
        };
        stack.push(call);
        calls.push(call);
        continue;
      }
      const end =
        /^Program ([1-9A-HJ-NP-Za-km-z]{32,44}) (success|failed: .+)$/.exec(
          line,
        );
      if (end) {
        const call = stack.pop();
        requireSolana(call && call.program === end[1], 'incomplete_metadata');
        call.success = end[2] === 'success';
      }
    }
    requireSolana(
      stack.length === 0 && cursor === instructions.length,
      'incomplete_metadata',
    );
    return new Set(
      calls
        .filter((c) => {
          for (let p: Invocation | null = c; p; p = p.parent)
            if (p.success !== true) return false;
          return true;
        })
        .map((c) => c.instruction.location),
    );
  } catch {
    return null;
  }
}
function deploymentKind(
  i: HistoryInstruction,
  tx: Resolved,
  program: ProgramInspection,
): ProgramHistoryEvent['kind'] | null {
  if (
    !program.loader ||
    program.loader === 'unknown' ||
    i.programId !== PROGRAM_LOADER_IDS[program.loader]
  )
    return null;
  const key = (n: number) => tx.keys[i.accounts[n]];
  const target = (n: number, expected: string | null) =>
    Boolean(expected && key(n)?.address === expected && key(n)?.writable);
  const signed = (n: number) => i.depth > 1 || key(n)?.signer === true;
  const fixed = (n: number, expected: string) => key(n)?.address === expected;
  if (i.programId === PROGRAM_LOADER_IDS.v3) {
    const pd =
      program.programDataAddress ?? programDataAddress(program.address);
    if (
      i.data.length === 12 &&
      u32(i.data) === 2 &&
      i.accounts.length === 8 &&
      target(1, pd) &&
      target(2, program.address) &&
      key(0)?.writable &&
      signed(0) &&
      key(3)?.writable &&
      fixed(4, RENT) &&
      fixed(5, CLOCK) &&
      fixed(6, SYSTEM) &&
      signed(7)
    )
      return 'deploy';
    if (
      i.data.length === 4 &&
      u32(i.data) === 3 &&
      i.accounts.length === 7 &&
      target(0, pd) &&
      target(1, program.address) &&
      key(2)?.writable &&
      key(3)?.writable &&
      fixed(4, RENT) &&
      fixed(5, CLOCK) &&
      signed(6)
    )
      return 'upgrade';
  }
  // Loader-v4 reused historical instruction discriminants. Without a reviewed
  // cluster activation boundary, byte 3 cannot distinguish older Retract from
  // current Deploy. Current metadata remains readable; historical events do not.
  if (
    (i.programId === PROGRAM_LOADER_IDS.v1 ||
      i.programId === PROGRAM_LOADER_IDS.v2) &&
    i.data.length === 4 &&
    u32(i.data) === 1 &&
    i.accounts.length === 2 &&
    target(0, program.address) &&
    signed(0) &&
    fixed(1, RENT)
  )
    return 'deploy';
  return null;
}
function transactionEvents(
  value: unknown,
  txid: string,
  expectedSlot: number,
  program: ProgramInspection,
) {
  const tx = compiledTransaction(value);
  requireSolana(
    tx.signatures[0] === txid &&
      tx.slot === expectedSlot &&
      tx.slot <= program.contextSlot &&
      tx.meta.err === null,
    'invalid_response',
  );
  const blockTime =
    tx.root.blockTime === null
      ? null
      : uint(tx.root.blockTime, 8_640_000_000_000);
  let instructions: HistoryInstruction[],
    incomplete = false;
  try {
    instructions = historyInstructions(tx);
  } catch {
    instructions = tx.instructions.map((i) => ({
      ...i,
      location: String(i.index),
      depth: 1,
    }));
    incomplete = true;
  }
  const cpi =
      instructions.some((i) => i.depth > 1) ||
      (Array.isArray(tx.meta.logMessages) &&
        tx.meta.logMessages.some(
          (line: unknown) =>
            typeof line === 'string' &&
            /^Program [1-9A-HJ-NP-Za-km-z]{32,44} invoke \[(?:[2-9]|[1-9][0-9])\]$/.test(
              line,
            ),
        )),
    success = cpi
      ? successfulInvocations(tx.meta.logMessages, instructions)
      : null;
  if (cpi && !success) incomplete = true;
  const events: ProgramHistoryEvent[] = [];
  for (const i of instructions) {
    if (i.depth > 1 && !success?.has(i.location)) continue;
    const kind = deploymentKind(i, tx, program);
    if (!kind) continue;
    const from = loader(i.programId);
    requireSolana(from !== 'native' && from !== 'unknown', 'invalid_response');
    events.push({
      signature: txid,
      slot: tx.slot,
      blockTime,
      kind,
      instruction: i.location,
      loader: from,
    });
  }
  return { events, incomplete };
}
async function history(
  result: ProgramInspection,
  rpc: ProgramReadRpc,
  signal: AbortSignal,
  parentSignal?: AbortSignal,
) {
  result.history.status = 'bounded';
  result.history.address = result.programDataAddress ?? result.address;
  warn(result, 'HISTORY_BOUNDED');
  if (result.loader === 'v4') warn(result, 'HISTORY_INCOMPLETE');
  let candidates: { signature: string; slot: number }[] = [];
  try {
    const rows = list(
      await rpc(
        'getSignaturesForAddress',
        [
          result.history.address,
          {
            commitment: 'finalized',
            minContextSlot: result.contextSlot,
            limit: 8,
          },
        ],
        signal,
      ),
      8,
    );
    const seen = new Set<string>();
    let previous = Number.MAX_SAFE_INTEGER;
    for (const raw of rows) {
      const r = record(raw),
        txid = signature(r.signature),
        slot = uint(r.slot);
      requireSolana(
        !seen.has(txid) && slot <= previous && Object.hasOwn(r, 'err'),
        'invalid_response',
      );
      seen.add(txid);
      previous = slot;
      result.history.scannedSignatures++;
      if (
        r.confirmationStatus !== 'finalized' ||
        slot > result.contextSlot ||
        r.err !== null
      ) {
        result.history.unavailableTransactions++;
        continue;
      }
      candidates.push({ signature: txid, slot });
    }
    if (!candidates.length) {
      if (result.history.unavailableTransactions)
        warn(result, 'HISTORY_INCOMPLETE');
      return;
    }
    const statuses = record(
      await rpc(
        'getSignatureStatuses',
        [
          candidates.map((c) => c.signature),
          { searchTransactionHistory: true },
        ],
        signal,
      ),
    );
    const values = list(statuses.value, 8);
    requireSolana(values.length === candidates.length, 'invalid_response');
    const eligible = candidates.filter((candidate, i) => {
      try {
        return finalizedStatus(values[i]).slot === candidate.slot;
      } catch {
        return false;
      }
    });
    result.history.unavailableTransactions +=
      candidates.length - eligible.length;
    candidates = eligible;
  } catch {
    if (parentSignal?.aborted) throw new SolanaError('cancelled');
    result.history.status = 'unavailable';
    result.history.scannedSignatures = 0;
    result.history.unavailableTransactions = 0;
    result.history.verifiedTransactions = 0;
    result.history.events = [];
    warn(result, 'HISTORY_UNAVAILABLE');
    return;
  }
  // Sequential retrieval is intentionally below the concurrency cap of two.
  for (const [index, candidate] of candidates.entries()) {
    if (signal.aborted) {
      if (parentSignal?.aborted) throw new SolanaError('cancelled');
      result.history.unavailableTransactions += candidates.length - index;
      break;
    }
    try {
      const value = await rpc(
        'getTransaction',
        [
          candidate.signature,
          {
            commitment: 'finalized',
            maxSupportedTransactionVersion: 0,
            encoding: 'json',
          },
        ],
        signal,
      );
      const read = transactionEvents(
        value,
        candidate.signature,
        candidate.slot,
        result,
      );
      result.history.verifiedTransactions++;
      if (read.incomplete) warn(result, 'HISTORY_INCOMPLETE');
      const remaining =
        PROGRAM_READER_LIMITS.historyEvents - result.history.events.length;
      if (read.events.length > remaining) warn(result, 'HISTORY_INCOMPLETE');
      result.history.events.push(...read.events.slice(0, remaining));
    } catch {
      if (parentSignal?.aborted) throw new SolanaError('cancelled');
      result.history.unavailableTransactions++;
    }
  }
  if (result.history.unavailableTransactions)
    warn(result, 'HISTORY_INCOMPLETE');
}
/** Metadata-only finalized reads. Never obtains account ELF data or calls chain-writing methods. */
export async function readProgramInspection(
  network: SolanaCluster,
  rpc: ProgramReadRpc,
  addressInput: string,
  signal?: AbortSignal,
  timeoutMs = PROGRAM_READER_LIMITS.totalTimeoutMs,
): Promise<ProgramInspection> {
  const program = address(addressInput);
  requireSolana(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 25_000,
    'invalid_configuration',
  );
  requireSolana(!signal?.aborted, 'cancelled');
  const controller = new AbortController();
  let timedOut = false,
    calls = 0;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  const call: ProgramReadRpc = async (method, params) => {
    requireSolana(
      !controller.signal.aborted,
      timedOut ? 'rpc_timeout' : 'cancelled',
    );
    requireSolana(
      ++calls <= PROGRAM_READER_LIMITS.rpcCalls,
      'response_too_large',
    );
    return rpc(method, params, controller.signal);
  };
  try {
    const genesis = await call('getGenesisHash', []);
    assertGenesis(network, genesis);
    const discovery = context(
      await call('getAccountInfo', [
        program,
        {
          commitment: 'finalized',
          encoding: 'base64',
          dataSlice: { offset: 0, length: 0 },
        },
      ]),
    );
    const first = account(discovery.data.value, 0),
      result = baseResult(network, genesis as string, program, discovery.slot);
    if (!first) {
      warn(result, 'ACCOUNT_NOT_FOUND');
      return result;
    }
    const known = loader(first.owner);
    let snapshotLength = 0,
      pointer: string | null = null,
      floor = discovery.slot;
    if (known === 'v3' && first.executable && first.space === 36) {
      const lookup = context(
        await call('getAccountInfo', [
          program,
          {
            commitment: 'finalized',
            encoding: 'base64',
            dataSlice: { offset: 0, length: 36 },
            minContextSlot: floor,
          },
        ]),
        floor,
      );
      const programState = assertProgram(
        account(lookup.data.value, 36),
        PROGRAM_LOADER_IDS.v3,
      );
      requireSolana(programState.space === 36, 'invalid_response');
      floor = lookup.slot;
      if (u32(programState.bytes) === 2) {
        pointer = keyBytes(programState.bytes.slice(4));
        requireSolana(
          pointer === programDataAddress(program),
          'invalid_response',
        );
        snapshotLength = 45;
      } else snapshotLength = 36;
    } else if (known === 'v4' && first.executable && first.space >= 48)
      snapshotLength = 48;
    const read = context(
      await call('getMultipleAccounts', [
        [program, ...(pointer ? [pointer] : [])],
        {
          commitment: 'finalized',
          encoding: 'base64',
          dataSlice: { offset: 0, length: snapshotLength },
          minContextSlot: floor,
        },
      ]),
      floor,
    );
    result.contextSlot = read.slot;
    const values = list(read.data.value, 2);
    requireSolana(values.length === (pointer ? 2 : 1), 'invalid_response');
    const current = account(values[0], snapshotLength);
    requireSolana(
      current &&
        current.owner === first.owner &&
        current.executable === first.executable,
      'invalid_response',
    );
    const data = pointer ? account(values[1], snapshotLength) : null;
    decodedSnapshot(result, current, data);
    if (
      result.status === 'deployed' ||
      result.status === 'finalized' ||
      result.status === 'retracted'
    )
      await history(result, call, controller.signal, signal);
    return result;
  } catch (failure) {
    if (signal?.aborted) throw new SolanaError('cancelled');
    if (timedOut) throw new SolanaError('rpc_timeout');
    throw failure;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

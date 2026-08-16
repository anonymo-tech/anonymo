import bs58 from 'bs58';
import { scanPrompt } from '../../lib/guards/index.ts';
import {
  PRE_SIGN_LIMITS,
  PRE_SIGN_READER_VERSION,
  PRE_SIGN_WARNING_SEVERITY,
  type PreSignInspection,
  type PreSignSimulationError,
  type PreSignWarningCode,
  type SimulatedAccount,
} from '../../lib/solana/pre-sign.ts';
import { explainRawInstructions } from './explain-raw.ts';
import {
  parseSerializedTransaction,
  resolveSerializedAccounts,
  detectDurableNonce,
} from './serialized.ts';
import {
  address,
  assertGenesis,
  list,
  record,
  requireSolana,
  SolanaError,
  TOKEN_PROGRAM,
  TOKEN_2022_PROGRAM,
  U64_MAX,
  uint,
  type SolanaCluster,
} from './validation.ts';

export type PreSignReadMethod =
  | 'getGenesisHash'
  | 'getMultipleAccounts'
  | 'simulateTransaction';
export type PreSignReadRpc = (
  method: PreSignReadMethod,
  params: unknown[],
  signal?: AbortSignal,
) => Promise<unknown>;
const ALT_PROGRAM = 'AddressLookupTab1e1111111111111111111111111';
const messages: Record<PreSignWarningCode, string> = {
  SIGNATURES_UNCHECKED:
    'Signature presence is counted, but signatures are not verified. This inspection never signs or submits the transaction.',
  SIMULATION_NOT_SAFETY:
    'Simulation is a temporary execution against a finalized bank, not transaction inclusion or a safety assessment. State and outcomes can change.',
  POST_STATE_ONLY:
    'Returned account values are selected simulated post-state, not balance changes or a complete account-effects report.',
  BLOCKHASH_REPLACED:
    'Simulation requested a fresh blockhash. It does not establish validity of the original blockhash or signatures.',
  DURABLE_NONCE:
    'A durable nonce instruction was detected. The original blockhash is preserved for simulation.',
  NONCE_AMBIGUOUS:
    'Nonce handling could not be established safely. Simulation was not attempted and the original blockhash was preserved.',
  LOOKUP_UNAVAILABLE:
    'Lookup tables could not be resolved under the supported finalized activation policy. Deactivating tables are not interpreted.',
  LOOKUP_BINDING_UNVERIFIED:
    'Simulation did not establish the exact resolved lookup addresses. Its outcome and account state are withheld.',
  SIMULATION_UNAVAILABLE:
    'Simulation evidence was unavailable or could not be validated. No outcome is inferred.',
  SIMULATION_FAILED:
    'Simulation reported an execution failure. Only a fixed error category is shown; provider logs and arbitrary error text are omitted.',
  ACCOUNTS_INCOMPLETE:
    'At most eight writable post-accounts are inspected. Other accounts, program effects and unsupported data remain uninspected.',
  INNER_INSTRUCTIONS_UNINSPECTED:
    'Simulation inner instructions and program logs are not decoded. The instruction list describes only the submitted top-level instructions.',
  TOKEN_2022_STATE_UNINSPECTED:
    'Token-2022 post-account extensions are not interpreted. Transfer fees, hooks and other extension effects remain unknown.',
};
function warn(result: PreSignInspection, code: PreSignWarningCode) {
  if (!result.warnings.some((item) => item.code === code))
    result.warnings.push({
      code,
      severity: PRE_SIGN_WARNING_SEVERITY[code],
      message: messages[code],
    });
}
function exactU64(value: unknown): string {
  if (typeof value === 'number') {
    requireSolana(
      Number.isSafeInteger(value) && value >= 0 && !Object.is(value, -0),
      'invalid_response',
    );
    return String(value);
  }
  requireSolana(
    typeof value === 'string' &&
      /^(0|[1-9][0-9]{0,19})$/.test(value) &&
      BigInt(value) <= U64_MAX,
    'invalid_response',
  );
  return value;
}
function rawData(value: unknown, maximum: number): Uint8Array {
  const pair = list(value, 2);
  requireSolana(
    pair.length === 2 &&
      pair[1] === 'base64' &&
      typeof pair[0] === 'string' &&
      pair[0].length <= Math.ceil(maximum / 3) * 4,
    'invalid_response',
  );
  const bytes = Buffer.from(pair[0], 'base64');
  requireSolana(
    bytes.length <= maximum && bytes.toString('base64') === pair[0],
    'invalid_response',
  );
  return bytes;
}
function view(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}
function key(bytes: Uint8Array, offset: number) {
  return bs58.encode(bytes.subarray(offset, offset + 32));
}
function tableAddresses(value: unknown, slot: number): string[] {
  const account = record(value);
  requireSolana(
    account.owner === ALT_PROGRAM && account.executable === false,
    'invalid_response',
  );
  const data = rawData(account.data, 56 + 256 * 32);
  requireSolana(
    data.length >= 56 && (data.length - 56) % 32 === 0,
    'invalid_response',
  );
  if (account.space !== undefined)
    requireSolana(uint(account.space) === data.length, 'invalid_response');
  const d = view(data);
  requireSolana(
    d.getUint32(0, true) === 1 && d.getBigUint64(4, true) === U64_MAX,
    'unsupported_transaction',
  );
  const extended = d.getBigUint64(12, true);
  const count = (data.length - 56) / 32;
  requireSolana(
    extended <= BigInt(slot) &&
      data[20] <= count &&
      (data[21] === 0 || data[21] === 1),
    'invalid_response',
  );
  const padding = data[21] === 1 ? 54 : 22;
  requireSolana(
    data.subarray(padding, 56).every((byte) => byte === 0),
    'invalid_response',
  );
  const active = extended === BigInt(slot) ? data[20] : count;
  return Array.from({ length: active }, (_, index) =>
    key(data, 56 + index * 32),
  );
}
function optionalKey(data: Uint8Array, offset: number): string | null {
  const tag = view(data).getUint32(offset, true);
  requireSolana(tag === 0 || tag === 1, 'invalid_response');
  return tag === 1 ? key(data, offset + 4) : null;
}
function postAccount(value: unknown, accountAddress: string): SimulatedAccount {
  const result: SimulatedAccount = {
    address: accountAddress,
    exists: value !== null,
    owner: null,
    executable: null,
    lamports: null,
    dataBytes: null,
    dataStatus: 'absent',
    token: null,
  };
  if (value === null) return result;
  const account = record(value);
  result.owner = address(account.owner);
  requireSolana(typeof account.executable === 'boolean', 'invalid_response');
  result.executable = account.executable;
  result.lamports = exactU64(account.lamports);
  const data = rawData(account.data, 384 * 1024);
  result.dataBytes = data.length;
  if (account.space !== undefined)
    requireSolana(uint(account.space) === data.length, 'invalid_response');
  result.dataStatus =
    data.length === 0
      ? 'empty'
      : data.length > PRE_SIGN_LIMITS.accountDataBytes
        ? 'too-large'
        : 'unsupported';
  if (
    result.owner !== TOKEN_PROGRAM ||
    result.executable ||
    data.length !== 165
  )
    return result;
  const d = view(data);
  requireSolana(data[108] === 1 || data[108] === 2, 'invalid_response');
  const nativeTag = d.getUint32(109, true);
  requireSolana(nativeTag === 0 || nativeTag === 1, 'invalid_response');
  result.token = {
    mint: key(data, 0),
    owner: key(data, 32),
    amount: d.getBigUint64(64, true).toString(),
    delegate: optionalKey(data, 72),
    delegatedAmount: d.getBigUint64(121, true).toString(),
    closeAuthority: optionalKey(data, 129),
    state: data[108] === 1 ? 'initialized' : 'frozen',
    nativeReserve:
      nativeTag === 1 ? d.getBigUint64(113, true).toString() : null,
  };
  result.dataStatus = 'decoded';
  return result;
}
function simulationError(
  value: unknown,
  instructionCount: number,
): PreSignSimulationError | null {
  if (value === null) return null;
  const result: PreSignSimulationError = {
    category: 'unknown',
    instructionIndex: null,
    code: 'execution-failed',
    customCode: null,
  };
  requireSolana(
    (typeof value === 'string' && value.length > 0 && value.length <= 256) ||
      (typeof value === 'object' &&
        !Array.isArray(value) &&
        Object.keys(record(value)).length === 1),
    'invalid_response',
  );
  let detail: unknown = value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const error = record(value);
    if (
      Object.keys(error).length === 1 &&
      Object.hasOwn(error, 'InstructionError')
    ) {
      const pair = list(error.InstructionError, 2);
      requireSolana(
        pair.length === 2 && instructionCount > 0,
        'invalid_response',
      );
      result.category = 'instruction';
      result.instructionIndex = uint(pair[0], instructionCount - 1);
      detail = pair[1];
      requireSolana(
        (typeof detail === 'string' &&
          detail.length > 0 &&
          detail.length <= 256) ||
          (detail !== null &&
            typeof detail === 'object' &&
            !Array.isArray(detail) &&
            Object.keys(record(detail)).length === 1 &&
            Object.hasOwn(record(detail), 'Custom')),
        'invalid_response',
      );
      if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
        const custom = record(detail);
        if (
          Object.keys(custom).length === 1 &&
          Object.hasOwn(custom, 'Custom')
        ) {
          result.code = 'custom';
          result.customCode = String(uint(custom.Custom, 0xffffffff));
          return result;
        }
      }
    }
  } else if (typeof value === 'string') result.category = 'transaction';
  if (
    detail === 'InsufficientFunds' ||
    detail === 'InsufficientFundsForFee' ||
    detail === 'InsufficientFundsForRent'
  )
    result.code = 'insufficient-funds';
  if (detail === 'InvalidInstructionData' || detail === 'InvalidAccountData')
    result.code = 'invalid-instruction';
  if (detail === 'AccountNotFound' || detail === 'MissingAccount')
    result.code = 'missing-account';
  if (detail === 'BlockhashNotFound') result.code = 'blockhash-not-found';
  return result;
}

/** Read-only inspection. The callback is restricted to three non-broadcast RPC methods. */
export async function readPreSignInspection(
  network: SolanaCluster,
  rpc: PreSignReadRpc,
  transaction: string,
  signal?: AbortSignal,
  options: { now?: () => number; deadlineMs?: number } = {},
): Promise<PreSignInspection> {
  const parsed = parseSerializedTransaction(transaction);
  requireSolana(
    parsed.addressTableLookups.length <= PRE_SIGN_LIMITS.lookupTables,
    'unsupported_transaction',
  );
  for (const instruction of parsed.instructions)
    requireSolana(
      !scanPrompt(new TextDecoder().decode(instruction.data)).findings.some(
        (finding) => finding.severity === 'block',
      ),
      'sensitive_input',
    );
  requireSolana(!signal?.aborted, 'cancelled');
  const controller = new AbortController();
  const deadline = options.deadlineMs ?? PRE_SIGN_LIMITS.deadlineMs;
  requireSolana(
    Number.isSafeInteger(deadline) &&
      deadline > 0 &&
      deadline <= PRE_SIGN_LIMITS.deadlineMs,
    'invalid_configuration',
  );
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, deadline);
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  let calls = 0;
  async function read(method: PreSignReadMethod, params: unknown[]) {
    requireSolana(++calls <= PRE_SIGN_LIMITS.rpcCalls, 'incomplete_metadata');
    requireSolana(
      !controller.signal.aborted,
      timedOut ? 'rpc_timeout' : 'cancelled',
    );
    return new Promise<unknown>((resolve, reject) => {
      const cancelled = () =>
        reject(new SolanaError(timedOut ? 'rpc_timeout' : 'cancelled'));
      controller.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve()
        .then(() => {
          requireSolana(
            !controller.signal.aborted,
            timedOut ? 'rpc_timeout' : 'cancelled',
          );
          return rpc(method, params, controller.signal);
        })
        .then(resolve, (failure) =>
          reject(
            failure instanceof SolanaError
              ? failure
              : new SolanaError('rpc_unavailable'),
          ),
        )
        .finally(() =>
          controller.signal.removeEventListener('abort', cancelled),
        );
    });
  }
  function preserveInterrupt(failure: unknown) {
    if (controller.signal.aborted)
      throw new SolanaError(timedOut ? 'rpc_timeout' : 'cancelled');
    if (
      failure instanceof SolanaError &&
      (failure.code === 'cancelled' || failure.code === 'rpc_timeout')
    )
      throw failure;
  }
  try {
    const genesisHash = await read('getGenesisHash', []);
    assertGenesis(network, genesisHash);
    const hasLookups = parsed.addressTableLookups.length > 0;
    const result: PreSignInspection = {
      readerVersion: PRE_SIGN_READER_VERSION,
      cluster: network,
      genesisHash: genesisHash as string,
      transactionHash: parsed.serializedHash,
      inspectedAt: new Date((options.now ?? Date.now)()).toISOString(),
      input: {
        version: parsed.version,
        byteLength: parsed.byteLength,
        recentBlockhash: parsed.recentBlockhash,
        feePayer: parsed.staticAccounts[0].address,
        requiredSignatures: parsed.header.numRequiredSignatures,
        presentSignatures: parsed.signatures.filter((entry) => entry.present)
          .length,
        signaturesVerified: false,
        nonce: detectDurableNonce(parsed).status,
      },
      accounts: parsed.staticAccounts,
      instructions: [],
      lookups: {
        status: hasLookups ? 'unavailable' : 'not-required',
        contextSlot: null,
        tables: parsed.addressTableLookups.map((entry) => entry.accountKey),
        writable: [],
        readonly: [],
        simulationBinding: hasLookups ? 'unverified' : 'not-required',
      },
      simulation: {
        status: 'not-run',
        contextSlot: null,
        commitment: 'finalized',
        signatureVerification: false,
        blockhashReplacementRequested: false,
        replacementBlockhash: null,
        unitsConsumed: null,
        feeLamports: null,
        error: null,
        accounts: [],
        requestedAccounts: [],
        omittedWritableAccounts: 0,
        effectsComplete: false,
        innerInstructions: 'not-returned',
      },
      limits: { ...PRE_SIGN_LIMITS },
      warnings: [],
    };
    warn(result, 'SIGNATURES_UNCHECKED');
    warn(result, 'SIMULATION_NOT_SAFETY');
    warn(result, 'POST_STATE_ONLY');
    warn(result, 'ACCOUNTS_INCOMPLETE');
    warn(result, 'INNER_INSTRUCTIONS_UNINSPECTED');
    if (hasLookups) warn(result, 'LOOKUP_BINDING_UNVERIFIED');
    if (hasLookups) {
      try {
        const response = record(
          await read('getMultipleAccounts', [
            result.lookups.tables,
            { encoding: 'base64', commitment: 'finalized' },
          ]),
        );
        const slot = uint(record(response.context).slot);
        const values = list(response.value, PRE_SIGN_LIMITS.lookupTables);
        requireSolana(
          values.length === result.lookups.tables.length,
          'invalid_response',
        );
        const writable: string[] = [],
          readonly: string[] = [];
        parsed.addressTableLookups.forEach((lookup, index) => {
          const active = tableAddresses(values[index], slot);
          for (const entry of lookup.writableIndexes) {
            requireSolana(entry < active.length, 'invalid_response');
            writable.push(active[entry]);
          }
          for (const entry of lookup.readonlyIndexes) {
            requireSolana(entry < active.length, 'invalid_response');
            readonly.push(active[entry]);
          }
        });
        result.accounts = resolveSerializedAccounts(parsed, writable, readonly);
        result.lookups = {
          ...result.lookups,
          status: 'resolved',
          contextSlot: slot,
          writable,
          readonly,
        };
      } catch (failure) {
        preserveInterrupt(failure);
        warn(result, 'LOOKUP_UNAVAILABLE');
        if (result.input.nonce === 'durable') warn(result, 'DURABLE_NONCE');
        if (result.input.nonce === 'ambiguous') warn(result, 'NONCE_AMBIGUOUS');
        return result;
      }
    } else result.accounts = resolveSerializedAccounts(parsed, [], []);
    result.instructions = explainRawInstructions(parsed, result.accounts);
    if (
      result.instructions.some(
        (instruction) => instruction.programId === TOKEN_2022_PROGRAM,
      )
    )
      warn(result, 'TOKEN_2022_STATE_UNINSPECTED');
    result.input.nonce = detectDurableNonce(parsed, result.accounts).status;
    if (result.input.nonce === 'ambiguous') {
      warn(result, 'NONCE_AMBIGUOUS');
      return result;
    }
    if (result.input.nonce === 'durable') warn(result, 'DURABLE_NONCE');
    const writable = result.accounts
      .filter((account) => account.writable)
      .map((account) => account.address);
    result.simulation.requestedAccounts = writable.slice(
      0,
      PRE_SIGN_LIMITS.returnedAccounts,
    );
    result.simulation.omittedWritableAccounts = Math.max(
      0,
      writable.length - PRE_SIGN_LIMITS.returnedAccounts,
    );
    result.simulation.blockhashReplacementRequested =
      result.input.nonce === 'none';
    if (result.simulation.blockhashReplacementRequested)
      warn(result, 'BLOCKHASH_REPLACED');
    try {
      const response = record(
        await read('simulateTransaction', [
          parsed.wireBase64,
          {
            encoding: 'base64',
            commitment: 'finalized',
            sigVerify: false,
            innerInstructions: true,
            replaceRecentBlockhash:
              result.simulation.blockhashReplacementRequested,
            ...(result.lookups.contextSlot === null
              ? {}
              : { minContextSlot: result.lookups.contextSlot }),
            accounts: {
              encoding: 'base64',
              addresses: result.simulation.requestedAccounts,
            },
          },
        ]),
      );
      const slot = uint(record(response.context).slot);
      requireSolana(
        result.lookups.contextSlot === null ||
          slot >= result.lookups.contextSlot,
        'invalid_response',
      );
      const value = record(response.value);
      if (hasLookups || value.loadedAddresses !== undefined) {
        try {
          const loaded = record(value.loadedAddresses);
          const match = (raw: unknown, expected: string[]) => {
            const actual = list(raw).map(address);
            requireSolana(
              actual.length === expected.length &&
                actual.every((item, index) => item === expected[index]),
              'invalid_response',
            );
          };
          match(loaded.writable, result.lookups.writable);
          match(loaded.readonly, result.lookups.readonly);
          if (hasLookups) {
            result.lookups.simulationBinding = 'matched';
            result.warnings = result.warnings.filter(
              (warning) => warning.code !== 'LOOKUP_BINDING_UNVERIFIED',
            );
          }
        } catch {
          warn(result, 'LOOKUP_BINDING_UNVERIFIED');
          throw new SolanaError('invalid_response');
        }
      }
      requireSolana(Object.hasOwn(value, 'err'), 'invalid_response');
      const error = simulationError(value.err, parsed.instructions.length);
      let replacement: PreSignInspection['simulation']['replacementBlockhash'] =
        null;
      if (
        value.replacementBlockhash !== undefined &&
        value.replacementBlockhash !== null
      ) {
        requireSolana(
          result.simulation.blockhashReplacementRequested,
          'invalid_response',
        );
        const block = record(value.replacementBlockhash);
        replacement = {
          blockhash: address(block.blockhash),
          lastValidBlockHeight: exactU64(block.lastValidBlockHeight),
        };
      }
      let accounts: SimulatedAccount[] = [];
      if (value.accounts !== null && value.accounts !== undefined) {
        const values = list(value.accounts, PRE_SIGN_LIMITS.returnedAccounts);
        requireSolana(
          values.length === result.simulation.requestedAccounts.length,
          'invalid_response',
        );
        accounts = values.map((account, index) =>
          postAccount(account, result.simulation.requestedAccounts[index]),
        );
      }
      if (accounts.some((account) => account.owner === TOKEN_2022_PROGRAM))
        warn(result, 'TOKEN_2022_STATE_UNINSPECTED');
      result.simulation = {
        ...result.simulation,
        status: error ? 'failed' : 'succeeded',
        contextSlot: slot,
        replacementBlockhash: replacement,
        error,
        unitsConsumed:
          value.unitsConsumed == null ? null : exactU64(value.unitsConsumed),
        feeLamports: value.fee == null ? null : exactU64(value.fee),
        accounts,
        innerInstructions:
          value.innerInstructions == null ? 'not-returned' : 'uninspected',
      };
      if (error) warn(result, 'SIMULATION_FAILED');
    } catch (failure) {
      preserveInterrupt(failure);
      result.simulation.status = 'unavailable';
      warn(result, 'SIMULATION_UNAVAILABLE');
    }
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', abort);
    controller.abort();
  }
}

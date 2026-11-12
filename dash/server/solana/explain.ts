import {
  list,
  record,
  requireSolana,
  signature,
  uint,
  address,
} from './validation.ts';
import { addFlag } from './explain-shared.ts';
import type {
  ExplanationFlag,
  ExplainedInstruction,
} from './explain-shared.ts';
import { decodeCoreInstruction } from './explain-core.ts';
import { decodeTokenInstruction } from './explain-token.ts';
import { SOLANA_DECODER_VERSION } from '../../lib/solana/explanation.ts';
import { normalizeTransactionError } from '../../lib/solana/transaction-errors.ts';
import type { TransactionErrorDetail } from '../../lib/solana/transaction-errors.ts';

export type {
  ExplanationFlag,
  ExplainedInstruction,
} from './explain-shared.ts';

function explainInstruction(
  raw: unknown,
  location: string,
): ExplainedInstruction {
  const result: ExplainedInstruction = {
    location,
    programId: null,
    kind: 'unknown',
    description: 'This instruction has not been decoded.',
    fields: {},
    flags: [],
  };
  try {
    const instruction = record(raw);
    result.programId = address(instruction.programId);
    if (
      !decodeTokenInstruction(instruction, result) &&
      !decodeCoreInstruction(instruction, result)
    ) {
      addFlag(
        result,
        'UNKNOWN_PROGRAM',
        'warning',
        'Unknown program. Its permissions and effects require separate review.',
      );
    }
  } catch {
    result.kind = 'unknown';
    result.description =
      'This instruction could not be decoded without ambiguity.';
    result.fields = {};
    addFlag(
      result,
      'MALFORMED_INSTRUCTION',
      'warning',
      'Required instruction fields are missing, unsupported or outside exact integer bounds.',
    );
  }
  return result;
}

/** Describes RPC-parsed data; it does not simulate, authorize or prove finality. */
export function explainParsedTransaction(value: unknown) {
  const root = record(value);
  const transaction = record(root.transaction);
  const message = record(transaction.message);
  const top = list(message.instructions, 64);
  const signatures = list(transaction.signatures).map(signature);
  requireSolana(signatures.length > 0, 'invalid_response');
  const instructions = top.map((entry, index) =>
    explainInstruction(entry, String(index)),
  );
  const flags: ExplanationFlag[] = [
    {
      code: 'FINALITY_UNVERIFIED',
      severity: 'warning',
      message:
        'Parsed transaction data alone does not establish finality or safety.',
    },
  ];
  let execution: 'succeeded' | 'failed' | 'unknown' = 'unknown';
  let executionError: TransactionErrorDetail | null = null;
  if (root.meta === null || root.meta === undefined) {
    flags.push({
      code: 'INCOMPLETE_METADATA',
      severity: 'warning',
      message: 'Execution metadata is unavailable.',
    });
  } else {
    const meta = record(root.meta);
    requireSolana(
      meta.err === undefined ||
        meta.err === null ||
        typeof meta.err === 'string' ||
        (typeof meta.err === 'object' && !Array.isArray(meta.err)),
      'invalid_response',
    );
    execution =
      meta.err === null
        ? 'succeeded'
        : meta.err === undefined
          ? 'unknown'
          : 'failed';
    if (execution === 'unknown')
      flags.push({
        code: 'INCOMPLETE_METADATA',
        severity: 'warning',
        message: 'Execution success or failure is not recorded.',
      });
    if (execution === 'failed') {
      {
        const detail = normalizeTransactionError(meta.err);
        if (
          detail &&
          (detail.instructionIndex === null ||
            detail.instructionIndex < top.length)
        )
          executionError = detail;
      }
      flags.push({
        code: 'TRANSACTION_FAILED',
        severity: 'warning',
        message:
          'The transaction failed; its instructions did not commit their requested changes.',
      });
    }
    if (Array.isArray(meta.innerInstructions)) {
      const seen = new Set<number>();
      for (const raw of list(meta.innerInstructions, 64)) {
        const group = record(raw);
        const parent = uint(group.index, top.length - 1);
        requireSolana(!seen.has(parent), 'invalid_response');
        seen.add(parent);
        const entries = list(group.instructions, 128);
        requireSolana(
          instructions.length + entries.length <= 256,
          'invalid_response',
        );
        instructions.push(
          ...entries.map((entry, index) =>
            explainInstruction(entry, `${parent}.${index}`),
          ),
        );
      }
    } else {
      requireSolana(
        meta.innerInstructions === undefined || meta.innerInstructions === null,
        'invalid_response',
      );
      flags.push({
        code: 'INCOMPLETE_METADATA',
        severity: 'warning',
        message:
          'Inner-instruction records are unavailable; this explanation may omit invoked programs.',
      });
    }
  }
  if (!instructions.length)
    flags.push({
      code: 'INCOMPLETE_METADATA',
      severity: 'warning',
      message: 'No instructions were supplied for explanation.',
    });
  flags.push(...instructions.flatMap((instruction) => instruction.flags));
  return {
    decoderVersion: SOLANA_DECODER_VERSION,
    signature: signatures[0],
    slot: uint(root.slot),
    execution,
    ...(executionError ? { executionError } : {}),
    finality: 'not-verified' as const,
    instructions,
    flags,
  };
}

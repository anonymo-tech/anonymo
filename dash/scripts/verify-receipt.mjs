import { readFile, realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import {
  rootEvidenceKey,
  verifyPublicReceipt,
  verifyReceiptInclusion,
} from '../server/receipts/index.ts';
import { receiptTrustFromValues } from '../server/receipts/service.ts';

/** trustDocument must originate from a separately authenticated operator registry. */
export async function verifyReceiptDocument(
  document,
  trustDocument,
  now = new Date().toISOString(),
) {
  if (
    !document ||
    typeof document !== 'object' ||
    Array.isArray(document) ||
    !trustDocument ||
    typeof trustDocument !== 'object' ||
    Array.isArray(trustDocument) ||
    Object.keys(trustDocument).some(
      (key) => !['signers', 'roots'].includes(key),
    )
  )
    throw new Error('INVALID_VERIFICATION_INPUT');
  const signers = receiptTrustFromValues(trustDocument.signers);
  const roots = new Map();
  if (trustDocument.roots !== undefined) {
    if (
      !Array.isArray(trustDocument.roots) ||
      trustDocument.roots.length > 4096
    )
      throw new Error('INVALID_TRUST_REGISTRY');
    for (const evidence of trustDocument.roots) {
      const key = rootEvidenceKey(evidence.claim);
      if (roots.has(key)) throw new Error('DUPLICATE_TRUSTED_ROOT');
      roots.set(key, evidence);
    }
  }
  const receipt = document.receipt ?? document;
  const result = await verifyPublicReceipt(
    receipt,
    { signers, roots, now },
    document.publication,
  );
  if (!result.valid) return result;
  if (document.batch !== undefined && document.batch !== null) {
    if (
      document.batch.state !== 'pending_anchor' ||
      !(await verifyReceiptInclusion(
        receipt,
        document.batch.proof,
        document.batch.root,
      ))
    ) {
      return { valid: false, status: 'invalid', reason: 'invalid_proof' };
    }
  }
  return result;
}

async function boundedJson(path) {
  if ((await stat(path)).size > 1_048_576) throw new Error();
  const data = await readFile(path);
  if (data.byteLength > 1_048_576) throw new Error();
  return JSON.parse(data.toString('utf8'));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 3 || args[1] !== '--trust') {
    process.stderr.write(
      'Usage: node --experimental-strip-types scripts/verify-receipt.mjs RECEIPT.json --trust TRUST.json\nTrust must contain independently authenticated signers and, for anchored status, separately verified root evidence.\n',
    );
    process.exitCode = 1;
  } else {
    try {
      if ((await realpath(args[0])) === (await realpath(args[2])))
        throw new Error();
      const [document, trusted] = await Promise.all([
        boundedJson(args[0]),
        boundedJson(args[2]),
      ]);
      const result = await verifyReceiptDocument(document, trusted);
      process.stdout.write(JSON.stringify(result) + '\n');
      if (!result.valid) process.exitCode = 1;
    } catch {
      process.stderr.write(
        JSON.stringify({
          valid: false,
          status: 'invalid',
          reason: 'verification_input_unavailable',
        }) + '\n',
      );
      process.exitCode = 1;
    }
  }
}

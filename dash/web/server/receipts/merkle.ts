import {
  canonicalReceiptBytes,
  exactObject,
  hex,
  normalizeSignedReceipt,
  ReceiptError,
  sha256,
  toBytes,
  type SignedReceipt,
} from './canonical.ts';

export const MAX_RECEIPTS_PER_TREE = 4096;
export type ReceiptRoot = { version: 1; leafCount: number; hash: string };
export type ReceiptProof = {
  version: 1;
  leafIndex: number;
  leafCount: number;
  siblings: { level: number; position: 'left' | 'right'; hash: string }[];
};
export type ReceiptTree = {
  root: ReceiptRoot;
  receiptIds: string[];
  proofs: ReceiptProof[];
};
const encoder = new TextEncoder();
const leafDomain = encoder.encode('conclave:receipt-leaf:v1\0');
const nodeDomain = encoder.encode('conclave:receipt-node:v1\0');
const rootDomain = encoder.encode('conclave:receipt-root:v1\0');

function count(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_RECEIPTS_PER_TREE
  )
    throw new ReceiptError('invalid_tree');
  return value;
}

export function normalizeRoot(value: unknown): ReceiptRoot {
  const item = exactObject(value, ['version', 'leafCount', 'hash']);
  if (item.version !== 1) throw new ReceiptError('invalid_tree');
  return {
    version: 1,
    leafCount: count(item.leafCount),
    hash: hex(item.hash, 32),
  };
}

export async function receiptLeafHash(value: unknown): Promise<string> {
  const receipt = normalizeSignedReceipt(value);
  return sha256(
    leafDomain,
    canonicalReceiptBytes(receipt.payload),
    toBytes(receipt.signature),
  );
}

async function parentHash(left: string, right: string) {
  return sha256(nodeDomain, toBytes(left), toBytes(right));
}

async function commitment(treeHash: string, leafCount: number) {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, leafCount, false);
  return sha256(rootDomain, bytes, toBytes(treeHash));
}

/** Leaves sort by ASCII receipt ID. Odd nodes promote unchanged, never duplicate. */
export async function buildReceiptTree(
  values: readonly SignedReceipt[],
): Promise<ReceiptTree> {
  if (!Array.isArray(values) || !values.length)
    throw new ReceiptError('empty_tree');
  count(values.length);
  const receipts = values
    .map(normalizeSignedReceipt)
    .sort((a, b) =>
      a.payload.receiptId < b.payload.receiptId
        ? -1
        : a.payload.receiptId > b.payload.receiptId
          ? 1
          : 0,
    );
  const receiptIds = receipts.map((receipt) => receipt.payload.receiptId);
  if (new Set(receiptIds).size !== receiptIds.length)
    throw new ReceiptError('duplicate_receipt');
  const levels = [await Promise.all(receipts.map(receiptLeafHash))];
  while (levels.at(-1)!.length > 1) {
    const layer = levels.at(-1)!;
    const next: Promise<string>[] = [];
    for (let index = 0; index < layer.length; index += 2)
      next.push(
        index + 1 < layer.length
          ? parentHash(layer[index], layer[index + 1])
          : Promise.resolve(layer[index]),
      );
    levels.push(await Promise.all(next));
  }
  const proofs = receipts.map((_receipt, leafIndex): ReceiptProof => {
    const siblings: ReceiptProof['siblings'] = [];
    let index = leafIndex;
    for (let level = 0; level < levels.length - 1; level++) {
      const layer = levels[level];
      if (index % 2)
        siblings.push({ level, position: 'left', hash: layer[index - 1] });
      else if (index + 1 < layer.length)
        siblings.push({ level, position: 'right', hash: layer[index + 1] });
      index = Math.floor(index / 2);
    }
    return { version: 1, leafIndex, leafCount: receipts.length, siblings };
  });
  return {
    root: {
      version: 1,
      leafCount: receipts.length,
      hash: await commitment(levels.at(-1)![0], receipts.length),
    },
    receiptIds,
    proofs,
  };
}

export async function verifyReceiptInclusion(
  receipt: unknown,
  proofValue: unknown,
  rootValue: unknown,
): Promise<boolean> {
  try {
    const root = normalizeRoot(rootValue);
    const proof = exactObject(proofValue, [
      'version',
      'leafIndex',
      'leafCount',
      'siblings',
    ]);
    if (
      proof.version !== 1 ||
      proof.leafCount !== root.leafCount ||
      typeof proof.leafIndex !== 'number' ||
      !Number.isSafeInteger(proof.leafIndex) ||
      proof.leafIndex < 0 ||
      proof.leafIndex >= root.leafCount ||
      !Array.isArray(proof.siblings) ||
      proof.siblings.length > 12
    )
      return false;
    let digest = await receiptLeafHash(receipt);
    let index = proof.leafIndex;
    let width = root.leafCount;
    let cursor = 0;
    let level = 0;
    const seen = new Set<string>();
    while (width > 1) {
      const position = index % 2 ? 'left' : index + 1 < width ? 'right' : null;
      if (position !== null) {
        const step = exactObject(proof.siblings[cursor++], [
          'level',
          'position',
          'hash',
        ]);
        const sibling = hex(step.hash, 32);
        if (
          step.level !== level ||
          step.position !== position ||
          seen.has(sibling)
        )
          return false;
        seen.add(sibling);
        digest =
          position === 'left'
            ? await parentHash(sibling, digest)
            : await parentHash(digest, sibling);
      }
      index = Math.floor(index / 2);
      width = Math.ceil(width / 2);
      level += 1;
    }
    return (
      cursor === proof.siblings.length &&
      (await commitment(digest, root.leafCount)) === root.hash
    );
  } catch {
    return false;
  }
}

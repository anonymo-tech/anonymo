import { createHash } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import bs58 from 'bs58';
import { requireCondition } from '../core/errors.ts';
import { address } from '../solana/validation.ts';
import { object, integer, safeText, type TokenProviders } from './providers.ts';
import { fact, source, blankChecks } from './token-facts.ts';
import type { TokenCheck } from '../../lib/second-look/token.ts';
const METADATA = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export function metadataAddress(mint: string) {
  const program = bs58.decode(METADATA),
    mintBytes = bs58.decode(address(mint));
  for (let bump = 255; bump >= 0; bump--) {
    const digest = new Uint8Array(
      createHash('sha256')
        .update('metadata')
        .update(program)
        .update(mintBytes)
        .update(new Uint8Array([bump]))
        .update(program)
        .update('ProgramDerivedAddress')
        .digest(),
    );
    try {
      ed25519.Point.fromBytes(digest, true);
    } catch {
      return bs58.encode(digest);
    }
  }
  throw new Error('Metadata address unavailable.');
}
export function decodeMetaplex(
  value: unknown,
  mint: string,
  now = Date.now(),
): TokenCheck {
  const envelope = object(value),
    slot = integer(object(envelope.context).slot),
    account = object(envelope.value);
  const valid = (v: unknown) =>
    requireCondition(
      v,
      503,
      'TOKEN_METADATA_INVALID',
      'Token metadata is unavailable.',
    );
  valid(
    account.owner === METADATA &&
      account.executable === false &&
      Array.isArray(account.data) &&
      account.data[1] === 'base64',
  );
  const encoded = (account.data as unknown[])[0];
  valid(typeof encoded === 'string' && encoded.length <= 2048);
  const b = Buffer.from(encoded as string, 'base64');
  valid(
    b.toString('base64') === encoded &&
      b.length >= 80 &&
      b[0] === 4 &&
      bs58.encode(b.subarray(33, 65)) === mint,
  );
  let at = 65;
  const text = (max: number) => {
    valid(at + 4 <= b.length);
    const length = b.readUInt32LE(at);
    at += 4;
    valid(length <= max && at + length <= b.length);
    const data = b.subarray(at, at + length);
    at += length;
    let end = data.length;
    while (end && data[end - 1] === 0) end--;
    return safeText(
      new TextDecoder('utf8', { fatal: true }).decode(data.subarray(0, end)),
      max,
    );
  };
  const name = text(32),
    symbol = text(10),
    uri = text(200);
  valid(at + 3 <= b.length && b.readUInt16LE(at) <= 10000);
  at += 2;
  const creators = b[at++];
  valid(creators <= 1);
  if (creators === 1) {
    valid(at + 4 <= b.length);
    const count = b.readUInt32LE(at);
    at += 4;
    valid(count <= 5 && at + count * 34 <= b.length);
    for (let i = 0; i < count; i++) {
      valid(b[at + 32] <= 1 && b[at + 33] <= 100);
      at += 34;
    }
  }
  valid(at + 2 <= b.length && b[at] <= 1 && b[at + 1] <= 1);
  const mutable = b[at + 1] === 1;
  let host: string | null = null;
  try {
    const u = new URL(uri);
    if (u.protocol === 'https:' && !u.username && !u.password)
      host = u.hostname;
  } catch {
    /* Not fetched. */
  }
  return {
    ...blankChecks()[2],
    status: 'complete',
    sources: [source('solana', now, String(slot))],
    facts: [
      fact(
        'metadataAuthority',
        'Metadata update authority',
        bs58.encode(b.subarray(1, 33)),
      ),
      fact('metadataMutable', 'Metadata remains mutable', mutable),
      fact('name', 'Name', name),
      fact('symbol', 'Symbol', symbol),
      fact('uriHost', 'Metadata URI host', host),
    ],
    limitations: [
      'Name, symbol and URI are token-authored text. Remote URI contents are not fetched or verified.',
    ],
  };
}
export async function readMetaplex(
  mint: string,
  providers: TokenProviders,
  signal?: AbortSignal,
) {
  return decodeMetaplex(
    await providers.mint(metadataAddress(mint), signal),
    mint,
  );
}

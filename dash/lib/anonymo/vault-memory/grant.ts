import { concat, decode, encode, utf8 } from './crypto.ts';

const size = 384;
const hashLength = 48;
const hash = async (data: Uint8Array<ArrayBuffer>) => new Uint8Array(await crypto.subtle.digest('SHA-384', data));
const integer = (bytes: Uint8Array) => BigInt('0x' + Array.from(bytes, (x) => x.toString(16).padStart(2, '0')).join(''));
const fixed = (n: bigint) => Uint8Array.from(n.toString(16).padStart(size * 2, '0').match(/../g)!, (x) => parseInt(x, 16));

function modpow(base: bigint, power: bigint, modulus: bigint) {
  let result = 1n;
  for (; power; power >>= 1n) {
    if (power & 1n) result = result * base % modulus;
    base = base * base % modulus;
  }
  return result;
}

function inverse(value: bigint, modulus: bigint) {
  let [a, b] = [modulus, value];
  let [x, y] = [0n, 1n];
  while (b) {
    const q = a / b;
    [a, b] = [b, a % b];
    [x, y] = [y, x - q * y];
  }
  if (a !== 1n) throw new Error('Invalid vault grant issuer.');
  return (x + modulus) % modulus;
}

// RFC 9474 (RSABSSA-SHA384-PSS-Randomized). Web Crypto verifies the finalized signature.
export async function blindGrant(jwk: { n: string; e: string }, id: string, verifier: string) {
  if (jwk.n.length !== 512 || jwk.e !== 'AQAB') throw new Error('Invalid vault grant issuer.');
  const modulus = decode(jwk.n);
  if (modulus[0]! < 128 || !(modulus.at(-1)! & 1)) throw new Error('Invalid vault grant issuer.');
  const n = integer(modulus);
  const prefix = crypto.getRandomValues(new Uint8Array(32));
  const message = concat(prefix, utf8.encode(`anonymo-vault-sync-v1:${id}:${verifier}`));
  const salt = crypto.getRandomValues(new Uint8Array(hashLength));
  const digest = await hash(concat(new Uint8Array(8), await hash(message), salt));
  const db = new Uint8Array(size - hashLength - 1);
  db[db.length - hashLength - 1] = 1;
  db.set(salt, db.length - hashLength);
  const masks = await Promise.all(Array.from({ length: Math.ceil(db.length / hashLength) }, (_, i) =>
    hash(concat(digest, Uint8Array.of(0, 0, 0, i)))));
  const mask = concat(...masks);
  for (let i = 0; i < db.length; i++) db[i] = db[i]! ^ mask[i]!;
  db[0] = db[0]! & 127;
  const m = integer(concat(db, digest, Uint8Array.of(0xbc)));
  inverse(m, n);

  let r: bigint;
  do { r = integer(crypto.getRandomValues(new Uint8Array(size))); } while (!r || r >= n);
  const factor = inverse(r, n);
  const blinded = encode(fixed(m * modpow(r, 65537n, n) % n));

  return {
    blinded,
    async finalize(signed: string) {
      const bytes = decode(signed);
      if (bytes.length !== size || integer(bytes) >= n) throw new Error('Invalid signed vault grant.');
      const signature = fixed(integer(bytes) * factor % n);
      const pub = await crypto.subtle.importKey('jwk', { kty: 'RSA', ...jwk }, { name: 'RSA-PSS', hash: 'SHA-384' }, false, ['verify']);
      if (!await crypto.subtle.verify({ name: 'RSA-PSS', saltLength: hashLength }, pub, signature, message))
        throw new Error('Invalid signed vault grant.');
      return { prefix: encode(prefix), signature: encode(signature) };
    },
  };
}

import {
  constants, createPrivateKey, createPublicKey, generateKeyPairSync, privateDecrypt,
  publicEncrypt, verify, type KeyObject,
} from "node:crypto";

/** Dedicated RFC 9474 RSABSSA-SHA384-PSS-Randomized issuer. */
export function memoryIssuer(pem: string | undefined) {
  const key = pem ? createPrivateKey(pem) : generateKeyPairSync("rsa", { modulusLength: 3072 }).privateKey;
  const pub = createPublicKey(key);
  const size = (pub.asymmetricKeyDetails?.modulusLength ?? 0) / 8;
  if (key.asymmetricKeyType !== "rsa" || size !== 384 || pub.asymmetricKeyDetails?.publicExponent !== 65537n)
    throw new Error("Memory sync needs a dedicated 3072-bit RSA private key with exponent 65537.");
  const { n, e } = pub.export({ format: "jwk" });
  return { key, pub, size, publicKey: { n, e } };
}

export function blindSign(issuer: ReturnType<typeof memoryIssuer>, blinded: Buffer) {
  if (blinded.length !== issuer.size || !blinded.some(Boolean)) return null;
  try {
    const signature = privateDecrypt({ key: issuer.key, padding: constants.RSA_NO_PADDING }, blinded);
    // Verify the private operation before releasing it, including on providers with CRT acceleration.
    return publicEncrypt({ key: issuer.pub, padding: constants.RSA_NO_PADDING }, signature).equals(blinded) ? signature : null;
  } catch {
    return null;
  }
}

export function verifyGrant(pub: KeyObject, vaultId: string, verifier: string, prefix: Buffer, signature: Buffer) {
  const message = Buffer.concat([prefix, Buffer.from(`anonymo-vault-sync-v1:${vaultId}:${verifier}`)]);
  return verify("sha384", message, { key: pub, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: 48 }, signature);
}

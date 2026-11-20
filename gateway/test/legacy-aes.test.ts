import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { decrypt, encrypt, LEGACY_AES_LABEL } from "../src/lib/util.ts";

// Secrets stored before the rename were encrypted under the old label; they must still decrypt, and new ones use the
// current label.
const SECRET = "x".repeat(40);
function encryptUnder(label: string, plaintext: string) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", createHash("sha256").update(label + SECRET).digest(), iv);
  const body = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), body.toString("base64url")].join(".");
}

describe("secrets at rest across the rename", () => {
  test("a secret encrypted under the old label still decrypts", () => {
    expect(LEGACY_AES_LABEL.endsWith(":aes:")).toBe(true);
    expect(decrypt(SECRET, encryptUnder(LEGACY_AES_LABEL, "upstream-key"))).toBe("upstream-key");
  });
  test("new secrets use the current label and round-trip", () => {
    const token = encrypt(SECRET, "new-key");
    expect(decrypt(SECRET, token)).toBe("new-key");
    expect(() => decrypt(SECRET, encryptUnder("another:aes:", "x"))).toThrow();
    expect(() => decrypt("y".repeat(40), token)).toThrow();
  });
});

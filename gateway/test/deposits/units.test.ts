// WS05 pure pieces: address codecs and derivation, conversions, IP allowlists, cap decisions, the SDN reader,
// BTCPay signatures and refund targets. No database, no network.
import { describe, expect, test } from "bun:test";
import { createHmac, randomBytes } from "node:crypto";
import { HDKey, privateKeyToAddress } from "viem/accounts";
import { toHex } from "viem";
import { base58CheckDecode, base58Decode, base58Encode, isBase58Of } from "../../src/anonymo/deposits/base58.ts";
import { evmKeyCommit, solanaReference, tronAddressAt, tronAddressOfPublicKey } from "../../src/anonymo/deposits/addresses.ts";
import { decimalProductToPico, picoToStableRaw, stableRawToPico } from "../../src/anonymo/deposits/units.ts";
import { ipAllowed, parseCidr } from "../../src/anonymo/keys/ip.ts";
import { capsVerdict, isSealedRequest } from "../../src/anonymo/keys/caps.ts";
import { normalizeAddress, parseSdnXmlAll } from "../../src/anonymo/deposits/sanctions.ts";
import { paidUsdPico, refundTarget, verifyBtcpaySignature } from "../../src/anonymo/deposits/btcpay.ts";
import { loadDepositsConfig } from "../../src/anonymo/deposits/config.ts";
import { KEY_RE } from "../../src/chain/keys.ts";
import { usdToPico } from "../../src/lib/money.ts";

describe("base58", () => {
  test("round-trips random bytes, including leading zeros", () => {
    for (let i = 0; i < 200; i++) {
      const b = Uint8Array.from([...new Array(i % 4).fill(0), ...randomBytes(1 + (i % 40))]);
      expect(base58Decode(base58Encode(b))).toEqual(b);
    }
  });
  test("known vector and checksum", () => {
    expect(base58Encode(Buffer.from("hello world"))).toBe("StV1DL6CwTryKyV");
    expect(base58CheckDecode("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2")?.length).toBe(21);
    expect(base58CheckDecode("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3")).toBeNull();
    expect(isBase58Of("11111111111111111111111111111111", 32)).toBe(true);
    expect(isBase58Of("0OIl", 32)).toBe(false);
  });
});

describe("deposit identifiers", () => {
  test("key commitment and Solana reference are deterministic, distinct per key, and do not contain the key hash", () => {
    const a = "a".repeat(64), b = "b".repeat(64);
    expect(evmKeyCommit(a)).toBe(evmKeyCommit(a));
    expect(evmKeyCommit(a)).not.toBe(evmKeyCommit(b));
    expect(evmKeyCommit(a)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(isBase58Of(solanaReference(a), 32)).toBe(true);
    expect(solanaReference(a)).not.toBe(solanaReference(b));
  });

  test("Tron address of the generator point matches the EVM address of private key 1", () => {
    const g = Buffer.from("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex");
    const payload = base58CheckDecode(tronAddressOfPublicKey(g))!;
    expect(toHex(payload)).toBe(("0x41" + privateKeyToAddress(toHex(1n, { size: 32 })).slice(2).toLowerCase()) as `0x${string}`);
  });

  test("xpub-derived Tron addresses match the private derivation, and differ per index", () => {
    const root = HDKey.fromMasterSeed(Buffer.from("000102030405060708090a0b0c0d0e0f", "hex")).derive("m/44'/195'/0'");
    const xpub = root.publicExtendedKey;
    const seen = new Set<string>();
    for (const i of [0, 1, 7, 1000]) {
      const priv = root.deriveChild(0).deriveChild(i).privateKey!;
      const evm = privateKeyToAddress(toHex(priv)).slice(2).toLowerCase();
      const tron = tronAddressAt(xpub, i);
      expect(tron.startsWith("T")).toBe(true);
      expect(toHex(base58CheckDecode(tron)!)).toBe(`0x41${evm}`);
      seen.add(tron);
    }
    expect(seen.size).toBe(4);
  });
});

describe("conversions", () => {
  test("stablecoins credit 1:1 at their decimals", () => {
    expect(stableRawToPico(1_000_000n, 6)).toBe(usdToPico("1"));
    expect(stableRawToPico(1n, 18)).toBe(0n);
    expect(stableRawToPico(10n ** 18n, 18)).toBe(usdToPico("1"));
    expect(picoToStableRaw(usdToPico("1.2345678"), 6)).toBe(1_234_567n); // rounded down
  });
  test("BTC paid × BTCPay rate is exact", () => {
    expect(decimalProductToPico("0.00123456", "65432.10")).toBe(usdToPico("80.779853376", "floor"));
    expect(decimalProductToPico("1", "0.000000000001")).toBe(1n);
    expect(paidUsdPico([{ rate: "60000", paymentMethodPaid: "0.001" }, { rate: "60000", paymentMethodPaid: "0.0005" }, { rate: "60000", paymentMethodPaid: "0" }])).toBe(usdToPico("90"));
  });
});

describe("ip allowlist", () => {
  test("IPv4 and IPv6 CIDRs", () => {
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
    expect(ipAllowed("192.168.1.9", ["192.168.1.9"])).toBe(true);
    expect(ipAllowed("::ffff:192.168.1.9", ["192.168.1.0/24"])).toBe(true);
    expect(ipAllowed("2001:db8::1", ["2001:db8::/32"])).toBe(true);
    expect(ipAllowed("2001:db9::1", ["2001:db8::/32"])).toBe(false);
    expect(ipAllowed(null, ["0.0.0.0/0"])).toBe(false);
    expect(ipAllowed("onion", ["0.0.0.0/0"])).toBe(false);
    expect(parseCidr("10.0.0.0/33")).toBeNull();
    expect(parseCidr("nonsense")).toBeNull();
  });
});

describe("cap decisions", () => {
  const none = { dailyCap: null, monthlyCap: null, lifetimeCap: null, ipAllow: null, sealedOnly: false };
  const zero = { day: 0n, month: 0n, life: 0n };
  const req = { ip: "1.2.3.4", model: "anonymo-1", sealed: false };
  test("no caps: everything passes", () => expect(capsVerdict(none, { day: 10n ** 20n, month: 10n ** 20n, life: 10n ** 20n }, req)).toBeNull());
  test("each window refuses at or above its cap, independently", () => {
    const cap = usdToPico("5");
    for (const [field, window] of [["dailyCap", "day"], ["monthlyCap", "month"], ["lifetimeCap", "life"]] as const) {
      expect(capsVerdict({ ...none, [field]: cap }, { ...zero, [window]: cap - 1n }, req)).toBeNull();
      expect(capsVerdict({ ...none, [field]: cap }, { ...zero, [window]: cap }, req)?.code).toBe("key_cap_reached");
    }
  });
  test("ip_allow and sealed_only", () => {
    expect(capsVerdict({ ...none, ipAllow: ["9.9.9.0/24"] }, zero, req)?.code).toBe("ip_not_allowed");
    expect(capsVerdict({ ...none, ipAllow: ["1.2.3.0/24"] }, zero, req)).toBeNull();
    expect(capsVerdict({ ...none, sealedOnly: true }, zero, req)?.code).toBe("sealed_only");
    expect(capsVerdict({ ...none, sealedOnly: true }, zero, { ...req, sealed: true })).toBeNull();
    expect(isSealedRequest("anonymo-sealed", undefined)).toBe(true);
    expect(isSealedRequest("anonymo-1", "required")).toBe(true);
    expect(isSealedRequest("anonymo-1", undefined)).toBe(false);
  });
});

describe("key format", () => {
  test("anm_live_ keys are accepted beside the legacy format; nothing else is", () => {
    expect(KEY_RE.test("anm_live_" + "a".repeat(64))).toBe(true);
    expect(KEY_RE.test("sk-ar-v1-" + "a".repeat(64))).toBe(true);
    expect(KEY_RE.test("anm_test_" + "a".repeat(64))).toBe(false);
    expect(KEY_RE.test("anm_live_" + "A".repeat(64))).toBe(false);
  });
});

describe("sanctions list", () => {
  const sdn = (ids: [string, string][]) =>
    `<?xml version="1.0"?><sdnList><publshInformation><Publish_Date>11/01/2026</Publish_Date><Record_Count>1</Record_Count></publshInformation><sdnEntry><uid>1</uid><idList>${ids
      .map(([t, n]) => `<id><idType>Digital Currency Address - ${t}</idType><idNumber>${n}</idNumber></id>`)
      .join("")}</idList></sdnEntry></sdnList>`;
  test("keeps EVM, Tron, Solana and Bitcoin addresses, one spelling each", () => {
    const tron = tronAddressOfPublicKey(Buffer.from("0279be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798", "hex"));
    const sol = base58Encode(randomBytes(32));
    const out = parseSdnXmlAll(sdn([["ETH", "0x00000000000000000000000000000000000ABC01"], ["TRX", tron], ["SOL", sol], ["XBT", "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"], ["XYZ", "not-an-address"]]));
    const got = new Map(out.addresses.map((a) => [a.address, a.family]));
    expect(got.get("0x00000000000000000000000000000000000abc01")).toBe("evm");
    expect(got.get(tron)).toBe("tron");
    expect(got.get(sol)).toBe("solana");
    expect(got.get("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toBe("btc");
    expect(out.ignoredCount).toBe(1);
    expect(normalizeAddress("0x00000000000000000000000000000000000ABC01")?.address).toBe("0x00000000000000000000000000000000000abc01");
  });
  test("rejects DTDs and truncated feeds", () => {
    expect(() => parseSdnXmlAll(`<!DOCTYPE x [<!ENTITY a "b">]>` + sdn([["ETH", "0x00000000000000000000000000000000000abc01"]]))).toThrow();
    expect(() => parseSdnXmlAll(sdn([["ETH", "0x00000000000000000000000000000000000abc01"]]).slice(0, -12))).toThrow();
  });
});

describe("BTCPay", () => {
  const secret = "webhook-secret-0123456789";
  const body = JSON.stringify({ type: "InvoiceSettled", invoiceId: "inv1" });
  const sig = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  test("webhook signature: valid, tampered, missing", () => {
    expect(verifyBtcpaySignature(secret, body, sig)).toBe(true);
    expect(verifyBtcpaySignature(secret, body + " ", sig)).toBe(false);
    expect(verifyBtcpaySignature("other-secret-0123456789", body, sig)).toBe(false);
    expect(verifyBtcpaySignature(secret, body, undefined)).toBe(false);
    expect(verifyBtcpaySignature(secret, body, "sha256=zz")).toBe(false);
  });
  test("refund targets", () => {
    expect(refundTarget("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq")).toEqual({ chain: "btc", address: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq" });
    expect(refundTarget("sample-user@wallet.example")).toEqual({ chain: "ln", address: "sample-user@wallet.example" });
    expect(refundTarget("0x00000000000000000000000000000000000abc01")).toBeNull();
  });
});

describe("config", () => {
  test("rails are off by default and parse from JSON", () => {
    const off = loadDepositsConfig({});
    expect(off.evm).toEqual([]);
    expect(off.solana).toBeUndefined();
    const on = loadDepositsConfig({ ANONYMO_EVM_CHAINS: JSON.stringify([{ chain: "base", rpcUrl: "http://127.0.0.1:1", router: "0x00000000000000000000000000000000000000Aa", tokens: [{ symbol: "USDC", address: "0x00000000000000000000000000000000000000Bb", decimals: 6 }] }]) });
    expect(on.evm[0].router).toBe("0x00000000000000000000000000000000000000aa");
    expect(on.evm[0].confirmations).toBe(12);
    expect(() => loadDepositsConfig({ ANONYMO_EVM_CHAINS: "[{" })).toThrow();
  });
});

describe("DepositRouter event", () => {
  test("our ABI fragment matches WS08's IAnonymo.Deposited, indexed fields included", async () => {
    const { readFileSync } = await import("node:fs");
    const { DEPOSITED_EVENT } = await import("../../src/anonymo/deposits/evm.ts");
    const sol = readFileSync(new URL("../../contracts/src/anonymo/interfaces/IAnonymo.sol", import.meta.url), "utf8");
    const m = /event Deposited\(([^)]*)\);/.exec(sol)!;
    const params = m[1].split(",").map((p) => p.trim().split(/\s+/));
    expect(DEPOSITED_EVENT.inputs.map((i) => [i.type, ...(i.indexed ? ["indexed"] : []), i.name])).toEqual(params);
  });
});

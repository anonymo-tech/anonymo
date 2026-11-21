import { describe, expect, test } from "bun:test";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { decodeFunctionData, parseAbi } from "viem";
import { arnsInstruction, base32Decode, cidV1Bytes, dnslinkRecord, dnslinkValue, ensContenthashTx, ipfsContenthash, validateArnsName, validateDomain, validateEnsName } from "../../src/anonymo/ventures/deploy/names.ts";

// Ventures Backend PART 7: DNSLink on the user's domain, or ENS (EIP-1577 contenthash) / ArNS. The ENS vectors are
// built here from first principles, independently of names.ts.

/** Independent RFC 4648 base32 encoder (lowercase, no padding), bit string based. */
function b32encode(bytes: Uint8Array): string {
  const A = "abcdefghijklmnopqrstuvwxyz234567";
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let s = "";
  for (let i = 0; i < bits.length; i += 5) s += A[parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return s;
}
const hex = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));

describe("EIP-1577 contenthash", () => {
  test("the EIP's own IPFS example, rebuilt as a CIDv1", () => {
    // EIP-1577's example contenthash e3 01 | 01 70 12 20 <sha256> is the CIDv0 Qm... multihash 12 20 29f2d17b... as a
    // CIDv1 (version 01, codec dag-pb 70). Encoding those CID bytes in base32 gives the "b..." form we decode.
    const digest = "29f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f";
    const cid = "b" + b32encode(hex(`01701220${digest}`));
    expect(cid).toBe("bafybeibj6lixxzqtsb45ysdjnupvqkufgdvzqbnvmhw2kf7cfkesy7r7d4");
    expect(ipfsContenthash(cid)).toBe(`0xe3010170122029f2d17be6139079dc48696d1f582a8530eb9805b561eda517e22a892c7e3f1f`);
  });

  test("bafybeibml5... decodes to its own digest", () => {
    // The brief paired this CID with the EIP example hash (29f2d17b...); that hash belongs to the CID above. Decoding
    // bafybeibml5... bit by bit gives 01 70 12 20 2c5f6882..., and re-encoding those bytes returns the same string.
    const cid = "bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm";
    const bytes = "017012202c5f688262e0ece8569aa6f94d60aad55ca8d9d83734e4a7430d0cff6588ec2b";
    expect("b" + b32encode(hex(bytes))).toBe(cid);
    expect(ipfsContenthash(cid)).toBe(`0xe301${bytes}`);
  });

  test("a raw-leaf CIDv1 and malformed input", () => {
    const digest = "aa".repeat(32);
    const cid = "b" + b32encode(hex(`01551220${digest}`));
    expect(bytesToHex(cidV1Bytes(cid))).toBe(`01551220${digest}`);
    expect(() => cidV1Bytes("QmRAQB6YaCyidP37UdDnjFY5vQuiBrcqdyoW1CuDgwxkD4")).toThrow("CIDv1");
    expect(() => cidV1Bytes(cid.slice(0, -4))).toThrow();
    expect(() => cidV1Bytes("b" + b32encode(hex(`00701220${digest}`)))).toThrow("version 1");
    expect(() => base32Decode("ab")).toThrow("canonical");
  });
});

describe("ENS setContenthash", () => {
  test("calldata targets the resolver with namehash(name) and the contenthash; value 0, unsigned", () => {
    const cid = "bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm";
    const resolver = "0x" + "ab".repeat(20);
    const r = ensContenthashTx({ name: "sample.eth", resolver, cid });
    // namehash by hand: keccak(keccak(0x00*32 ‖ keccak("eth")) ‖ keccak("sample"))
    const k = (b: Uint8Array) => keccak_256(b);
    const cat = (a: Uint8Array, b: Uint8Array) => Uint8Array.from([...a, ...b]);
    const te = new TextEncoder();
    const node = k(cat(k(cat(new Uint8Array(32), k(te.encode("eth")))), k(te.encode("sample"))));
    expect(r.node).toBe(`0x${bytesToHex(node)}`);
    expect(r.tx.to).toBe(resolver);
    expect(r.tx.value).toBe("0x0");
    expect(r.tx.chainId).toBe(1);
    // setContenthash(bytes32,bytes) selector
    expect(r.tx.data.slice(0, 10)).toBe(`0x${bytesToHex(k(te.encode("setContenthash(bytes32,bytes)"))).slice(0, 8)}`);
    expect(r.tx.data.slice(0, 10)).toBe("0x304e6ade");
    const decoded = decodeFunctionData({ abi: parseAbi(["function setContenthash(bytes32 node, bytes hash)"]), data: r.tx.data });
    expect(decoded.args).toEqual([r.node, ipfsContenthash(cid)]);
    expect(JSON.stringify(r)).not.toMatch(/privateKey|signature/i);
  });

  test("names and resolvers are validated", () => {
    expect(validateEnsName("sample.eth")).toBe("sample.eth");
    expect(() => validateEnsName("Sample.eth")).toThrow("normalised");
    expect(() => validateEnsName("eth")).toThrow();
    expect(() => validateEnsName("a..eth")).toThrow();
    expect(() => ensContenthashTx({ name: "sample.eth", resolver: "0x1234", cid: "bafkqaaa" })).toThrow("resolver");
    expect(() => ensContenthashTx({ name: "sample.eth", resolver: "0x" + "00".repeat(20), cid: "bafkqaaa" })).toThrow("resolver");
  });
});

describe("DNSLink", () => {
  test("TXT _dnslink.<domain> = dnslink=/ipfs/<cid>", () => {
    const cid = "bafybeibml5uieyxa5tufngvg7fgwbkwvlsuntwbxgtskoqynbt7wlchmfm";
    expect(dnslinkValue(cid)).toBe(`dnslink=/ipfs/${cid}`);
    expect(dnslinkRecord("Example.COM.", cid)).toEqual({ name: "_dnslink.example.com", type: "TXT", value: `dnslink=/ipfs/${cid}` });
    expect(dnslinkRecord("www.example.com", cid).name).toBe("_dnslink.www.example.com");
    expect(() => dnslinkValue("not-a-cid")).toThrow();
  });

  test("domains are validated", () => {
    expect(validateDomain("xn--bcher-kva.example")).toBe("xn--bcher-kva.example");
    for (const bad of ["localhost", "-a.example.com", "a_b.example.com", "exa mple.com", "example.c0m", "a".repeat(64) + ".com", "exämple.com", ""]) {
      expect(() => validateDomain(bad)).toThrow();
    }
  });
});

describe("ArNS", () => {
  test("an instruction for the user to set, pointing at the Arweave manifest", () => {
    const id = "A".repeat(20) + "_-" + "b".repeat(21);
    expect(arnsInstruction("sample", id)).toMatchObject({ name: "sample", transactionId: id });
    expect(validateArnsName("blog_sample")).toBe("blog_sample");
    expect(() => validateArnsName("-sample")).toThrow();
    expect(() => validateArnsName("a".repeat(52))).toThrow();
    expect(() => arnsInstruction("sample", "short")).toThrow("manifest id");
  });
});

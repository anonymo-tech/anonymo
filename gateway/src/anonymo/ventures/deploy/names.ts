// WS11 · Ventures deploy (Ventures Backend spec, PART 7 "DNSLink on the user's domain or ENS / ArNS"): pointing a
// name at a deployed CID.
//
// DNSLink is a TXT record we can set through a DnsProvider. ENS and ArNS records belong to the user's own wallet: we
// build the unsigned transaction (ENS) or the instruction (ArNS) and the user signs it. We never hold their key.

import { encodeFunctionData, type Hex } from "viem";
import { namehash, normalize } from "viem/ens";

// ---- DNSLink -----------------------------------------------------------------------------------------------------

/** A lowercase ASCII DNS name with at least two labels (punycode for IDNs). Returns it normalised or throws. */
export function validateDomain(raw: string): string {
  const d = raw.trim().toLowerCase().replace(/\.$/, "");
  if (!d || d.length > 253) throw new Error("bad domain");
  const labels = d.split(".");
  if (labels.length < 2) throw new Error("bad domain: needs at least two labels");
  for (const l of labels) if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(l)) throw new Error(`bad domain label: ${JSON.stringify(l)}`);
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) throw new Error("bad domain: top-level label");
  return d;
}

export type TxtRecord = { name: string; type: "TXT"; value: string };

export function dnslinkValue(cid: string): string {
  cidV1Bytes(cid); // only well-formed CIDs reach a record
  return `dnslink=/ipfs/${cid}`;
}

/** The record that makes `domain` resolve to `cid` over DNSLink: TXT `_dnslink.<domain>` = `dnslink=/ipfs/<cid>`. */
export function dnslinkRecord(domain: string, cid: string): TxtRecord {
  return { name: `_dnslink.${validateDomain(domain)}`, type: "TXT", value: dnslinkValue(cid) };
}

/** Any DNS host the user has connected. setTxt replaces the TXT records at `name` with the one value. */
export interface DnsProvider {
  readonly name: string;
  setTxt(name: string, value: string): Promise<void>;
}

// ---- CIDv1 bytes and the EIP-1577 contenthash ---------------------------------------------------------------------

const B32 = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 base32, lowercase, no padding (the multibase "b" alphabet). */
export function base32Decode(s: string): Uint8Array {
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const c of s) {
    const v = B32.indexOf(c);
    if (v < 0) throw new Error("not base32");
    value = ((value << 5) | v) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  if (bits >= 5 || (value & ((1 << bits) - 1)) !== 0) throw new Error("not canonical base32");
  return Uint8Array.from(out);
}

function readVarint(b: Uint8Array, at: number): [number, number] {
  let n = 0;
  for (let shift = 0, i = at; i < b.length && shift < 28; i++, shift += 7) {
    n |= (b[i] & 0x7f) << shift;
    if (!(b[i] & 0x80)) return [n, i + 1];
  }
  throw new Error("bad varint");
}

/** Decode a base32 CIDv1 ("b..." multibase) to its binary form: version, codec, multihash. */
export function cidV1Bytes(cid: string): Uint8Array {
  if (typeof cid !== "string" || !/^b[a-z2-7]+$/.test(cid)) throw new Error("expected a base32 CIDv1 (b...)");
  const bytes = base32Decode(cid.slice(1));
  const [version, a] = readVarint(bytes, 0);
  if (version !== 1) throw new Error("expected CID version 1");
  const [, b] = readVarint(bytes, a); // content codec
  const [, c] = readVarint(bytes, b); // multihash function
  const [len, d] = readVarint(bytes, c);
  if (d + len !== bytes.length) throw new Error("CID multihash length does not match");
  return bytes;
}

/** EIP-1577 contenthash for an IPFS CID: the ipfs-ns code 0xe3 as a varint (0xe3 0x01), then the binary CIDv1. */
export function ipfsContenthash(cid: string): Hex {
  const bytes = cidV1Bytes(cid);
  return `0xe301${Buffer.from(bytes).toString("hex")}`;
}

// ---- ENS ---------------------------------------------------------------------------------------------------------

/** A normalised (ENSIP-15) ENS name with at least two labels. Returns it or throws. */
export function validateEnsName(raw: string): string {
  const name = raw.trim();
  let norm: string;
  try {
    norm = normalize(name);
  } catch {
    throw new Error("bad ENS name");
  }
  if (norm !== name) throw new Error("ENS name is not normalised");
  if (norm.split(".").length < 2 || norm.split(".").some((l) => !l)) throw new Error("bad ENS name");
  return norm;
}

const SET_CONTENTHASH_ABI = [
  {
    type: "function",
    name: "setContenthash",
    stateMutability: "nonpayable",
    inputs: [
      { name: "node", type: "bytes32" },
      { name: "hash", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export type UnsignedTx = { to: Hex; data: Hex; value: "0x0"; chainId: number };
export type EnsRecord = { name: string; node: Hex; contenthash: Hex; tx: UnsignedTx };

/** The unsigned `setContenthash(namehash(name), contenthash(cid))` call on the name's resolver, for the user to sign. */
export function ensContenthashTx(input: { name: string; resolver: string; cid: string; chainId?: number }): EnsRecord {
  const name = validateEnsName(input.name);
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.resolver) || /^0x0{40}$/.test(input.resolver)) throw new Error("bad resolver address");
  const node = namehash(name);
  const contenthash = ipfsContenthash(input.cid);
  const data = encodeFunctionData({ abi: SET_CONTENTHASH_ABI, functionName: "setContenthash", args: [node, contenthash] });
  return { name, node, contenthash, tx: { to: input.resolver as Hex, data, value: "0x0", chainId: input.chainId ?? 1 } };
}

// ---- ArNS --------------------------------------------------------------------------------------------------------

/** An ArNS name, or `undername_name`: lowercase letters, digits and inner hyphens, 1-51 characters per part. */
export function validateArnsName(raw: string): string {
  const n = raw.trim().toLowerCase();
  const part = "[a-z0-9](?:[a-z0-9-]{0,49}[a-z0-9])?";
  if (!new RegExp(`^(?:${part}_)?${part}$`).test(n)) throw new Error("bad ArNS name");
  return n;
}

export type ArnsInstruction = { name: string; transactionId: string; note: string };

/** What the user sets on their ArNS name (its ANT record) so it serves the Arweave path manifest. */
export function arnsInstruction(name: string, manifestId: string): ArnsInstruction {
  if (!/^[A-Za-z0-9_-]{43}$/.test(manifestId)) throw new Error("bad Arweave manifest id");
  return { name: validateArnsName(name), transactionId: manifestId, note: "Set this transaction id on the name's record from your own wallet." };
}

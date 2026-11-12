// A C2PA manifest for every output, built and signed in process (no maintained C2PA library runs under Bun without a
// native addon, and gateway/package.json is not this workstream's to change; see README.md in this folder).
//
// What is embedded: a JUMBF manifest store (C2PA 2.x box layout and UUIDs) holding one manifest with
//   c2pa.actions        c2pa.created, digitalSourceType trainedAlgorithmicMedia, softwareAgent = the model id
//   c2pa.hash.data      sha256 of the whole file except the manifest unit itself (one exclusion range)
//   anonymo.generation  model, request id, time, and the id the invisible watermark carries
// plus the claim (CBOR, with sha256 hard bindings to each assertion box) and a COSE_Sign1 EdDSA signature over it.
//
// Known gaps against a conformant C2PA validator (c2patool): the COSE signature carries the claim attached and a `kid`
// instead of an `x5chain` certificate from a C2PA trust list; MP4 uses c2pa.hash.data rather than c2pa.hash.bmff.v2.
// The manifest is still verifiable end to end with verifyManifest() and the published key (GET /v1/media/provenance/keys).

import { createPrivateKey, createPublicKey, randomUUID, sign as edSign, verify as edVerify, type KeyObject } from "node:crypto";
import { cborDecode, cborEncode, cborToJson, type CborValue } from "../../receipts/cbor.ts";
import { coseSign1, decodeCoseSign1 } from "../../receipts/v2.ts";
import { ascii, bytesEqual, concatBytes, readU32be, sha256Bytes, te, u32be, without } from "./bytes.ts";
import { containerFor, sniffMime } from "./containers.ts";

// ---- Signing key ---------------------------------------------------------------------------------------------------
export type ProvenanceKey = { keyId: string; publicKeyHex: string; sign(tbs: Uint8Array): Uint8Array; verify(tbs: Uint8Array, sig: Uint8Array): boolean };
const PKCS8_ED25519 = Buffer.from("302e020100300506032b657004220420", "hex");

export function provenanceKeyFromSeed(seed: Uint8Array): ProvenanceKey {
  if (seed.length !== 32) throw new Error("provenance key seed must be 32 bytes");
  const priv: KeyObject = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: "der", type: "pkcs8" });
  const pub = createPublicKey(priv);
  const raw = Buffer.from(pub.export({ format: "jwk" }).x as string, "base64url");
  return {
    keyId: Buffer.from(sha256Bytes(raw).subarray(0, 8)).toString("hex"),
    publicKeyHex: raw.toString("hex"),
    sign: (tbs) => new Uint8Array(edSign(null, tbs, priv)),
    verify: (tbs, sig) => edVerify(null, tbs, pub, sig),
  };
}
export const verifyWithPublicHex = (publicKeyHex: string, tbs: Uint8Array, sig: Uint8Array) => {
  try {
    const pub = createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: Buffer.from(publicKeyHex, "hex").toString("base64url") }, format: "jwk" });
    return edVerify(null, tbs, pub, sig);
  } catch {
    return false;
  }
};

// ---- JUMBF ---------------------------------------------------------------------------------------------------------
const C2PA_UUID_TAIL = Buffer.from("00110010800000aa00389b71", "hex");
const uuidOf = (tag: string) => concatBytes([te.encode(tag), C2PA_UUID_TAIL]);
const box = (type: string, payload: Uint8Array) => concatBytes([u32be(8 + payload.length), te.encode(type), payload]);
const superbox = (tag: string, label: string, children: Uint8Array[]) =>
  box("jumb", concatBytes([box("jumd", concatBytes([uuidOf(tag), Uint8Array.of(0x03), te.encode(label), Uint8Array.of(0)])), ...children]));

type Parsed = { type: string; payload: Uint8Array; raw: Uint8Array };
function parseBoxes(b: Uint8Array): Parsed[] {
  const out: Parsed[] = [];
  let at = 0;
  while (at < b.length) {
    if (at + 8 > b.length) throw new Error("truncated JUMBF box");
    const size = readU32be(b, at);
    if (size < 8 || at + size > b.length) throw new Error("bad JUMBF box size");
    out.push({ type: ascii(b, at + 4, 4), payload: b.subarray(at + 8, at + size), raw: b.subarray(at, at + size) });
    at += size;
  }
  return out;
}
type Super = { tag: string; label: string; children: Parsed[]; raw: Uint8Array };
function parseSuper(p: Parsed): Super {
  if (p.type !== "jumb") throw new Error("expected a JUMBF superbox");
  const [d, ...children] = parseBoxes(p.payload);
  if (d?.type !== "jumd" || d.payload.length < 18) throw new Error("JUMBF superbox without a description box");
  const tag = ascii(d.payload, 0, 4);
  const nul = d.payload.indexOf(0, 17);
  return { tag, label: new TextDecoder().decode(d.payload.subarray(17, nul < 0 ? undefined : nul)), children, raw: p.raw };
}

// ---- Manifest ------------------------------------------------------------------------------------------------------
export const TRAINED_ALGORITHMIC_MEDIA = "http://cv.iptc.org/newscodes/digitalsourcetype/trainedAlgorithmicMedia";
export const CLAIM_GENERATOR = "anonymo-gateway/1 (c2pa-in-process)";
export type ManifestMeta = { requestId: string; model: string; generatedAt: string; watermark: { alg: string; id: string } };
type Exclusion = { start: number; length: number };

function buildStore(mime: string, meta: ManifestMeta, manifestId: string, excl: Exclusion, hash: Uint8Array, key: ProvenanceKey): Uint8Array {
  const assertions: [string, CborValue][] = [
    ["c2pa.actions", { actions: [{ action: "c2pa.created", digitalSourceType: TRAINED_ALGORITHMIC_MEDIA, softwareAgent: { name: meta.model } }] }],
    ["c2pa.hash.data", { exclusions: [{ start: excl.start, length: excl.length }], name: "jumbf manifest", alg: "sha256", hash, pad: new Uint8Array() }],
    ["anonymo.generation", { model: meta.model, request_id: meta.requestId, generated_at: meta.generatedAt, watermark: meta.watermark, ai_generated: true }],
  ];
  const assertionBoxes = assertions.map(([label, v]) => superbox("cbor", label, [box("cbor", cborEncode(v))]));
  const claim = cborEncode({
    claim_generator: CLAIM_GENERATOR,
    claim_generator_info: [{ name: "anonymo", version: "1" }],
    "dc:format": mime,
    instanceID: `xmp:iid:${manifestId}`,
    signature: "self#jumbf=c2pa.signature",
    alg: "sha256",
    assertions: assertions.map(([label], i) => ({ url: `self#jumbf=c2pa.assertions/${label}`, alg: "sha256", hash: sha256Bytes(assertionBoxes[i]) })),
  });
  const signature = coseSign1(claim, Buffer.from(key.keyId, "hex"), key.sign);
  const manifest = superbox("c2ma", `urn:uuid:${manifestId}`, [
    superbox("c2as", "c2pa.assertions", assertionBoxes),
    superbox("c2cl", "c2pa.claim", [box("cbor", claim)]),
    superbox("c2cs", "c2pa.signature", [box("cbor", signature)]),
  ]);
  return superbox("c2pa", "c2pa", [manifest]);
}

/** Embed a signed manifest whose data hash covers every byte of the result except the manifest unit. */
export function embedManifest(asset: Uint8Array, mime: string, meta: ManifestMeta, key: ProvenanceKey): Uint8Array {
  const c = containerFor(mime);
  if (!c || !c.matches(asset)) throw new Error(`no C2PA container for ${mime}`);
  const base = c.strip(asset);
  const manifestId = randomUUID();
  const zero = new Uint8Array(32);
  let excl: Exclusion = { start: 0, length: 0 };
  let placed = c.insert(base, buildStore(mime, meta, manifestId, excl, zero, key));
  // The exclusion names the unit's own offset and length, which the encoded numbers can change: settle it first.
  for (let i = 0; i < 6 && (placed.offset !== excl.start || placed.length !== excl.length); i++) {
    excl = { start: placed.offset, length: placed.length };
    placed = c.insert(base, buildStore(mime, meta, manifestId, excl, zero, key));
  }
  if (placed.offset !== excl.start || placed.length !== excl.length) throw new Error("manifest layout did not settle");
  const hash = sha256Bytes(without(placed.bytes, excl.start, excl.length));
  const final = c.insert(base, buildStore(mime, meta, manifestId, excl, hash, key));
  if (final.length !== excl.length || final.offset !== excl.start) throw new Error("manifest length changed while signing");
  return final.bytes;
}

export type ManifestCheck =
  | { ok: true; mime: string; keyId: string; generation: ManifestMeta & { ai_generated: boolean }; digitalSourceType: string }
  | { ok: false; reason: "unsupported_format" | "no_manifest" | "malformed" | "unknown_key" | "bad_signature" | "assertion_mismatch" | "content_changed" };

/** Verify a manifest end to end: signature, assertion bindings, and the data hash over the file. */
export function verifyManifest(bytes: Uint8Array, publicKeyOf: (keyId: string) => string | null): ManifestCheck {
  const mime = sniffMime(bytes);
  const c = mime ? containerFor(mime) : null;
  if (!mime || !c) return { ok: false, reason: "unsupported_format" };
  let located;
  try {
    located = c.extract(bytes);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!located) return { ok: false, reason: "no_manifest" };
  try {
    const store = parseSuper(parseBoxes(located.store)[0]);
    if (store.tag !== "c2pa") return { ok: false, reason: "malformed" };
    const manifest = parseSuper(store.children[0]);
    const parts = new Map(manifest.children.map((p) => parseSuper(p)).map((s) => [s.label, s]));
    const claimBytes = parts.get("c2pa.claim")?.children[0]?.payload;
    const sigBytes = parts.get("c2pa.signature")?.children[0]?.payload;
    const assertionStore = parts.get("c2pa.assertions");
    if (!claimBytes || !sigBytes || !assertionStore) return { ok: false, reason: "malformed" };
    const cose = decodeCoseSign1(sigBytes);
    const keyId = cose.kid ? Buffer.from(cose.kid).toString("hex") : "";
    const pub = publicKeyOf(keyId);
    if (!pub) return { ok: false, reason: "unknown_key" };
    if (!bytesEqual(cose.payload, claimBytes) || !verifyWithPublicHex(pub, cose.toBeSigned, cose.signature)) return { ok: false, reason: "bad_signature" };
    const refs = (cborDecode(claimBytes) as Map<CborValue, CborValue>).get("assertions") as Map<CborValue, CborValue>[];
    const assertions = new Map(assertionStore.children.map((p) => parseSuper(p)).map((s) => [s.label, s]));
    const read = (label: string) => cborDecode(assertions.get(label)!.children[0].payload);
    for (const ref of refs) {
      const a = assertions.get(String(ref.get("url")).replace("self#jumbf=c2pa.assertions/", ""));
      const expected = ref.get("hash");
      if (!a || !(expected instanceof Uint8Array) || !bytesEqual(sha256Bytes(a.raw), expected)) return { ok: false, reason: "assertion_mismatch" };
    }
    for (const required of ["c2pa.actions", "c2pa.hash.data", "anonymo.generation"]) if (!assertions.has(required)) return { ok: false, reason: "malformed" };
    const dataHash = read("c2pa.hash.data") as Map<CborValue, CborValue>;
    const excl = (dataHash.get("exclusions") as Map<CborValue, CborValue>[])[0];
    if (excl.get("start") !== located.offset || excl.get("length") !== located.length) return { ok: false, reason: "content_changed" };
    const hash = dataHash.get("hash");
    if (!(hash instanceof Uint8Array) || !bytesEqual(sha256Bytes(without(bytes, located.offset, located.length)), hash)) return { ok: false, reason: "content_changed" };
    const actions = cborToJson(read("c2pa.actions")) as { actions: { digitalSourceType: string }[] };
    const gen = cborToJson(read("anonymo.generation")) as { model: string; request_id: string; generated_at: string; watermark: { alg: string; id: string }; ai_generated: boolean };
    return {
      ok: true,
      mime,
      keyId,
      digitalSourceType: actions.actions[0]?.digitalSourceType ?? "",
      generation: { model: gen.model, requestId: gen.request_id, generatedAt: gen.generated_at, watermark: gen.watermark, ai_generated: gen.ai_generated },
    };
  } catch {
    return { ok: false, reason: "malformed" };
  }
}

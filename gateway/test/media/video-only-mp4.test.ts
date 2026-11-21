// videoOnlyMp4: keep only the picture track the frame classifier reviewed. The fixtures are one-second synthetic
// clips (an ffmpeg test pattern and a 440 Hz tone), one with the index before the media data and one after it.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { concatBytes, te, u32be } from "../../src/anonymo/media/bytes.ts";
import { C2PA_BMFF_UUID, containerFor, isSilentMp4, videoOnlyMp4 } from "../../src/anonymo/media/containers.ts";

const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));
const box = (type: string, data: Uint8Array) => concatBytes([u32be(data.length + 8), te.encode(type), data]);
const track = (kind: string) => box("trak", box("mdia", box("hdlr", concatBytes([new Uint8Array(8), te.encode(kind), new Uint8Array(12)]))));

/** Top-level boxes, and the video track's chunk offsets (stco), read independently of the code under test. */
function layout(b: Uint8Array) {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const children = (start: number, end: number) => {
    const out: { type: string; start: number; end: number }[] = [];
    for (let at = start; at < end; ) {
      const size = dv.getUint32(at);
      out.push({ type: new TextDecoder().decode(b.subarray(at + 4, at + 8)), start: at + 8, end: at + size });
      at += size;
    }
    return out;
  };
  const top = children(0, b.length);
  const moov = top.find((x) => x.type === "moov")!;
  const traks = children(moov.start, moov.end).filter((x) => x.type === "trak");
  const find = (list: { type: string; start: number; end: number }[], type: string) => list.find((x) => x.type === type)!;
  const handler = (t: { start: number; end: number }) => {
    const hdlr = find(children(find(children(t.start, t.end), "mdia").start, find(children(t.start, t.end), "mdia").end), "hdlr");
    return new TextDecoder().decode(b.subarray(hdlr.start + 8, hdlr.start + 12));
  };
  const video = traks.find((t) => handler(t) === "vide")!;
  const mdia = find(children(video.start, video.end), "mdia");
  const minf = find(children(mdia.start, mdia.end), "minf");
  const stbl = find(children(minf.start, minf.end), "stbl");
  const stco = find(children(stbl.start, stbl.end), "stco");
  const count = dv.getUint32(stco.start + 4);
  const offsets = Array.from({ length: count }, (_, i) => dv.getUint32(stco.start + 8 + i * 4));
  return { top: top.map((x) => x.type), traks: traks.map(handler), offsets };
}

for (const name of ["av-faststart.mp4", "av-moov-last.mp4"]) {
  test(`${name}: the soundtrack is dropped and the picture track still points at the same samples`, () => {
    const input = fixture(name);
    expect(isSilentMp4(input)).toBe(false);
    const before = layout(input);
    expect(before.traks.sort()).toEqual(["soun", "vide"]);
    const out = videoOnlyMp4(input)!;
    expect(out).not.toBeNull();
    expect(isSilentMp4(out)).toBe(true);
    const after = layout(out);
    expect(after.traks).toEqual(["vide"]);
    expect(after.top).toEqual(before.top);
    expect(after.offsets).toHaveLength(before.offsets.length);
    // Every video chunk starts with the same bytes it did before, wherever the index sits.
    for (let i = 0; i < before.offsets.length; i++)
      expect(Buffer.from(out.subarray(after.offsets[i], after.offsets[i] + 32))).toEqual(Buffer.from(input.subarray(before.offsets[i], before.offsets[i] + 32)));
  });
}

test("a clip that is already video-only comes back unchanged", () => {
  const once = videoOnlyMp4(fixture("av-faststart.mp4"))!;
  expect(videoOnlyMp4(once)).toBe(once);
});

test("fragmented files, files with no or two picture tracks, and non-MP4 bytes give null", () => {
  const ftyp = box("ftyp", te.encode("isom"));
  const mdat = box("mdat", new Uint8Array(8));
  expect(videoOnlyMp4(concatBytes([ftyp, box("moov", track("soun")), mdat]))).toBeNull();
  expect(videoOnlyMp4(concatBytes([ftyp, box("moov", concatBytes([track("vide"), track("vide")])), mdat]))).toBeNull();
  expect(videoOnlyMp4(concatBytes([ftyp, box("moov", concatBytes([track("vide"), box("mvex", new Uint8Array(0))])), mdat]))).toBeNull();
  expect(videoOnlyMp4(concatBytes([ftyp, box("moov", track("vide")), box("moof", new Uint8Array(0)), mdat]))).toBeNull();
  expect(videoOnlyMp4(te.encode("not an mp4 at all"))).toBeNull();
});

test("removing an upstream C2PA box that sits before the media data keeps every sample findable (Veo's layout)", () => {
  for (const name of ["av-faststart.mp4", "av-moov-last.mp4"]) {
    const input = fixture(name);
    const ftypEnd = new DataView(input.buffer, input.byteOffset).getUint32(0);
    const upstream = box("uuid", concatBytes([C2PA_BMFF_UUID, new Uint8Array(4), te.encode("manifest\0"), new Uint8Array(8), new Uint8Array(500).fill(7)]));
    const withUpstream = withUpstreamFixed(input, ftypEnd, upstream);
    expect(layout(withUpstream).offsets).not.toEqual(layout(input).offsets);
    const stripped = containerFor("video/mp4")!.strip(withUpstream);
    const after = layout(stripped);
    const before = layout(input);
    expect(after.top).toEqual(before.top);
    for (let i = 0; i < before.offsets.length; i++)
      expect(Buffer.from(stripped.subarray(after.offsets[i], after.offsets[i] + 32))).toEqual(Buffer.from(input.subarray(before.offsets[i], before.offsets[i] + 32)));
  }
});

/** The fixture with an extra box after ftyp and its chunk offsets moved forward to match, as a muxer would write it. */
function withUpstreamFixed(input: Uint8Array, ftypEnd: number, extra: Uint8Array): Uint8Array {
  const file = concatBytes([input.subarray(0, ftypEnd), extra, input.subarray(ftypEnd)]);
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const walk = (start: number, end: number) => {
    for (let at = start; at < end; ) {
      const size = dv.getUint32(at);
      const type = new TextDecoder().decode(file.subarray(at + 4, at + 8));
      if (["moov", "trak", "mdia", "minf", "stbl"].includes(type)) walk(at + 8, at + size);
      if (type === "stco") {
        const count = dv.getUint32(at + 12);
        for (let i = 0; i < count; i++) dv.setUint32(at + 16 + i * 4, dv.getUint32(at + 16 + i * 4) + extra.length);
      }
      at += size;
    }
  };
  walk(0, file.length);
  return file;
}

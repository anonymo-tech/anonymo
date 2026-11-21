// sampleVideoFrames with the real ffmpeg (skipped where ffmpeg is not installed; the API image installs it).
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { isPng } from "../../src/anonymo/media/png.ts";
import { sampleVideoFrames, splitPngs } from "../../src/anonymo/media/video-frames.ts";

const hasFfmpeg = Bun.which("ffmpeg") !== null && Bun.which("ffprobe") !== null;
const fixture = (name: string) => new Uint8Array(readFileSync(new URL(`../fixtures/${name}`, import.meta.url)));

test.skipIf(!hasFfmpeg)("samples the requested number of PNG frames across a clip, wherever its index sits", async () => {
  for (const name of ["av-faststart.mp4", "av-moov-last.mp4"]) {
    const frames = await sampleVideoFrames(fixture(name), 8);
    expect(frames).toHaveLength(8);
    expect(frames.every(isPng)).toBe(true);
    // The test pattern moves, so frames from different slices differ.
    expect(new Set(frames.map((f) => Buffer.from(f).toString("base64"))).size).toBeGreaterThan(1);
  }
});

test.skipIf(!hasFfmpeg)("anything that is not a readable video throws", async () => {
  await expect(sampleVideoFrames(new TextEncoder().encode("not a video"), 8)).rejects.toThrow();
  await expect(sampleVideoFrames(fixture("av-faststart.mp4"), 0)).rejects.toThrow(/out of range/);
});

test("ffmpeg's piped output splits into whole PNGs, and a cut-off frame throws", () => {
  const frames = splitPngs(new Uint8Array(Buffer.concat([readFileSync(new URL("../fixtures/av-faststart.mp4", import.meta.url)).subarray(0, 0)])));
  expect(frames).toEqual([]);
  const png = Uint8Array.from(Buffer.from("89504e470d0a1a0a0000000049454e44ae426082", "hex"));
  expect(splitPngs(new Uint8Array(Buffer.concat([png, png])))).toHaveLength(2);
  expect(() => splitPngs(png.subarray(0, png.length - 3))).toThrow(/truncated/);
});

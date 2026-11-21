// Still frames from a video, for classifiers that only check images (hosted-classifier.ts). The clip is written to a
// private temp file and decoded by ffmpeg, sampled evenly across its length, and each frame comes back as a PNG.
// ffmpeg reads only that local file (no network protocols), is killed after a deadline, and its output is capped.
// Anything unexpected throws, and the gate turns a throw into a block: a video whose frames cannot be read is never
// served. Nothing is logged; the temp folder is removed whatever happens.

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isPng } from "./png.ts";

const PNG_END = Uint8Array.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]); // "IEND" + its CRC
const MAX_FRAME_OUTPUT = 64 * 1024 * 1024;

export type FrameOptions = { signal?: AbortSignal; timeoutMs?: number; ffmpeg?: string; ffprobe?: string; maxWidth?: number };

async function run(cmd: string[], timeoutMs: number, signal?: AbortSignal): Promise<Uint8Array> {
  const proc = Bun.spawn(cmd, { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
  const kill = () => proc.kill(9);
  const timer = setTimeout(kill, timeoutMs);
  signal?.addEventListener("abort", kill, { once: true });
  try {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of proc.stdout) {
      size += chunk.byteLength;
      if (size > MAX_FRAME_OUTPUT) {
        kill();
        throw new Error("frame output too large");
      }
      chunks.push(chunk);
    }
    const code = await proc.exited;
    if (code !== 0) throw new Error(`${cmd[0].split("/").at(-1)} exited ${code}`);
    return Buffer.concat(chunks, size);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", kill);
  }
}

/** Split ffmpeg's image2pipe output into separate PNG files. */
export function splitPngs(out: Uint8Array): Uint8Array[] {
  const frames: Uint8Array[] = [];
  const buf = Buffer.from(out.buffer, out.byteOffset, out.byteLength);
  let start = 0;
  while (start < buf.length) {
    const end = buf.indexOf(PNG_END, start);
    if (end < 0) throw new Error("truncated frame");
    const frame = out.subarray(start, end + PNG_END.length);
    if (!isPng(frame)) throw new Error("frame is not a PNG");
    frames.push(frame);
    start = end + PNG_END.length;
  }
  return frames;
}

/** `count` frames spread evenly across the clip, as PNGs no wider than `maxWidth`. Throws unless all are read. */
export async function sampleVideoFrames(video: Uint8Array, count: number, o: FrameOptions = {}): Promise<Uint8Array[]> {
  if (!Number.isInteger(count) || count < 1 || count > 32) throw new Error("frame count out of range");
  const timeoutMs = o.timeoutMs ?? 15_000;
  const dir = await mkdtemp(join(tmpdir(), "anonymo-frames-"));
  const file = join(dir, "clip.mp4");
  try {
    await writeFile(file, video, { mode: 0o600 });
    const safe = ["-protocol_whitelist", "file", "-f", "mov"];
    const probe = new TextDecoder().decode(await run(
      [o.ffprobe ?? "ffprobe", "-v", "error", ...safe, "-select_streams", "v:0", "-show_entries", "stream=duration", "-of", "csv=p=0", file],
      timeoutMs, o.signal,
    )).trim();
    const duration = Number(probe);
    if (!Number.isFinite(duration) || duration <= 0 || duration > 600) throw new Error("unreadable video duration");
    // One frame from the start of each of `count` equal slices of the clip (an exact seek per frame; the start of a slice
    // always has a frame, where a midpoint can fall after the last one in a short clip).
    const width = o.maxWidth ?? 768;
    return await Promise.all(Array.from({ length: count }, async (_, i) => {
      const at = ((duration * i) / count).toFixed(3);
      const out = await run(
        [o.ffmpeg ?? "ffmpeg", "-nostdin", "-v", "error", ...safe, "-ss", at, "-i", file, "-map", "0:v:0", "-frames:v", "1",
          "-vf", `scale='min(${width},iw)':-2`, "-f", "image2pipe", "-c:v", "png", "-"],
        timeoutMs, o.signal,
      );
      const frames = splitPngs(out);
      if (frames.length !== 1) throw new Error(`expected one frame at ${at}s, got ${frames.length}`);
      return frames[0];
    }));
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

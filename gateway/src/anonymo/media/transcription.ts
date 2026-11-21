import type { Context } from "hono";
import { fail } from "../../lib/errors.ts";
import { audioMp4ForPipe } from "./containers.ts";
import { TRANSCRIPTION_FORMATS, TRANSCRIPTION_MAX_BYTES, TRANSCRIPTION_MAX_SECONDS, type TranscriptionFormat } from "./voice-models.ts";

const FORMATS = "MP3, OGG, WAV, M4A or AAC";
const MIMES: Record<string, TranscriptionFormat> = {
  "audio/mpeg": "mp3", "audio/mp3": "mp3", "audio/ogg": "ogg", "application/ogg": "ogg",
  "audio/wav": "wav", "audio/x-wav": "wav", "audio/wave": "wav",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/aac": "aac", "audio/aacp": "aac",
};

export async function readTranscription(c: Context) {
  if (!/^multipart\/form-data\s*;/i.test(c.req.header("content-type") ?? ""))
    fail(415, "Send multipart form data with an audio file.", "unsupported_media_type");
  const form = await c.req.formData().catch(() => null);
  if (!form) fail(400, "Send valid multipart form data.");
  const [file] = form.getAll("file");
  if (!(file instanceof File) || !file.size || form.getAll("file").length !== 1)
    fail(400, "Send one audio file.");
  if (file.size > TRANSCRIPTION_MAX_BYTES) fail(413, "Audio is too large.", "payload_too_large");
  const language = form.get("language");
  if (language !== null && (typeof language !== "string" || !/^[a-z]{2}$/i.test(language) || form.getAll("language").length !== 1))
    fail(400, "Use a two-letter language code.");
  if (form.getAll("model").length !== 1) fail(400, "Choose one transcription model.");
  const ext = file.name.split(".").at(-1)?.toLowerCase() ?? "";
  const format = Object.hasOwn(TRANSCRIPTION_FORMATS, ext) ? ext as TranscriptionFormat : MIMES[file.type.split(";")[0]];
  if (!format) fail(415, `Send audio as ${FORMATS}.`, "unsupported_format");
  return {
    model: form.get("model"), language: language?.toLowerCase(), format,
    file: new File([file], `clip.${format}`, { type: TRANSCRIPTION_FORMATS[format].mime }),
  };
}

const BYTES_PER_SECOND = 8_000 * 2; // mono PCM used only to count decoded samples
const MAX_PCM_BYTES = BYTES_PER_SECOND * TRANSCRIPTION_MAX_SECONDS;

export async function transcriptionMinutes(file: File, format: TranscriptionFormat, signal: AbortSignal) {
  signal.throwIfAborted();
  let input: Blob = file;
  if (format === "m4a") {
    try {
      input = new Blob([audioMp4ForPipe(new Uint8Array(await file.arrayBuffer())) as Uint8Array<ArrayBuffer>]);
    } catch {
      fail(400, "The audio could not be read.", "invalid_audio");
    }
  }
  signal.throwIfAborted();
  let proc;
  try {
    // Input and output stay on pipes. Disable other protocols and ignore all decoder diagnostics.
    const ffmpeg = Bun.which("ffmpeg");
    if (!ffmpeg) fail(503, "Audio validation is unavailable.", "audio_validation_unavailable");
    proc = Bun.spawn([ffmpeg, "-nostdin", "-loglevel", "quiet", "-xerror",
      "-protocol_whitelist", "pipe", "-f", TRANSCRIPTION_FORMATS[format].demuxer, "-threads", "1",
      "-i", "pipe:0", "-map", "0:a:0", "-vn", "-sn", "-dn", "-ac", "1", "-ar", "8000", "-f", "s16le", "pipe:1"],
    { stdin: input, stdout: "pipe", stderr: "ignore", env: {} });
  } catch {
    fail(503, "Audio validation is unavailable.", "audio_validation_unavailable");
  }
  const kill = () => proc.kill(9);
  signal.addEventListener("abort", kill, { once: true });
  let size = 0;
  try {
    signal.throwIfAborted();
    for await (const chunk of proc.stdout) {
      size += chunk.byteLength;
      if (size > MAX_PCM_BYTES) fail(400, "Audio must be 5 minutes or less.", "audio_too_long");
    }
    const code = await proc.exited;
    signal.throwIfAborted();
    if (code !== 0 || !size) fail(400, "The audio could not be read.", "invalid_audio");
  } finally {
    signal.removeEventListener("abort", kill);
    if (proc.exitCode === null) kill();
    await proc.exited;
  }
  return Math.ceil(size / (BYTES_PER_SECOND * 60));
}

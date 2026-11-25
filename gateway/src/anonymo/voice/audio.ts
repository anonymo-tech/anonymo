export const SAMPLE_RATE = 48_000;
export const FRAME_SAMPLES = SAMPLE_RATE / 50;
export const FRAME_BYTES = FRAME_SAMPLES * 2;

export function micWav(frames: readonly Uint8Array[]) {
  const data = Buffer.concat(frames);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(data.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(SAMPLE_RATE * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return new File([header, data], "clip.wav", { type: "audio/wav" });
}

export function voiced(bytes: Uint8Array) {
  const frame = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let energy = 0;
  for (let i = 0; i < bytes.length; i += 2) energy += frame.getInt16(i, true) ** 2;
  return energy / FRAME_SAMPLES >= 420 ** 2;
}

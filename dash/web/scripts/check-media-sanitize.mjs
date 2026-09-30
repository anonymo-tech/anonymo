import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test, { after, before } from 'node:test';
import sharp from 'sharp';
import {
  auditSanitizedImage,
  MediaSanitizeError,
  sanitizeMedia,
} from '../server/media/sanitize.ts';

const execute = promisify(execFile);
const ffmpeg = process.env.CONCLAVE_TEST_FFMPEG_PATH ?? 'ffmpeg';
const ffprobe = process.env.CONCLAVE_TEST_FFPROBE_PATH ?? 'ffprobe';
const runtime = { ffmpegPath: ffmpeg, ffprobePath: ffprobe };
const marker = 'SYNTHETIC_PRIVATE_MEDIA_METADATA';
let directory, video, silent, png;
const originalTmpdir = process.env.TMPDIR;
const temps = async () =>
  (await readdir(tmpdir()))
    .filter((n) => n.startsWith('conclave-media-'))
    .sort();
const code =
  (...expected) =>
  (error) => {
    assert.ok(error instanceof MediaSanitizeError);
    assert.ok(expected.includes(error.code), `Unexpected code ${error.code}`);
    assert.equal(error.cause, undefined);
    assert.ok(!JSON.stringify(error).includes(marker));
    assert.ok(!error.message.includes(directory));
    return true;
  };
const from = (bytes, contentType) => ({ bytes, contentType });
const base = () =>
  sharp({
    create: {
      width: 32,
      height: 24,
      channels: 4,
      background: { r: 180, g: 44, b: 60, alpha: 0.5 },
    },
  });
const command = (args) =>
  execute(ffmpeg, ['-hide_banner', '-v', 'error', '-nostdin', ...args], {
    timeout: 15000,
    maxBuffer: 1024 * 1024,
  });

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'conclave-sanitize-test-'));
  const workerRoot = join(directory, 'workers');
  await mkdir(workerRoot, { mode: 0o700 });
  process.env.TMPDIR = workerRoot;
  png = await base().png().toBuffer();
  for (const audio of [true, false]) {
    const path = join(directory, audio ? 'video.mp4' : 'silent.mp4');
    await command([
      '-f',
      'lavfi',
      '-i',
      'testsrc2=size=64x48:rate=24:duration=0.5',
      ...(audio
        ? [
            '-f',
            'lavfi',
            '-i',
            'sine=frequency=440:sample_rate=48000:duration=0.5',
          ]
        : []),
      '-map',
      '0:v:0',
      ...(audio ? ['-map', '1:a:0'] : []),
      '-c:v',
      'libx264',
      '-threads',
      '1',
      '-pix_fmt',
      'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-b:a', '96k'] : []),
      '-metadata',
      `title=${marker}`,
      '-metadata',
      `comment=${marker}`,
      '-metadata',
      'creation_time=2020-01-02T00:00:00Z',
      '-metadata:s:v',
      `handler_name=${marker}`,
      '-movflags',
      '+faststart',
      '-y',
      path,
    ]);
    if (audio) video = await readFile(path);
    else silent = await readFile(path);
  }
});
after(async () => {
  if (originalTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = originalTmpdir;
  if (directory) await rm(directory, { recursive: true, force: true });
});

for (const format of ['png', 'jpeg', 'webp'])
  void test(`${format}: decode, rebuild and independently audit metadata-free output`, async () => {
    const input = await base()
      .withExif({ IFD0: { Artist: marker, ImageDescription: marker } })
      [format]()
      .toBuffer();
    assert.ok(input.includes(Buffer.from(marker)));
    const result = await sanitizeMedia(from(input, `image/${format}`));
    assert.deepEqual(Object.keys(result).sort(), [
      'bytes',
      'contentType',
      'durationMs',
      'hasAudio',
      'height',
      'sanitizerVersion',
      'width',
    ]);
    assert.equal(result.width, 32);
    assert.equal(result.height, 24);
    assert.equal(result.hasAudio, false);
    assert.equal(result.durationMs, null);
    assert.equal(result.sanitizerVersion, 'media-canonical-v1');
    assert.ok(!Buffer.from(result.bytes).includes(Buffer.from(marker)));
    auditSanitizedImage(result.bytes, result.contentType);
    const meta = await sharp(result.bytes).metadata();
    for (const field of ['exif', 'xmp', 'icc', 'iptc', 'orientation'])
      assert.equal(meta[field], undefined);
    const raw = await sharp(result.bytes)
      .raw()
      .toBuffer({ resolveWithObject: true });
    if (format !== 'jpeg') {
      assert.equal(raw.info.channels, 4);
      assert.ok(raw.data[3] > 120 && raw.data[3] < 135);
    }
  });

void test('EXIF orientation is applied to pixels before its removal', async () => {
  const input = await sharp({
    create: { width: 12, height: 20, channels: 3, background: 'red' },
  })
    .withMetadata({ orientation: 6 })
    .jpeg()
    .toBuffer();
  const result = await sanitizeMedia(from(input, 'image/jpeg'));
  assert.equal(result.width, 20);
  assert.equal(result.height, 12);
  assert.equal((await sharp(result.bytes).metadata()).orientation, undefined);
});

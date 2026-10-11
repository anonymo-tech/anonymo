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

void test('animated, mismatched, unknown and truncated images fail closed', async () => {
  const chunk = Buffer.alloc(20);
  chunk.writeUInt32BE(8);
  chunk.write('acTL', 4);
  const animated = Buffer.concat([
    png.subarray(0, 33),
    chunk,
    png.subarray(33),
  ]);
  await assert.rejects(
    sanitizeMedia(from(animated, 'image/png')),
    code('unsupported'),
  );
  await assert.rejects(
    sanitizeMedia(from(png, 'image/jpeg')),
    code('unsupported'),
  );
  await assert.rejects(
    sanitizeMedia(from(Buffer.from('<svg/>'), 'image/png')),
    code('unsupported'),
  );
  await assert.rejects(
    sanitizeMedia(from(png.subarray(0, png.length - 4), 'image/png')),
    code('invalid'),
  );
  const webp = await base()
    .withExif({ IFD0: { Artist: marker } })
    .webp()
    .toBuffer();
  assert.equal(webp.toString('ascii', 12, 16), 'VP8X');
  webp[20] |= 2;
  await assert.rejects(
    sanitizeMedia(from(webp, 'image/webp')),
    code('unsupported'),
  );
});

void test('byte and decoded-pixel limits reject oversized data and decoder bombs', async () => {
  await assert.rejects(
    sanitizeMedia(from(new Uint8Array(20 * 1024 * 1024 + 1), 'image/png')),
    code('too_large'),
  );
  // A genuine highly compressed image exceeding the allowed side is small on disk.
  const wide = await sharp({
    create: { width: 8193, height: 1, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  await assert.rejects(
    sanitizeMedia(from(wide, 'image/png')),
    code('unsupported'),
  );
  const bomb = await sharp({
    create: { width: 4097, height: 4097, channels: 3, background: 'white' },
  })
    .png()
    .toBuffer();
  assert.ok(bomb.length < 100000);
  await assert.rejects(
    sanitizeMedia(from(bomb, 'image/png')),
    code('invalid', 'unsupported', 'too_large'),
  );
});

void test('native image timeout and pre-abort clean temporary plaintext files', async () => {
  const before = await temps();
  await assert.rejects(
    sanitizeMedia(from(png, 'image/png'), { timeoutMs: 1 }),
    code('timeout'),
  );
  assert.deepEqual(await temps(), before);
  await assert.rejects(
    sanitizeMedia(from(png, 'image/png'), { signal: AbortSignal.abort() }),
    code('cancelled'),
  );
  assert.deepEqual(await temps(), before);
});

void test('MP4 re-encodes video and audio while removing private metadata and encoder annotations', async () => {
  assert.ok(video.includes(Buffer.from(marker)));
  const original = Buffer.from(video);
  const result = await sanitizeMedia(from(video, 'video/mp4'), runtime);
  assert.equal(result.width, 64);
  assert.equal(result.height, 48);
  assert.equal(result.hasAudio, true);
  assert.ok(result.durationMs >= 490 && result.durationMs <= 750);
  assert.deepEqual(video, original);
  assert.ok(!Buffer.from(result.bytes).includes(Buffer.from(marker)));
  for (const value of ['Lavf', 'Lavc', 'x264 - core', '2020-01-02'])
    assert.ok(!Buffer.from(result.bytes).includes(Buffer.from(value)), value);
  const path = join(directory, 'canonical.mp4');
  await writeFile(path, result.bytes);
  const inspect = JSON.parse(
    (
      await execute(ffprobe, [
        '-v',
        'error',
        '-show_streams',
        '-show_format',
        '-of',
        'json',
        path,
      ])
    ).stdout,
  );
  assert.equal(
    inspect.streams.filter((s) => s.codec_type === 'audio').length,
    1,
  );
  for (const record of [inspect.format, ...inspect.streams])
    for (const field of [
      'title',
      'comment',
      'artist',
      'encoder',
      'creation_time',
      'handler_name',
    ])
      assert.equal(record.tags?.[field], undefined);
  // Re-encoding is deliberately lossy; both streams keep all twelve frames.
  // Binary subprocess output is requested separately for a real pixel comparison.
  const raw = async (input) =>
    (
      await execute(
        ffmpeg,
        [
          '-hide_banner',
          '-v',
          'error',
          '-i',
          input,
          '-map',
          '0:v:0',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgb24',
          '-',
        ],
        { encoding: 'buffer', maxBuffer: 1024 * 1024 },
      )
    ).stdout;
  const inputPixels = await raw(join(directory, 'video.mp4')),
    outputPixels = await raw(path);
  assert.equal(inputPixels.length, 64 * 48 * 3 * 12);
  assert.equal(outputPixels.length, inputPixels.length);
  const difference =
    inputPixels.reduce(
      (sum, value, index) => sum + Math.abs(value - outputPixels[index]),
      0,
    ) / inputPixels.length;
  assert.ok(difference < 6, `Synthetic mean pixel difference ${difference}`);
});

void test('silent MP4 does not gain an audio stream', async () => {
  const result = await sanitizeMedia(from(silent, 'video/mp4'), runtime);
  assert.equal(result.hasAudio, false);
  assert.equal(result.width, 64);
});

const videoPackets = async () =>
  JSON.parse(
    (
      await execute(ffprobe, [
        '-v',
        'error',
        '-show_packets',
        '-show_entries',
        'packet=pos,size',
        '-of',
        'json',
        join(directory, 'silent.mp4'),
      ])
    ).stdout,
  ).packets;

void test('opaque payloads in H264 delimiter and end NAL units never survive canonicalization', async () => {
  const packets = await videoPackets();
  for (const type of [9, 10, 11]) {
    const input = Buffer.from(silent);
    let changed = false;
    for (const packet of packets)
      for (
        let at = Number(packet.pos);
        at < Number(packet.pos) + Number(packet.size);
      ) {
        const size = input.readUInt32BE(at);
        at += 4;
        if ((input[at] & 31) === 6 && size > marker.length + 3) {
          input.fill(0, at, at + size);
          input[at] = type;
          input[at + 1] = 0xf0;
          Buffer.from(marker).copy(input, at + 2);
          input[at + size - 1] = 0x80;
          changed = true;
        }
        at += size;
      }
    assert.ok(changed);
    const result = await sanitizeMedia(from(input, 'video/mp4'), runtime);
    assert.ok(
      !Buffer.from(result.bytes).includes(Buffer.from(marker)),
      `NAL type ${type}`,
    );
  }
});

void test('ignored bytes after a decoded H264 slice never survive canonicalization', async () => {
  const packets = await videoPackets(),
    packet = packets.at(-1);
  const end = Number(packet.pos) + Number(packet.size);
  let mdat = 0;
  for (let at = 0; at < silent.length; at += silent.readUInt32BE(at))
    if (silent.toString('ascii', at + 4, at + 8) === 'mdat') mdat = at;
  assert.equal(mdat + silent.readUInt32BE(mdat), end);
  let lastNAL = Number(packet.pos);
  for (let at = lastNAL; at < end;) {
    lastNAL = at;
    at += 4 + silent.readUInt32BE(at);
  }
  assert.ok([1, 5].includes(silent[lastNAL + 4] & 31));
  const input = Buffer.concat([
    silent.subarray(0, end),
    Buffer.from(marker),
    silent.subarray(end),
  ]);
  input.writeUInt32BE(silent.readUInt32BE(mdat) + marker.length, mdat);
  input.writeUInt32BE(silent.readUInt32BE(lastNAL) + marker.length, lastNAL);
  const stsz = input.indexOf(Buffer.from('stsz')),
    count = input.readUInt32BE(stsz + 12);
  input.writeUInt32BE(
    Number(packet.size) + marker.length,
    stsz + 16 + (count - 1) * 4,
  );
  const result = await sanitizeMedia(from(input, 'video/mp4'), runtime);
  assert.ok(!Buffer.from(result.bytes).includes(Buffer.from(marker)));
});

void test('external data references fail before launching any decoder', async () => {
  const external = Buffer.from(silent);
  const at = external.indexOf(Buffer.from('url '));
  assert.ok(at > 0);
  external.writeUInt32BE(0, at + 4);
  await assert.rejects(
    sanitizeMedia(from(external, 'video/mp4'), {
      ffprobePath: join(directory, 'does-not-exist'),
    }),
    code('unsupported'),
  );
});

void test('unsupported extra streams and excessive duration are rejected', async () => {
  const subtitles = join(directory, 'subtitle.srt'),
    subtitled = join(directory, 'subtitled.mp4');
  await writeFile(
    subtitles,
    '1\n00:00:00,000 --> 00:00:00,400\nSynthetic subtitle\n',
  );
  await command([
    '-i',
    join(directory, 'silent.mp4'),
    '-i',
    subtitles,
    '-map',
    '0:v:0',
    '-map',
    '1:0',
    '-c:v',
    'copy',
    '-c:s',
    'mov_text',
    '-y',
    subtitled,
  ]);
  await assert.rejects(
    sanitizeMedia(from(await readFile(subtitled), 'video/mp4'), runtime),
    code('unsupported'),
  );
  const long = join(directory, 'long.mp4');
  await command([
    '-f',
    'lavfi',
    '-i',
    'color=size=16x16:rate=1:duration=31',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-pix_fmt',
    'yuv420p',
    '-y',
    long,
  ]);
  await assert.rejects(
    sanitizeMedia(from(await readFile(long), 'video/mp4'), runtime),
    code('too_large'),
  );
});

void test('malformed compressed video packets cannot pass a container-only check', async () => {
  const bad = Buffer.from(silent),
    at = bad.indexOf(Buffer.from('mdat'));
  assert.ok(at > 0);
  bad.fill(0, at + 4);
  await assert.rejects(
    sanitizeMedia(from(bad, 'video/mp4'), runtime),
    code('invalid', 'unsupported'),
  );
});

void test('native timeout, cancellation and stderr errors are bounded, private and clean up', async () => {
  const blocked = join(directory, 'blocked'),
    pid = join(directory, 'pid');
  await writeFile(
    blocked,
    `#!${process.execPath}\nimport('node:fs').then(fs=>{fs.writeFileSync(${JSON.stringify(pid)},String(process.pid));setInterval(()=>{},1000)});\n`,
    { mode: 0o700 },
  );
  await chmod(blocked, 0o700);
  const before = await temps();
  await assert.rejects(
    sanitizeMedia(from(silent, 'video/mp4'), {
      ...runtime,
      ffprobePath: blocked,
      timeoutMs: 500,
    }),
    code('timeout'),
  );
  const child = Number(await readFile(pid, 'utf8'));
  assert.throws(() => process.kill(child, 0), { code: 'ESRCH' });
  assert.deepEqual(await temps(), before);
  const controller = new AbortController();
  const promise = sanitizeMedia(from(silent, 'video/mp4'), {
    ...runtime,
    ffprobePath: blocked,
    signal: controller.signal,
  });
  const timer = setTimeout(() => controller.abort(), 200);
  try {
    await assert.rejects(promise, code('cancelled'));
  } finally {
    clearTimeout(timer);
  }
  assert.deepEqual(await temps(), before);
  const noisy = join(directory, 'noisy');
  await writeFile(
    noisy,
    `#!${process.execPath}\nprocess.stderr.write(${JSON.stringify(marker)});process.exit(2);\n`,
    { mode: 0o700 },
  );
  await assert.rejects(
    sanitizeMedia(from(silent, 'video/mp4'), {
      ...runtime,
      ffprobePath: noisy,
    }),
    code('invalid'),
  );
  assert.deepEqual(await temps(), before);
  await assert.rejects(
    sanitizeMedia(from(silent, 'video/mp4'), {
      ffprobePath: join(directory, 'missing'),
    }),
    code('unavailable'),
  );
});

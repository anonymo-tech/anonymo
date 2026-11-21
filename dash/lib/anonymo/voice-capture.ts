import { pcmWav, type TranscriptionModel } from './talk.ts';
import type { Capture } from './voice-recorder.ts';

type Options = {
  signal: AbortSignal;
  model: TranscriptionModel;
  onLimit: () => void;
  onLevel: (level: number, seconds: number) => void;
};

const FORMATS = [
  ['audio/ogg;codecs=opus', 'ogg'], ['audio/mp4;codecs=mp4a.40.2', 'm4a'],
  ['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm'],
] as const;
const MAX_FORM_OVERHEAD = 1024;

async function webmToWav(blob: Blob, maxBytes: number) {
  const rate = 16_000;
  const context = new OfflineAudioContext(1, 1, rate);
  const audio = await context.decodeAudioData(await blob.arrayBuffer());
  // Keep short clips at 16 kHz. Fit longer recordings in the upload budget by averaging adjacent samples.
  const count = Math.min(audio.length, Math.floor((maxBytes - 44) / 2));
  const step = audio.length / count;
  const samples = new Float32Array(count);
  for (let ch = 0; ch < audio.numberOfChannels; ch++) {
    const channel = audio.getChannelData(ch);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * step);
      const end = Math.floor((i + 1) * step);
      let sum = 0;
      for (let j = start; j < end; j++) sum += channel[j];
      samples[i] += sum / ((end - start) * audio.numberOfChannels);
    }
  }
  return pcmWav(samples, Math.round(rate / step));
}

export function microphoneError(error: unknown) {
  const name = error instanceof Error ? error.name : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'Microphone permission denied.';
  if (name === 'NotFoundError') return 'No microphone found.';
  if (name === 'NotReadableError') return 'The microphone is unavailable or in use.';
  return error instanceof Error && error.name === 'VoiceCaptureError' ? error.message : 'Could not record audio.';
}

function captureError(message: string) {
  const error = new Error(message);
  error.name = 'VoiceCaptureError';
  return error;
}

export async function captureVoice({ signal, model, onLimit, onLevel }: Options): Promise<Capture> {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined')
    throw captureError('Microphone recording is unavailable in this browser.');
  const format = FORMATS.find(([type]) => MediaRecorder.isTypeSupported(type));
  if (!format) throw captureError('This browser has no supported recording format.');

  signal.throwIfAborted();
  const context = new AudioContext();
  void context.resume().catch(() => {});
  let stream: MediaStream | undefined;
  let recorder: MediaRecorder | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  function cleanup() {
    clearInterval(timer);
    clearTimeout(deadline);
    stream?.getTracks().forEach((track) => track.stop());
    if (context.state !== 'closed') void context.close().catch(() => {});
  }
  signal.addEventListener('abort', cleanup, { once: true });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 } });
    signal.throwIfAborted();
    const [mimeType, extension] = format;
    const recording = recorder = new MediaRecorder(stream, { mimeType, audioBitsPerSecond: 64_000 });
    const analyser = context.createAnalyser();
    analyser.fftSize = 512;
    context.createMediaStreamSource(stream).connect(analyser);
    const wave = new Uint8Array(analyser.fftSize);
    const chunks: Blob[] = [];
    let size = 0;
    const maxBytes = model.max_request_bytes - MAX_FORM_OVERHEAD;
    let error: Error | undefined;
    let finished: () => void;
    const stopped = new Promise<void>((resolve) => { finished = resolve; });
    recording.ondataavailable = ({ data }) => {
      if (signal.aborted || !data.size) return;
      size += data.size;
      chunks.push(data);
      if (size >= maxBytes - 128 * 1024) onLimit();
    };
    recording.onerror = () => { error = captureError('Recording stopped unexpectedly.'); onLimit(); };
    recording.onstop = () => {
      cleanup();
      finished();
      onLimit();
    };
    recording.start(250);
    signal.removeEventListener('abort', cleanup);
    signal.addEventListener('abort', () => {
      chunks.length = 0;
      if (recording.state !== 'inactive') recording.stop();
      cleanup();
    }, { once: true });

    const started = performance.now();
    onLevel(0, 0);
    timer = setInterval(() => {
      analyser.getByteTimeDomainData(wave);
      const rms = Math.sqrt(wave.reduce((sum, byte) => sum + ((byte - 128) / 128) ** 2, 0) / wave.length);
      onLevel(Math.min(1, rms * 5), (performance.now() - started) / 1000);
    }, 80);
    deadline = setTimeout(onLimit, model.max_seconds * 1000 - 500);

    return {
      async stop() {
        if (recording.state !== 'inactive') recording.stop();
        cleanup();
        await stopped;
        signal.throwIfAborted();
        if (error) throw error;
        if (size === 0) throw captureError('Hold the microphone button while you speak.');
        if (size > maxBytes) throw captureError('Recording is too large. Try a shorter clip.');
        const raw = new Blob(chunks, { type: recording.mimeType });
        const audio = extension === 'webm' ? await webmToWav(raw, maxBytes) : raw;
        const ext = extension === 'webm' ? 'wav' : extension;
        signal.throwIfAborted();
        return new File([audio], `clip.${ext}`, { type: audio.type });
      },
    };
  } catch (error) {
    signal.removeEventListener('abort', cleanup);
    if (recorder && recorder.state !== 'inactive') recorder.stop();
    cleanup();
    throw error;
  }
}

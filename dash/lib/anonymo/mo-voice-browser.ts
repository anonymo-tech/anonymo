import { voiceSocketUrl, type VoiceEvent, type VoiceTicket } from './mo-voice.ts';

export class CallPlayback {
  private queue = Promise.resolve();
  private generation = 0;
  private current: AudioBufferSourceNode | null = null;

  private readonly context: AudioContext;
  private readonly speaking: (value: boolean) => void;

  constructor(context: AudioContext, speaking: (value: boolean) => void) {
    this.context = context;
    this.speaking = speaking;
  }

  append(wav: ArrayBuffer) {
    const generation = this.generation;
    this.queue = this.queue.then(async () => {
      if (this.generation !== generation) return;
      const output = await this.context.decodeAudioData(wav);
      if (this.generation !== generation) return;
      const source = this.context.createBufferSource();
      this.current = source;
      source.buffer = output;
      source.connect(this.context.destination);
      this.speaking(true);
      await new Promise<void>((resolve) => {
        source.onended = () => {
          source.disconnect();
          if (this.current === source) {
            this.current = null;
            this.speaking(false);
          }
          resolve();
        };
        source.start();
      });
    }).catch(() => undefined);
  }

  stop() {
    this.generation++;
    this.current?.stop();
    this.current = null;
    this.queue = Promise.resolve();
    this.speaking(false);
  }
}

export type CallConnection = {
  mute(value: boolean): void;
  hangup(): void;
  close(): void;
  typeLine?(text: string): void;
};

export async function connectCall(o: {
  base: string; ticket: () => Promise<VoiceTicket>; voice: string; character?: string; audio: AudioContext; signal: AbortSignal;
  event: (event: VoiceEvent) => void; audioOut: (audio: ArrayBuffer) => void; closed: () => void;
}): Promise<CallConnection> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: false },
  });
  let socket: WebSocket | undefined;
  let capture: AudioWorkletNode | undefined;
  let source: MediaStreamAudioSourceNode | undefined;
  let keepalive: ReturnType<typeof setInterval> | undefined;
  let ready = false;
  let muted = false;
  let ending = false;
  let disposed = false;
  const stopMic = () => {
    capture?.disconnect();
    capture?.port.close();
    source?.disconnect();
    for (const track of stream.getTracks()) track.stop();
  };
  const close = () => {
    if (disposed) return;
    disposed = true;
    clearInterval(keepalive);
    stopMic();
    socket?.close();
    o.signal.removeEventListener('abort', close);
  };
  try {
    o.signal.throwIfAborted();
    await o.audio.audioWorklet.addModule('/movoice-capture.js');
    const ticket = await o.ticket();
    if (ticket.sample_rate !== o.audio.sampleRate || ticket.frame_bytes !== 1920) throw new Error('This microphone format is unavailable.');
    o.signal.throwIfAborted();
    capture = new AudioWorkletNode(o.audio, 'movoice-capture', { channelCount: 1, outputChannelCount: [1] });
    source = o.audio.createMediaStreamSource(stream);
    const ws = new WebSocket(voiceSocketUrl(o.base, ticket.path), [ticket.protocol, ticket.ticket]);
    socket = ws;
    socket.binaryType = 'arraybuffer';
    const send = (event: object) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(event)); };
    ws.onopen = () => {
      send({ type: 'start', voice: o.voice, ...(o.character ? { character: o.character } : {}) });
      keepalive = setInterval(() => send({ type: 'ping' }), 10_000);
    };
    ws.onmessage = ({ data }) => {
      if (disposed) return;
      if (data instanceof ArrayBuffer) {
        if (!ending) o.audioOut(data);
        return;
      }
      const event = JSON.parse(data) as VoiceEvent;
      if (event.type === 'ready') ready = true;
      if (!ending || event.type === 'receipt') o.event(event);
    };
    ws.onclose = () => {
      if (disposed) return;
      close();
      o.closed();
    };
    for (const track of stream.getTracks()) track.onended = () => {
      if (disposed || ending) return;
      close();
      o.closed();
    };
    capture.port.onmessage = ({ data }) => {
      if (!ready || muted || ending || ws.readyState !== WebSocket.OPEN) return;
      if (ws.bufferedAmount > 96_000) {
        close();
        o.closed();
      } else {
        ws.send(data);
      }
    };
    source.connect(capture);
    capture.connect(o.audio.destination);
    o.signal.addEventListener('abort', close, { once: true });
    return {
      mute(value) {
        muted = value;
        for (const track of stream.getAudioTracks()) track.enabled = !value;
        send({ type: 'mute', value });
      },
      hangup() { ending = true; stopMic(); send({ type: 'hangup' }); },
      close,
    };
  } catch (error) {
    close();
    throw error;
  }
}

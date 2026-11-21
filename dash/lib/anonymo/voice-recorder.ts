export type Capture = { stop: () => Promise<File> };
export type RecorderState = 'idle' | 'requesting' | 'recording' | 'transcribing';

type RecorderOptions = {
  capture: (signal: AbortSignal, onLimit: () => void) => Promise<Capture>;
  transcribe: (file: File, signal: AbortSignal) => Promise<string>;
  onState: (state: RecorderState) => void;
  onText: (text: string) => void;
  onError: (error: unknown, duringCapture: boolean) => void;
};

/** One held gesture owns permission, the microphone and its eventual transcription. */
export function createVoiceRecorder(options: RecorderOptions) {
  type Session = { abort: AbortController; capture?: Capture; released: boolean };
  let active: Session | null = null;

  function clear() {
    const session = active;
    active = null;
    session?.abort.abort();
  }

  function cancel() {
    if (!active) return false;
    clear();
    options.onState('idle');
    return true;
  }

  async function press() {
    if (active) return;
    const session: Session = { abort: new AbortController(), released: false };
    active = session;
    options.onState('requesting');
    try {
      const capture = await options.capture(session.abort.signal, () => { void release(); });
      if (active !== session) return;
      session.capture = capture;
      options.onState('recording');
    } catch (error) {
      if (active !== session) return;
      cancel();
      options.onError(error, true);
    }
  }

  async function release() {
    const session = active;
    if (!session || session.released) return;
    if (!session.capture) { cancel(); return; }
    session.released = true;
    options.onState('transcribing');
    let duringCapture = true;
    try {
      const file = await session.capture.stop();
      if (active !== session) return;
      duringCapture = false;
      const text = await options.transcribe(file, session.abort.signal);
      if (active === session) options.onText(text);
    } catch (error) {
      if (active === session) options.onError(error, duringCapture);
    } finally {
      if (active === session) cancel();
    }
  }

  return { press, release, cancel, dispose: clear };
}

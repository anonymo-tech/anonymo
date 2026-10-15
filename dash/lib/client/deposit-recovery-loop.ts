/** Bounded read-only finality checks. The caller supplies recovery, never signing
 * or submission. A page lifetime owns the signal and cancels its pending work. */
export function startDepositRecoveryPolling(options: {
  signal: AbortSignal;
  check: () => Promise<'retry' | 'credited' | 'stop'>;
  onExhausted: () => void;
  now?: () => number;
  schedule?: (run: () => void, delay: number) => () => void;
}) {
  const now = options.now ?? Date.now;
  const schedule =
    options.schedule ??
    ((run, delay) => {
      const timer = setTimeout(run, delay);
      return () => clearTimeout(timer);
    });
  const deadline = now() + 120_000;
  let stopped = false;
  let attempts = 0;
  let cancelTimer: (() => void) | undefined;
  const stop = () => {
    stopped = true;
    cancelTimer?.();
    options.signal.removeEventListener('abort', stop);
  };
  const exhausted = () => {
    stop();
    if (!options.signal.aborted) options.onExhausted();
  };
  async function tick() {
    cancelTimer = undefined;
    if (stopped || options.signal.aborted) return;
    if (now() > deadline || attempts >= 8) return exhausted();
    attempts++;
    let result: 'retry' | 'credited' | 'stop';
    try {
      result = await options.check();
    } catch {
      stop();
      return;
    }
    if (stopped || options.signal.aborted) return;
    if (result !== 'retry') return stop();
    if (attempts >= 8 || now() >= deadline) return exhausted();
    cancelTimer = schedule(
      () => {
        void tick();
      },
      Math.min(15_000, deadline - now()),
    );
  }
  if (!options.signal.aborted) {
    options.signal.addEventListener('abort', stop, { once: true });
    cancelTimer = schedule(() => {
      void tick();
    }, 15_000);
  }
  return stop;
}

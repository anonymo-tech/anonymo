/** Stops claiming at the next boundary; already-dispatched calls finish normally. */
export async function runWorkerLoop({
  runNextCall,
  recover,
  signal,
  concurrency = 4,
  once = false,
  log = () => {},
  sleep = interruptibleSleep,
  maxFailures = 5,
}) {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 4)
    throw new Error('WORKER_CONFIGURATION_INVALID');
  let failures = 0;
  while (!signal.aborted) {
    let ran = false;
    try {
      await recover();
      if (signal.aborted) break;
      const results = await Promise.allSettled(
        Array.from({ length: concurrency }, () =>
          signal.aborted ? false : runNextCall(),
        ),
      );
      ran = results.some(
        (result) => result.status === 'fulfilled' && result.value,
      );
      if (results.some((result) => result.status === 'rejected'))
        throw new Error('WORKER_BATCH_FAILED');
      failures = 0;
    } catch {
      failures++;
      log('WORKER_CYCLE_FAILED');
      if (once || failures >= maxFailures) throw new Error('WORKER_FAILED');
    }
    if (once || signal.aborted) break;
    if (!ran)
      await sleep(Math.min(30000, 1000 * 2 ** Math.min(failures, 5)), signal);
  }
}

export function interruptibleSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

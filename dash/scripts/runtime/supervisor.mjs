import { spawn } from 'node:child_process';

/** One container lifecycle: either child failing brings the whole unit down. */
export async function supervise({
  web,
  worker,
  graceMs = 630000,
  startupMs = 30000,
  pulseMs = 45000,
  signals = process,
  log = () => {},
  spawnProcess = spawn,
}) {
  return new Promise((resolve) => {
    const children = new Map();
    let closing = false,
      finished = false,
      exitCode = 0,
      webStarted = false;
    let deadline, startup, watchdog;
    let lastPulse = Date.now();

    const finish = () => {
      if (
        !closing ||
        finished ||
        [...children.values()].some((item) => !item.exited)
      )
        return;
      finished = true;
      clearTimeout(deadline);
      clearTimeout(startup);
      clearInterval(watchdog);
      signals.off('SIGTERM', onSignal);
      signals.off('SIGINT', onSignal);
      resolve(exitCode);
    };
    const kill = (item, signal) => {
      if (item.exited || !item.child.pid) return;
      try {
        process.kill(-item.child.pid, signal);
      } catch {
        try {
          item.child.kill(signal);
        } catch {}
      }
    };
    const stop = (code) => {
      if (closing) {
        if (code) exitCode = code;
        return;
      }
      closing = true;
      exitCode = code;
      clearTimeout(startup);
      clearInterval(watchdog);
      log(code ? 'RUNTIME_FAILED' : 'RUNTIME_STOPPING');
      for (const item of children.values()) kill(item, 'SIGTERM');
      deadline = setTimeout(() => {
        exitCode = 1;
        log('RUNTIME_DRAIN_TIMEOUT');
        for (const item of children.values()) kill(item, 'SIGKILL');
      }, graceMs);
      finish();
    };
    const onSignal = () => stop(0);
    signals.once('SIGTERM', onSignal);
    signals.once('SIGINT', onSignal);

    const start = (name, command) => {
      let child;
      try {
        child = spawnProcess(command.file, command.args, {
          cwd: command.cwd,
          env: command.env,
          detached: true,
          stdio:
            name === 'worker'
              ? ['ignore', 'inherit', 'inherit', 'ipc']
              : ['ignore', 'inherit', 'inherit'],
        });
      } catch {
        stop(1);
        return;
      }
      const item = { child, exited: false };
      children.set(name, item);
      child.once('error', () => {
        item.exited = true;
        stop(1);
        finish();
      });
      child.once('exit', (code, signal) => {
        item.exited = true;
        if (!closing) stop(1);
        else if (code !== 0 && signal !== 'SIGTERM' && signal !== 'SIGINT')
          exitCode = 1;
        finish();
      });
      if (name === 'worker') {
        child.on('message', (message) => {
          if (closing || !message || typeof message !== 'object') return;
          if (message.type === 'worker-ready' && !webStarted) {
            clearTimeout(startup);
            webStarted = true;
            lastPulse = Date.now();
            start('web', web);
            log('RUNTIME_WORKER_READY');
            if (!closing)
              watchdog = setInterval(
                () => {
                  if (Date.now() - lastPulse > pulseMs) stop(1);
                },
                Math.min(10000, pulseMs),
              );
          } else if (message.type === 'worker-pulse') lastPulse = Date.now();
        });
      }
    };
    if (worker) {
      startup = setTimeout(() => stop(1), startupMs);
      start('worker', worker);
    } else {
      webStarted = true;
      start('web', web);
    }
  });
}

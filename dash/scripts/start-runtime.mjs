import { prepareEnvironment } from './runtime/environment.mjs';
import { supervise } from './runtime/supervisor.mjs';

const log = (event) =>
  process.stderr.write(
    JSON.stringify({ event, at: new Date().toISOString() }) + '\n',
  );
let environment;
try {
  environment = await prepareEnvironment(process.env);
  const web = {
    file: process.execPath,
    args: ['node_modules/vinext/dist/cli.js', 'start'],
    env: environment.web,
  };
  const worker = environment.enabled
    ? {
        file: process.execPath,
        args: ['--experimental-strip-types', 'scripts/run-released-worker.mjs'],
        env: environment.worker,
      }
    : undefined;
  // A cold catalog refresh registers every reviewed model before serving chat.
  // Keep this below the 180s deployment health check, with time for API startup.
  process.exitCode = await supervise({ web, worker, log, startupMs: 120000 });
} catch {
  log('RUNTIME_CONFIGURATION_INVALID');
  process.exitCode = 1;
} finally {
  await environment?.cleanup();
}

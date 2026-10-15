import { createDatabase } from '../server/db/database.ts';
import { configuredKeyring } from '../server/core/encryption.ts';
import {
  telegramConfig,
  telegramCapability,
  processNextTelegramUpdate,
  deliverNextTelegramMessage,
} from '../server/second-look/telegram.ts';
import { createTelegramServices } from '../server/second-look/telegram-services.ts';

const args = new Set(process.argv.slice(2));
if (
  [...args].some((arg) => !['--once', '--deliver'].includes(arg)) ||
  (args.has('--deliver') && !args.has('--once'))
) {
  process.stderr.write(
    'Use no arguments for readiness, or --once with optional --deliver.\n',
  );
  process.exitCode = 1;
} else if (!args.has('--once')) {
  process.stdout.write(JSON.stringify(telegramCapability()) + '\n');
} else {
  let pool;
  try {
    const config = telegramConfig();
    if (!config.enabled || !process.env.CONCLAVE_DATABASE_URL)
      throw new Error('unavailable');
    const keyring = configuredKeyring();
    pool = createDatabase(process.env.CONCLAVE_DATABASE_URL, 2);
    const processed = await processNextTelegramUpdate(
      pool,
      config,
      keyring,
      createTelegramServices({ pool }),
    );
    const delivery = args.has('--deliver')
      ? await deliverNextTelegramMessage(pool, config, keyring)
      : { state: 'not-requested' };
    process.stdout.write(
      JSON.stringify({
        processed: processed.processed,
        delivery: delivery.state,
      }) + '\n',
    );
  } catch {
    process.stderr.write(
      'Telegram work is unavailable or failed. No credentials or provider diagnostics are logged.\n',
    );
    process.exitCode = 1;
  } finally {
    if (pool) await pool.end();
  }
}

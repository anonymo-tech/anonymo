import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createDatabase } from '../server/db/database.ts';
import { migrate } from './migrate.mjs';
import { decryptText } from '../server/core/encryption.ts';
import { generateSessionToken, hashToken } from '../server/auth/primitives.ts';
import {
  telegramConfig,
  telegramCapability,
  verifyTelegramSecret,
  parseTelegramUpdate,
  escapeTelegram,
  telegramCardText,
  acceptTelegramUpdate,
  telegramWebhook,
  createTelegramLink,
  confirmTelegramLink,
  processNextTelegramUpdate,
  deliverNextTelegramMessage,
} from '../server/second-look/telegram.ts';
import { createTelegramServices } from '../server/second-look/telegram-services.ts';
import { createTokenProviders } from '../server/second-look/providers.ts';
import { TOKEN_PROGRAM, SOLANA_NETWORKS } from '../server/solana/validation.ts';
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
if (!connection)
  throw new Error('An isolated CONCLAVE_TEST_DATABASE_URL is required.');
const url = new URL(connection);
if (
  !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
  !url.pathname.endsWith('_test')
)
  throw new Error('Only loopback test databases are supported.');
const pool = createDatabase(connection, 6),
  keyring = {
    active: 'fixture',
    keys: { fixture: randomBytes(32).toString('base64') },
  };
const token =
    String(randomBytes(4).readUInt32BE() + 100000) +
    ':' +
    randomBytes(32).toString('base64url'),
  secret = randomBytes(32).toString('base64url');
const env = {
  CONCLAVE_TELEGRAM_ENABLED: 'true',
  CONCLAVE_TELEGRAM_DELIVERY_ENABLED: 'true',
  CONCLAVE_TELEGRAM_BOT_TOKEN: token,
  CONCLAVE_TELEGRAM_WEBHOOK_SECRET: secret,
  CONCLAVE_TELEGRAM_BOT_USERNAME: 'conclave_fixture_bot',
};
const config = telegramConfig(env);
before(() => migrate(pool));
after(() => pool.end());
let nextId = 1,
  nextUser = randomBytes(4).readUInt32BE() + 100000;
const message = (text, user = nextUser++, extra = {}) => ({
  update_id: nextId++,
  message: {
    message_id: nextId,
    chat: { id: user, type: 'private' },
    from: { id: user, is_bot: false, username: 'not_an_identity' },
    text,
    ...extra,
  },
});
const inline = (query, user = nextUser++) => ({
  update_id: nextId++,
  inline_query: {
    id: String(nextId),
    from: { id: user, is_bot: false },
    query,
    offset: '',
  },
});
const card = {
  title: 'Token facts',
  mint: '11111111111111111111111111111111',
  observedAt: new Date().toISOString(),
  facts: [{ label: 'Mint authority', value: 'unknown' }],
  unknowns: ['Holder coverage'],
};
const services = {
  token: async () => card,
  firewall: async () => ({
    verdictLabel: 'Caution',
    findings: [{ message: 'Unknown source.' }],
    inspectedAt: new Date().toISOString(),
  }),
};
async function outgoing(update) {
  const r = await pool.query(
    'SELECT id,method,payload_ciphertext,state FROM second_look_telegram_outbox WHERE bot_id=$1 AND update_id=$2',
    [config.botId, update.update_id],
  );
  assert.equal(r.rowCount, 1);
  return {
    ...r.rows[0],
    body: JSON.parse(
      await decryptText(
        r.rows[0].payload_ciphertext,
        `second-look:telegram-outbox:${r.rows[0].id}`,
        keyring,
      ),
    ),
  };
}
async function account() {
  const id = randomUUID(),
    session = generateSessionToken(),
    hash = await hashToken(session);
  await pool.query('INSERT INTO accounts(id) VALUES($1)', [id]);
  await pool.query(
    "INSERT INTO sessions(token_hash,account_id,expires_at) VALUES($1,$2,clock_timestamp()+interval '1 hour')",
    [hash, id],
  );
  return { id, hash };
}
test('configuration never auto-registers a bot and delivery needs explicit enable', () => {
  assert.equal(telegramConfig({}).enabled, false);
  assert.equal(
    telegramConfig({ ...env, CONCLAVE_TELEGRAM_DELIVERY_ENABLED: 'false' })
      .deliveryEnabled,
    false,
  );
  const cap = telegramCapability(env);
  assert.equal(cap.configured, false);
  assert.equal(cap.automaticallyRegistersWebhook, false);
  assert.equal(cap.automaticAlerts, false);
  assert.equal(JSON.stringify(cap).includes(token), false);
});
test('secret verification checks exact value without exposing credentials', () => {
  assert.equal(verifyTelegramSecret(secret, secret), true);
  for (const value of [
    null,
    '',
    secret + 'x',
    secret.slice(1),
    'x'.repeat(secret.length),
  ])
    assert.equal(verifyTelegramSecret(value, secret), false);
});
test('commands and inline accept only explicit supported inputs', () => {
  assert.equal(
    parseTelegramUpdate(message('/token ' + card.mint), config.botUsername)
      .command,
    'token',
  );
  assert.equal(
    parseTelegramUpdate(inline(card.mint), config.botUsername).command,
    'token',
  );
  assert.equal(
    parseTelegramUpdate(
      message('/token@other_bot ' + card.mint),
      config.botUsername,
    ),
    null,
  );
  const edited = message('/token ' + card.mint);
  edited.edited_message = edited.message;
  delete edited.message;
  assert.equal(parseTelegramUpdate(edited, config.botUsername), null);
  const group = message('/start link_' + 'a'.repeat(43));
  group.message.chat.type = 'group';
  assert.equal(parseTelegramUpdate(group, config.botUsername), null);
});
test('HTML is escaped and source timestamp is retained without recommendations', () => {
  assert.equal(escapeTelegram('<a&"'), '&lt;a&amp;&quot;');
  const rendered = telegramCardText({
    ...card,
    title: '<script>',
    facts: [{ label: '<b>', value: '1 & 2' }],
  });
  assert.ok(rendered.includes('&lt;script&gt;'));
  assert.ok(rendered.includes(card.observedAt));
  assert.ok(rendered.includes('Facts only.'));
  assert.equal(rendered.includes('<script>'), false);
});
test('duplicate webhook updates produce one immutable durable command', async () => {
  const update = message('/token ' + card.mint);
  const [a, b] = await Promise.all([
    acceptTelegramUpdate(pool, update, config, keyring),
    acceptTelegramUpdate(pool, update, config, keyring),
  ]);
  assert.equal([a, b].filter((v) => v.replayed).length, 1);
  await assert.rejects(
    acceptTelegramUpdate(
      pool,
      {
        ...update,
        message: { ...update.message, text: '/firewall https://example.com' },
      },
      config,
      keyring,
    ),
    (e) => e.code === 'TELEGRAM_UPDATE_CONFLICT',
  );
  await processNextTelegramUpdate(pool, config, keyring, services);
  assert.equal((await outgoing(update)).method, 'sendMessage');
});
test('inline responses are personal, uncached facts and never auto-approve paid calls', async () => {
  const update = inline(card.mint);
  await acceptTelegramUpdate(pool, update, config, keyring);
  let called = 0;
  await processNextTelegramUpdate(pool, config, keyring, {
    ...services,
    token: async (input, context) => {
      called++;
      assert.equal(input, card.mint);
      assert.equal(context.accountId, null);
      return card;
    },
  });
  const out = await outgoing(update);
  assert.equal(out.method, 'answerInlineQuery');
  assert.equal(out.body.is_personal, true);
  assert.equal(out.body.cache_time, 0);
  assert.equal(called, 1);
  assert.equal(out.body.results.length, 1);
});
test('real token adapter produces a sourced inline card through mocked fixed-origin RPC', async () => {
  let reads = 0;
  const providers = createTokenProviders(
    {
      enabled: true,
      rpcUrl: 'https://rpc.example/',
      dex: false,
      rug: false,
      evidence: false,
      simulation: false,
      claims: false,
      deep: false,
      freeDailyGlobalLimit: 1000,
    },
    async (url, init) => {
      assert.equal(url, 'https://rpc.example/');
      const req = JSON.parse(init.body);
      reads++;
      let result;
      if (req.method === 'getGenesisHash')
        result = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
      else {
        assert.equal(req.method, 'getAccountInfo');
        const data = Buffer.alloc(82);
        data[44] = 6;
        data[45] = 1;
        data.writeBigUInt64LE(1000000n, 36);
        result = {
          context: { slot: 500 },
          value: {
            executable: false,
            owner: TOKEN_PROGRAM,
            data: [data.toString('base64'), 'base64'],
          },
        };
      }
      return Response.json({ jsonrpc: '2.0', id: 1, result });
    },
  );
  const update = inline(card.mint);
  await acceptTelegramUpdate(pool, update, config, keyring);
  await processNextTelegramUpdate(
    pool,
    config,
    keyring,
    createTelegramServices({ providers }),
  );
  const out = await outgoing(update);
  assert.equal(reads, 4); // Input resolution and the fresh facts read each bind the cluster and mint.
  assert.ok(
    out.body.results[0].input_message_content.message_text.includes(
      'Raw supply: 1000000',
    ),
  );
  assert.ok(
    out.body.results[0].input_message_content.message_text.includes('Unknown:'),
  );
  assert.equal(
    (await pool.query('SELECT count(*)::int AS n FROM holds')).rows[0].n,
    0,
  );
});
test('anonymous fourth daily request never reaches the facts service', async () => {
  const user = nextUser++;
  let called = 0,
    last;
  for (let i = 0; i < 4; i++) {
    last = message('/token ' + card.mint, user);
    await acceptTelegramUpdate(pool, last, config, keyring);
    await processNextTelegramUpdate(pool, config, keyring, {
      ...services,
      token: async () => {
        called++;
        return card;
      },
    });
  }
  assert.equal(called, 3);
  assert.ok((await outgoing(last)).body.text.includes('limit'));
});
test('one-time link exchange requires matching live browser confirmation', async () => {
  const owner = await account(),
    other = await account(),
    challenge = await createTelegramLink(pool, owner.id, owner.hash),
    user = nextUser++;
  const update = message('/start link_' + challenge.token, user);
  await acceptTelegramUpdate(pool, update, config, keyring);
  await processNextTelegramUpdate(pool, config, keyring, services);
  assert.equal(
    (
      await pool.query(
        'SELECT * FROM second_look_telegram_links WHERE account_id=$1',
        [owner.id],
      )
    ).rowCount,
    0,
  );
  await assert.rejects(
    confirmTelegramLink(pool, other.id, other.hash, challenge.id, String(user)),
    (e) => e.code === 'TELEGRAM_LINK_UNCONFIRMED',
  );
  await assert.rejects(
    confirmTelegramLink(
      pool,
      owner.id,
      owner.hash,
      challenge.id,
      String(user + 1),
    ),
    (e) => e.code === 'TELEGRAM_LINK_UNCONFIRMED',
  );
  const result = await confirmTelegramLink(
    pool,
    owner.id,
    owner.hash,
    challenge.id,
    String(user),
  );
  assert.equal(result.deliveryEnabled, false);
  await assert.rejects(
    confirmTelegramLink(pool, owner.id, owner.hash, challenge.id, String(user)),
    (e) => e.code === 'TELEGRAM_LINK_UNCONFIRMED',
  );
});
test('revoked session cannot exchange a link or confirm ownership', async () => {
  const owner = await account(),
    challenge = await createTelegramLink(pool, owner.id, owner.hash),
    user = nextUser++;
  await pool.query(
    'UPDATE sessions SET revoked_at=clock_timestamp() WHERE token_hash=$1',
    [owner.hash],
  );
  const update = message('/start link_' + challenge.token, user);
  await acceptTelegramUpdate(pool, update, config, keyring);
  await processNextTelegramUpdate(pool, config, keyring, services);
  assert.equal(
    (
      await pool.query(
        'SELECT telegram_user_id FROM second_look_telegram_link_challenges WHERE id=$1',
        [challenge.id],
      )
    ).rows[0].telegram_user_id,
    null,
  );
  await assert.rejects(
    confirmTelegramLink(pool, owner.id, owner.hash, challenge.id, String(user)),
    (e) => e.code === 'SIGN_IN_REQUIRED',
  );
});
test('same Telegram account cannot link to two Conclave accounts', async () => {
  const a = await account(),
    b = await account(),
    user = nextUser++;
  for (const owner of [a, b]) {
    const c = await createTelegramLink(pool, owner.id, owner.hash);
    const u = message('/start link_' + c.token, user);
    await acceptTelegramUpdate(pool, u, config, keyring);
    await processNextTelegramUpdate(pool, config, keyring, services);
    if (owner === a)
      await confirmTelegramLink(pool, owner.id, owner.hash, c.id, String(user));
    else
      await assert.rejects(
        confirmTelegramLink(pool, owner.id, owner.hash, c.id, String(user)),
        (e) => e.code === 'TELEGRAM_ALREADY_LINKED',
      );
  }
});
test('linked Telegram quota uses the account-wide ten-card budget', async () => {
  const owner = await account(),
    user = nextUser++;
  await pool.query(
    'INSERT INTO second_look_telegram_links(account_id,telegram_user_id) VALUES($1,$2)',
    [owner.id, user],
  );
  await pool.query(
    "INSERT INTO secondlook_token_usage(account_id,day,used) VALUES($1,(clock_timestamp() AT TIME ZONE 'UTC')::date,10)",
    [owner.id],
  );
  const u = message('/token ' + card.mint, user);
  await acceptTelegramUpdate(pool, u, config, keyring);
  let calls = 0;
  await processNextTelegramUpdate(pool, config, keyring, {
    ...services,
    token: async () => {
      calls++;
      return card;
    },
  });
  assert.equal(calls, 0);
  assert.ok((await outgoing(u)).body.text.includes('limit'));
});
test('delivery is opt-in operationally, records dispatch before send and cannot resend', async () => {
  await assert.rejects(
    deliverNextTelegramMessage(
      pool,
      { ...config, deliveryEnabled: false },
      keyring,
      async () => {
        throw new Error('must not send');
      },
    ),
    (e) => e.code === 'TELEGRAM_DELIVERY_DISABLED',
  );
  let sent = 0;
  const result = await deliverNextTelegramMessage(
    pool,
    config,
    keyring,
    async (url, options) => {
      sent++;
      assert.ok(url.startsWith('https://api.telegram.org/bot'));
      assert.equal(options.redirect, 'error');
      const count = await pool.query(
        "SELECT count(*)::int AS n FROM second_look_telegram_outbox WHERE state='dispatching'",
      );
      assert.equal(count.rows[0].n, 1);
      return Response.json({ ok: true, result: true });
    },
  );
  assert.equal(result.state, 'delivered');
  assert.equal(sent, 1);
});
test('ambiguous send is never automatically retried and saved payload is immutable', async () => {
  let calls = 0;
  const result = await deliverNextTelegramMessage(
    pool,
    config,
    keyring,
    async () => {
      calls++;
      throw new Error('synthetic transport loss');
    },
  );
  assert.equal(result.state, 'uncertain');
  assert.equal(calls, 1);
  const rows = await pool.query(
    "SELECT id FROM second_look_telegram_outbox WHERE state='uncertain'",
  );
  assert.ok(rows.rowCount);
  await assert.rejects(
    pool.query(
      "UPDATE second_look_telegram_outbox SET state='pending' WHERE id=$1",
      [rows.rows[0].id],
    ),
  );
  await assert.rejects(
    pool.query(
      "UPDATE second_look_telegram_outbox SET payload_ciphertext=repeat('a',40) WHERE id=$1",
      [rows.rows[0].id],
    ),
  );
});
test('bad webhook secret returns before reading a body or querying the database', async () => {
  const old = {};
  for (const [key, value] of Object.entries(env)) {
    old[key] = process.env[key];
    process.env[key] = value;
  }
  try {
    let queries = 0;
    const request = new Request(
      'https://workspace.example/api/second-look/telegram/webhook',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-telegram-bot-api-secret-token': 'wrong',
        },
        body: '{}',
      },
    );
    await assert.rejects(
      telegramWebhook(
        {
          query() {
            queries++;
            throw new Error('not allowed');
          },
        },
        request,
      ),
      (e) => e.code === 'TELEGRAM_SECRET_REJECTED',
    );
    assert.equal(queries, 0);
  } finally {
    for (const [key, value] of Object.entries(old))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
  }
});

test('account commands discard group input, require a linked account and preserve retry identity', async () => {
  const owner = await account(),
    user = nextUser++;
  let reads = 0,
    seen;
  const accountServices = {
    ...services,
    account: async (command, input, context) => {
      reads++;
      seen = { command, input, ...context };
      return '<private budget>';
    },
  };
  const group = message('/budget private-label', user, {
    chat: { id: -987654321, type: 'supergroup' },
  });
  const parsed = parseTelegramUpdate(group, config.botUsername);
  assert.equal(parsed.command, 'private');
  assert.equal(parsed.input, '');
  await acceptTelegramUpdate(pool, group, config, keyring);
  await processNextTelegramUpdate(pool, config, keyring, accountServices);
  assert.equal(reads, 0);
  assert.match((await outgoing(group)).body.text, /private chat/);
  const unlinked = message('/budget', user);
  await acceptTelegramUpdate(pool, unlinked, config, keyring);
  await processNextTelegramUpdate(pool, config, keyring, accountServices);
  assert.equal(reads, 0);
  assert.match((await outgoing(unlinked)).body.text, /confirm/);
  await pool.query(
    'INSERT INTO second_look_telegram_links(account_id,telegram_user_id) VALUES($1,$2)',
    [owner.id, user],
  );
  const linked = message('/budget', user);
  await acceptTelegramUpdate(pool, linked, config, keyring);
  await acceptTelegramUpdate(pool, linked, config, keyring);
  await processNextTelegramUpdate(pool, config, keyring, accountServices);
  assert.equal(reads, 1);
  assert.equal(seen.accountId, owner.id);
  assert.match(seen.requestKey, /^[a-f0-9]{64}$/);
  const out = await outgoing(linked);
  assert.equal(out.body.text, '&lt;private budget&gt;');
  assert.equal(out.body._conclaveTool, 'plan');
  for (const c of ['follow', 'pnl', 'why', 'exit', 'budget', 'call'])
    assert.equal(
      parseTelegramUpdate(message('/' + c, user), config.botUsername).command,
      c,
    );
});

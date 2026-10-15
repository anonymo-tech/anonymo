import { createHash, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import {
  configuredKeyring,
  encryptText,
  decryptText,
  type DataKeyring,
} from '../core/encryption.ts';
import { requireCondition, ServiceError } from '../core/errors.ts';
import { jsonResponse, readJson, uuidField } from '../core/http.ts';
import {
  rateLimit,
  RPC_GLOBAL_BUCKET,
  RPC_GLOBAL_LIMIT,
} from '../core/rate-limit.ts';
import { transaction, one, type Queryable } from '../db/database.ts';
import { getSession } from '../routes/session.ts';
import { generateSessionToken } from '../auth/primitives.ts';
import { scanPrompt } from '../../lib/guards/index.ts';
import type { SignatureReport } from '../../lib/second-look/signature.ts';
import {
  consumeFreeTokenQuota,
  consumeAnonymousTokenBudget,
} from './token-store.ts';
import { tokenProviderConfig } from './providers.ts';

export type TelegramConfig = {
  enabled: boolean;
  deliveryEnabled: boolean;
  botId: string | null;
  botUsername: string | null;
  botToken: string | null;
  webhookSecret: string | null;
};
export function telegramConfig(
  env: Record<string, string | undefined> = process.env,
): TelegramConfig {
  const token = env.CONCLAVE_TELEGRAM_BOT_TOKEN,
    secret = env.CONCLAVE_TELEGRAM_WEBHOOK_SECRET,
    username = env.CONCLAVE_TELEGRAM_BOT_USERNAME;
  const validToken =
    typeof token === 'string' &&
    /^[1-9][0-9]{4,15}:[A-Za-z0-9_-]{30,100}$/.test(token);
  const validSecret =
    typeof secret === 'string' && /^[A-Za-z0-9_-]{32,256}$/.test(secret);
  const validName =
    typeof username === 'string' &&
    /^[A-Za-z][A-Za-z0-9_]{4,31}$/.test(username) &&
    /bot$/i.test(username);
  return {
    enabled:
      env.CONCLAVE_TELEGRAM_ENABLED === 'true' &&
      validToken &&
      validSecret &&
      validName,
    deliveryEnabled: env.CONCLAVE_TELEGRAM_DELIVERY_ENABLED === 'true',
    botId: validToken ? token.split(':')[0] : null,
    botUsername: validName ? username : null,
    botToken: validToken ? token : null,
    webhookSecret: validSecret ? secret : null,
  };
}
export function telegramCapability(
  env: Record<string, string | undefined> = process.env,
) {
  const config = telegramConfig(env);
  let storage = false;
  try {
    configuredKeyring(env);
    storage = true;
  } catch {
    /* Missing storage is reported without exposing configuration. */
  }
  return {
    configured: config.enabled && storage,
    deliveryConfigured: config.enabled && storage && config.deliveryEnabled,
    botUsername: config.enabled ? config.botUsername : null,
    webhookPath: '/api/second-look/telegram/webhook',
    commands: ['/token', '/firewall', '/start'],
    inlineCards: true,
    accountLinkRequiresConfirmation: true,
    automaticAlerts: false,
    automaticallyRegistersWebhook: false,
    missing: [
      !config.enabled && 'reviewed-bot-configuration',
      !storage && 'encrypted-storage',
      !config.deliveryEnabled && 'explicit-delivery-enable',
    ].filter(Boolean),
  };
}
function digest(value: string) {
  return createHash('sha256').update(value).digest('hex');
}
async function transactionalLimit(
  db: Queryable,
  bucket: string,
  maximum: number,
  seconds = 60,
) {
  const result = await db.query<{ hits: number }>(
    `INSERT INTO rate_limits(bucket,window_start,hits) VALUES($1,to_timestamp(floor(extract(epoch FROM now())/$2)*$2),1) ON CONFLICT(bucket,window_start) DO UPDATE SET hits=rate_limits.hits+1 RETURNING hits`,
    [bucket, seconds],
  );
  requireCondition(
    result.rows[0].hits <= maximum,
    429,
    'RATE_LIMITED',
    'The free usage limit has been reached.',
  );
}
export function verifyTelegramSecret(
  provided: string | null,
  expected: string,
) {
  const a = createHash('sha256')
      .update(provided ?? '')
      .digest(),
    b = createHash('sha256').update(expected).digest();
  return (
    timingSafeEqual(a, b) &&
    typeof provided === 'string' &&
    provided.length >= 32 &&
    provided.length <= 256
  );
}
function validInteger(value: unknown, allowZero = false): value is number {
  return (
    typeof value === 'number' &&
    Number.isSafeInteger(value) &&
    value >= (allowZero ? 0 : 1)
  );
}
function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
export type TelegramCommand = {
  updateId: number;
  userId: number;
  reply:
    | { kind: 'message'; chatId: number; messageId: number }
    | { kind: 'inline'; queryId: string };
  command: 'token' | 'firewall' | 'link' | 'help' | 'sensitive';
  input: string;
};
export function parseTelegramUpdate(
  value: Record<string, unknown>,
  botUsername: string,
): TelegramCommand | null {
  if (!validInteger(value.update_id, true))
    throw new ServiceError(
      400,
      'INVALID_TELEGRAM_UPDATE',
      'The update is invalid.',
    );
  if (value.edited_message || value.edited_channel_post || value.channel_post)
    return null;
  const message = object(value.message),
    inline = object(value.inline_query);
  if (Boolean(message) === Boolean(inline)) return null;
  const source = message ?? inline!,
    from = object(source.from);
  if (!from || !validInteger(from.id) || from.is_bot !== false) return null;
  let reply: TelegramCommand['reply'], raw: string;
  if (message) {
    const chat = object(message.chat);
    if (
      !chat ||
      typeof chat.id !== 'number' ||
      !Number.isSafeInteger(chat.id) ||
      chat.id === 0 ||
      !validInteger(message.message_id) ||
      !['private', 'group', 'supergroup'].includes(String(chat.type)) ||
      typeof message.text !== 'string'
    )
      return null;
    raw = message.text;
    reply = { kind: 'message', chatId: chat.id, messageId: message.message_id };
  } else {
    if (
      typeof inline!.id !== 'string' ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(inline!.id) ||
      typeof inline!.query !== 'string' ||
      (inline!.offset !== undefined && inline!.offset !== '')
    )
      return null;
    raw = inline!.query;
    reply = { kind: 'inline', queryId: inline!.id };
  }
  if (
    Buffer.byteLength(raw) > 8192 ||
    [...raw].some((character) => {
      const code = character.charCodeAt(0);
      return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
    })
  )
    return null;
  const base = { updateId: value.update_id, userId: from.id, reply };
  if (scanPrompt(raw).findings.some((f) => f.severity === 'block'))
    return { ...base, command: 'sensitive', input: '' };
  if (inline)
    return {
      ...base,
      command: raw.trim() ? 'token' : 'help',
      input: raw.trim(),
    };
  const match =
    /^\/(token|firewall|start|help)(?:@([A-Za-z0-9_]+))?(?:\s+([\s\S]*))?$/.exec(
      raw.trim(),
    );
  if (
    !match ||
    (match[2] && match[2].toLowerCase() !== botUsername.toLowerCase())
  ) {
    if (object(message!.chat)?.type === 'private' && message!.forward_origin)
      return { ...base, command: 'firewall', input: raw.trim() };
    return null;
  }
  const input = match[3]?.trim() ?? '';
  if (match[1] === 'start' && /^link_[A-Za-z0-9_-]{43}$/.test(input)) {
    if (
      object(message!.chat)?.type !== 'private' ||
      reply.kind !== 'message' ||
      reply.chatId !== from.id
    )
      return null;
    return { ...base, command: 'link', input: input.slice(5) };
  }
  return {
    ...base,
    command:
      match[1] === 'token' || match[1] === 'firewall' ? match[1] : 'help',
    input,
  };
}
function scope(bot: string, update: number | string) {
  return `second-look:telegram:${bot}:${update}`;
}
export async function acceptTelegramUpdate(
  pool: Pool,
  body: Record<string, unknown>,
  config: TelegramConfig,
  keyring: DataKeyring,
) {
  requireCondition(
    config.enabled && config.botId && config.botUsername,
    503,
    'TELEGRAM_UNAVAILABLE',
    'Telegram is not configured.',
  );
  const command = parseTelegramUpdate(body, config.botUsername);
  if (!command) return { accepted: true, ignored: true, replayed: false };
  const serialized = JSON.stringify(command),
    hash = digest(serialized),
    cipher = await encryptText(
      serialized,
      scope(config.botId, command.updateId),
      keyring,
    );
  return transaction(pool, async (db) => {
    const prior = await one<{ payload_hash: string }>(
      db,
      'SELECT payload_hash FROM second_look_telegram_updates WHERE bot_id=$1 AND update_id=$2',
      [config.botId, command.updateId],
    );
    if (prior) {
      requireCondition(
        prior.payload_hash === hash,
        409,
        'TELEGRAM_UPDATE_CONFLICT',
        'The update identifier was already accepted.',
      );
      return { accepted: true, ignored: false, replayed: true };
    }
    await transactionalLimit(
      db,
      `telegram-inbound:${config.botId}:${command.userId}`,
      30,
    );
    await transactionalLimit(
      db,
      `telegram-inbound:${config.botId}:global`,
      300,
    );
    const inserted = await db.query(
      `INSERT INTO second_look_telegram_updates(bot_id,update_id,telegram_user_id,payload_hash,payload_ciphertext) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING update_id`,
      [config.botId, command.updateId, command.userId, hash, cipher],
    );
    if (!inserted.rowCount) {
      const existing = await one<{ payload_hash: string }>(
        db,
        'SELECT payload_hash FROM second_look_telegram_updates WHERE bot_id=$1 AND update_id=$2',
        [config.botId, command.updateId],
      );
      requireCondition(
        existing?.payload_hash === hash,
        409,
        'TELEGRAM_UPDATE_CONFLICT',
        'The update identifier was already accepted.',
      );
    }
    return { accepted: true, ignored: false, replayed: !inserted.rowCount };
  });
}
export async function telegramWebhook(
  pool: Pool,
  request: Request,
): Promise<Response> {
  if (request.method !== 'POST')
    throw new ServiceError(405, 'METHOD_NOT_ALLOWED', 'Use POST.');
  const config = telegramConfig();
  requireCondition(
    config.enabled && config.webhookSecret,
    503,
    'TELEGRAM_UNAVAILABLE',
    'Telegram is not configured.',
  );
  requireCondition(
    verifyTelegramSecret(
      request.headers.get('x-telegram-bot-api-secret-token'),
      config.webhookSecret,
    ),
    403,
    'TELEGRAM_SECRET_REJECTED',
    'The webhook could not be authenticated.',
  );
  return jsonResponse(
    await acceptTelegramUpdate(
      pool,
      await readJson(request, 65536),
      config,
      configuredKeyring(),
    ),
  );
}
async function activeSession(
  db: Queryable,
  accountId: string,
  sessionHash: string,
) {
  const account = await one(
    db,
    'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
    [accountId],
  );
  requireCondition(account, 401, 'SIGN_IN_REQUIRED', 'Sign in to continue.');
  const session = await one(
    db,
    `SELECT token_hash FROM sessions s WHERE account_id=$1 AND token_hash=$2 AND expires_at>clock_timestamp() AND revoked_at IS NULL AND (identity_id IS NULL OR EXISTS(SELECT 1 FROM identities i WHERE i.id=s.identity_id AND i.account_id=s.account_id AND i.revoked_at IS NULL)) FOR UPDATE`,
    [accountId, sessionHash],
  );
  requireCondition(
    session,
    401,
    'SIGN_IN_REQUIRED',
    'Your session is no longer active.',
  );
}
export async function createTelegramLink(
  pool: Pool,
  accountId: string,
  sessionHash: string,
) {
  const token = generateSessionToken(),
    id = crypto.randomUUID();
  return transaction(pool, async (db) => {
    await activeSession(db, accountId, sessionHash);
    requireCondition(
      !(await one(
        db,
        'SELECT account_id FROM second_look_telegram_links WHERE account_id=$1',
        [accountId],
      )),
      409,
      'TELEGRAM_ALREADY_LINKED',
      'Unlink the existing Telegram account first.',
    );
    await db.query(
      'DELETE FROM second_look_telegram_link_challenges WHERE account_id=$1 AND confirmed_at IS NULL',
      [accountId],
    );
    const row = await one<{ expires_at: Date }>(
      db,
      `INSERT INTO second_look_telegram_link_challenges(id,account_id,session_hash,token_hash,expires_at) VALUES($1,$2,$3,$4,clock_timestamp()+interval '5 minutes') RETURNING expires_at`,
      [id, accountId, sessionHash, digest(`telegram-link:${token}`)],
    );
    return {
      id,
      token,
      expiresAt: row!.expires_at.toISOString(),
      requiresWebConfirmation: true,
    };
  });
}
async function exchangeTelegramLink(pool: Pool, token: string, userId: number) {
  return transaction(pool, async (db) => {
    const before = await one<{ account_id: string; session_hash: string }>(
      db,
      'SELECT account_id,session_hash FROM second_look_telegram_link_challenges WHERE token_hash=$1',
      [digest(`telegram-link:${token}`)],
    );
    requireCondition(
      before,
      409,
      'TELEGRAM_LINK_EXPIRED',
      'Request a new link from your signed-in account.',
    );
    await activeSession(db, before.account_id, before.session_hash);
    const changed = await db.query(
      `UPDATE second_look_telegram_link_challenges SET telegram_user_id=$2,exchanged_at=clock_timestamp() WHERE token_hash=$1 AND telegram_user_id IS NULL AND expires_at>clock_timestamp() AND confirmed_at IS NULL RETURNING id`,
      [digest(`telegram-link:${token}`), userId],
    );
    requireCondition(
      changed.rowCount === 1,
      409,
      'TELEGRAM_LINK_EXPIRED',
      'This link token is expired or already used.',
    );
  });
}
export async function confirmTelegramLink(
  pool: Pool,
  accountId: string,
  sessionHash: string,
  challengeId: string,
  telegramUserId: string,
) {
  requireCondition(
    /^[1-9][0-9]{0,15}$/.test(telegramUserId),
    400,
    'INVALID_REQUEST',
    'A Telegram account identifier is required.',
  );
  return transaction(pool, async (db) => {
    await activeSession(db, accountId, sessionHash);
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `telegram-link:${telegramUserId}`,
    ]);
    const challenge = await one<{ telegram_user_id: string }>(
      db,
      `SELECT telegram_user_id FROM second_look_telegram_link_challenges WHERE id=$1 AND account_id=$2 AND session_hash=$3 AND expires_at>clock_timestamp() AND confirmed_at IS NULL FOR UPDATE`,
      [challengeId, accountId, sessionHash],
    );
    requireCondition(
      challenge?.telegram_user_id === telegramUserId,
      409,
      'TELEGRAM_LINK_UNCONFIRMED',
      'Complete the private bot exchange and confirm the matching account.',
    );
    requireCondition(
      !(await one(
        db,
        'SELECT account_id FROM second_look_telegram_links WHERE account_id=$1 OR telegram_user_id=$2',
        [accountId, telegramUserId],
      )),
      409,
      'TELEGRAM_ALREADY_LINKED',
      'This account already has a Telegram link.',
    );
    const consumed = await db.query(
      'UPDATE second_look_telegram_link_challenges SET confirmed_at=clock_timestamp() WHERE id=$1 AND expires_at>clock_timestamp() AND confirmed_at IS NULL RETURNING id',
      [challengeId],
    );
    requireCondition(
      consumed.rowCount === 1,
      409,
      'TELEGRAM_LINK_EXPIRED',
      'Request a new link.',
    );
    await db.query(
      'INSERT INTO second_look_telegram_links(account_id,telegram_user_id) VALUES($1,$2)',
      [accountId, telegramUserId],
    );
    return { linked: true, telegramUserId, deliveryEnabled: false };
  });
}
export async function telegramRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (!path.startsWith('second-look/telegram/')) return null;
  if (path === 'second-look/telegram/capabilities' && request.method === 'GET')
    return jsonResponse(telegramCapability());
  const session = await getSession(pool, request);
  requireCondition(
    session.accountId === accountId,
    401,
    'ACCOUNT_CHANGED',
    'The signed-in account changed.',
  );
  if (path === 'second-look/telegram/status' && request.method === 'GET') {
    const link = await one<{
      telegram_user_id: string;
      delivery_enabled: boolean;
    }>(
      pool,
      'SELECT telegram_user_id,delivery_enabled FROM second_look_telegram_links WHERE account_id=$1',
      [accountId],
    );
    const challenge = await one<{
      id: string;
      telegram_user_id: string | null;
      expires_at: Date;
    }>(
      pool,
      'SELECT id,telegram_user_id,expires_at FROM second_look_telegram_link_challenges WHERE account_id=$1 AND session_hash=$2 AND expires_at>clock_timestamp() AND confirmed_at IS NULL ORDER BY created_at DESC LIMIT 1',
      [accountId, session.tokenHash],
    );
    return jsonResponse({
      linked: Boolean(link),
      telegramUserId: link?.telegram_user_id ?? null,
      deliveryEnabled: link?.delivery_enabled ?? false,
      pending: challenge
        ? {
            id: challenge.id,
            telegramUserId: challenge.telegram_user_id,
            expiresAt: challenge.expires_at.toISOString(),
          }
        : null,
    });
  }
  await rateLimit(pool, `telegram-link:${accountId}`, 10);
  if (path === 'second-look/telegram/link' && request.method === 'POST') {
    const body = await readJson(request, 64);
    requireCondition(
      !Object.keys(body).length,
      400,
      'INVALID_REQUEST',
      'No extra fields are accepted.',
    );
    const config = telegramConfig();
    requireCondition(
      config.enabled,
      503,
      'TELEGRAM_UNAVAILABLE',
      'Telegram is not configured.',
    );
    const result = await createTelegramLink(pool, accountId, session.tokenHash);
    return jsonResponse(
      {
        id: result.id,
        expiresAt: result.expiresAt,
        requiresWebConfirmation: true,
        url: `https://t.me/${config.botUsername}?start=link_${result.token}`,
      },
      201,
    );
  }
  const confirm = /^second-look\/telegram\/link\/([^/]+)\/confirm$/.exec(path);
  if (confirm && request.method === 'POST') {
    const body = await readJson(request, 256);
    requireCondition(
      Object.keys(body).length === 1 && typeof body.telegramUserId === 'string',
      400,
      'INVALID_REQUEST',
      'Only the matching Telegram account identifier is accepted.',
    );
    return jsonResponse(
      await confirmTelegramLink(
        pool,
        accountId,
        session.tokenHash,
        uuidField(confirm[1]),
        body.telegramUserId,
      ),
    );
  }
  if (path === 'second-look/telegram/link' && request.method === 'DELETE') {
    await transaction(pool, async (db) => {
      await activeSession(db, accountId, session.tokenHash);
      await db.query(
        'DELETE FROM second_look_telegram_links WHERE account_id=$1',
        [accountId],
      );
      await db.query(
        'DELETE FROM second_look_telegram_link_challenges WHERE account_id=$1',
        [accountId],
      );
    });
    return jsonResponse({ linked: false, deliveryEnabled: false });
  }
  if (path === 'second-look/telegram/delivery' && request.method === 'PATCH') {
    const body = await readJson(request, 64);
    requireCondition(
      Object.keys(body).length === 1 && typeof body.enabled === 'boolean',
      400,
      'INVALID_REQUEST',
      'Supply an explicit delivery preference.',
    );
    await transaction(pool, async (db) => {
      await activeSession(db, accountId, session.tokenHash);
      const updated = await db.query(
        'UPDATE second_look_telegram_links SET delivery_enabled=$2 WHERE account_id=$1 RETURNING account_id',
        [accountId, body.enabled],
      );
      requireCondition(
        updated.rowCount === 1,
        409,
        'TELEGRAM_NOT_LINKED',
        'Link and confirm Telegram first.',
      );
    });
    return jsonResponse({ deliveryEnabled: body.enabled });
  }
  return null;
}
export function escapeTelegram(value: string) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}
export type TelegramFactsCard = {
  title: string;
  mint: string;
  observedAt: string;
  facts: { label: string; value: string }[];
  unknowns: string[];
};
export function telegramCardText(card: TelegramFactsCard) {
  requireCondition(
    card.facts.length <= 16 &&
      card.unknowns.length <= 16 &&
      /^\d{4}-\d{2}-\d{2}T.*Z$/.test(card.observedAt),
    503,
    'CARD_UNAVAILABLE',
    'The card evidence is unavailable.',
  );
  const lines = [
    `<b>${escapeTelegram(card.title.slice(0, 100))}</b>`,
    `<code>${escapeTelegram(card.mint)}</code>`,
    ...card.facts.map(
      (f) =>
        `${escapeTelegram(f.label.slice(0, 80))}: ${escapeTelegram(f.value.slice(0, 160))}`,
    ),
    `Observed: ${escapeTelegram(card.observedAt)}`,
    ...(card.unknowns.length
      ? ['Unknown: ' + escapeTelegram(card.unknowns.join('; ').slice(0, 600))]
      : []),
    'Facts only. This card does not establish safety or recommend a trade.',
  ];
  const result = lines.join('\n');
  requireCondition(
    result.length <= 3800,
    503,
    'CARD_UNAVAILABLE',
    'The card is too large.',
  );
  return result;
}
function signatureText(report: SignatureReport) {
  return [
    `<b>${escapeTelegram(report.verdictLabel)}</b>`,
    ...report.findings.slice(0, 8).map((f) => escapeTelegram(f.message)),
    `Inspected: ${escapeTelegram(report.inspectedAt)}`,
    'No transaction was signed or submitted.',
  ]
    .join('\n')
    .slice(0, 3800);
}
export type TelegramServices = {
  token(
    input: string,
    options: { accountId: string | null; signal?: AbortSignal },
  ): Promise<TelegramFactsCard>;
  firewall(input: string, signal?: AbortSignal): Promise<SignatureReport>;
};
type UpdateRow = {
  bot_id: string;
  update_id: string;
  telegram_user_id: string;
  payload_ciphertext: string;
  lease_id: string;
  attempts: number;
  quota_charged: boolean;
};
export async function processNextTelegramUpdate(
  pool: Pool,
  config: TelegramConfig,
  keyring: DataKeyring,
  services: TelegramServices,
) {
  requireCondition(
    config.enabled && config.botId,
    503,
    'TELEGRAM_UNAVAILABLE',
    'Telegram is not configured.',
  );
  const row = await transaction(pool, async (db) => {
    await db.query(
      `UPDATE second_look_telegram_updates SET state=CASE WHEN attempts>=3 THEN 'failed' ELSE 'pending' END,lease_id=NULL,lease_expires_at=NULL WHERE bot_id=$1 AND state='processing' AND lease_expires_at<clock_timestamp()`,
      [config.botId],
    );
    const current = await one<UpdateRow>(
      db,
      `SELECT * FROM second_look_telegram_updates WHERE bot_id=$1 AND state='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      [config.botId],
    );
    if (!current) return null;
    const lease = crypto.randomUUID();
    await db.query(
      `UPDATE second_look_telegram_updates SET state='processing',attempts=attempts+1,lease_id=$3,lease_expires_at=clock_timestamp()+interval '45 seconds' WHERE bot_id=$1 AND update_id=$2`,
      [config.botId, current.update_id, lease],
    );
    return { ...current, lease_id: lease };
  });
  if (!row) return { processed: false };
  const payload = JSON.parse(
    await decryptText(
      row.payload_ciphertext,
      scope(row.bot_id, row.update_id),
      keyring,
    ),
  ) as TelegramCommand;
  let response =
    'Use /token followed by a Solana mint or /firewall followed by transaction bytes, a URL, or a suspicious message. For a reviewed Action endpoint, add your public Solana address after the URL; that endpoint will receive the address to construct bytes for inspection only.';
  try {
    const link = await one<{ account_id: string }>(
      pool,
      'SELECT l.account_id FROM second_look_telegram_links l JOIN accounts a ON a.id=l.account_id WHERE telegram_user_id=$1 AND a.disabled_at IS NULL',
      [row.telegram_user_id],
    );
    if (!row.quota_charged && ['token', 'firewall'].includes(payload.command)) {
      await transaction(pool, async (db) => {
        const locked = await one<UpdateRow>(
          db,
          "SELECT * FROM second_look_telegram_updates WHERE bot_id=$1 AND update_id=$2 AND state='processing' AND lease_id=$3 AND lease_expires_at>clock_timestamp() FOR UPDATE",
          [row.bot_id, row.update_id, row.lease_id],
        );
        requireCondition(
          locked,
          409,
          'TELEGRAM_LEASE_LOST',
          'The update lease expired.',
        );
        if (!locked.quota_charged) {
          const day = (await one<{ day: string }>(
            db,
            "SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD') AS day",
          ))!.day;
          if (payload.command === 'token' && link) {
            const active = await one(
              db,
              'SELECT id FROM accounts WHERE id=$1 AND disabled_at IS NULL FOR UPDATE',
              [link.account_id],
            );
            requireCondition(
              active,
              401,
              'SIGN_IN_REQUIRED',
              'The linked account is not active.',
            );
            await consumeFreeTokenQuota(
              db,
              link.account_id,
              day,
              tokenProviderConfig().freeDailyGlobalLimit,
            );
          } else {
            await transactionalLimit(
              db,
              `telegram-free:${row.bot_id}:${row.telegram_user_id}`,
              3,
              86400,
            );
            if (payload.command === 'token')
              await consumeAnonymousTokenBudget(
                db,
                day,
                tokenProviderConfig().freeDailyGlobalLimit,
              );
          }
          await transactionalLimit(db, RPC_GLOBAL_BUCKET, RPC_GLOBAL_LIMIT);
          await db.query(
            'UPDATE second_look_telegram_updates SET quota_charged=true WHERE bot_id=$1 AND update_id=$2',
            [row.bot_id, row.update_id],
          );
        }
      });
    }
    if (payload.command === 'token')
      response = telegramCardText(
        await services.token(payload.input, {
          accountId: link?.account_id ?? null,
          signal: AbortSignal.timeout(30000),
        }),
      );
    else if (payload.command === 'firewall')
      response = signatureText(
        await services.firewall(payload.input, AbortSignal.timeout(30000)),
      );
    else if (payload.command === 'link') {
      await exchangeTelegramLink(pool, payload.input, payload.userId);
      response =
        'Return to your signed-in Conclave account and confirm this Telegram account identifier: <code>' +
        String(payload.userId) +
        '</code>. The link is not active until that confirmation.';
    } else if (payload.command === 'sensitive')
      response =
        'This input appears to contain private key or recovery information. It was not saved or forwarded for inspection. Never send secrets to a bot.';
  } catch (error) {
    response =
      error instanceof ServiceError &&
      [
        'RATE_LIMITED',
        'TOKEN_FREE_QUOTA_EXHAUSTED',
        'TOKEN_FREE_BUDGET_EXHAUSTED',
      ].includes(error.code)
        ? 'The free-card limit has been reached. No paid check was started.'
        : error instanceof ServiceError && error.code === 'TOKEN_MINT_REQUIRED'
          ? 'Supply the exact Solana mint address. A ticker or pool link needs confirmation in the web app; the bot will not guess a token.'
          : 'The check could not be completed. No safety result is available. Request a new check explicitly if needed.';
  }
  const outgoing =
    payload.reply.kind === 'message'
      ? {
          chat_id: payload.reply.chatId,
          text: response,
          parse_mode: 'HTML',
          link_preview_options: { is_disabled: true },
          reply_parameters: {
            message_id: payload.reply.messageId,
            allow_sending_without_reply: false,
          },
        }
      : {
          inline_query_id: payload.reply.queryId,
          is_personal: true,
          cache_time: 0,
          results: [
            {
              type: 'article',
              id: digest(`${row.bot_id}:${row.update_id}`),
              title: 'Conclave · Second Look',
              description: 'Facts and explicit unknowns',
              input_message_content: {
                message_text: response,
                parse_mode: 'HTML',
                link_preview_options: { is_disabled: true },
              },
            },
          ],
          next_offset: '',
        };
  const id = crypto.randomUUID(),
    cipher = await encryptText(
      JSON.stringify(outgoing),
      `second-look:telegram-outbox:${id}`,
      keyring,
    );
  await transaction(pool, async (db) => {
    const locked = await one(
      db,
      "SELECT update_id FROM second_look_telegram_updates WHERE bot_id=$1 AND update_id=$2 AND lease_id=$3 AND state='processing' AND lease_expires_at>clock_timestamp() FOR UPDATE",
      [row.bot_id, row.update_id, row.lease_id],
    );
    requireCondition(
      locked,
      409,
      'TELEGRAM_LEASE_LOST',
      'The update lease expired.',
    );
    await db.query(
      'INSERT INTO second_look_telegram_outbox(id,bot_id,update_id,method,payload_ciphertext) VALUES($1,$2,$3,$4,$5)',
      [
        id,
        row.bot_id,
        row.update_id,
        payload.reply.kind === 'message' ? 'sendMessage' : 'answerInlineQuery',
        cipher,
      ],
    );
    await db.query(
      `UPDATE second_look_telegram_updates SET state='complete',lease_id=NULL,lease_expires_at=NULL,finished_at=clock_timestamp() WHERE bot_id=$1 AND update_id=$2`,
      [row.bot_id, row.update_id],
    );
  });
  return { processed: true, delivery: 'queued' };
}

/** A delivery attempt is recorded before its only network send. An ambiguous
 * outcome remains uncertain and is never retried automatically. */
export async function deliverNextTelegramMessage(
  pool: Pool,
  config: TelegramConfig,
  keyring: DataKeyring,
  fetcher: typeof fetch = fetch,
) {
  requireCondition(
    config.enabled && config.deliveryEnabled && config.botToken && config.botId,
    503,
    'TELEGRAM_DELIVERY_DISABLED',
    'Telegram delivery requires explicit configuration.',
  );
  const delivery = await transaction(pool, async (db) => {
    await db.query(
      `UPDATE second_look_telegram_outbox SET state='uncertain',finished_at=clock_timestamp() WHERE bot_id=$1 AND state='dispatching' AND dispatched_at<clock_timestamp()-interval '1 minute'`,
      [config.botId],
    );
    const row = await one<{
      id: string;
      method: 'sendMessage' | 'answerInlineQuery';
      payload_ciphertext: string;
    }>(
      db,
      `SELECT id,method,payload_ciphertext FROM second_look_telegram_outbox WHERE bot_id=$1 AND state='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`,
      [config.botId],
    );
    if (!row) return null;
    const dispatch = crypto.randomUUID();
    await db.query(
      `UPDATE second_look_telegram_outbox SET state='dispatching',dispatch_id=$2,dispatched_at=clock_timestamp() WHERE id=$1`,
      [row.id, dispatch],
    );
    return { ...row, dispatch };
  });
  if (!delivery) return { delivered: false, state: 'idle' };
  let state: 'delivered' | 'failed' | 'uncertain' = 'uncertain';
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 8000);
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const wait = <T>(promise: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const abort = () => reject(new Error('delivery unavailable'));
      if (controller.signal.aborted) {
        void promise.catch(() => {});
        abort();
        return;
      }
      controller.signal.addEventListener('abort', abort, { once: true });
      promise
        .then(resolve, reject)
        .finally(() => controller.signal.removeEventListener('abort', abort));
    });
  try {
    const payload = await decryptText(
      delivery.payload_ciphertext,
      `second-look:telegram-outbox:${delivery.id}`,
      keyring,
    );
    requireCondition(
      payload.length <= 50000 &&
        ['sendMessage', 'answerInlineQuery'].includes(delivery.method),
      503,
      'TELEGRAM_DELIVERY_INVALID',
      'The prepared delivery is invalid.',
    );
    const response = await wait(
      fetcher(
        `https://api.telegram.org/bot${config.botToken}/${delivery.method}`,
        {
          method: 'POST',
          body: payload,
          headers: { 'Content-Type': 'application/json' },
          signal: controller.signal,
          redirect: 'error',
          credentials: 'omit',
          cache: 'no-store',
        },
      ).then((r) => {
        if (controller.signal.aborted) void r.body?.cancel().catch(() => {});
        return r;
      }),
    );
    if (!response.body || response.redirected)
      throw new Error('delivery unavailable');
    reader = response.body.getReader();
    let bytes = 0,
      raw = '';
    const decoder = new TextDecoder('utf-8', { fatal: true });
    while (true) {
      const part = await wait(reader.read());
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 65536) throw new Error('delivery unavailable');
      raw += decoder.decode(part.value, { stream: true });
    }
    const body = JSON.parse(raw + decoder.decode());
    if (response.ok && body?.ok === true) state = 'delivered';
    else if (
      body?.ok === false &&
      Number.isInteger(body.error_code) &&
      body.error_code >= 400 &&
      body.error_code < 500
    )
      state = 'failed';
  } catch {
    /* Do not expose Bot API URLs, tokens, payloads or response diagnostics. */
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) {
      void reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }
  await pool.query(
    `UPDATE second_look_telegram_outbox SET state=$3,finished_at=clock_timestamp() WHERE id=$1 AND dispatch_id=$2 AND state='dispatching'`,
    [delivery.id, delivery.dispatch, state],
  );
  return { delivered: state === 'delivered', state };
}

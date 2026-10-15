'use client';
import { useEffect, useState } from 'react';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { object } from '../../lib/client/second-look';
import { ErrorNotice, Modal, useSecondLookApi } from './shared';
type Status = {
  linked: boolean;
  telegramUserId: string | null;
  deliveryEnabled: boolean;
  pending: null | {
    id: string;
    telegramUserId: string | null;
    expiresAt: string;
  };
};
const validStatus = (x: unknown): x is Status =>
  object(x) &&
  typeof x.linked === 'boolean' &&
  typeof x.deliveryEnabled === 'boolean' &&
  (x.telegramUserId === null || typeof x.telegramUserId === 'string') &&
  (x.pending === null ||
    (object(x.pending) &&
      typeof x.pending.id === 'string' &&
      typeof x.pending.expiresAt === 'string' &&
      (x.pending.telegramUserId === null ||
        typeof x.pending.telegramUserId === 'string')));
type Challenge = {
  id: string;
  expiresAt: string;
  requiresWebConfirmation: true;
  url: string;
};
const validChallenge = (x: unknown): x is Challenge =>
  object(x) &&
  typeof x.id === 'string' &&
  typeof x.expiresAt === 'string' &&
  x.requiresWebConfirmation === true &&
  typeof x.url === 'string' &&
  /^https:\/\/t\.me\/[a-zA-Z0-9_]+\?start=link_[a-zA-Z0-9_-]+$/.test(x.url);
export function TelegramPanel({
  accountId,
  onClose,
  onSignIn,
}: {
  accountId: string | null;
  onClose: () => void;
  onSignIn: () => void;
}) {
  const api = useSecondLookApi(accountId);
  const { run } = api;
  const [status, setStatus] = useState<Status | null>(null);
  const [challenge, setChallenge] = useState<Challenge | null>(null);
  const [remove, setRemove] = useState(false);
  useEffect(() => {
    if (accountId)
      void run(async (request) => {
        setStatus(
          await request('second-look/telegram/status', {
            validate: validStatus,
          }),
        );
      });
  }, [accountId, run]);
  const refresh = () =>
    run(async (request) => {
      setStatus(
        await request('second-look/telegram/status', { validate: validStatus }),
      );
    });
  return (
    <Modal title="Second Look in Telegram" onClose={onClose}>
      <p className="sl-muted">
        Check tokens and share a compact report from Telegram. Connect
        privately, then confirm the account here.
      </p>
      <ErrorNotice message={api.error} />
      {!accountId ? (
        <button
          className="sl-button sl-primary sl-wide"
          onClick={() => {
            onClose();
            onSignIn();
          }}
        >
          Sign in to connect
        </button>
      ) : status?.linked ? (
        <>
          <dl className="sl-quote">
            <div>
              <dt>Connected account ID</dt>
              <dd>{status.telegramUserId}</dd>
            </div>
          </dl>
          <label className="sl-checkbox sl-delivery">
            <input
              type="checkbox"
              checked={status.deliveryEnabled}
              disabled={api.busy}
              onChange={(e) => {
                const enabled = e.target.checked;
                void run(async (request) => {
                  const result = await request(
                    'second-look/telegram/delivery',
                    {
                      method: 'PATCH',
                      body: { enabled },
                      validate: (x): x is { deliveryEnabled: boolean } =>
                        object(x) && typeof x.deliveryEnabled === 'boolean',
                    },
                  );
                  setStatus({
                    ...status,
                    deliveryEnabled: result.deliveryEnabled,
                  });
                });
              }}
            />
            Allow Telegram delivery
          </label>
          <p className="sl-muted">
            Delivery is opt-in. Automatic market alerts are not part of this
            release.
          </p>
          {remove ? (
            <div className="sl-notice">
              <p>Disconnect this Telegram account?</p>
              <button
                className="sl-button sl-danger"
                disabled={api.busy}
                onClick={() =>
                  void run(async (request) => {
                    await request('second-look/telegram/link', {
                      method: 'DELETE',
                      validate: (x): x is { linked: false } =>
                        object(x) && x.linked === false,
                    });
                    setStatus({
                      linked: false,
                      telegramUserId: null,
                      deliveryEnabled: false,
                      pending: null,
                    });
                    setChallenge(null);
                    setRemove(false);
                  })
                }
              >
                Disconnect
              </button>
              <button
                className="sl-text-button"
                onClick={() => setRemove(false)}
              >
                Cancel
              </button>
            </div>
          ) : (
            <button className="sl-text-button" onClick={() => setRemove(true)}>
              Disconnect Telegram
            </button>
          )}
        </>
      ) : (
        <>
          {challenge ? (
            <div className="sl-telegram-link">
              <a
                className="sl-button sl-primary"
                href={challenge.url}
                target="_blank"
                rel="noopener noreferrer"
                referrerPolicy="no-referrer"
              >
                Open private bot
                <ExternalLink size={14} />
              </a>
              <p className="sl-muted">
                Press Start in Telegram, then return here.
              </p>
              <button
                className="sl-button"
                disabled={api.busy}
                onClick={() => void refresh()}
              >
                <RefreshCw size={14} />
                Check connection
              </button>
            </div>
          ) : (
            <button
              className="sl-button sl-primary sl-wide"
              disabled={api.busy}
              onClick={() =>
                void run(async (request) => {
                  setChallenge(
                    await request('second-look/telegram/link', {
                      body: {},
                      validate: validChallenge,
                    }),
                  );
                })
              }
            >
              {api.busy ? 'Checking…' : 'Connect Telegram'}
            </button>
          )}
          {status?.pending?.telegramUserId && (
            <div className="sl-notice">
              <p>
                Telegram account{' '}
                <strong>{status.pending.telegramUserId}</strong> responded.
                Match this ID with the bot before confirming.
              </p>
              <button
                className="sl-button sl-primary"
                disabled={api.busy}
                onClick={() =>
                  void run(async (request) => {
                    const pending = status.pending!;
                    await request(
                      `second-look/telegram/link/${pending.id}/confirm`,
                      {
                        body: { telegramUserId: pending.telegramUserId },
                        validate: (x): x is { linked: true } =>
                          object(x) && x.linked === true,
                      },
                    );
                    setStatus(
                      await request('second-look/telegram/status', {
                        validate: validStatus,
                      }),
                    );
                    setChallenge(null);
                  })
                }
              >
                Confirm this account
              </button>
            </div>
          )}
        </>
      )}
    </Modal>
  );
}

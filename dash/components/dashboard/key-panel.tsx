'use client';

import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { CopyButton } from '../copy-button';
import { describeError } from '@/lib/anonymo/client';
import { isApiKey, maskKey } from '@/lib/anonymo/key-store';
import { musdToUsdString, parseUsd } from '@/lib/anonymo/money';
import type { CreateKeyResponse, KeyCapsInput } from '@/lib/anonymo/types';

/** Create a key (shown once), paste an existing one, or forget it on this device. No identity fields anywhere. */
export function KeyPanel() {
  const { ready, demo, key, client, setKey, clearKey } = useAnonymo();
  const router = useRouter();
  const [created, setCreated] = useState<CreateKeyResponse | null>(null);
  const [remember, setRemember] = useState(true);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dailyCap, setDailyCap] = useState('');
  const [sealedOnly, setSealedOnly] = useState(false);
  const [pasted, setPasted] = useState('');
  const [method, setMethod] = useState<'create' | 'connect'>('create');

  async function create() {
    setBusy(true);
    setError('');
    const caps: KeyCapsInput = {};
    if (dailyCap.trim()) {
      const musd = parseUsd(dailyCap);
      if (musd === null || musd <= 0) {
        setError('Enter the daily cap as a dollar amount, like 5 or 12.50.');
        setBusy(false);
        return;
      }
      caps.daily_usd = musdToUsdString(musd);
    }
    if (sealedOnly) caps.sealed_only = true;
    try {
      setCreated(await client.createKey({ caps }));
      setSaved(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return null;

  if (created)
    return (
      <div className="panel-stack">
        <section className="key-reveal" aria-labelledby="key-title">
          <h2 id="key-title">Your key. This is the only time it is shown.</h2>
          <p className="muted">
            Anonymo keeps only a hash of it and cannot show it again or recover
            it. Anyone holding this key can spend its credit, so store it like a
            password.
          </p>
          <code>{created.key}</code>
          <div className="row">
            <CopyButton text={created.key} label="Copy key" />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={remember}
                onChange={(e) => setRemember(e.target.checked)}
              />
              Remember on this device
            </label>
          </div>
          <label className="checkbox">
            <input
              type="checkbox"
              checked={saved}
              onChange={(e) => setSaved(e.target.checked)}
            />
            I have stored this key somewhere safe
          </label>
          <div className="row">
            <button
              type="button"
              className="btn btn-primary"
              disabled={!saved}
              onClick={() => {
                setKey(created.key, remember);
                setCreated(null);
                router.push('/dashboard/funds');
              }}
            >
              View funding options
            </button>
          </div>
        </section>
      </div>
    );

  return (
    <div className="panel-stack">
      {key ? (
        <section className="panel">
          <header>
            <h2>Key on this device</h2>
            <span className="chip chip-signal">
              {demo ? 'demo key' : 'active'}
            </span>
          </header>
          <p className="mono">{maskKey(key)}</p>
          <p className="lede">
            Use it as a Bearer token with any OpenAI-compatible client, or paste
            it into a frontend from{' '}
            <Link href="/dashboard/presets">Presets</Link>.
          </p>
          <div className="row">
            <Link className="btn btn-primary" href="/dashboard/funds">
              Add funds
            </Link>
            <button type="button" className="btn btn-danger" onClick={clearKey}>
              Forget key on this device
            </button>
          </div>
          <p className="faint">
            Forgetting only removes it from this browser. The key and its credit
            keep working.
          </p>
        </section>
      ) : (
        <section className="panel">
          <fieldset className="task-tabs" aria-label="Key setup">
            <button
              type="button"
              aria-pressed={method === 'create'}
              onClick={() => {
                setError('');
                setMethod('create');
              }}
            >
              Create a key
            </button>
            <button
              type="button"
              aria-pressed={method === 'connect'}
              onClick={() => {
                setError('');
                setMethod('connect');
              }}
            >
              Use an existing key
            </button>
          </fieldset>
          {method === 'create' ? (
            <>
              <h2>Create your API key</h2>
              <p className="lede">
                Save the key somewhere private. You’ll use it to access your
                credit and chats.
              </p>
              <details>
                <summary className="muted" style={{ cursor: 'pointer' }}>
                  Optional limits
                </summary>
                <div className="panel-stack" style={{ marginTop: 12 }}>
                  <label className="field">
                    Daily spend cap (USD)
                    <input
                      className="input"
                      inputMode="decimal"
                      placeholder="No cap"
                      value={dailyCap}
                      onChange={(e) => setDailyCap(e.target.value)}
                    />
                  </label>
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={sealedOnly}
                      onChange={(e) => setSealedOnly(e.target.checked)}
                    />
                    Sealed only: this key may use anonymo-sealed and nothing
                    else
                  </label>
                </div>
              </details>
              <div className="row">
                <button
                  type="button"
                  className="btn btn-primary"
                  disabled={busy}
                  onClick={() => void create()}
                >
                  <KeyRound size={16} aria-hidden="true" />
                  {busy ? 'Creating…' : 'Create key'}
                </button>
              </div>
            </>
          ) : (
            <>
              <h2>Connect your key</h2>
              <form
                className="row"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (!isApiKey(pasted)) {
                    setError(
                      'That does not look like an Anonymo key (anm_live_…).',
                    );
                    return;
                  }
                  setKey(pasted, remember);
                  setPasted('');
                }}
              >
                <label className="sr-only" htmlFor="paste-key">
                  API key
                </label>
                <input
                  id="paste-key"
                  className="input mono"
                  style={{ flex: '1 1 200px', minWidth: 0 }}
                  type="password"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder="anm_live_…"
                  value={pasted}
                  onChange={(e) => setPasted(e.target.value)}
                />
                <button type="submit" className="btn">
                  Use this key
                </button>
              </form>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                Remember on this device
              </label>
            </>
          )}
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
        </section>
      )}
    </div>
  );
}

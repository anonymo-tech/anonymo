'use client';

import Link from 'next/link';
import { KeyRound } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { availableNymoRail } from '@/lib/anonymo/wallet-links';
import { setupHref, setupReturn } from '@/lib/anonymo/setup-return';
import { useEffect, useState } from 'react';
import { chainName } from '@/lib/anonymo/chains';
import { useAnonymo } from '../anonymo-provider';
import { NewKeyReveal } from './new-key-reveal';
import { CopyButton } from '../copy-button';
import { describeError } from '@/lib/anonymo/client';
import { dashboardSignup } from '@/lib/anonymo/dashboard-signup';
import { isApiKey, maskKey } from '@/lib/anonymo/key-store';
import { updateOn } from '@/lib/anonymo/updates';
import { musdToUsdString, parseUsd } from '@/lib/anonymo/money';
import type { CreateKeyResponse, DepositContracts, KeyCapsInput } from '@/lib/anonymo/types';
import { KeySafeControls } from './key-safe-controls';

/** Create a key (shown once), paste an existing one, or forget it on this device. No identity fields anywhere. */
export function KeyPanel() {
  const { ready, demo, key, client, setKey, clearKey } = useAnonymo();
  const router = useRouter();
  const target = setupReturn(useSearchParams().get('returnTo'));
  const fundsHref = setupHref('funds', target?.href);
  const nextHref = target?.href ?? '/dashboard/chat';
  const nextAction = !target || target.href === '/dashboard/chat' ? 'Open chat' : `Return to ${target.label}`;
  const fromChat = target?.href.split('?')[0] === '/dashboard/chat';
  const [created, setCreated] = useState<CreateKeyResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dailyCap, setDailyCap] = useState('');
  const [sealedOnly, setSealedOnly] = useState(false);
  const [pasted, setPasted] = useState('');
  const [remember, setRemember] = useState(true);
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
      const fresh = await client.createKey({ caps, dashboard_signup: await dashboardSignup(demo) });
      // A first key is kept in this tab at once, so leaving this screen early (to Funds, say) never strands a key
      // that already exists. "Remember on this device" still applies when the person confirms. A key already on the
      // device is never replaced until then: it may hold credit.
      if (!key) setKey(fresh.key, false);
      setCreated(fresh);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (!ready) return null;
  const keySafe = updateOn('keysafe', demo);

  function finishCreating(href: string, remember: boolean) {
    if (!created) return;
    setKey(created.key, remember);
    setCreated(null);
    router.push(href);
  }

  if (created)
    return (
      <div className="panel-stack">
        <NewKeyReveal secret={created.key} action={nextAction}
          remember={remember} onRememberChange={setRemember}
          onContinue={(remember) => finishCreating(nextHref, remember)}
          onAddFunds={fromChat ? (remember) => finishCreating(fundsHref, remember) : undefined}
          safe={keySafe ? (markSaved) => <KeySafeControls client={client} demo={demo} apiKey={created.key} onSaved={markSaved} /> : undefined}
        />
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
            <Link className="btn btn-primary" href={nextHref}>{nextAction}</Link>
            <Link className="btn" href={fundsHref}>
              Add funds
            </Link>
            {keySafe && <CopyButton text={key} label="Copy key" />}
            <button type="button" className="btn btn-danger" onClick={clearKey}>
              Forget key on this device
            </button>
          </div>
          <p className="faint">
            Forgetting only removes it from this browser. The key and its credit
            keep working.
          </p>
          {keySafe && <KeySafeControls client={client} demo={demo} apiKey={key} canRemove />}
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
              <details><summary className="muted">Funding options for later</summary><WalletFundingMethods /></details>
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
                  router.push(nextHref);
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
          {keySafe && <KeySafeControls client={client} demo={demo} apiKey={null} onUnlocked={(restored) => setKey(restored, remember)} />}
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

function WalletFundingMethods() {
  const { client } = useAnonymo();
  const [contracts, setContracts] = useState<DepositContracts | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    client.depositContracts(controller.signal).then(
      value => { if (!controller.signal.aborted) setContracts(value); },
      () => { if (!controller.signal.aborted) setContracts(null); },
    );
    return () => controller.abort();
  }, [client]);

  if (!contracts) return null;
  if (contracts.paused) return <p className="faint">New deposits are currently paused.</p>;
  const options = contracts.chains.filter(c => c.tokens.length).map(c =>
    `${c.tokens.map(t => t.symbol).join(' or ')} on ${chainName(c.chain)}`,
  );
  if (availableNymoRail(contracts.coin) && contracts.coin.price_usd) options.push('NYMO on Robinhood Chain for usage credit');
  return options.length ? <p className="faint">Wallet funding supports {options.join(' · ')}.</p> : null;
}

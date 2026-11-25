'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowRight } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAnonymo } from './anonymo-provider';
import { NewKeyReveal } from './dashboard/new-key-reveal';
import { AnonymoApiError, describeError } from '@/lib/anonymo/client';
import { canonicalCode, codeFromFragment, DEMO_CODE, formatCodeInput, type CodeRedemption } from '@/lib/anonymo/codes';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { loadKey } from '@/lib/anonymo/key-store';
import { adultStore } from '@/lib/anonymo/prefs';
import { setupReturn } from '@/lib/anonymo/setup-return';

export function RedeemCode() {
  const { ready, demo, key, client, setKey, refreshBalance } = useAnonymo();
  const adult = useDeviceStore(adultStore);
  const router = useRouter();
  const destination = setupReturn(useSearchParams().get('returnTo'));
  const nextHref = destination?.href ?? '/dashboard/chat';
  const nextAction = !destination || nextHref === '/dashboard/chat' ? 'Continue to chat' : `Return to ${destination.label}`;
  const [input, setInput] = useState('');
  const [error, setError] = useState('');
  const [result, setResult] = useState<CodeRedemption | null>(null);
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const submitting = useRef(false);
  const success = useRef<HTMLHeadingElement>(null);
  const code = canonicalCode(input);
  const invalid = input.replace(/-/g, '').length >= 16 && !code;

  useEffect(() => {
    function readScan() {
      const { hash, pathname, search } = window.location;
      if (!new URLSearchParams(hash.slice(1)).has('code')) return;
      window.history.replaceState(window.history.state, '', pathname + search);
      const scanned = codeFromFragment(hash);
      if (scanned) setInput(scanned);
      else setError('Check the 16 characters on your Anonymo Code.');
    }
    readScan();
    window.addEventListener('hashchange', readScan);
    return () => window.removeEventListener('hashchange', readScan);
  }, []);

  useEffect(() => {
    if (result) success.current?.focus();
  }, [result]);

  async function redeem() {
    if (!ready || !adult || !code || submitting.current || result) return;
    submitting.current = true;
    setBusy(true);
    setError('');
    try {
      const received = await client.redeemCode(code);
      // Keep a fresh funded key in this tab at once, as on the API key page.
      if (received.key && !loadKey(demo)) setKey(received.key, false);
      else refreshBalance();
      setInput('');
      setResult(received);
    } catch (e) {
      setError(e instanceof AnonymoApiError && e.status === 429
        ? 'Too many attempts. Wait a minute and try again.'
        : describeError(e));
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  if (!ready) return null;

  if (result) return (
    <section className="redeem-code panel-stack">
      <h1 className="redeem-amount" ref={success} tabIndex={-1}>${result.added_usd} added</h1>
      {result.key ? (
        <NewKeyReveal secret={result.key} action={nextAction} remember={remember} onRememberChange={setRemember}
          onContinue={(keep) => { setKey(result.key!, keep); router.push(nextHref); }} />
      ) : (
        <div className="row"><Link className="btn btn-primary" href={nextHref}>{nextAction} <ArrowRight size={17} aria-hidden="true" /></Link></div>
      )}
    </section>
  );

  return (
    <section className="redeem-code panel-stack" aria-labelledby="redeem-title">
      <header>
        <h1 id="redeem-title">Redeem an Anonymo Code</h1>
        <p className="muted">Get in with a code. No wallet needed.</p>
      </header>
      <form className="panel" onSubmit={(event) => { event.preventDefault(); void redeem(); }}>
        <label className="field">
          Anonymo Code
          <input className="input mono redeem-input" value={input} placeholder="XXXX-XXXX-XXXX-XXXX"
            maxLength={64} autoComplete="off" autoCapitalize="characters" spellCheck={false}
            aria-describedby="redeem-help" aria-invalid={invalid} disabled={busy}
            onChange={(event) => { setInput(formatCodeInput(event.target.value)); setError(''); }} />
        </label>
        <p id="redeem-help" className="muted">{invalid ? 'Check the 16 characters and try again.'
          : 'Type or paste the code, or scan the voucher’s QR code with your phone camera.'}</p>
        {demo && <p className="muted">Try <code>{DEMO_CODE}</code> for $25.</p>}
        {key && <p className="muted">Credit goes to the key ending in <span className="mono">{key.slice(-4)}</span>.</p>}
        {error && <p className="notice notice-rose" role="alert">{error}</p>}
        <div className="row"><button type="submit" className="btn btn-primary" disabled={busy || !adult || !code}>
          {busy ? 'Redeeming…' : 'Redeem code'}
        </button></div>
      </form>
    </section>
  );
}

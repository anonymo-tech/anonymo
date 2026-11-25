'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { describeError, type AnonymoClient, type RegionCompliance } from '@/lib/anonymo/client';
import { AI_DISCLOSURE, companionSignals, CRISIS_LINES, disclosureDelay, reminderDue } from '@/lib/anonymo/safety';

export function useCompanionCompliance(client: AnonymoClient, enabled: boolean, active: boolean, session: string) {
  const legacyNoticeAt = useRef(Date.now());
  const [status, setStatus] = useState<{ client: AnonymoClient; policy: RegionCompliance } | null>(null);
  const [refreshes, setRefreshes] = useState(0);
  const [lastAt, setLastAt] = useState<number | null>(null);
  const [disclosure, setDisclosure] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    let request: AbortController | undefined;
    const load = () => {
      request?.abort();
      const pending = new AbortController();
      request = pending;
      void client.regionCompliance(pending.signal).then((policy) => {
        if (!pending.signal.aborted) setStatus({ client, policy });
      }, () => undefined);
    };
    load();
    window.addEventListener('focus', load);
    return () => { window.removeEventListener('focus', load); request?.abort(); };
  }, [client, enabled, refreshes]);

  const policy = enabled && status?.client === client ? status.policy : null;
  const restricted = policy && !policy.access ? policy.mode : null;
  const interval = policy?.disclosure_interval_min ?? null;
  useEffect(() => {
    setLastAt(enabled && active && !restricted ? Date.now() : null);
    setDisclosure(false);
  }, [enabled, active, restricted, session]);

  useEffect(() => {
    if (!enabled || !active || restricted || lastAt === null) return;
    let timeout: number | undefined;
    const check = () => {
      window.clearTimeout(timeout);
      const delay = disclosureDelay(lastAt, Date.now(), interval);
      setDisclosure(delay === 0);
      if (delay) timeout = window.setTimeout(check, Math.min(delay, 2_147_483_647));
    };
    check();
    document.addEventListener('visibilitychange', check);
    return () => { window.clearTimeout(timeout); document.removeEventListener('visibilitychange', check); };
  }, [enabled, active, restricted, lastAt, interval]);

  function takeSignals(prompt: string) {
    const { crisis, asksAboutAI } = companionSignals(prompt);
    const now = Date.now();
    if (!enabled) {
      const aiReminder = reminderDue(legacyNoticeAt.current, now);
      if (aiReminder) legacyNoticeAt.current = now;
      return { aiReminder, crisis };
    }
    const aiReminder = asksAboutAI || (lastAt !== null && disclosureDelay(lastAt, now, interval) === 0);
    if (aiReminder) {
      setLastAt(now);
      setDisclosure(false);
    }
    return { aiReminder, crisis };
  }

  return {
    restricted,
    disclosure: enabled && active && !restricted && disclosure,
    takeSignals,
    refresh: () => setRefreshes((n) => n + 1),
  };
}

export function CompanionDisclosure() {
  return <p className="ai-reminder" role="status">{AI_DISCLOSURE}</p>;
}

export function RegionPage({ client, mode, onVerified }: {
  client: AnonymoClient;
  mode: RegionCompliance['mode'];
  onVerified: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const proofRequired = mode === 'proof_required';
  return (
    <section className="notice chat-col" aria-label="Region access">
      <h2>{proofRequired ? 'Age proof required' : 'Anonymo is unavailable in this region'}</h2>
      {proofRequired ? (
        <>
          <p className="muted">Your region requires a proof that you’re over 18. The proof is linked to your Anonymo key.</p>
          {client.hasKey ? (
            <form className="field" onSubmit={async (event) => {
              event.preventDefault();
              if (busy) return;
              const form = event.currentTarget;
              const proof = String(new FormData(form).get('proof') ?? '').trim();
              if (!proof) return;
              form.reset();
              setBusy(true);
              setError(null);
              try {
                await client.submitAgeProof(proof);
                onVerified();
              } catch (e) {
                setError(describeError(e));
              } finally {
                setBusy(false);
              }
            }}>
              <label className="field">
                Paste your age proof
                <textarea className="textarea" name="proof" maxLength={65_536} rows={3} required autoComplete="off" spellCheck={false} />
              </label>
              <div><button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Verifying…' : 'Verify age proof'}</button></div>
              {error && <p role="alert">{error}</p>}
            </form>
          ) : <Link className="btn btn-primary" href="/dashboard/key">Set up a key</Link>}
        </>
      ) : <p className="muted">Model access is unavailable here. You can still withdraw eligible credit.</p>}
      <Link className="btn btn-ghost" href="/dashboard/funds">Open funds</Link>
    </section>
  );
}

/** Shown alongside a message about suicide or self-harm. */
export function CrisisNotice() {
  return (
    <aside className="notice crisis-notice" aria-label="Crisis support">
      <strong>If you’re thinking about suicide or hurting yourself, you can talk to a person right now.</strong>
      <p className="muted">Free and confidential. If you’re in immediate danger, call your local emergency number.</p>
      <ul>
        {CRISIS_LINES.map((l) => (
          <li key={l.href}>
            <span className="crisis-where">{l.where} ·</span> {l.what}:{' '}
            <a href={l.href} {...(l.href.startsWith('http') ? { target: '_blank', rel: 'noreferrer noopener' } : {})}>
              {l.action}
            </a>
          </li>
        ))}
      </ul>
    </aside>
  );
}

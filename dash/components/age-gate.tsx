'use client';

import { Photo } from '@/components/photo';
import { useEffect, useRef } from 'react';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { adultStore, confirmAdult } from '@/lib/anonymo/prefs';

/**
 * 18+ notice on entry (Overview §10). It asks once per browser and stores only "confirmed" on this device: no date
 * of birth, no identity. It renders on the server so nothing shows before the question is answered.
 */
export function AgeGate() {
  const confirmed = useDeviceStore(adultStore);
  const button = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    document.documentElement.toggleAttribute('data-gated', !confirmed);
    if (!confirmed) button.current?.focus();
  }, [confirmed]);
  if (confirmed) return null;
  return (
    <dialog open className="age-gate" aria-modal="true" aria-labelledby="age-gate-title" aria-describedby="age-gate-text">
      <div className="age-gate-card">
        <Photo src="/mascot/avatar.jpg" alt="" width={64} height={64} style={{ borderRadius: 16 }} />
        <h2 id="age-gate-title">Adults only</h2>
        <p id="age-gate-text">
          Anonymo serves uncensored models for adults: no refusals for legal adult use, with a floor that stays on. You
          must be 18 or older, and of legal age where you live, to continue.
        </p>
        <div className="age-gate-actions">
          <button ref={button} type="button" className="btn btn-primary" onClick={confirmAdult}>
            I am 18 or older
          </button>
          <a className="btn btn-ghost" href="about:blank" rel="noreferrer">
            Leave
          </a>
        </div>
      </div>
    </dialog>
  );
}

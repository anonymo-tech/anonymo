'use client';

import { Photo } from '@/components/photo';
import { useEffect, useRef, useState } from 'react';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { adultStore, confirmAdult } from '@/lib/anonymo/prefs';
import { declareRegion, parseRegionDeclaration } from '@/lib/anonymo/region-declaration';
import { BUILT_WITH } from '@/lib/anonymo/updates';

/**
 * 18+ notice on entry (Overview §10). It asks once per browser and stores only "confirmed" on this device: no date
 * of birth, no identity. It renders on the server so nothing shows before the question is answered.
 */
export function AgeGate() {
  const confirmed = useDeviceStore(adultStore);
  const button = useRef<HTMLButtonElement>(null);
  const [region, setRegion] = useState('');
  const [invalid, setInvalid] = useState(false);
  const compliance = BUILT_WITH.has('compliance');
  useEffect(() => {
    document.documentElement.toggleAttribute('data-gated', !confirmed);
    const app = document.querySelector<HTMLElement>('.app-root');
    if (app) app.inert = !confirmed;
    if (!confirmed) button.current?.focus();
    return () => { if (app) app.inert = false; };
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
        {compliance && (
          <label className="field">
            Country or subdivision code (optional)
            <input className="input" value={region} maxLength={6} placeholder="CA or US-NY" aria-invalid={invalid}
              onChange={(e) => { setRegion(e.target.value); setInvalid(false); }} />
            {invalid && <span role="alert">Enter a country or subdivision code, such as CA or US-NY.</span>}
          </label>
        )}
        <div className="age-gate-actions">
          <button ref={button} type="button" className="btn btn-primary" onClick={() => {
            if (compliance && region.trim()) {
              const code = parseRegionDeclaration(region);
              if (!code) { setInvalid(true); return; }
              declareRegion(code);
            }
            confirmAdult();
          }}>
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

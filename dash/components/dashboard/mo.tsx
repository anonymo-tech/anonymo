'use client';

// Update "ventures": a Mo, one of the crew. Every Mo is the Anonymo plush, dressed with the plush maker's own artwork
// (lib/anonymo/plush-image.ts: outfits, hats, glasses, dyes) and wearing the face for what it is doing: calm while
// queued, focused while working, laughing when done, sad when a step fails. The pieces the wardrobe has no artwork
// for (a cape, hoodie strings, a scarf, the wall Red Team Mo peeks over) are sewn on top in felt, as an SVG. Tester
// Mo is the mascot photo in gold headphones. Sheets are rendered once per look and kept for the session.

import { useEffect, useState } from 'react';
import { plushCanvas } from '@/lib/anonymo/plush-image';
import { CREW, familyDye, moodFor, type Badge, type Role, type StepState } from '@/lib/anonymo/ventures';
import type { Plush } from '@/lib/anonymo/plush';

const sheets = new Map<string, Promise<string>>();

/** The six faces of one plush on a 3 × 2 sprite sheet, as a small JPEG. */
function sheetFor(id: string, plush: Plush): Promise<string> {
  let pending = sheets.get(id);
  if (!pending) {
    pending = plushCanvas(plush).then((full) => {
      const small = document.createElement('canvas');
      small.width = 600;
      small.height = 400;
      const ctx = small.getContext('2d');
      if (!ctx) throw new Error('This browser could not open a canvas.');
      ctx.drawImage(full, 0, 0, small.width, small.height);
      return small.toDataURL('image/jpeg', 0.86);
    });
    pending.catch(() => sheets.delete(id));
    sheets.set(id, pending);
  }
  return pending;
}

/** A Mo's plush: Builder Mos wear their model family's colour. */
function plushOf(role: Role, family?: string): Plush | null {
  const base = CREW[role]?.plush ?? null;
  return base && family ? { ...base, coat: familyDye(family), mask: familyDye(family) } : base;
}

function useSheet(role: Role, family?: string) {
  const id = `${role}:${family ? familyDye(family) : ''}`;
  const [shown, setShown] = useState<{ id: string; url: string } | null>(null);
  useEffect(() => {
    const plush = plushOf(role, family);
    if (!plush) return;
    let live = true;
    sheetFor(id, plush).then(
      (url) => live && setShown({ id, url }),
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [id, role, family]);
  return shown?.id === id ? shown.url : null;
}

const STITCH = '#f3e6dc';

/** Felt pieces the wardrobe has no artwork for, drawn over the 512-pixel tile (viewBox 0 0 100 100). */
function Felt({ badge }: { badge: Badge }) {
  if (!badge) return null;
  return (
    <svg className="mo-felt" viewBox="0 0 100 100" aria-hidden="true" preserveAspectRatio="none">
      {badge === 'cape' && (
        <g>
          <path d="M14 100 L26 70 Q50 78 74 70 L86 100 Z" fill="#8f1f36" />
          <path d="M18 99 L28 73 Q50 81 72 73 L82 99" fill="none" stroke={STITCH} strokeWidth="0.9" strokeDasharray="2 1.6" opacity="0.8" />
          <circle cx="50" cy="76" r="3.6" fill="#e7a93a" stroke="#7a4c12" strokeWidth="0.7" />
        </g>
      )}
      {badge === 'hoodie' && (
        <g strokeLinecap="round">
          <path d="M44 70 Q43 80 44.5 90" fill="none" stroke={STITCH} strokeWidth="1.6" />
          <path d="M56 70 Q57 80 55.5 90" fill="none" stroke={STITCH} strokeWidth="1.6" />
          <rect x="42.8" y="89" width="3.4" height="5" rx="1.2" fill="#c9a24a" />
          <rect x="53.8" y="89" width="3.4" height="5" rx="1.2" fill="#c9a24a" />
          <path d="M30 96 Q50 90 70 96" fill="none" stroke={STITCH} strokeWidth="0.8" strokeDasharray="2 1.5" opacity="0.7" />
        </g>
      )}
      {badge === 'scarf' && (
        <g>
          <path d="M29 67 Q50 76 71 67 L72 74 Q50 83 28 74 Z" fill="#d9a441" />
          <path d="M33 70 L35 77 M41 72 L42 79 M49 73 L49 80 M57 72 L56 79 M65 70 L64 77" stroke="#a33a2e" strokeWidth="2.2" />
          <path d="M58 76 L66 76 L68 98 L59 98 Z" fill="#d9a441" />
          <path d="M59 82 L67 82 M59.5 89 L67.5 89" stroke="#a33a2e" strokeWidth="2.2" />
          <path d="M29 67 Q50 76 71 67" fill="none" stroke={STITCH} strokeWidth="0.7" strokeDasharray="1.8 1.4" opacity="0.8" />
        </g>
      )}
      {badge === 'peeker' && (
        <g>
          <rect x="0" y="66" width="100" height="34" fill="#3a1b3d" />
          <path d="M0 66 H100" stroke={STITCH} strokeWidth="1" strokeDasharray="3 2" />
          <path d="M0 80 H100 M25 66 V80 M75 66 V80 M50 80 V100 M0 93 H100" stroke="#5a3360" strokeWidth="0.8" />
          <ellipse cx="31" cy="66" rx="9" ry="5.5" fill="#e3c9a6" />
          <ellipse cx="69" cy="66" rx="9" ry="5.5" fill="#e3c9a6" />
          <path d="M26 65 v3 M30 64.5 v3.5 M34 65 v3 M66 65 v3 M70 64.5 v3.5 M74 65 v3" stroke="#b39070" strokeWidth="0.7" />
        </g>
      )}
    </svg>
  );
}

export type MoProps = {
  role: Role;
  state?: StepState | 'idle';
  chosen?: boolean;
  /** Builder Mos wear their model family's colour. */
  family?: string;
  size?: number;
  /** Shown as the image's text alternative; leave empty when a caption beside it already names the Mo. */
  label?: string;
  className?: string;
};

export function Mo({ role, state = 'idle', chosen = false, family, size = 56, label = '', className = '' }: MoProps) {
  const mo = CREW[role] ?? CREW.boss;
  const sheet = useSheet(mo.role, mo.role === 'builder' ? family : undefined);
  const mood = moodFor(state, chosen);
  const style = {
    width: size,
    height: size,
    ...(sheet ? { backgroundImage: `url(${sheet})`, backgroundPosition: `${(mood % 3) * 50}% ${Math.floor(mood / 3) * 100}%` } : {}),
  };
  return (
    <span className={`mo mo-${role} ${className}`} data-state={state} data-chosen={chosen || undefined} role={label ? 'img' : undefined} aria-label={label || undefined} aria-hidden={label ? undefined : true}>
      {mo.plush ? <span className={sheet ? 'mo-face' : 'mo-face mo-loading'} style={style} /> : <img className="mo-face mo-photo" src="/mascot/headphones.jpg" alt="" width={size} height={size} decoding="async" />}
      <Felt badge={mo.badge} />
    </span>
  );
}

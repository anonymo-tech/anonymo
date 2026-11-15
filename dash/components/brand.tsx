import Link from 'next/link';
import { VENICE_BADGE } from '@/lib/anonymo/config';

/** The sleep-mask glyph: a stitched mask with two closed, gold-thread eyes. */
export function MaskGlyph({ size = 40 }: { size?: number }) {
  return (
    <svg className="mask-glyph" width={size} height={size / 2} viewBox="0 0 48 24" aria-hidden="true" focusable="false">
      <path
        d="M4 12C4 5.5 11 3.5 24 6.5 37 3.5 44 5.5 44 12s-7 8.5-20 5.5C11 20.5 4 18.5 4 12Z"
        fill="#3b1240"
        stroke="var(--pink)"
        strokeWidth="2"
        strokeLinejoin="round"
      />
      <g fill="none" stroke="var(--amber)" strokeWidth="1.6" strokeLinecap="round">
        <path d="M10.5 11.5q4.5 3.6 9 0M28.5 11.5q4.5 3.6 9 0" />
        <path d="M12.6 13.6l-.9 1.6M15 14.4v1.8M17.4 13.6l.9 1.6M30.6 13.6l-.9 1.6M33 14.4v1.8M35.4 13.6l.9 1.6" />
      </g>
    </svg>
  );
}

/** The Anonymo wordmark: the sleep-mask glyph and the lowercase name. */
export function Wordmark({ href = '/', size = 'md' }: { href?: string; size?: 'md' | 'lg' }) {
  return (
    <Link href={href} className={`wordmark wordmark-${size}`} aria-label="Anonymo home">
      <MaskGlyph size={size === 'lg' ? 96 : 44} />
      <span aria-hidden="true">anonymo</span>
    </Link>
  );
}

/** Square mark for small places: the mask glyph on a plum tile. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="8" fill="#2e1531" />
      <g transform="translate(2 10) scale(0.583)">
        <path d="M4 12C4 5.5 11 3.5 24 6.5 37 3.5 44 5.5 44 12s-7 8.5-20 5.5C11 20.5 4 18.5 4 12Z" fill="#3b1240" stroke="#ff5fae" strokeWidth="2.4" strokeLinejoin="round" />
        <path d="M10.5 11.5q4.5 3.6 9 0M28.5 11.5q4.5 3.6 9 0" fill="none" stroke="#f6b84b" strokeWidth="2" strokeLinecap="round" />
      </g>
    </svg>
  );
}

/** "Adults only" appears on every page (Overview §10). */
export function AdultsOnly({ compact = false }: { compact?: boolean }) {
  return (
    <span className="adults-only" title="Anonymo is for adults only.">
      18+{compact ? '' : ' · adults only'}
    </span>
  );
}

/**
 * Venice's official "Built in Venice" badge, shown only behind NEXT_PUBLIC_ANONYMO_VENICE_BADGE=1 (Overview §4, §10).
 * Never the "powered by" wording (Overview §10). Replace the text with Venice's official badge artwork once it is supplied.
 */
export function VeniceBadge() {
  if (!VENICE_BADGE) return null;
  return (
    <a className="venice-badge" href="https://venice.ai" rel="noopener noreferrer" target="_blank">
      Built in Venice
    </a>
  );
}

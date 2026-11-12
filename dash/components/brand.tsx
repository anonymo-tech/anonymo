import Link from 'next/link';
import { VENICE_BADGE } from '@/lib/anonymo/config';

/** The Anonymo wordmark: the name with its middle ("nym", a name) shown as a lifted redaction. */
export function Wordmark({ href = '/', size = 'md' }: { href?: string; size?: 'md' | 'lg' }) {
  return (
    <Link href={href} className={`wordmark wordmark-${size}`} aria-label="Anonymo home">
      <span aria-hidden="true">
        ano<span className="wordmark-redact">nym</span>o
      </span>
    </Link>
  );
}

/** Square mark for small places: a redaction bar over a seal dot. */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
      <rect width="32" height="32" rx="7" fill="var(--text)" />
      <rect x="6" y="12" width="20" height="8" rx="1.5" fill="var(--bg)" />
      <circle cx="23" cy="24.5" r="3" fill="var(--signal)" />
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

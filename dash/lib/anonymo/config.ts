// Where the dashboard sends requests. Demo mode serves every endpoint from in-browser fixtures (lib/anonymo/mock)
// so the workspace runs end to end while the gateway endpoints are still being built.
//
//   NEXT_PUBLIC_ANONYMO_API             gateway origin, e.g. https://api.example. Unset means demo mode.
//   NEXT_PUBLIC_ANONYMO_DEMO=1          force demo mode even when an API is set.
//   ?demo=1 / ?demo=0                   turn demo mode on or off for this browser tab.
//   NEXT_PUBLIC_ANONYMO_VENICE_BADGE=1  show the official "Built in Venice" badge (Overview §4, §10).

const DEMO_FLAG = 'anonymo.demo';

export const API_BASE = (process.env.NEXT_PUBLIC_ANONYMO_API ?? '').replace(/\/+$/, '');
export const VENICE_BADGE = process.env.NEXT_PUBLIC_ANONYMO_VENICE_BADGE === '1';
const FORCED_DEMO = process.env.NEXT_PUBLIC_ANONYMO_DEMO === '1';
/** What the server renders before the browser can read `?demo=`. */
export const DEMO_BY_DEFAULT = FORCED_DEMO || !API_BASE;

/** Demo mode for this tab. Reads `?demo=` and keeps the choice for the tab's session. */
export function isDemoMode(): boolean {
  if (FORCED_DEMO || !API_BASE) return true;
  if (typeof window === 'undefined') return false;
  const flag = new URLSearchParams(window.location.search).get('demo');
  try {
    if (flag === '1') sessionStorage.setItem(DEMO_FLAG, '1');
    if (flag === '0') sessionStorage.setItem(DEMO_FLAG, '0');
    return sessionStorage.getItem(DEMO_FLAG) === '1';
  } catch {
    return flag === '1';
  }
}

/** The base URL people paste into frontends. In demo mode it is a placeholder, not a working endpoint. */
export const publicApiBase = (demo: boolean) => (demo ? 'https://api.anonymo.example' : API_BASE);

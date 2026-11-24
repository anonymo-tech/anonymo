export const APP_START = '/dashboard/chat';
export const APP_SCOPE = '/dashboard/';
export const APP_WORKER = '/dashboard/app-sw.js';
export const APP_DISMISSAL = 'anonymo.app.dismissed';

export function isIosSafari(userAgent: string, touchPoints: number): boolean {
  const ios = /iPhone|iPad|iPod/.test(userAgent) ||
    (userAgent.includes('Macintosh') && touchPoints > 1);
  return ios && /Version\/\S+.*Safari\//.test(userAgent);
}

export function canRunAppWorker(apiBase: string, pageUrl: string): boolean {
  // Some setups proxy the gateway on the dashboard origin. Leave that entire origin to the browser.
  try {
    return !apiBase || new URL(apiBase, pageUrl).origin !== new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

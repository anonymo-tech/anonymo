import { API_BASE } from '@/lib/anonymo/config';
import { APP_START, canRunAppWorker } from '@/lib/anonymo/phone-app';
import offline from '@/lib/anonymo/phone-app-offline.html?raw';
import worker from '@/lib/anonymo/phone-app-worker.js?raw';
import { BUILT_WITH } from '@/lib/anonymo/updates';

export function GET(request: Request) {
  if (process.env.NODE_ENV !== 'production') return new Response(null, { status: 404 });
  const config = {
    enabled: BUILT_WITH.has('app') && canRunAppWorker(API_BASE, request.url),
    version: process.env.__VINEXT_BUILD_ID ?? '1',
    start: APP_START,
    offline,
  };
  return new Response(`const app = ${JSON.stringify(config)};\n${worker}`, {
    headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

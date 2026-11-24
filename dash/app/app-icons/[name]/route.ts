import { APP_ICONS, appIconPng } from '@/server/app-icon';
import { BUILT_WITH } from '@/lib/anonymo/updates';

// Served from code rather than committed PNGs: see server/app-icon.ts.
export function GET(request: Request) {
  const icon = APP_ICONS[new URL(request.url).pathname.split('/').pop() ?? ''];
  if (!icon || !BUILT_WITH.has('app')) return new Response(null, { status: 404 });
  return new Response(appIconPng(icon.size, icon.kind) as BodyInit, {
    headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' },
  });
}

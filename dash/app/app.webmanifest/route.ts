import type { MetadataRoute } from 'next';
import { APP_SCOPE, APP_START } from '@/lib/anonymo/phone-app';
import { BUILT_WITH } from '@/lib/anonymo/updates';

const manifest: MetadataRoute.Manifest = {
  id: APP_START,
  name: 'Anonymo',
  short_name: 'Anonymo',
  start_url: APP_START,
  scope: APP_SCOPE,
  display: 'standalone',
  theme_color: '#1b0b1d',
  background_color: '#1b0b1d',
  icons: [
    { src: '/app-icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/app-icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/app-icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};

export function GET() {
  if (!BUILT_WITH.has('app')) return new Response(null, { status: 404 });
  return Response.json(manifest, {
    headers: { 'Content-Type': 'application/manifest+json', 'Cache-Control': 'no-cache' },
  });
}

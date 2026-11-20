import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  async headers() {
    // Deliver public reading pages as authored, including when served through the CDN.
    return ['/', '/docs', '/brief', '/whitepaper', '/roadmap'].map((source) => ({
      source,
      headers: [{ key: 'Cache-Control', value: 'private, no-store, no-transform' }],
    }));
  },
};

export default nextConfig;

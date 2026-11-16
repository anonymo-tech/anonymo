import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/figtree/index.css';
import '@fontsource-variable/newsreader/opsz.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';
import { AgeGate } from '@/components/age-gate';
import { AnonymoProvider } from '@/components/anonymo-provider';
import { RevealOnScroll } from '@/components/reveal';

export const metadata: Metadata = {
  title: 'Anonymo — Ask anything. Keep the receipt.',
  description:
    'One OpenAI-compatible key for uncensored and low-refusal models. No refusals for legal adult use, refused attempts refunded, a signed receipt on every call. Adults only.',
  icons: { icon: '/favicon.svg' },
  referrer: 'no-referrer',
  // Link previews in chat apps and social posts.
  openGraph: {
    type: 'website',
    siteName: 'Anonymo',
    title: 'Anonymo — Ask anything. Keep the receipt.',
    description: 'Private AI chat for adults. No account, no email. Just a key, and a signed receipt for every answer.',
  },
  twitter: {
    card: 'summary',
    title: 'Anonymo — Ask anything. Keep the receipt.',
    description: 'Private AI chat for adults. No account, no email. Just a key, and a signed receipt for every answer.',
  },
};

export const viewport: Viewport = { themeColor: '#1b0b1d', colorScheme: 'dark' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-gated="">
      <body>
        <AnonymoProvider>
          <div className="app-root">{children}</div>
          <AgeGate />
          <RevealOnScroll />
        </AnonymoProvider>
      </body>
    </html>
  );
}

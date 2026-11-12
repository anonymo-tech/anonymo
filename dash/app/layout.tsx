import type { Metadata, Viewport } from 'next';
import '@fontsource/ibm-plex-sans/400.css';
import '@fontsource/ibm-plex-sans/500.css';
import '@fontsource/ibm-plex-sans/600.css';
import '@fontsource/ibm-plex-mono/400.css';
import '@fontsource/ibm-plex-mono/500.css';
import './globals.css';
import { AgeGate } from '@/components/age-gate';
import { AnonymoProvider } from '@/components/anonymo-provider';

export const metadata: Metadata = {
  title: 'Anonymo — Ask anything. Get an answer. One key.',
  description:
    'One OpenAI-compatible key for uncensored and low-refusal models. No refusals for legal adult use, refused attempts refunded, a signed receipt on every call. Adults only.',
  icons: { icon: '/favicon.svg' },
  referrer: 'no-referrer',
};

export const viewport: Viewport = { themeColor: '#0d0f0d', colorScheme: 'dark' };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-gated="">
      <body>
        <AnonymoProvider>
          <div className="app-root">{children}</div>
          <AgeGate />
        </AnonymoProvider>
      </body>
    </html>
  );
}

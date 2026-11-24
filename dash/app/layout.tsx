import type { Metadata, Viewport } from 'next';
import '@fontsource-variable/space-grotesk/index.css';
import './globals.css';
import { AgeGate } from '@/components/age-gate';
import { AnonymoProvider } from '@/components/anonymo-provider';
import { MascotChat } from '@/components/mascot-chat';
import { PhoneApp } from '@/components/phone-app';
import { RevealOnScroll } from '@/components/reveal';
import { BUILT_WITH } from '@/lib/anonymo/updates';

const appOn = BUILT_WITH.has('app');

export const metadata: Metadata = {
  title: 'Anonymo — Ask anything. Keep the receipt.',
  description:
    'One OpenAI-compatible key for uncensored and low-refusal models. No refusals for legal adult use, refused attempts refunded, a signed receipt on every call. Adults only.',
  icons: { icon: '/favicon.svg', ...(appOn && { apple: '/app-icons/apple-touch-icon.png' }) },
  ...(appOn && {
    manifest: '/app.webmanifest',
    appleWebApp: { capable: true, statusBarStyle: 'black-translucent', title: 'Anonymo' },
    other: { 'apple-mobile-web-app-capable': 'yes' },
  }),
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
  const content = (
    <AnonymoProvider>
      <div className="app-root"><MascotChat>{children}</MascotChat></div>
      <AgeGate />
      <RevealOnScroll />
    </AnonymoProvider>
  );
  return (
    <html lang="en" data-gated="" data-phone-app={appOn ? '' : undefined}>
      <body>
        {appOn ? <PhoneApp>{content}</PhoneApp> : content}
      </body>
    </html>
  );
}

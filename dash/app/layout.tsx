import type { Metadata } from 'next';
import '@fontsource/anton/400.css';
import '@fontsource/instrument-serif/400.css';
import '@fontsource/instrument-serif/400-italic.css';
import '@fontsource/jetbrains-mono/400.css';
import './globals.css';
import './conclave-typography.css';
import './i18n.css';
import { LocaleSync } from '@/components/locale-sync';

export const metadata: Metadata = {
  title: 'Conclave — See what one model misses.',
  description:
    'A multi-model AI chat built for Solana. Ask seven models in one room, compare up to four side by side, and sign in with a wallet or a passkey.',
  icons: { icon: '/favicon.svg' },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <LocaleSync />
        {children}
      </body>
    </html>
  );
}

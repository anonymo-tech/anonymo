import { notFound } from 'next/navigation';
import { TelegramMini } from '@/components/telegram-mini';
import { DEMO_BY_DEFAULT } from '@/lib/anonymo/config';
import { updateOn } from '@/lib/anonymo/updates';
import '../telegram.css';

export const metadata = { title: 'Anonymo in Telegram', robots: { index: false, follow: false } };

export default function TelegramMiniPage() {
  if (!updateOn('telegram', DEMO_BY_DEFAULT)) notFound();
  return <TelegramMini />;
}

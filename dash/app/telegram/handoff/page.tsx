import { notFound } from 'next/navigation';
import { TelegramHandoff } from '@/components/telegram-handoff';
import { DEMO_BY_DEFAULT } from '@/lib/anonymo/config';
import { updateOn } from '@/lib/anonymo/updates';
import '../telegram.css';

export const metadata = { title: 'Open Anonymo', robots: { index: false, follow: false } };

export default function TelegramHandoffPage() {
  if (!updateOn('telegram', DEMO_BY_DEFAULT)) notFound();
  return <TelegramHandoff />;
}

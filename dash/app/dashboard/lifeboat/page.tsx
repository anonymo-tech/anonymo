import { notFound } from 'next/navigation';
import { MoveInWorkspace } from '@/components/dashboard/move-in';
import { DEMO_BY_DEFAULT } from '@/lib/anonymo/config';
import { updateOn } from '@/lib/anonymo/updates';

export const metadata = { title: 'Lifeboat — Anonymo' };

export default function LifeboatPage() {
  if (!updateOn('lifeboat', DEMO_BY_DEFAULT)) notFound();
  return <MoveInWorkspace />;
}

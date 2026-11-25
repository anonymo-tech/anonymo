import { MoveInWorkspace } from '@/components/dashboard/move-in';
import { DEMO_BY_DEFAULT } from '@/lib/anonymo/config';
import { updateOn } from '@/lib/anonymo/updates';

export const metadata = { title: updateOn('lifeboat', DEMO_BY_DEFAULT) ? 'Lifeboat — Anonymo' : 'Move in — Anonymo' };

export default function MoveInPage() {
  return <MoveInWorkspace />;
}

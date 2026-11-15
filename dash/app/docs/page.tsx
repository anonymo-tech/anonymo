import { DocsView } from '@/components/docs-view';
import { PublicPage } from '@/components/site-chrome';

export const metadata = {
  title: 'API docs — Anonymo',
  description: 'Use Anonymo from any OpenAI-compatible client: keys, chat completions, model IDs, receipts and errors.',
};

export default function DocsPage() {
  return (
    <PublicPage bare>
      <DocsView />
    </PublicPage>
  );
}

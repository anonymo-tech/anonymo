import { redirect } from 'next/navigation';
import { RESEARCH_CHAT } from '@/lib/anonymo/askmo';

export default async function AskMoPage({ searchParams }: { searchParams: Promise<{ demo?: string }> }) {
  const { demo } = await searchParams;
  redirect(demo === '1' ? RESEARCH_CHAT + '&demo=1' : RESEARCH_CHAT);
}

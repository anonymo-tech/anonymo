'use client';

import Link from 'next/link';
import { Phone } from 'lucide-react';
import { useAnonymo } from '../anonymo-provider';
import { characterDestination } from '@/lib/anonymo/setup-return';
import { updateOn } from '@/lib/anonymo/updates';

export function MoVoiceLink({ character, className }: { character?: string | null; className?: string }) {
  const { demo, ready } = useAnonymo();
  if (!ready || !updateOn('movoice', demo)) return null;
  return <Link className={className ?? 'btn btn-small'} href={characterDestination('mo-voice', character)}>
    <Phone size={15} aria-hidden="true" /> Call
  </Link>;
}

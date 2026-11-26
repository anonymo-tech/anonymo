'use client';

import Link from 'next/link';
import { ArrowRight, ArrowUpRight } from 'lucide-react';
import { useAnonymo } from '../anonymo-provider';
import { available, developerLinks, settingsTabs } from './workspace-sections';

const lists = { settings: settingsTabs.slice(1), developers: developerLinks };

/** A plain list of places, one row each, filtered to what this build and tab can open. */
export function LinkRows({ list, label }: { list: keyof typeof lists; label: string }) {
  const { ready, demo } = useAnonymo();
  return (
    <nav className="link-rows" aria-label={label}>
      {available(lists[list], ready && demo).map(({ href, label: name, detail, icon: Icon }) => {
        const away = !href.startsWith('/dashboard');
        const Arrow = away ? ArrowUpRight : ArrowRight;
        return (
          <Link href={href} key={href}>
            <Icon size={18} strokeWidth={1.65} aria-hidden="true" />
            <span>
              <strong>{name}</strong>
              {detail && <small>{detail}</small>}
            </span>
            <Arrow size={16} aria-hidden="true" />
          </Link>
        );
      })}
    </nav>
  );
}

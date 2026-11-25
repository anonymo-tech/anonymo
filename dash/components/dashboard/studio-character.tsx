'use client';

import Link from 'next/link';
import type { StoredCharacter } from '@/lib/anonymo/characters-store';

export function StudioCharacter({ characters, selected, onChange }: {
  characters: StoredCharacter[];
  selected: string;
  onChange: (id: string) => void;
}) {
  if (!characters.length) return <p className="muted">Add a character in <Link href="/dashboard/characters">Characters</Link> to use it here.</p>;
  return (
    <label className="field">
      <span>Character</span>
      <select className="select" value={selected} onChange={(event) => onChange(event.target.value)}>
        <option value="">No character selected</option>
        {characters.map(({ id, card }) => <option key={id} value={id}>{card.data.name}</option>)}
      </select>
    </label>
  );
}

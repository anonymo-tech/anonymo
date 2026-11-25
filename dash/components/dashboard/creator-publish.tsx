'use client';

import Link from 'next/link';
import { useState } from 'react';
import { connectWallet } from '@/lib/anonymo/wallet';
import { creatorProvider, signCreatorRequest } from '@/lib/anonymo/creator-wallet';
import { shareBasisPoints, type PublishCharacter } from '@/lib/anonymo/creators';
import { cardHash, normalizeCard } from '@/lib/anonymo/card';
import { describeError } from '@/lib/anonymo/client';
import type { StoredCharacter } from '@/lib/anonymo/characters-store';
import { useAnonymo } from '../anonymo-provider';

export function CreatorPublish({ character, close }: { character: StoredCharacter; close: () => void }) {
  const { client, demo, key } = useAnonymo();
  const [share, setShare] = useState('15');
  const [adult, setAdult] = useState(false);
  const [tags, setTags] = useState(character.card.data.tags.slice(0, 12).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [published, setPublished] = useState(false);

  async function publish() {
    setBusy(true);
    setError('');
    try {
      const shareBps = shareBasisPoints(share);
      const provider = demo ? null : creatorProvider();
      const creatorWallet = provider ? await connectWallet(provider) : '0x1111111111111111111111111111111111111111'; // gitleaks:allow
      const { name, description, personality, scenario } = character.card.data;
      const profile = {
        name: name.slice(0, 80).trim(), description: description.slice(0, 2000).trim(),
        personality: personality.slice(0, 1000).trim(), scenario: scenario.slice(0, 1000).trim(),
        tags: [...new Set(tags.split(',').map((tag) => tag.trim().slice(0, 32).toLowerCase()).filter(Boolean))].slice(0, 12),
      };
      const payload: PublishCharacter = { ...profile, cardHash: await cardHash(normalizeCard(profile)), creatorWallet, shareBps, adult };
      const body = JSON.stringify(payload);
      await client.publishCreator(body, provider ? await signCreatorRequest(provider, creatorWallet, body) : '');
      setPublished(true);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel" aria-label="Publish character">
    <header><h2>Publish {character.card.data.name}</h2><button className="btn btn-small" type="button" onClick={close}>Close</button></header>
    {published ? <p role="status">Published. <Link href="/dashboard/discover">Open Discover</Link> or <Link href="/dashboard/creators">view Creator Cut</Link>.</p> :
      <form className="panel-stack" onSubmit={(event) => { event.preventDefault(); void publish(); }}>
        <p className="lede">Get a share of what your characters bring in. Discover lists the public profile with a generated thumbnail.</p>
        <div className="creator-filters">
          <label className="field">Share of paid chats (%)<input className="input" inputMode="decimal" value={share} onChange={(e) => setShare(e.target.value)} required /></label>
          <label className="field">Tags, separated by commas<input className="input" value={tags} onChange={(e) => setTags(e.target.value)} maxLength={400} /></label>
        </div>
        <label className="checkbox"><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} />Adult character</label>
        <p className="muted">The public profile uses the name, description, personality, scenario and tags. The original card stays on this device.</p>
        {error && <p className="notice notice-rose" role="alert">{error}</p>}
        <div>{key
          ? <button className="btn btn-primary" disabled={busy}>{busy ? 'Publishing…' : 'Publish character'}</button>
          : <Link className="btn btn-primary" href="/dashboard/key">Set up an API key</Link>}</div>
      </form>}
  </section>;
}

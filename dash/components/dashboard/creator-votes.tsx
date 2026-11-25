'use client';

import { Vote } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { CreatorVotes } from '@/lib/anonymo/creators';
import { describeError } from '@/lib/anonymo/client';
import { voteForCreatorOption } from '@/lib/anonymo/creator-wallet';
import { formatUnits } from '@/lib/anonymo/wallet';
import { useAnonymo } from '../anonymo-provider';

const BALLOTS = ['Stock voices', 'Featured characters', 'Model families'];

export function CreatorVotesPanel() {
  const { client, demo } = useAnonymo();
  const [data, setData] = useState<CreatorVotes | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const abort = new AbortController();
    void client.creatorVotes(abort.signal).then(setData, (e) => { if (!abort.signal.aborted) setError(describeError(e)); });
    return () => abort.abort();
  }, [client]);

  async function vote(option: CreatorVotes['options'][number]) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (demo) {
        const actions = await import('@/lib/anonymo/mock/creator-actions');
        actions.demoVote(option.option);
      } else await voteForCreatorOption(await client.creatorContracts(), option.ballot, option.option);
      setData(await client.creatorVotes());
      setNotice(`Vote confirmed for ${option.label}.`);
    } catch (error) {
      setError(describeError(error));
    } finally {
      setBusy(false);
    }
  }

  return <div className="panel-stack">
    <p className="lede">Vote for stock voices, featured characters and model families. Each wallet is capped at 2% of a vote.</p>
    {data && <p className="muted">Epoch {data.epoch} closes {new Date(data.closesAt).toLocaleString()}.</p>}
    {notice && <p className="notice notice-signal" role="status">{notice}</p>}
    {error && <p className="notice notice-rose" role="alert">{error}</p>}
    {data ? BALLOTS.map((title, ballot) => <section className="panel" key={title}><h2>{title}</h2>
      {data.options.some((option) => option.ballot === ballot) ? data.options.filter((option) => option.ballot === ballot).map((option) =>
        <article className="notice notice-action" key={option.option}>
          <div><strong>{option.label}</strong><p className="muted">{formatUnits(BigInt(option.tally), 18, 2)} weight</p></div>
          <button className="btn btn-small" type="button" disabled={busy} onClick={() => void vote(option)}><Vote size={16} /> Vote</button>
        </article>) : <p className="muted">There are no options on this ballot yet.</p>}
    </section>) : !error && <p role="status">Loading the current epoch…</p>}
  </div>;
}

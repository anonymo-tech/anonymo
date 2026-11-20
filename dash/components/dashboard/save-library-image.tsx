'use client';

import Link from 'next/link';
import { BookmarkPlus } from 'lucide-react';
import { useState } from 'react';
import { saveLibraryImages } from '@/lib/anonymo/library-store';
import { VaultLocked } from '@/lib/anonymo/vault';
import { useVault } from './vault-controls';

export function SaveLibraryImage({ demo, src, title }: { demo: boolean; src: string; title: string }) {
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState('');
  const { mode } = useVault();

  async function save() {
    setStatus('saving');
    setError('');
    try {
      if (!src.startsWith('blob:')) throw new Error('Image is not in this tab.');
      const response = await fetch(src);
      await saveLibraryImages(demo, [{ png: await response.blob(), title }]);
      setStatus('saved');
    } catch (err) {
      setError(err instanceof VaultLocked ? err.message : 'Couldn’t save the image on this device.');
      setStatus('idle');
    }
  }

  if (status === 'saved') return <Link className="btn btn-small" href="/dashboard/library">Saved in Library</Link>;
  return (
    <>
      <button className="btn btn-small" type="button" disabled={status === 'saving' || mode === 'loading'} onClick={() => void save()}>
        <BookmarkPlus size={15} aria-hidden="true" /> {status === 'saving' ? 'Saving…' : 'Save to library'}
      </button>
      {error && <span className="library-save-error" role="alert">{error}</span>}
    </>
  );
}

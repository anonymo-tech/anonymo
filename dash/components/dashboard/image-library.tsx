'use client';

import Link from 'next/link';
import { Download, Images, LockKeyhole, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAnonymo } from '../anonymo-provider';
import { Photo } from '../photo';
import { deleteLibrary, deleteLibraryImage, loadLibrary, saveLibraryImages, type LibraryImage } from '@/lib/anonymo/library-store';
import { demoImage } from '@/lib/anonymo/mock/images';
import { updateOn } from '@/lib/anonymo/updates';
import { useVault, VaultButton, VaultModal } from './vault-controls';

const samples = [
  { title: 'Dusk over the salt flats', width: 1024, height: 768 },
  { title: 'First light in the highlands', width: 1024, height: 1024 },
  { title: 'Violet hills', width: 768, height: 1024 },
];
const day = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' });

function ImageTile({ image, remove }: { image: LibraryImage; remove: () => void }) {
  const { png, title, savedAt } = image;
  const [src, setSrc] = useState('');
  const [view, setView] = useState(false);
  useEffect(() => {
    const url = URL.createObjectURL(png);
    setSrc(url);
    return () => URL.revokeObjectURL(url);
  }, [png]);

  const fileName = `anonymo-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'image'}.png`;
  const download = (
    <a className="btn btn-ghost btn-small" href={src} download={fileName} aria-label={`Download ${title}`}>
      <Download size={15} aria-hidden="true" /> Download
    </a>
  );

  return (
    <li className="shot">
      <button type="button" className="library-thumb" aria-label={`View ${title}`} onClick={() => setView(true)}>
        {src && <Photo src={src} alt="" />}
      </button>
      <div className="library-caption">
        <strong>{title}</strong>
        <small className="muted">{day.format(savedAt)}</small>
        <div className="vault-actions">
          {download}
          <button type="button" className="icon-btn icon-danger" aria-label={`Delete ${title}`} onClick={remove}>
            <Trash2 size={15} aria-hidden="true" />
          </button>
        </div>
      </div>
      {view && src && (
        <VaultModal title={title} close={() => setView(false)}>
          <Photo className="library-preview" src={src} alt={title} loading="eager" />
          <div className="vault-actions">{download}</div>
        </VaultModal>
      )}
    </li>
  );
}

function LibraryContents({ demo, revision }: { demo: boolean; revision: number }) {
  const [images, setImages] = useState<LibraryImage[] | null>(null);
  const [error, setError] = useState('');
  const [confirmAll, setConfirmAll] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let stale = false;
    loadLibrary(demo).then((next) => {
      if (!stale) setImages(next);
    }, () => {
      if (!stale) setError('Couldn’t open the image library.');
    });
    return () => { stale = true; };
  }, [demo, revision]);

  async function act(operation: () => Promise<void>, failure: string) {
    setBusy(true);
    setError('');
    try {
      await operation();
      setConfirmAll(false);
    } catch {
      setError(failure);
    } finally {
      setBusy(false);
    }
  }

  async function loadSamples() {
    const images = await Promise.all(samples.map(async ({ title, width, height }) => {
      const data = await demoImage(title, width, height);
      const png = new Blob([Uint8Array.from(atob(data), (byte) => byte.charCodeAt(0))], { type: 'image/png' });
      return { title, png };
    }));
    await saveLibraryImages(demo, images);
  }

  return (
    <>
      {error && <p className="notice notice-rose" role="alert">{error}</p>}
      {images === null ? (!error && <p className="muted" role="status">Opening library…</p>) : images.length ? (
        <>
          <div className="library-tools">
            <span className="muted">{images.length} {images.length === 1 ? 'image' : 'images'}</span>
            <button className="btn btn-ghost btn-small" type="button" disabled={busy} onClick={() => setConfirmAll(true)}>
              <Trash2 size={15} aria-hidden="true" /> Delete all
            </button>
          </div>
          <ul className="library-grid">
            {images.map((image) => (
              <ImageTile key={image.id} image={image} remove={() => {
                if (!busy) void act(() => deleteLibraryImage(demo, image.id), 'Couldn’t delete the image.');
              }} />
            ))}
          </ul>
        </>
      ) : (
        <div className="studio-empty">
          <Images size={32} strokeWidth={1.3} aria-hidden="true" />
          <strong>Your library is empty.</strong>
          <p className="muted">Save a studio result to keep it on this device.</p>
          <div className="vault-actions">
            {updateOn('images', demo) && <Link href="/dashboard/images" className="btn btn-small">Open image studio</Link>}
            {demo && <button className="btn btn-small" type="button" disabled={busy} onClick={() => void act(loadSamples, 'Couldn’t save the demo images.')}>{busy ? 'Loading samples…' : 'Load sample images'}</button>}
          </div>
        </div>
      )}
      {confirmAll && (
        <VaultModal title="Delete all saved images?" busy={busy} close={() => setConfirmAll(false)}>
          <p>This can’t be undone.</p>
          {error && <p className="notice notice-rose" role="alert">{error}</p>}
          <div className="vault-actions">
            <button type="button" className="btn btn-danger btn-small" disabled={busy} onClick={() => void act(() => deleteLibrary(demo), 'Couldn’t delete the images.')}>Delete all</button>
            <button type="button" className="btn btn-ghost btn-small" disabled={busy} onClick={() => setConfirmAll(false)}>Cancel</button>
          </div>
        </VaultModal>
      )}
    </>
  );
}

export function ImageLibrary() {
  const { demo } = useAnonymo();
  const { mode, revision } = useVault();

  return (
    <div className="device-library">
      <div className="library-tools library-status">
        <span className="chip">{mode === 'unlocked' ? 'Encrypted on this device' : mode === 'locked' ? 'Vault locked' : 'On this device'}</span>
        <VaultButton settings />
      </div>
      {mode === 'locked' ? (
        <div className="studio-empty">
          <LockKeyhole size={32} strokeWidth={1.3} aria-hidden="true" />
          <strong>Your library is locked.</strong>
          <p className="muted">Unlock the vault to view saved images.</p>
        </div>
      ) : mode === 'unavailable' ? <p className="notice notice-rose" role="alert">The library can’t access device storage.</p> : mode === 'loading' ? (
        <p className="muted" role="status">Opening library…</p>
      ) : <LibraryContents key={String(demo)} demo={demo} revision={revision} />}
    </div>
  );
}

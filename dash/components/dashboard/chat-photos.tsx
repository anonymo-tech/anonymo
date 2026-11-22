'use client';

// Update "photos": attach up to four photos to a chat message (button, paste or drop). Each is shrunk and re-encoded
// in the browser (lib/anonymo/photos.ts), kept in this tab's memory only and sent with that one message.

import { ImagePlus, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MAX_PHOTOS, PHOTO_ACCEPT, PHOTO_NOTE, PhotoError, imageFiles, photoHint, preparePhoto, type PhotoSupport, type PreparedPhoto } from '@/lib/anonymo/photos';

export type PhotoTray = ReturnType<typeof usePhotos>;

/** The photos waiting to be sent with the next message. */
export function usePhotos(support: PhotoSupport) {
  const [photos, setPhotos] = useState<PreparedPhoto[]>([]);
  const [busy, setBusy] = useState(0);
  const [note, setNote] = useState('');
  // Photos already in the tray plus those still being prepared, read when more arrive (not during render).
  const held = useRef(0);
  const pending = useRef(0);
  useEffect(() => {
    held.current = photos.length;
  }, [photos]);

  const add = useCallback(async (input: Iterable<File> | ArrayLike<File> | null | undefined) => {
    const files = imageFiles(input);
    if (!files.length) return;
    if (!support.ok) {
      setNote(photoHint(support));
      return;
    }
    const room = MAX_PHOTOS - held.current - pending.current;
    if (room <= 0) {
      setNote(`Attach at most ${MAX_PHOTOS} photos.`);
      return;
    }
    setNote(files.length > room ? `Only ${MAX_PHOTOS} photos fit. The rest were left out.` : '');
    const take = files.slice(0, room);
    pending.current += take.length;
    setBusy((b) => b + take.length);
    for (const file of take) {
      try {
        const photo = await preparePhoto(file);
        setPhotos((list) => (list.length < MAX_PHOTOS ? [...list, photo] : list));
      } catch (e) {
        setNote(e instanceof PhotoError ? e.message : 'That photo could not be prepared.');
      } finally {
        pending.current--;
        setBusy((b) => b - 1);
      }
    }
  }, [support]);

  const remove = (id: string) => setPhotos((list) => list.filter((p) => p.id !== id));
  const clear = () => {
    setPhotos([]);
    setNote('');
  };
  return { photos, busy: busy > 0, note, setNote, add, remove, clear };
}

/** The attach button for the composer's tool row. It stays visible on text-only models and says which models can. */
export function PhotoButton({ tray, support, disabled }: { tray: PhotoTray; support: PhotoSupport; disabled?: boolean }) {
  const file = useRef<HTMLInputElement>(null);
  const full = tray.photos.length >= MAX_PHOTOS;
  return (
    <>
      <input
        ref={file}
        type="file"
        hidden
        multiple
        accept={PHOTO_ACCEPT}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          void tray.add(files);
        }}
      />
      <button
        type="button"
        className="tool"
        aria-disabled={!support.ok || full || disabled}
        disabled={disabled || tray.busy}
        title={support.ok ? `Attach up to ${MAX_PHOTOS} photos. ${PHOTO_NOTE}` : photoHint(support)}
        onClick={() => {
          if (!support.ok) tray.setNote(photoHint(support));
          else if (full) tray.setNote(`Attach at most ${MAX_PHOTOS} photos.`);
          else file.current?.click();
        }}
      >
        <ImagePlus size={14} aria-hidden="true" />
        {tray.busy ? 'Preparing photo…' : tray.photos.length ? `Photos ${tray.photos.length}/${MAX_PHOTOS}` : 'Photo'}
      </button>
    </>
  );
}

/** The photos waiting to go, with remove buttons and the "never saved" note. */
export function PhotoTrayView({ tray, support }: { tray: PhotoTray; support: PhotoSupport }) {
  if (!tray.photos.length && !tray.note) return null;
  return (
    <div className="photo-tray">
      {tray.photos.length > 0 && (
        <>
          <ul className="photo-thumbs" aria-label="Photos to send">
            {tray.photos.map((p, i) => (
              <li key={p.id} className="photo-thumb">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={p.dataUrl} alt={`Attachment ${i + 1}`} width={56} height={56} />
                <button type="button" aria-label={`Remove attachment ${i + 1}`} onClick={() => tray.remove(p.id)}>
                  <X size={12} aria-hidden="true" />
                </button>
              </li>
            ))}
          </ul>
          <span className="muted">{support.ok ? PHOTO_NOTE : photoHint(support)}</span>
        </>
      )}
      {tray.note && (
        <output className="photo-note">{tray.note}</output>
      )}
    </div>
  );
}

/** A sent message's photos in the thread. A saved chat has no photos, only how many there were. */
export function TurnPhotos({ photos, count }: { photos?: string[]; count?: number }) {
  if (photos?.length)
    return (
      <ul className="photo-thumbs photo-thumbs-sent" aria-label="Photos sent">
        {photos.map((url, i) => (
          <li key={i} className="photo-thumb">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={url} alt={`Attachment ${i + 1} sent with this message`} width={96} height={96} />
          </li>
        ))}
      </ul>
    );
  if (!count) return null;
  return (
    <ul className="photo-thumbs photo-thumbs-sent" aria-label="Photos sent">
      {Array.from({ length: count }, (_, i) => (
        <li key={i} className="photo-thumb photo-missing">
          Photo not saved
        </li>
      ))}
    </ul>
  );
}

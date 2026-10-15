'use client';
import { useEffect, useRef, useState } from 'react';
import type { ChatImage } from '../../lib/picture-this';
export function PictureThis({
  value,
  onChange,
}: {
  value: ChatImage[];
  onChange: (images: ChatImage[]) => void;
}) {
  const file = useRef<HTMLInputElement>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState('');
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function read(input: File) {
    const current = ++generation.current;
    setBusy(true);
    setError('');
    try {
      if (
        !['image/png', 'image/jpeg', 'image/webp'].includes(input.type) ||
        input.size > 10 * 1024 * 1024
      )
        throw new Error('Choose a PNG, JPEG or WebP smaller than 10 MB.');
      const bitmap = await createImageBitmap(input);
      try {
        if (bitmap.width * bitmap.height > 40000000)
          throw new Error('Choose an image below 40 megapixels.');
        const scale = Math.min(1, 1536 / Math.max(bitmap.width, bitmap.height)),
          canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('The image could not be read.');
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        if (current !== generation.current) return;
        onChange([{ dataUrl: canvas.toDataURL('image/jpeg', 0.9) }]);
      } finally {
        bitmap.close();
      }
    } catch (e) {
      if (current !== generation.current) return;
      setError(e instanceof Error ? e.message : 'The image could not be read.');
    } finally {
      if (current === generation.current) setBusy(false);
    }
  }
  return (
    <>
      <input
        ref={file}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp"
        onChange={(e) => {
          const input = e.target.files?.[0];
          e.target.value = '';
          if (input) void read(input);
        }}
      />
      <button
        type="button"
        disabled={busy}
        onClick={() => file.current?.click()}
      >
        {busy
          ? 'Reading image…'
          : value.length
            ? 'Replace picture'
            : 'Picture This'}
      </button>
      {value.length > 0 && (
        <>
          <span className="eu-note">
            Picture ready · Claude, GPT, Gemini or Grok
          </span>
          <button type="button" onClick={() => onChange([])}>
            Remove picture
          </button>
        </>
      )}
      {error && (
        <span role="alert" className="eu-error">
          {error}
        </span>
      )}
    </>
  );
}

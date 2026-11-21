'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Photo } from '@/components/photo';
import Link from 'next/link';
import {
  ArrowUpRight,
  Check,
  ChevronLeft,
  ChevronRight,
  Glasses,
  Layers,
  ScanFace,
  Shirt,
  Shuffle,
} from 'lucide-react';
import { EXPRESSIONS, EXPRESSION_LABEL } from '@/lib/anonymo/faces';
import { savePlush } from '@/lib/anonymo/faces-store';
import { sliceSheet } from '@/lib/anonymo/faces-image';
import {
  BASE_PLUSH,
  DYES,
  GLASSES,
  HATS,
  MARKS,
  MOUTHS,
  OUTFITS,
  SHAPES,
  dyeHex,
  headUrl,
  partUrl,
  type Plush,
} from '@/lib/anonymo/plush';
import { plushBlob, plushCanvas } from '@/lib/anonymo/plush-image';

function Swatches({
  label,
  value,
  select,
}: {
  label: string;
  value: Plush['coat'];
  select: (v: Plush['coat']) => void;
}) {
  return (
    <fieldset className="faces-field">
      <legend>
        {label} · {value}
      </legend>
      <div className="plush-swatches">
        {(Object.keys(DYES) as (keyof typeof DYES)[]).map((k) => (
          <button
            key={k}
            type="button"
            aria-label={`${label} ${k}`}
            title={k}
            aria-pressed={k === value}
            style={{ backgroundColor: DYES[k] }}
            onClick={() => select(k)}
          >
            {k === value && (
              <Check
                size={13}
                color={
                  parseInt(DYES[k].slice(3, 5), 16) > 145 ? '#241522' : '#fff'
                }
              />
            )}
          </button>
        ))}
        <label className="plush-custom">
          Custom
          <input
            type="color"
            aria-label={`Custom ${label.toLowerCase()} color`}
            value={dyeHex(value)}
            onChange={(e) => select(e.target.value as Plush['coat'])}
          />
        </label>
      </div>
    </fieldset>
  );
}

function Choices<T extends string>({
  label,
  options,
  value,
  select,
}: {
  label: string;
  options: readonly T[];
  value: T;
  select: (item: T) => void;
}) {
  return (
    <fieldset className="faces-field">
      <legend>{label}</legend>
      <div
        className={
          label === 'Hat' || label === 'Glasses'
            ? 'accessory-options'
            : 'plush-moods'
        }
      >
        {options.map((item) => (
          <button
            className="size-chip"
            type="button"
            key={item}
            aria-pressed={value === item}
            onClick={() => select(item)}
          >
            {(label === 'Hat' || label === 'Glasses') &&
              (item === 'None' ? (
                <span className="empty-part">∅</span>
              ) : label === 'Hat' &&
                (item === 'Flight helmet' || item === 'Star cap') ? (
                <span
                  className="part-head"
                  style={{
                    backgroundImage: `url(${headUrl(item === 'Star cap' ? 'stargazer' : 'pilot')})`,
                  }}
                />
              ) : (
                <span
                  className="part-image"
                  style={{
                    backgroundImage: `url(${partUrl(label === 'Hat' ? 'hat' : 'glasses', item)})`,
                  }}
                />
              ))}
            {item}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

export function PlushMaker({
  demo,
  id,
  name,
  saved,
  identity,
  onCreate,
}: {
  demo: boolean;
  id?: string;
  identity?: ReactNode;
  onCreate?: (design: Plush, tiles: Blob[]) => Promise<void>;
  name: string;
  saved?: Plush;
}) {
  const [draft, setDraft] = useState<Plush | null>(null);
  const design = draft ?? saved ?? BASE_PLUSH;
  const [section, setSection] = useState<'Outfit' | 'Face' | 'Accessories'>(
    'Outfit',
  );
  const [material, setMaterial] = useState<'felt' | 'mask' | 'thread'>('felt');
  const [mood, setMood] = useState(0);
  const portrait = useRef<HTMLDivElement>(null);
  const [compactPreview, setCompactPreview] = useState(false);
  useEffect(() => {
    if (!portrait.current || typeof IntersectionObserver === 'undefined')
      return;
    const observer = new IntersectionObserver(([entry]) =>
      setCompactPreview(
        !entry.isIntersecting && entry.boundingClientRect.bottom <= 0,
      ),
    );
    observer.observe(portrait.current);
    return () => observer.disconnect();
  }, []);
  const [preview, setPreview] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let current = true;
    plushCanvas(design, mood)
      .then((canvas) => {
        if (!current) return;
        setPreview(canvas.toDataURL('image/jpeg', 0.91));
        setError('');
      })
      .catch(() => {
        if (current) setError('The preview could not load.');
      });
    return () => {
      current = false;
    };
  }, [design, mood, retry]);

  function change(updates: Partial<Plush>) {
    setDraft({ ...design, ...updates });
    setNotice('');
  }
  function shuffle() {
    const pick = <T,>(items: readonly T[]) =>
      items[Math.floor(Math.random() * items.length)];
    const palette = Object.keys(DYES) as (keyof typeof DYES)[];
    change({
      outfit: pick(OUTFITS),
      hat: pick(HATS),
      glasses: pick(GLASSES),
      shape: pick(SHAPES),
      mouth: pick(MOUTHS),
      marks: pick(MARKS),
      coat: pick(palette),
      mask: pick(palette),
      thread: pick(palette),
      felt: pick(['Oat', 'Cocoa', 'Blush', 'Mint', 'Lilac']),
    });
  }
  async function save() {
    setSaving(true);
    setNotice('');
    try {
      const sheet = await plushBlob(await plushCanvas(design));
      const tiles = await sliceSheet(sheet);
      if (onCreate) await onCreate(design, tiles);
      else if (id) await savePlush(demo, id, design, tiles);
      setNotice('Saved. Your plush is ready in chat.');
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : 'This browser could not save your plush. Try again.',
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className="plush-maker"
      onSubmit={(e) => {
        e.preventDefault();
        if (saving) return;
        if (onCreate && !name.trim()) {
          const field = e.currentTarget.elements.namedItem(
            'characterName',
          ) as HTMLInputElement;
          field.focus();
          setError('Give your character a name to save it.');
          return;
        }
        void save();
      }}
    >
      <div className="plush-proof">
        <div className="proof-top">
          <span>
            <Layers size={15} aria-hidden="true" /> Portrait
          </span>
          <button
            type="button"
            title="Surprise me"
            onClick={shuffle}
            disabled={saving}
          >
            <Shuffle size={15} /> Surprise me
          </button>
        </div>
        <div className="portrait-print">
          <div className="portrait-picture" ref={portrait}>
            {preview ? (
              <Photo
                src={preview}
                alt={`${name || 'Your plush'}, ${design.outfit}, ${EXPRESSIONS[mood]}`}
                loading="eager"
              />
            ) : (
              <output>Loading portrait…</output>
            )}
          </div>
          <div className="proof-expression">
            <button
              type="button"
              aria-label="Previous expression"
              onClick={() => setMood((mood + 5) % 6)}
            >
              <ChevronLeft size={18} />
            </button>
            <select
              aria-label="Preview expression"
              value={mood}
              onChange={(e) => setMood(Number(e.target.value))}
            >
              {EXPRESSIONS.map((e, i) => (
                <option key={e} value={i}>
                  {EXPRESSION_LABEL[e]}
                </option>
              ))}
            </select>
            <button
              type="button"
              aria-label="Next expression"
              onClick={() => setMood((mood + 1) % 6)}
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
        <div className="proof-identity">{identity ?? <h2>{name}</h2>}</div>
      </div>
      <fieldset className="plush-controls" disabled={saving}>
        <fieldset className="plush-sections" aria-label="Customize">
          {compactPreview && preview && (
            <Photo className="mini-portrait" src={preview} alt="" />
          )}

          {(['Outfit', 'Face', 'Accessories'] as const).map((item) => {
            const Icon = {
              Outfit: Shirt,
              Face: ScanFace,
              Accessories: Glasses,
            }[item];
            return (
              <button
                type="button"
                key={item}
                aria-pressed={section === item}
                onClick={() => setSection(item)}
              >
                <Icon size={16} />
                {item}
              </button>
            );
          })}
        </fieldset>
        <div className="plush-inspector">
          {section === 'Outfit' && (
            <>
              <fieldset className="faces-field">
                <legend>Wardrobe</legend>
                <div className="plush-outfits">
                  {OUTFITS.map((outfit) => (
                    <button
                      type="button"
                      key={outfit}
                      aria-pressed={outfit === design.outfit}
                      onClick={() => change({ outfit })}
                    >
                      <span
                        aria-hidden="true"
                        style={{
                          backgroundImage: `url(${partUrl('outfit', outfit)})`,
                        }}
                      />
                      <strong>{outfit}</strong>
                      {outfit === design.outfit && (
                        <Check
                          className="outfit-check"
                          size={13}
                          aria-hidden="true"
                        />
                      )}
                    </button>
                  ))}
                </div>
              </fieldset>
              <Swatches
                label="Outfit dye"
                value={design.coat}
                select={(coat) => change({ coat })}
              />
            </>
          )}
          {section === 'Face' && (
            <>
              <Choices
                label="Face shape"
                options={SHAPES}
                value={design.shape}
                select={(shape) => change({ shape })}
              />
              <Choices
                label="Mouth"
                options={MOUTHS}
                value={design.mouth}
                select={(mouth) => change({ mouth })}
              />
              <Choices
                label="Cheek details"
                options={MARKS}
                value={design.marks}
                select={(marks) => change({ marks })}
              />
              <fieldset className="material-picker">
                <legend>Fabric colors</legend>
                <div>
                  {(['felt', 'mask', 'thread'] as const).map((m) => (
                    <button
                      type="button"
                      key={m}
                      aria-pressed={m === material}
                      onClick={() => setMaterial(m)}
                    >
                      <i style={{ backgroundColor: dyeHex(design[m]) }} />
                      {m === 'thread'
                        ? 'Stitching'
                        : m === 'mask'
                          ? 'Mask'
                          : 'Felt'}
                    </button>
                  ))}
                </div>
              </fieldset>
              <Swatches
                label={
                  { felt: 'Felt', mask: 'Mask', thread: 'Eye stitching' }[
                    material
                  ]
                }
                value={design[material]}
                select={(v) => change({ [material]: v })}
              />
            </>
          )}
          {section === 'Accessories' && (
            <>
              <Choices
                label="Hat"
                options={HATS}
                value={design.hat}
                select={(hat) => change({ hat })}
              />
              <Choices
                label="Glasses"
                options={GLASSES}
                value={design.glasses}
                select={(glasses) => change({ glasses })}
              />
            </>
          )}
        </div>
        <div className="plush-save">
          <span>Device storage · Free</span>
          <button type="submit" className="btn btn-primary" disabled={saving}>
            {saving ? 'Saving…' : onCreate ? 'Save character' : 'Save changes'}{' '}
            <Check size={15} />
          </button>
          {id && (
            <Link
              className="btn btn-small"
              href={`/dashboard/chat?character=${encodeURIComponent(id)}`}
            >
              Chat <ArrowUpRight size={14} />
            </Link>
          )}
        </div>
        {notice && <output className="plush-feedback">{notice}</output>}
        {error && (
          <p role="alert">
            {error}{' '}
            <button
              type="button"
              className="btn btn-small"
              onClick={() => setRetry((n) => n + 1)}
            >
              Retry preview
            </button>
          </p>
        )}
      </fieldset>
    </form>
  );
}

'use client';

// Feature 06 "Make this safe to post": the attachment editor's stage, used to hide parts of a screenshot before it is
// shared. Suggested boxes come from the browser's own QR and text detection where it has them; the screen says which
// detections this browser supports, and manual boxes always work. The export is drawn onto a new canvas with opaque
// fills and encoded as a new PNG, then shared or downloaded. Nothing is sent to Anonymo and the source is not changed.

import { Download, EyeOff, Minus, Move, Plus, Share2, ShieldCheck, Square, Trash2, Undo2, X } from 'lucide-react';
import { useEffect, useId, useState } from 'react';
import { detectQr, detectText, flattenRedacted, qrDetectionSupported, textDetectionSupported, type DecodedImage } from '@/lib/anonymo/attachment-image';
import { clampRect } from '@/lib/anonymo/region';
import { SUGGESTION_LABEL, suggestBoxes, type SuggestionKind } from '@/lib/anonymo/safe-post';
import { EditorStage, Sheet, nudge, type Shape } from './attachment-editor';
import './chat-inputs.css';

type Box = Shape & { kind: SuggestionKind | 'manual'; hidden: boolean };
type Support = { qr: boolean | null; text: boolean | null };
type Status = { tone: 'ok' | 'warn' | 'error'; text: string; retry?: boolean } | null;

const EXPORT_NAME = 'safe-to-post.png';

function download(blob: Blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = EXPORT_NAME;
  a.rel = 'noopener';
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

export function SafePostEditor({ image, onClose }: { image: DecodedImage; onClose: () => void }) {
  const [boxes, setBoxes] = useState<Box[]>([]);
  const [past, setPast] = useState<Box[][]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(false);
  const [support, setSupport] = useState<Support>({ qr: null, text: textDetectionSupported() ? null : false });
  const [status, setStatus] = useState<Status>(null);
  const [busy, setBusy] = useState(false);
  const [clean, setClean] = useState<Blob | null>(null);
  const hintId = useId();

  // Suggestions from this browser's own detectors. Missing detectors are said plainly; manual boxes still work.
  useEffect(() => {
    let live = true;
    void (async () => {
      const qrOk = await qrDetectionSupported();
      const [qr, lines] = await Promise.all([qrOk ? detectQr(image.bitmap) : null, detectText(image.bitmap)]);
      if (!live) return;
      setSupport({ qr: qrOk && qr !== null, text: lines !== null });
      const found = suggestBoxes(qr, lines);
      const counts: Partial<Record<SuggestionKind, number>> = {};
      setBoxes((current) => [
        ...found.map((f, i) => {
          counts[f.kind] = (counts[f.kind] ?? 0) + 1;
          const n = found.filter((x) => x.kind === f.kind).length > 1 ? ` ${counts[f.kind]}` : '';
          return { id: `found-${i}`, rect: f.rect, kind: f.kind, hidden: true, fill: true, label: `${SUGGESTION_LABEL[f.kind]}${n}` };
        }),
        ...current,
      ]);
    })();
    return () => { live = false; };
  }, [image]);

  const commit = (next: Box[]) => {
    setPast((p) => [...p, boxes]);
    setBoxes(next);
    setClean(null);
  };
  const manualCount = boxes.filter((b) => b.kind === 'manual').length;
  const addBox = () => {
    const id = `box-${Date.now().toString(36)}`;
    commit([...boxes, { id, rect: clampRect({ x: 0.3, y: 0.4, w: 0.4, h: 0.12 }), kind: 'manual', hidden: true, fill: true, label: `Your box ${manualCount + 1}` }]);
    setActive(id);
    setStatus({ tone: 'ok', text: 'Box added. Drag it over the area, or move it with the arrow keys (Shift resizes).' });
  };
  const activeBox = boxes.find((b) => b.id === active) ?? null;
  const hiddenBoxes = boxes.filter((b) => b.hidden);

  async function save() {
    if (!hiddenBoxes.length) return;
    setBusy(true);
    setStatus(null);
    try {
      const blob = clean ?? (await flattenRedacted(image.bitmap, hiddenBoxes.map((b) => b.rect)));
      setClean(blob);
      const file = new File([blob], EXPORT_NAME, { type: 'image/png' });
      const nav = navigator as Navigator & { canShare?: (data: ShareData) => boolean };
      if (typeof nav.share === 'function' && nav.canShare?.({ files: [file] })) {
        try {
          await nav.share({ files: [file] });
          setStatus({ tone: 'ok', text: 'Clean copy shared. Your original picture is unchanged.' });
        } catch (error) {
          if (error instanceof DOMException && error.name === 'AbortError')
            setStatus({ tone: 'warn', text: 'Sharing was cancelled. Nothing was shared.', retry: true });
          else setStatus({ tone: 'warn', text: 'Sharing is not available here. Download the clean copy instead.', retry: true });
        }
        return;
      }
      download(blob);
      setStatus({ tone: 'ok', text: `Clean copy downloaded as ${EXPORT_NAME}. Your original picture is unchanged.` });
    } catch {
      setStatus({ tone: 'error', text: 'The clean copy could not be made. Nothing was saved.' });
    } finally {
      setBusy(false);
    }
  }

  const describe = (s: Support) => [
    s.qr === null ? 'QR codes: checking…' : s.qr ? 'QR codes: found automatically in this browser.' : 'QR codes: this browser cannot find them. Add a box by hand.',
    s.text === null ? 'Handles and addresses: checking…' : s.text ? 'Handles and addresses: read on this device.' : 'Handles and addresses: this browser cannot read text in pictures. Add a box by hand.',
  ];
  return (
    <Sheet label="Make this safe to post" onCancel={onClose}>
      <div className="sheet-head">
        <p className="sheet-crumb"><ShieldCheck size={14} aria-hidden="true" /> Chat / Image export</p>
        <button type="button" className="btn btn-small btn-ghost sheet-close" onClick={onClose} aria-label="Close"><X size={18} aria-hidden="true" /></button>
      </div>
      <h2 className="sheet-title">Make this safe to post</h2>
      <div className="editor-card">
        <div className="editor-card-head">
          <span className="editor-file" title="Shown on this device only.">{image.name}</span>
          <span className="editor-pages">Preview</span>
        </div>
        <EditorStage
          source={{ kind: 'image', image }} page={1} zoom={zoom} pan={pan} round={false}
          shapes={boxes} active={active} onActive={setActive}
          onShapes={(next, before) => {
            // A drawn shape arrives as a plain Shape: it becomes a manual box that is hidden.
            const drawnSoFar = next.filter((s) => 'kind' in s && (s as Box).kind === 'manual').length;
            const typed = next.map((s) => ('kind' in s ? (s as Box) : { ...s, kind: 'manual' as const, hidden: true, fill: true, label: `Your box ${drawnSoFar + 1}` }));
            setBoxes(typed);
            if (before) {
              setPast((p) => [...p, before as Box[]]);
              setClean(null);
            }
          }}
          onTap={() => setStatus({ tone: 'ok', text: 'Drag to draw a box over anything else you want hidden.' })}
          label="Picture. Drag to draw a box; drag a box to move it; pull a corner to resize."
        />
      </div>
      <ul className="safe-detect" aria-label="Detection in this browser">
        {describe(support).map((line) => <li key={line}>{line}</li>)}
      </ul>
      <div className="editor-tools" role="toolbar" aria-label="Box tools">
        <button type="button" className="btn btn-small" onClick={addBox}><Square size={14} aria-hidden="true" /> Add box</button>
        {activeBox && (
          <button
            type="button" className="btn btn-small editor-selection" aria-describedby={hintId}
            aria-label={`${activeBox.label}. Arrow keys move it, Shift with arrow keys resizes it, Delete removes it.`}
            onKeyDown={(e) => {
              if (e.key === 'Delete' || e.key === 'Backspace') {
                e.preventDefault();
                commit(boxes.filter((b) => b.id !== activeBox.id));
                setActive(null);
                return;
              }
              const next = nudge(e, activeBox.rect);
              if (next) commit(boxes.map((b) => (b.id === activeBox.id ? { ...b, rect: next } : b)));
            }}
          >
            <Move size={14} aria-hidden="true" /> Move {activeBox.label}
          </button>
        )}
        <button type="button" className="btn btn-small btn-ghost" disabled={!past.length} onClick={() => { setBoxes(past[past.length - 1]); setPast(past.slice(0, -1)); setClean(null); }}>
          <Undo2 size={14} aria-hidden="true" /> Undo
        </button>
        <span className="editor-zoom">
          <button type="button" className="btn btn-small btn-ghost" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => { setZoom((z) => Math.max(1, z - 1)); if (zoom <= 2) setPan(false); }}><Minus size={14} aria-hidden="true" /></button>
          <span aria-live="polite">{zoom}×</span>
          <button type="button" className="btn btn-small btn-ghost" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom((z) => Math.min(4, z + 1))}><Plus size={14} aria-hidden="true" /></button>
          {zoom > 1 && <button type="button" className="btn btn-small btn-ghost" aria-pressed={pan} onClick={() => setPan((p) => !p)}>Move view</button>}
        </span>
      </div>
      <p className="editor-hint" id={hintId}><EyeOff size={14} aria-hidden="true" /> Black boxes are filled solid in the copy. Zoom in to check the edges.</p>

      <section className="editor-preview" aria-label="Hide in exported image">
        <h3 className="sheet-label">Hide in exported image</h3>
        {boxes.length ? (
          <div className="safe-list">
            {boxes.map((b) => (
              <div key={b.id} className="safe-row">
                <button type="button" className="link-button safe-row-name" data-active={active === b.id || undefined} onClick={() => setActive(b.id)}>{b.label}</button>
                {b.kind === 'manual' ? (
                  <button type="button" className="btn btn-small btn-ghost" aria-label={`Remove ${b.label}`} onClick={() => { commit(boxes.filter((x) => x.id !== b.id)); if (active === b.id) setActive(null); }}>
                    <Trash2 size={14} aria-hidden="true" /> Remove
                  </button>
                ) : (
                  <button type="button" className="safe-toggle" aria-pressed={b.hidden} aria-label={`${b.label}: ${b.hidden ? 'hidden' : 'shown'}`}
                    onClick={() => commit(boxes.map((x) => (x.id === b.id ? { ...x, hidden: !x.hidden, fill: !x.hidden } : x)))}>
                    {b.hidden ? '✓ Hidden' : 'Shown'}
                  </button>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="muted">Nothing to hide yet. Add a box over a handle, address, QR code or anything else.</p>
        )}
      </section>
      {status && (
        <output className={`notice ${status.tone === 'ok' ? 'notice-signal' : status.tone === 'warn' ? 'notice-amber' : 'notice-rose'} safe-done`}>
          <span>{status.text}</span>
          {status.retry && clean && (
            <button type="button" className="btn btn-small" onClick={() => { download(clean); setStatus({ tone: 'ok', text: `Clean copy downloaded as ${EXPORT_NAME}. Your original picture is unchanged.` }); }}>
              <Download size={14} aria-hidden="true" /> Download instead
            </button>
          )}
        </output>
      )}
      <div className="sheet-actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>Close</button>
        <button type="button" className="btn btn-primary sheet-primary" disabled={!hiddenBoxes.length || busy} onClick={() => void save()}>
          {typeof navigator !== 'undefined' && typeof navigator.share === 'function' ? <Share2 size={16} aria-hidden="true" /> : <Download size={16} aria-hidden="true" />} Save clean copy
        </button>
      </div>
    </Sheet>
  );
}

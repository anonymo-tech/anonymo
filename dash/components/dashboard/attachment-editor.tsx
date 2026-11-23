'use client';

// Features 02 "Circle anything", 03 "Send only this part" and 06 "Make this safe to post": one bottom-sheet editor for
// an attached PDF page or image. Draw, drag and resize a selection, undo, or use the equivalents: tap a text line,
// "Line above"/"Line below", "Add circle"/"Add box", and arrow keys (Shift resizes) on a focused selection.
// Coordinates are kept 0–1 against the oriented source, never display pixels, so zoom and screen size do not matter.
// The editor shows exactly what the model would get; only what the person approves leaves it.

import { ChevronLeft, ChevronRight, Crop, FileText, ImageIcon, Minus, Move, Plus, ScanLine, Send, Undo2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { cropPng, detectText, textDetectionSupported, type DecodedImage, type DetectedText } from '@/lib/anonymo/attachment-image';
import { DEFAULT_QUESTION, type Excerpt, type ExcerptPurpose } from '@/lib/anonymo/excerpt';
import { adjacentLine, clampRect, growRect, lineAt, moveRect, nearbyText, rectFromPoints, resizeRect, textInRegion, toSource, type Handle, type Point, type Rect } from '@/lib/anonymo/region';
import type { PaperSource } from '@/lib/paper-trail';
import type { PageLayout } from '@/lib/pdf-layout';
import './chat-inputs.css';

export type EditorSource = { kind: 'pdf'; paper: PaperSource } | { kind: 'image'; image: DecodedImage };
export type Shape = { id: string; rect: Rect; label?: string; /** Shown as the opaque fill it will get in an export (06). */ fill?: boolean };

const TITLES: Record<ExcerptPurpose, string> = { explain: 'Circle anything', excerpt: 'Send only this part' };
const STEP = 0.01;

/** The drawing surface shared by the excerpt editor and the safe-to-post editor. */
export function EditorStage({ source, page, zoom, pan, shapes, active, round, onActive, onShapes, onTap, label, children }: {
  source: EditorSource;
  page: number;
  zoom: number;
  pan: boolean;
  shapes: Shape[];
  active: string | null;
  round: boolean;
  onActive: (id: string | null) => void;
  /** `before` is null while a drag is in progress; on release it is the shapes before the drag, for undo. */
  onShapes: (shapes: Shape[], before: Shape[] | null) => void;
  onTap: (p: Point) => void;
  label: string;
  children?: ReactNode;
}) {
  const stage = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [renderError, setRenderError] = useState('');
  const aspect = source.kind === 'image' ? source.image.width / source.image.height : (() => {
    const layout = source.paper.pages[page - 1]?.layout;
    return layout ? layout.width / layout.height : 612 / 792;
  })();

  // Draw the page or picture. A PDF page is rendered with pdf.js from the bytes kept on this device.
  useEffect(() => {
    const target = canvas.current;
    if (!target) return;
    if (source.kind === 'image') {
      const { bitmap } = source.image;
      const scale = Math.min(1, 2400 / Math.max(bitmap.width, bitmap.height));
      target.width = Math.max(1, Math.round(bitmap.width * scale));
      target.height = Math.max(1, Math.round(bitmap.height * scale));
      target.getContext('2d')?.drawImage(bitmap, 0, 0, target.width, target.height);
      return;
    }
    const bytes = source.paper.bytes;
    if (!bytes) return;
    let cancelled = false;
    let destroy: (() => void) | null = null;
    void (async () => {
      const [{ getDocument, GlobalWorkerOptions }, { default: worker }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
      GlobalWorkerOptions.workerSrc = worker;
      const task = getDocument({ data: bytes.slice(), useSystemFonts: true });
      destroy = () => void task.destroy();
      const doc = await task.promise;
      if (cancelled) return;
      const pdfPage = await doc.getPage(page);
      const base = pdfPage.getViewport({ scale: 1 });
      const width = (stage.current?.clientWidth ?? 360) * Math.min(2, window.devicePixelRatio || 1);
      const viewport = pdfPage.getViewport({ scale: Math.min(4, Math.max(0.5, width / base.width)) });
      target.width = Math.round(viewport.width);
      target.height = Math.round(viewport.height);
      await pdfPage.render({ canvas: target, viewport }).promise;
      setRenderError('');
    })().catch(() => {
      if (!cancelled) setRenderError('This page could not be drawn. Select by tapping lines, or type the text.');
    });
    return () => {
      cancelled = true;
      destroy?.();
    };
  }, [source, page, zoom]);

  const drag = useRef<{ kind: 'draw' | 'move' | 'resize'; id: string | null; handle?: Handle; start: Point; before: Shape[]; moved: boolean } | null>(null);
  const point = (e: PointerEvent) => toSource(e.clientX, e.clientY, stage.current!.getBoundingClientRect());

  function down(e: PointerEvent<HTMLDivElement>) {
    if (pan || e.button > 0) return;
    const target = e.target as HTMLElement;
    const id = target.closest<HTMLElement>('[data-shape]')?.dataset.shape ?? null;
    const handle = target.dataset.handle as Handle | undefined;
    drag.current = { kind: handle && id ? 'resize' : id ? 'move' : 'draw', id, handle, start: point(e), before: shapes, moved: false };
    if (id) onActive(id);
    stage.current?.setPointerCapture(e.pointerId);
    e.preventDefault();
  }
  function move(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dx = p.x - d.start.x, dy = p.y - d.start.y;
    if (!d.moved && Math.hypot(dx, dy) < 0.012) return;
    d.moved = true;
    if (d.kind === 'draw') {
      const id = d.id ?? `s${Date.now().toString(36)}`;
      d.id = id;
      const drawn = { id, rect: rectFromPoints(d.start, p) };
      onShapes([...d.before.filter((s) => s.id !== id), drawn], null);
      onActive(id);
      return;
    }
    const original = d.before.find((s) => s.id === d.id);
    if (!original) return;
    const rect = d.kind === 'move' ? moveRect(original.rect, dx, dy) : resizeRect(original.rect, d.handle!, dx, dy);
    onShapes(d.before.map((s) => (s.id === d.id ? { ...s, rect } : s)), null);
  }
  function up(e: PointerEvent<HTMLDivElement>) {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (!d.moved) {
      if (d.kind === 'draw') onTap(point(e));
      return;
    }
    onShapes(shapes, d.before);
  }

  return (
    <div className="editor-viewport" data-pan={pan || undefined}>
      <div
        ref={stage}
        className="editor-stage"
        role="group"
        aria-label={label}
        style={{ width: `${zoom * 100}%`, aspectRatio: String(aspect), touchAction: pan ? 'pan-x pan-y' : 'none' }}
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={up}
        onPointerCancel={() => { drag.current = null; }}
      >
        <canvas ref={canvas} className="editor-canvas" aria-hidden="true" />
        {(renderError || (source.kind === 'pdf' && !source.paper.bytes)) && (
          <p className="editor-render-error">{renderError || 'This page cannot be drawn. Select by tapping lines, or type the text.'}</p>
        )}
        {shapes.map((s) => (
          <div
            key={s.id}
            data-shape={s.id}
            className={`editor-shape${round ? ' editor-shape-round' : ''}${s.fill ? ' editor-shape-fill' : ''}${active === s.id ? ' editor-shape-active' : ''}`}
            style={{ left: `${s.rect.x * 100}%`, top: `${s.rect.y * 100}%`, width: `${s.rect.w * 100}%`, height: `${s.rect.h * 100}%` }}
          >
            {s.label && <span className="editor-shape-label">{s.label}</span>}
            {active === s.id && (['nw', 'ne', 'sw', 'se'] as const).map((h) => <span key={h} data-handle={h} className={`editor-handle editor-handle-${h}`} aria-hidden="true" />)}
          </div>
        ))}
        {children}
      </div>
    </div>
  );
}

/** Arrow keys move the active selection; Shift+arrows resize it. Returns true when the key was used. */
export function nudge(e: KeyboardEvent, rect: Rect): Rect | null {
  const step = e.altKey ? STEP / 5 : STEP;
  const d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (!d) return null;
  e.preventDefault();
  return e.shiftKey ? growRect(rect, d[0], d[1]) : moveRect(rect, d[0], d[1]);
}

const describe = (r: Rect) => `left ${Math.round(r.x * 100)}%, top ${Math.round(r.y * 100)}%, ${Math.round(r.w * 100)}% wide, ${Math.round(r.h * 100)}% high`;

/** A modal bottom sheet with focus kept inside; Escape cancels. */
export function Sheet({ label, onCancel, children }: { label: string; onCancel: () => void; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = dialog.current;
    if (d && !d.open) d.showModal();
    return () => d?.close();
  }, []);
  return createPortal(
    <dialog ref={dialog} className="attach-sheet" aria-label={label} onCancel={(e) => { e.preventDefault(); onCancel(); }}>
      {children}
    </dialog>,
    document.body,
  );
}

type OcrState = { status: 'unsupported' } | { status: 'reading' } | { status: 'done'; text: string };

export function AttachmentEditor({ source, initialPurpose, imageModel, initialQuestion, onCancel, onUse }: {
  source: EditorSource;
  initialPurpose: ExcerptPurpose;
  /** The selected model takes image input (catalog `input_modalities`) and nothing else rules it out. */
  imageModel: boolean;
  initialQuestion: string;
  onCancel: () => void;
  onUse: (excerpt: Excerpt, question: string) => void;
}) {
  const [purpose, setPurpose] = useState(initialPurpose);
  const [page, setPage] = useState(1);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState(false);
  const [shapes, setShapes] = useState<Shape[]>([]);
  const [past, setPast] = useState<Shape[][]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [hint, setHint] = useState('');
  const [question, setQuestion] = useState(initialQuestion);
  const [nearbyOn, setNearbyOn] = useState(false);
  const [typed, setTyped] = useState<string | null>(null);
  const [sendImage, setSendImage] = useState(imageModel);
  const [ocr, setOcr] = useState<OcrState>(() => ({ status: source.kind === 'image' && !textDetectionSupported() ? 'unsupported' : 'reading' }));
  const [crop, setCrop] = useState<{ url: string; width: number; height: number } | null>(null);
  const [lines, setLines] = useState<DetectedText[] | null>(null);
  const [busy, setBusy] = useState(false);
  const hintId = useId();
  const card = useRef<HTMLDivElement>(null);
  /** Clears the selection and brings the page back into view to select again. */
  function reselect(message: string) {
    select(null, message);
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    card.current?.scrollIntoView({ block: 'start', behavior: still ? 'auto' : 'smooth' });
  }

  const rect = shapes[0]?.rect ?? null;
  const pages = source.kind === 'pdf' ? source.paper.pages.length : 1;
  const pdfPage = source.kind === 'pdf' ? source.paper.pages[page - 1] : null;
  const layout: PageLayout | null = pdfPage?.layout ?? null;

  // Text recognition for a picture, on this device: the whole picture once (for tap-a-line), and the selection.
  useEffect(() => {
    if (source.kind !== 'image') return;
    let live = true;
    void detectText(source.image.bitmap).then((found) => { if (live) setLines(found); });
    return () => { live = false; };
  }, [source]);
  useEffect(() => {
    if (source.kind !== 'image' || !rect) return;
    let live = true;
    const timer = setTimeout(() => {
      void cropPng(source.image.bitmap, rect).then(async (c) => {
        if (!live) return;
        setCrop(c);
        if (!textDetectionSupported()) return;
        setOcr({ status: 'reading' });
        const found = await detectText(await createImageBitmap(c.blob));
        if (live) setOcr(found === null ? { status: 'unsupported' } : { status: 'done', text: found.map((f) => f.text).join('\n') });
      }).catch(() => { if (live) setCrop(null); });
    }, 200);
    return () => { live = false; clearTimeout(timer); };
  }, [source, rect]);

  const extracted = useMemo(() => {
    if (!rect) return '';
    if (pdfPage) return layout ? textInRegion(pdfPage.text, layout, rect) : '';
    return ocr.status === 'done' ? ocr.text : '';
  }, [rect, pdfPage, layout, ocr]);
  const nearby = useMemo(() => (rect && pdfPage && layout ? nearbyText(pdfPage.text, layout, rect) : null), [rect, pdfPage, layout]);
  const hasNearby = !!nearby && !!(nearby.before || nearby.after);
  const text = typed ?? extracted;
  const imageOut = source.kind === 'image' && imageModel && sendImage && crop ? crop : null;
  const ready = !!rect && (text.trim().length > 0 || !!imageOut) && question.trim().length > 0;

  function commit(next: Shape[]) {
    setPast((p) => [...p, shapes]);
    setShapes(next);
    setTyped(null);
  }
  function select(r: Rect | null, message = '') {
    const id = shapes[0]?.id ?? 'selection';
    commit(r ? [{ id, rect: r }] : []);
    setActive(r ? id : null);
    setHint(message);
  }
  function tap(p: Point) {
    if (layout) {
      const line = lineAt(layout, p);
      return line ? select(line, 'Line selected.') : setHint('No text line there. Drag to draw a selection instead.');
    }
    const hit = lines?.find((l) => p.x >= l.rect.x && p.x <= l.rect.x + l.rect.w && p.y >= l.rect.y && p.y <= l.rect.y + l.rect.h);
    if (hit) return select(clampRect({ x: hit.rect.x - 0.01, y: hit.rect.y - 0.01, w: hit.rect.w + 0.02, h: hit.rect.h + 0.02 }), 'Line selected.');
    setHint(lines === null ? 'Drag to draw a selection. Tapping a line needs text recognition, which this browser does not have.' : 'No text line there. Drag to draw a selection instead.');
  }
  function step(direction: -1 | 1) {
    if (!rect || !layout) return;
    const next = adjacentLine(layout, rect, direction);
    if (next) select(next, direction < 0 ? 'Moved to the line above.' : 'Moved to the line below.');
    else setHint(direction < 0 ? 'No line above in this column.' : 'No line below in this column.');
  }
  function goPage(n: number) {
    if (n < 1 || n > pages) return;
    setPage(n);
    select(null, `Page ${n} of ${pages}.`);
  }
  async function use() {
    if (!ready || !rect) return;
    setBusy(true);
    try {
      onUse({
        purpose,
        page: source.kind === 'pdf' ? page : null,
        text: text.trim(),
        nearby: purpose === 'explain' && nearbyOn && hasNearby ? nearby : null,
        image: imageOut ? { url: imageOut.url, width: imageOut.width, height: imageOut.height } : null,
      }, question.trim());
    } finally {
      setBusy(false);
    }
  }

  const name = source.kind === 'pdf' ? source.paper.name : source.image.name;
  const round = purpose === 'explain';
  const pdfEmpty = !!rect && !!pdfPage && !extracted;
  return (
    <Sheet label={TITLES[purpose]} onCancel={onCancel}>
      <div className="sheet-head">
        <p className="sheet-crumb">{source.kind === 'pdf' ? <FileText size={14} aria-hidden="true" /> : <ImageIcon size={14} aria-hidden="true" />} Chat / Attachment</p>
        <button type="button" className="btn btn-small btn-ghost sheet-close" onClick={onCancel} aria-label="Cancel"><X size={18} aria-hidden="true" /></button>
      </div>
      <h2 className="sheet-title">{TITLES[purpose]}</h2>
      <div className="editor-modes" role="group" aria-label="What to do with the selection">
        {(['explain', 'excerpt'] as const).map((p) => (
          <button key={p} type="button" className="editor-mode" aria-pressed={purpose === p} onClick={() => {
            // An untouched default question follows the mode.
            if (question === DEFAULT_QUESTION[purpose]) setQuestion(DEFAULT_QUESTION[p]);
            setPurpose(p);
          }}>
            {p === 'explain' ? 'Explain this' : 'Send only this'}
          </button>
        ))}
      </div>
      <div className="editor-card" ref={card}>
        <div className="editor-card-head">
          <span className="editor-file" title="Shown on this device only. The file name is never sent.">{name}</span>
          {pages > 1 ? (
            <span className="editor-pages">
              <button type="button" className="btn btn-small btn-ghost" onClick={() => goPage(page - 1)} disabled={page <= 1} aria-label="Previous page"><ChevronLeft size={16} aria-hidden="true" /></button>
              <span aria-live="polite">Page {page} / {pages}</span>
              <button type="button" className="btn btn-small btn-ghost" onClick={() => goPage(page + 1)} disabled={page >= pages} aria-label="Next page"><ChevronRight size={16} aria-hidden="true" /></button>
            </span>
          ) : <span className="editor-pages">{source.kind === 'pdf' ? 'Page 1' : `${source.image.width} × ${source.image.height}`}</span>}
        </div>
        <EditorStage
          source={source} page={page} zoom={zoom} pan={pan} shapes={shapes} active={active} round={round}
          onActive={setActive}
          onShapes={(next, before) => {
            setShapes(next.slice(-1));
            if (before) {
              setPast((p) => [...p, before]);
              setTyped(null);
            }
          }}
          onTap={tap}
          label={`${source.kind === 'pdf' ? `Page ${page}` : 'Picture'}. Drag to draw a selection, or tap a line.`}
        />
      </div>
      <p className="editor-hint" id={hintId}><ScanLine size={14} aria-hidden="true" /> {rect ? 'Drag to move, pull a corner to resize, or tap another line.' : `Tap a line to ${round ? 'circle' : 'select'} it, or drag to draw.`}</p>
      <div className="editor-tools" role="toolbar" aria-label="Selection tools">
        {rect ? (
          <button
            type="button" className="btn btn-small editor-selection" aria-describedby={hintId}
            aria-label={`Selection: ${describe(rect)}. Arrow keys move it, Shift with arrow keys resizes it.`}
            onKeyDown={(e) => { const next = nudge(e, rect); if (next) select(next); }}
          >
            <Move size={14} aria-hidden="true" /> Selection
          </button>
        ) : (
          <button type="button" className="btn btn-small" onClick={() => select(clampRect({ x: 0.1, y: 0.4, w: 0.8, h: 0.08 }), 'Selection added in the middle. Move it with the arrow keys or Line above/below.')}>
            <Crop size={14} aria-hidden="true" /> {round ? 'Add circle' : 'Add box'}
          </button>
        )}
        {layout && <button type="button" className="btn btn-small btn-ghost" onClick={() => step(-1)} disabled={!rect}>Line above</button>}
        {layout && <button type="button" className="btn btn-small btn-ghost" onClick={() => step(1)} disabled={!rect}>Line below</button>}
        <button type="button" className="btn btn-small btn-ghost" disabled={!past.length} onClick={() => { setShapes(past[past.length - 1]); setPast(past.slice(0, -1)); setTyped(null); }}>
          <Undo2 size={14} aria-hidden="true" /> Undo
        </button>
        <span className="editor-zoom">
          <button type="button" className="btn btn-small btn-ghost" aria-label="Zoom out" disabled={zoom <= 1} onClick={() => { setZoom((z) => Math.max(1, z - 1)); if (zoom <= 2) setPan(false); }}><Minus size={14} aria-hidden="true" /></button>
          <span aria-live="polite">{zoom}×</span>
          <button type="button" className="btn btn-small btn-ghost" aria-label="Zoom in" disabled={zoom >= 4} onClick={() => setZoom((z) => Math.min(4, z + 1))}><Plus size={14} aria-hidden="true" /></button>
          {zoom > 1 && <button type="button" className="btn btn-small btn-ghost" aria-pressed={pan} onClick={() => setPan((p) => !p)}>Move view</button>}
        </span>
      </div>
      {hint && <output className="editor-status">{hint}</output>}

      <section className="editor-preview" aria-label="What the model gets">
        <h3 className="sheet-label">What the model gets</h3>
        {!rect ? (
          <p className="muted">Nothing yet. Select part of the {source.kind === 'pdf' ? 'page' : 'picture'} first.</p>
        ) : (
          <>
            <span className="chip editor-only">
              <Crop size={13} aria-hidden="true" /> {imageOut ? (text.trim() ? 'Cropped image and its text only' : 'Cropped image only') : 'Text excerpt only'}
              {source.kind === 'pdf' ? ` · p. ${page}` : ''}
            </span>
            {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, never fetched */}
            {imageOut && <img className="editor-crop" src={imageOut.url} alt="The cropped part that would be sent" width={imageOut.width} height={imageOut.height} />}
            {source.kind === 'image' && imageModel && (
              <label className="editor-check">
                <input type="checkbox" checked={sendImage} onChange={(e) => setSendImage(e.target.checked)} /> Send the cropped image (this model accepts images)
              </label>
            )}
            {source.kind === 'image' && ocr.status === 'unsupported' && !typed && (
              <p className="faint">Text recognition is not available in this browser.{imageOut ? '' : ' Type the text below, or send the crop to a model that accepts images.'}</p>
            )}
            {source.kind === 'image' && ocr.status === 'reading' && <output className="faint">Reading text on this device…</output>}
            {(pdfEmpty || (source.kind === 'image' && ocr.status === 'done' && !ocr.text)) && typed === null && (
              <div className="notice notice-amber editor-empty" role="status">
                <p>No readable text in this part.</p>
                <div className="row">
                  <button type="button" className="btn btn-small" onClick={() => reselect('Draw a new selection.')}>Select again</button>
                  <button type="button" className="btn btn-small btn-ghost" onClick={() => setTyped('')}>Type the text</button>
                </div>
              </div>
            )}
            {purpose === 'explain' && hasNearby && nearbyOn && nearby.before && <p className="editor-nearby">{nearby.before}</p>}
            {(text || typed !== null || (source.kind === 'image' && ocr.status === 'unsupported' && !imageOut)) && (
              <label className="editor-text">
                <span className="sr-only">Excerpt text</span>
                <textarea
                  value={text}
                  rows={Math.min(6, Math.max(2, text.split('\n').length + 1))}
                  placeholder="Type the text you want to send"
                  onChange={(e) => setTyped(e.target.value)}
                />
              </label>
            )}
            {purpose === 'explain' && hasNearby && nearbyOn && nearby.after && <p className="editor-nearby">{nearby.after}</p>}
            {purpose === 'explain' && hasNearby && (
              <label className="editor-check">
                <input type="checkbox" checked={nearbyOn} onChange={(e) => setNearbyOn(e.target.checked)} /> Include nearby lines
                {!nearbyOn && <span className="faint"> · adds {[nearby.before, nearby.after].filter(Boolean).map((l) => `“${l}”`).join(' and ')}</span>}
              </label>
            )}
            <p className="faint editor-never">Never sent: the file name, other pages, the rest of this {source.kind === 'pdf' ? 'page' : 'picture'} and its metadata.</p>
            {source.kind === 'pdf' && <button type="button" className="link-button" onClick={() => reselect('Draw or tap a new selection.')}>Select another part</button>}
          </>
        )}
      </section>
      <label className="editor-question">
        <span className="sheet-label">Your question</span>
        <textarea value={question} rows={2} placeholder={DEFAULT_QUESTION[purpose]} onChange={(e) => setQuestion(e.target.value)} />
      </label>
      <div className="sheet-actions">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>Cancel</button>
        <button type="button" className="btn btn-primary sheet-primary" disabled={!ready || busy} onClick={() => void use()}>
          {purpose === 'explain' ? <ScanLine size={16} aria-hidden="true" /> : <Send size={16} aria-hidden="true" />}
          {purpose === 'explain' ? 'Explain circled part' : 'Send excerpt'}
        </button>
      </div>
    </Sheet>
  );
}

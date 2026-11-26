'use client';

import { Plus, X } from 'lucide-react';
import { Fragment, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { modeHint, type ChatMode } from '@/lib/anonymo/chat-modes';
import { MODE_LABELS } from './chat-mode-settings';
import './chat-modes.css';

export type ActiveTool = { label: string; remove: () => void };

export function ChatModeComposer({ text, textarea, mode, hint, available, options, tools, modelPicker, active, price, action, onMode, menu, setMenu }: {
  text: string;
  textarea: ReactNode;
  mode: ChatMode | null;
  hint: ReturnType<typeof modeHint>;
  available: readonly ChatMode[];
  options: ReactNode;
  tools: ReactNode;
  modelPicker: ReactNode;
  active: ActiveTool[];
  price: string;
  action: ReactNode;
  onMode: (mode: ChatMode | null) => void;
  menu: boolean;
  setMenu: (open: boolean) => void;
}) {
  const mirror = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const section = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!menu) return;
    panel.current?.querySelector('button')?.focus();
    const closeOutside = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Element && !section.current?.contains(target) && !target.closest('dialog')) setMenu(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || (event.target instanceof Element && event.target.closest('dialog'))) return;
      setMenu(false);
      toggle.current?.focus();
    };
    document.addEventListener('pointerdown', closeOutside);
    document.addEventListener('keydown', closeOnEscape);
    return () => {
      document.removeEventListener('pointerdown', closeOutside);
      document.removeEventListener('keydown', closeOnEscape);
    };
  }, [menu, setMenu]);
  useLayoutEffect(() => {
    const field = section.current?.querySelector('textarea');
    if (!field) return;
    const syncScroll = () => {
      if (mirror.current) mirror.current.scrollTop = field.scrollTop;
    };
    const resize = () => {
      field.style.height = 'auto';
      field.style.height = `${Math.min(field.scrollHeight, 200)}px`;
      syncScroll();
    };
    resize();
    // Observe the width, so wrapping and the mirror stay aligned on window and dock resizes.
    let width = field.clientWidth;
    const observer = new ResizeObserver(() => {
      if (width === field.clientWidth) return;
      width = field.clientWidth;
      resize();
    });
    if (field.parentElement) observer.observe(field.parentElement);
    field.addEventListener('scroll', syncScroll);
    return () => {
      observer.disconnect();
      field.removeEventListener('scroll', syncScroll);
    };
  }, [text]);

  const matches = (mode ? modeHint(text, [mode]) : hint)?.matches ?? [];
  const startTail = matches.at(-1)?.end ?? 0;
  const Selected = mode ? MODE_LABELS[mode].icon : null;
  const Suggested = hint ? MODE_LABELS[hint.mode].icon : null;

  return (
    <div className="mode-box" ref={section}>
      <div className="mode-input">
        <div className="mode-mirror" ref={mirror} aria-hidden="true">
          {matches.map(({ start, end }, index) => (
            <Fragment key={start}>{text.slice(matches[index - 1]?.end ?? 0, start)}<mark>{text.slice(start, end)}</mark></Fragment>
          ))}
          {text.slice(startTail)}{text.endsWith('\n') && '\u200b'}
        </div>
        {textarea}
      </div>
      <div className="mode-menu" ref={panel} hidden={!menu}>
        {!!available.length && (
          <>
            <span className="mode-menu-heading">Modes</span>
            {available.map((id) => {
              const { icon: Icon, label } = MODE_LABELS[id];
              return <button type="button" className="tool" key={id} onClick={() => onMode(id)}><Icon size={15} aria-hidden="true" /> {label}</button>;
            })}
          </>
        )}
        <span className="mode-menu-heading">Tools</span>
        {tools}
      </div>
      {options}
      {!!active.length && <fieldset className="mode-active" aria-label="Active tools">
        {active.map(({ label, remove }, index) => <button type="button" className="mode-tag mode-tool-tag" key={index} onClick={remove} aria-label={`Remove ${label}`}>
          <span>{label}</span> <X size={13} aria-hidden="true" />
        </button>)}
      </fieldset>}
      <div className="mode-bar">
        <button type="button" className="mode-plus" ref={toggle} aria-label="Modes and tools" aria-expanded={menu}
          onClick={() => setMenu(!menu)}>
          <Plus size={18} aria-hidden="true" />
        </button>
        {modelPicker}
        {mode && Selected && (
          <span className="mode-tag">
            <Selected size={14} aria-hidden="true" /> {MODE_LABELS[mode].label}
            <button type="button" aria-label="Back to chat" onClick={() => onMode(null)}><X size={13} aria-hidden="true" /></button>
          </span>
        )}
        {hint && Suggested && (
          <button type="button" className="mode-suggest" onClick={() => onMode(hint.mode)}>
            <Suggested size={14} aria-hidden="true" /> {MODE_LABELS[hint.mode].label}? <kbd>Tab</kbd>
          </button>
        )}
        <span className="mode-price">{price}</span>
        {action}
      </div>

    </div>
  );
}

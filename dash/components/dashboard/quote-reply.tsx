'use client';

import { useCallback, useSyncExternalStore } from 'react';

// One selection listener for the whole thread, even when many answers are loaded.
const listeners = new Set<() => void>();
let selected = { id: '', text: '' };
function selectionChanged() {
  const selection = window.getSelection();
  const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const element = range?.startContainer.nodeType === Node.ELEMENT_NODE
    ? range.startContainer as Element : range?.startContainer.parentElement;
  const body = element?.closest<HTMLElement>('[data-quote-answer]');
  const text = range && body?.contains(range.endContainer) && !selection?.isCollapsed
    ? selection?.toString().trim() ?? '' : '';
  const id = text ? body?.dataset.quoteAnswer ?? '' : '';
  if (selected.id === id && selected.text === text) return;
  selected = { id, text };
  listeners.forEach(listener => listener());
}
function subscribe(listener: () => void) {
  if (!listeners.size) document.addEventListener('selectionchange', selectionChanged);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (!listeners.size) {
      document.removeEventListener('selectionchange', selectionChanged);
      selected = { id: '', text: '' };
    }
  };
}
const serverSnapshot = () => '';

export function QuoteReply({ answerId, onQuote }: { answerId: string; onQuote: (text: string) => void }) {
  const snapshot = useCallback(() => selected.id === answerId ? selected.text : '', [answerId]);
  const quote = useSyncExternalStore(subscribe, snapshot, serverSnapshot);
  if (!quote) return null;
  return (
    <button type="button" className="cw-quote-reply" onPointerDown={event => event.preventDefault()} onClick={() => {
      onQuote(quote);
      window.getSelection()?.removeAllRanges();
    }}>Reply to selected text</button>
  );
}

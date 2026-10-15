import {
  createElement,
  Fragment,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from 'react';

/**
 * Site language. English is the source text and the default; Simplified Chinese
 * is a dictionary keyed by that English text, loaded only after a visitor picks
 * 中文, so English pages carry none of it. The server always renders English and
 * the stored choice applies right after hydration.
 */
export type Locale = 'en' | 'zh';
export type Dictionary = Readonly<Record<string, string>>;
export type Vars = Readonly<Record<string, string | number>>;

export interface Translator {
  /** The Chinese for this exact English text when 中文 is on, else the text itself. `{name}` placeholders take `vars`. */
  (text: string, vars?: Vars): string;
  /** Like the call form, but each `{name}` placeholder becomes a React node, so markup can move with the word order. */
  rich(text: string, nodes: Readonly<Record<string, ReactNode>>): ReactNode;
  locale: Locale;
}

type Snapshot = {
  readonly locale: Locale;
  readonly dictionary: Dictionary | null;
};

const STORAGE_KEY = 'conclave-locale';
const SERVER: Snapshot = { locale: 'en', dictionary: null };
const listeners = new Set<() => void>();
let snapshot: Snapshot = SERVER;
let loading: Promise<void> | null = null;

function publish(next: Snapshot) {
  snapshot = next;
  for (const listener of listeners) listener();
}

function loadChinese() {
  if (snapshot.dictionary || loading) return;
  loading = import('./zh/index.ts').then(
    ({ default: dictionary }) => publish({ ...snapshot, dictionary }),
    () => {
      loading = null;
    },
  );
}

function stored(): Locale {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'zh' ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

if (typeof window !== 'undefined') {
  snapshot = { locale: stored(), dictionary: null };
  if (snapshot.locale === 'zh') loadChinese();
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return;
    const locale = stored();
    if (locale !== snapshot.locale) publish({ ...snapshot, locale });
    if (locale === 'zh') loadChinese();
  });
}

export function setLocale(locale: Locale) {
  try {
    window.localStorage.setItem(STORAGE_KEY, locale);
  } catch {
    // Private windows may refuse storage; the choice still applies to this page.
  }
  if (locale !== snapshot.locale) publish({ ...snapshot, locale });
  if (locale === 'zh') loadChinese();
}

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const read = () => snapshot;
const readServer = () => SERVER;

const missing = new Set<string>();
if (typeof window !== 'undefined' && process.env.NODE_ENV !== 'production')
  // Development aid: English text rendered while 中文 was on but not in the dictionary.
  (window as { __conclaveMissingZh?: Set<string> }).__conclaveMissingZh =
    missing;

function lookup(state: Snapshot, text: string): string {
  if (state.locale !== 'zh' || !state.dictionary) return text;
  const found = Object.hasOwn(state.dictionary, text)
    ? state.dictionary[text]
    : undefined;
  if (typeof found === 'string') return found;
  if (text.trim()) missing.add(text);
  return text;
}

const fill = (template: string, vars?: Vars) =>
  vars
    ? template.replace(/\{(\w+)\}/g, (match, name: string) =>
        Object.hasOwn(vars, name) ? String(vars[name]) : match,
      )
    : template;

function richly(
  template: string,
  nodes: Readonly<Record<string, ReactNode>>,
): ReactNode {
  const parts = template.split(/\{(\w+)\}/g);
  return parts.map((part, index) =>
    index % 2
      ? createElement(
          Fragment,
          { key: index },
          Object.hasOwn(nodes, part) ? nodes[part] : `{${part}}`,
        )
      : part,
  );
}

function translatorFor(state: Snapshot): Translator {
  const t = ((text: string, vars?: Vars) =>
    fill(lookup(state, text), vars)) as Translator;
  t.rich = (text, nodes) => richly(lookup(state, text), nodes);
  t.locale = state.locale;
  return t;
}

/** The locale the visitor picked. It is 'en' during server rendering and hydration. */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, read, readServer).locale;
}

/** The translator for render code. Wrap user-facing English text at the place it is shown. */
export function useT(): Translator {
  const state = useSyncExternalStore(subscribe, read, readServer);
  return useMemo(() => translatorFor(state), [state]);
}

/** The same lookup outside React, for a document title or a message built in an event handler. */
export function translate(text: string, vars?: Vars): string {
  return fill(lookup(snapshot, text), vars);
}

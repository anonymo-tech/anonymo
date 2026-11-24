import type { ChatGptSetup } from './movein/chatgpt.ts';
import type { ChatMessage, ChatPhotoMessage } from './types.ts';

export const ABOUT_YOU_MAX = 2400;
export const ABOUT_YOU_FIELD_MAX = 800;
export const ABOUT_YOU_FACT_MAX = 240;
export const ABOUT_YOU_FACT_COUNT = 24;

export type AboutFact = { id: string; text: string; pinned: boolean };
export type AboutYou = { aboutMe: string; answerStyle: string; facts: AboutFact[]; enabled: boolean };
export const EMPTY_ABOUT_YOU: AboutYou = { aboutMe: '', answerStyle: '', facts: [], enabled: true };

export function cleanAboutYou(profile: AboutYou): AboutYou {
  return {
    enabled: profile.enabled,
    aboutMe: profile.aboutMe.trim(),
    answerStyle: profile.answerStyle.trim(),
    facts: profile.facts.flatMap(({ id, text, pinned }) => text.trim() ? [{ id, text: text.trim(), pinned }] : []),
  };
}

export const aboutYouLength = ({ aboutMe, answerStyle, facts }: AboutYou) =>
  aboutMe.length + answerStyle.length + facts.reduce((sum, { text }) => sum + text.length, 0);

export function aboutYouFits(profile: AboutYou) {
  return aboutYouLength(profile) <= ABOUT_YOU_MAX &&
    profile.aboutMe.length <= ABOUT_YOU_FIELD_MAX && profile.answerStyle.length <= ABOUT_YOU_FIELD_MAX &&
    profile.facts.length <= ABOUT_YOU_FACT_COUNT && profile.facts.every(({ text }) => text.length <= ABOUT_YOU_FACT_MAX);
}

export function readAboutYou(value: unknown): AboutYou {
  const profile = value as Partial<AboutYou> | null | undefined;
  if (typeof profile?.enabled !== 'boolean' || typeof profile.aboutMe !== 'string' || typeof profile.answerStyle !== 'string' ||
      !Array.isArray(profile.facts) || !profile.facts.every((fact) => fact && typeof fact.id === 'string' &&
        typeof fact.text === 'string' && typeof fact.pinned === 'boolean')) return EMPTY_ABOUT_YOU;
  const clean = cleanAboutYou(profile as AboutYou);
  return aboutYouFits(clean) ? clean : EMPTY_ABOUT_YOU;
}

// Quote the text so a pasted line cannot break out of its field or close the surrounding tag.
const quoted = (text: string) => JSON.stringify(text).replace(/</g, '\\u003c').replace(/>/g, '\\u003e');

export function buildAboutYouNote(profile: AboutYou): string {
  if (!profile.enabled || !aboutYouLength(profile) || !aboutYouFits(profile)) return '';
  const pinned = profile.facts.filter((fact) => fact.pinned);
  const others = profile.facts.filter((fact) => !fact.pinned);
  return [
    '<about_you>',
    'Use this profile when relevant to the conversation. Avoid quoting it unless asked. Keep it out of summaries unless the conversation itself includes it.',
    ...(profile.aboutMe ? [`About me: ${quoted(profile.aboutMe)}`] : []),
    ...(profile.answerStyle ? [`How I like answers: ${quoted(profile.answerStyle)}`] : []),
    ...pinned.map(({ text }) => `Pinned fact: ${quoted(text)}`),
    ...others.map(({ text }) => `Fact: ${quoted(text)}`),
    '</about_you>',
  ].join('\n');
}

export function withAboutYou<T extends ChatPhotoMessage>(messages: T[], note: string): (T | ChatMessage)[] {
  if (!note) return messages;
  const [first, ...rest] = messages;
  if (first?.role === 'system' && typeof first.content === 'string')
    return [{ ...first, content: `${first.content}\n\n${note}` }, ...rest];
  return [{ role: 'system', content: note }, ...messages];
}

type ImportField = 'aboutMe' | 'answerStyle' | 'fact';
export type AboutYouImport = { field: ImportField; text: string; shortened: boolean };

export function mapChatGptSetup(setup: ChatGptSetup): AboutYouImport[] {
  const items: AboutYouImport[] = [];
  const seen = new Set<string>();
  function add(field: ImportField, value: string | undefined, max: number) {
    const original = value?.trim();
    if (!original) return;
    const text = original.slice(0, max).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
    const key = `${field}|${text.toLowerCase()}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push({ field, text, shortened: original.length > max });
  }
  add('aboutMe', setup.aboutUser, ABOUT_YOU_FIELD_MAX);
  add('answerStyle', setup.aboutModel, ABOUT_YOU_FIELD_MAX);
  for (const fact of setup.saved ?? []) add('fact', fact, ABOUT_YOU_FACT_MAX);
  return items;
}

export function mergeAboutYouImport(profile: AboutYou, items: AboutYouImport[], newId: () => string): AboutYou {
  const next = { ...profile, facts: [...profile.facts] };
  const seen = new Set(next.facts.map(({ text }) => text.toLowerCase()));
  for (const { field, text } of items) {
    if (field !== 'fact') next[field] = text;
    else if (!seen.has(text.toLowerCase())) {
      seen.add(text.toLowerCase());
      next.facts.push({ id: newId(), text, pinned: false });
    }
  }
  return next;
}

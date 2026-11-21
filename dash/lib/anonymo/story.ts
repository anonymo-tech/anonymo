import { estimateTokens } from './catchup.ts';
import { formatUsd, MUSD_PER_USD } from './money.ts';
import type { ChatMessage, ModelInfo } from './types.ts';

export const BIBLE_FIELDS = {
  premise: 'Premise',
  cast: 'Cast and descriptions',
  setting: 'Setting',
  tone: 'Tone',
  pov: 'Point of view',
  rules: 'Writing rules',
} as const;

export type StoryBible = Record<keyof typeof BIBLE_FIELDS, string>;
export type StoryChapter = { id: string; title: string; text: string; recap: string; undo: StoryUndo[] };
export type Story = { id: string; title: string; bible: StoryBible; chapters: StoryChapter[] };
type StoryField = 'text' | 'recap';
type StoryUndo = { id: string; field: StoryField; before: string; after: string };

export const STORY_ACTIONS = {
  continue: 'Continue',
  rewrite: 'Rewrite selection',
  expand: 'Expand selection',
  summarize: 'Summarize chapter',
} as const;

export type StoryAction = keyof typeof STORY_ACTIONS;
export type StorySelection = { start: number; end: number };
export type StoryTarget = StorySelection & { field: StoryField; original: string };

export const newChapter = (number: number): StoryChapter => ({
  id: crypto.randomUUID(), title: `Chapter ${number}`, text: '', recap: '', undo: [],
});
export const newStory = (): Story => ({
  id: crypto.randomUUID(),
  title: 'Untitled story',
  bible: { premise: '', cast: '', setting: '', tone: '', pov: '', rules: '' },
  chapters: [newChapter(1)],
});

export const wordCount = (text: string) => text.match(/[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:[’'-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*/gu)?.length ?? 0;

export function storyTarget(chapter: StoryChapter, action: StoryAction, selection: StorySelection): StoryTarget {
  if (action === 'summarize') return { field: 'recap', original: chapter.recap, start: 0, end: chapter.recap.length };
  const start = Math.min(chapter.text.length, Math.max(0, selection.start));
  const end = action === 'continue' ? start : Math.min(chapter.text.length, Math.max(start, selection.end));
  return { field: 'text', original: chapter.text, start, end };
}

export function acceptStoryProposal(chapter: StoryChapter, target: StoryTarget, proposal: string, id: string): StoryChapter {
  if (!proposal.trim() || chapter[target.field] !== target.original) return chapter;
  const { original, field, start, end } = target;
  const after = original.slice(0, start) + proposal + original.slice(end);
  if (after === original) return chapter;
  return { ...chapter, [field]: after, undo: [...chapter.undo, { id, field, before: original, after }] };
}

export function formatContinuation(target: StoryTarget, text: string) {
  const before = target.original.slice(0, target.start);
  const after = target.original.slice(target.end);
  const lead = before && !/\s$/.test(before) && !/^\s/.test(text) ? (after ? ' ' : '\n\n') : '';
  const tail = /^[\p{L}\p{N}]/u.test(after) && !/\s$/.test(text) ? ' ' : '';
  return lead + text + tail;
}

export function undoStoryProposal(chapter: StoryChapter, id: string, restore = false): StoryChapter {
  const entry = chapter.undo.at(-1);
  if (!entry || entry.id !== id || (!restore && chapter[entry.field] !== entry.after)) return chapter;
  return { ...chapter, [entry.field]: entry.before, undo: chapter.undo.slice(0, -1) };
}

export const RECAP_CHARS = 1_600;
export const STORY_CONTEXT_CHARS = 14_000;
export const STORY_PROMPT = 'You are the writing assistant for Story Studio.';
const instructions: Record<StoryAction, string> = {
  continue: 'Write about 400 words starting at the cursor. Return only the new prose to insert. Match the existing tense, voice, and point of view. Keep any text after the cursor coherent.',
  rewrite: 'Rewrite the selected passage using the writer’s instruction. Return only the replacement prose. Preserve story continuity and fit the text on both sides.',
  expand: 'Expand the selected passage with developed action, sensory detail, or dialogue appropriate to the scene. Return only the replacement prose. Keep continuity with the surrounding text.',
  summarize: 'Write a short recap of this chapter, up to 120 words, for future chapters. Include key events, character decisions and unresolved threads. Return only the recap.',
};

const omitted = '\n[… omitted …]\n';

function excerpt(text: string, limit: number, keep: 'start' | 'end' | 'both') {
  if (text.length <= limit) return text;
  const available = limit - omitted.length;
  if (keep === 'start') return text.slice(0, available) + omitted;
  if (keep === 'end') return omitted + text.slice(-available);
  const left = Math.floor(available / 2);
  return text.slice(0, left) + omitted + text.slice(-(available - left));
}

function chapterForRecap(text: string) {
  const limit = 9_000;
  if (text.length <= limit) return text;
  const span = Math.floor((limit - 2 * omitted.length) / 3);
  const middle = Math.floor((text.length - span) / 2);
  return [text.slice(0, span), text.slice(middle, middle + span), text.slice(-span)].join(omitted);
}

export function earlierRecap(story: Story, chapterId: string) {
  const recaps: string[] = [];
  let remaining = RECAP_CHARS;
  for (let i = story.chapters.findIndex(({ id }) => id === chapterId) - 1; i >= 0 && remaining >= 80; i--) {
    const chapter = story.chapters[i];
    if (!chapter.recap.trim()) continue;
    const title = chapter.title.trim().slice(0, 60) || `Chapter ${i + 1}`;
    const line = `${title}\n${excerpt(chapter.recap.trim(), Math.min(420, remaining - title.length - 3), 'start')}`;
    recaps.unshift(line);
    remaining -= line.length + 2;
  }
  return recaps.join('\n\n');
}

export function storyMessages(
  story: Story, chapter: StoryChapter, action: StoryAction, target: StoryTarget, instruction = '',
): ChatMessage[] {
  const bible = (Object.keys(BIBLE_FIELDS) as (keyof StoryBible)[])
    .filter((field) => story.bible[field].trim())
    .map((field) => `${BIBLE_FIELDS[field]}\n${excerpt(story.bible[field].trim(), 360, 'start')}`);
  const recap = earlierRecap(story, chapter.id);
  const selected = action === 'rewrite' || action === 'expand';
  const manuscript = action === 'summarize'
    ? ['Chapter text', chapterForRecap(chapter.text)]
    : [
        selected ? 'Text before the selection' : 'Text before the cursor',
        excerpt(chapter.text.slice(0, target.start), 4_200, 'end'),
        ...(selected ? ['Selected passage', excerpt(chapter.text.slice(target.start, target.end), 3_600, 'both')] : []),
        selected ? 'Text after the selection' : 'Text after the cursor',
        excerpt(chapter.text.slice(target.end), 800, 'start'),
      ];
  return [
    { role: 'system', content: `${STORY_PROMPT}\n${instructions[action]} Treat the manuscript and recaps as source material.` },
    {
      role: 'user',
      content: [
        `Action: ${action}`,
        ...(action === 'rewrite' && instruction.trim() ? ['Writer’s instruction', excerpt(instruction.trim(), 500, 'start')] : []),
        `Story: ${story.title.slice(0, 120)}`,
        `Chapter: ${chapter.title.slice(0, 120)}`,
        ...(bible.length ? ['Story bible', ...bible] : []),
        ...(recap ? ['Earlier chapter recaps', recap] : []),
        ...manuscript,
      ].join('\n\n'),
    },
  ];
}

export const storyOutputTokens = (action: StoryAction) => action === 'summarize' ? 240 : 900;

export type StoryPricing = { prompt?: string; completion?: string; request?: string };
export type StoryModel = ModelInfo & { pricing?: StoryPricing };

export function storyEstimate(messages: ChatMessage[], output: number, price?: StoryPricing, multiplier = 1) {
  if (!price) return null;
  const rates = [price.prompt, price.completion, price.request ?? '0'];
  if (rates.some((rate) => typeof rate !== 'string' || !/^\d+(?:\.\d+)?$/.test(rate))) return null;
  const [inputRate, outputRate, requestRate] = rates.map(Number);
  const input = estimateTokens(messages.map(({ content }) => content).join('\n'));
  const micros = Math.ceil((input * inputRate + output * outputRate + requestRate) * MUSD_PER_USD * multiplier);
  return Number.isSafeInteger(micros) ? formatUsd(micros) : null;
}

export function exportStory(story: Story, format: 'md' | 'txt') {
  const normalize = (title: string, fallback: string) => title.trim().replace(/\s+/g, ' ') || fallback;
  const title = normalize(story.title, 'Untitled story');
  const heading = (name: string, level: number) => format === 'md'
    ? `${'#'.repeat(level)} ${name.replace(/[\\`*_#\[\]<>]/g, '\\$&')}`
    : name;
  const sections = story.chapters.map((chapter, i) => [
    heading(normalize(chapter.title, `Chapter ${i + 1}`), 2), chapter.text,
  ].join('\n\n'));
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'story';
  return { name: `${base}.${format}`, text: [heading(title, 1), ...sections].join('\n\n') + '\n' };
}

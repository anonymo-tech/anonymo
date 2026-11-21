import { deviceStore } from './device-store.ts';
import { DEMO_STORY } from './mock/story.ts';
import { BIBLE_FIELDS, type Story, type StoryChapter } from './story.ts';
import { startVault, vault } from './vault-browser.ts';
import { storySlot } from './vault.ts';

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function strings(value: Record<string, unknown>, keys: string[]) {
  return keys.every((key) => typeof value[key] === 'string');
}

function isChapter(value: unknown): value is StoryChapter {
  return object(value) && strings(value, ['id', 'title', 'text', 'recap']) && Array.isArray(value.undo) &&
    value.undo.every((entry) => object(entry) && strings(entry, ['id', 'before', 'after']) &&
      (entry.field === 'text' || entry.field === 'recap'));
}

function isStory(value: unknown): value is Story {
  return object(value) && strings(value, ['id', 'title']) && object(value.bible) &&
    strings(value.bible, Object.keys(BIBLE_FIELDS)) &&
    Array.isArray(value.chapters) && value.chapters.length > 0 && value.chapters.every(isChapter);
}

let listening = false;
function readStories(demo: boolean) {
  startVault();
  if (!listening && typeof window !== 'undefined') {
    listening = true;
    window.addEventListener('storage', ({ key }) => {
      if (key === null || key === storySlot(false) || key === storySlot(true)) void vault.refresh().catch(() => {});
    });
  }
  return vault.snapshotStories(demo).filter(isStory);
}

const liveStories = deviceStore<Story[]>(() => readStories(false), []);
const demoStories = deviceStore<Story[]>(() => readStories(true), []);
export const storiesStore = (demo: boolean) => demo ? demoStories : liveStories;

vault.subscribe(() => {
  liveStories.changed();
  demoStories.changed();
});

export function writeStories(demo: boolean, update: (stories: Story[]) => Story[]) {
  const mode = vault.state().mode;
  if ((mode !== 'off' && mode !== 'unlocked') ||
      (typeof document !== 'undefined' && document.documentElement.hasAttribute('data-anonymo-panic'))) {
    return Promise.reject(new Error('Story storage is closed.'));
  }
  return vault.updateStories(demo, (records) => update(records.filter(isStory)));
}

export type StoryEdit = (story: Story) => Story;

export function editStory(demo: boolean, id: string, edit: StoryEdit) {
  return writeStories(demo, (stories) => {
    const current = stories.find((story) => story.id === id);
    if (current) return stories.map((story) => story.id === id ? edit(story) : story);
    if (demo && id === DEMO_STORY.id) return [edit(DEMO_STORY), ...stories];
    throw new Error('Story is no longer saved.');
  });
}

export function editChapter(story: Story, id: string, change: (chapter: StoryChapter) => StoryChapter): Story {
  return { ...story, chapters: story.chapters.map((chapter) => chapter.id === id ? change(chapter) : chapter) };
}

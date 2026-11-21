'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { BookOpen, Download, Plus } from 'lucide-react';
import { useAnonymo } from '../anonymo-provider';
import { useVault } from './vault-controls';
import { StoryChapterEditor } from './story-chapter';
import { useDeviceStore } from '@/lib/anonymo/device-store';
import { DEMO_STORY } from '@/lib/anonymo/mock/story';
import { BIBLE_FIELDS, exportStory, newChapter, newStory, wordCount, type Story, type StoryBible, type StoryModel } from '@/lib/anonymo/story';
import { editChapter, editStory, storiesStore, writeStories, type StoryEdit } from '@/lib/anonymo/story-store';

export function StoryStudio() {
  const { mode } = useVault();
  const { demo, client } = useAnonymo();
  const stories = useDeviceStore(storiesStore(demo));
  const [catalog, setCatalog] = useState<{ client: typeof client; models: StoryModel[] }>();
  useEffect(() => {
    let active = true;
    void client.models().then(({ data }) => {
      if (active) setCatalog({ client, models: data });
    }, () => {});
    return () => { active = false; };
  }, [client]);
  if (mode === 'locked') return <p className="notice">Unlock the vault to open your stories.</p>;
  if (mode === 'unavailable') return <p className="notice" role="alert">Story storage is unavailable on this device.</p>;
  if (mode === 'loading') return <p className="faint" role="status">Opening story storage…</p>;
  const shelf = demo && !stories.some((story) => story.id === DEMO_STORY.id) ? [DEMO_STORY, ...stories] : stories;
  return <StoryShelf key={String(demo)} demo={demo} stories={shelf} models={catalog?.client === client ? catalog.models : []} />;
}

function StoryShelf({ demo, stories, models }: { demo: boolean; stories: Story[]; models: StoryModel[] }) {
  const [selected, setSelected] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState(false);
  const story = stories.find(({ id }) => id === selected) ?? stories[0];

  async function create() {
    setCreating(true);
    setError(false);
    try {
      const next = newStory();
      await writeStories(demo, (list) => [next, ...list]);
      setSelected(next.id);
    } catch {
      setError(true);
    } finally {
      setCreating(false);
    }
  }

  const picker = (
    <div className="story-shelf-tools">
      {story && (
        <label className="field">
          Story
          <select className="select" value={story.id} onChange={(event) => setSelected(event.currentTarget.value)}>
            {stories.map(({ id, title }) => <option key={id} value={id}>{title.trim() || 'Untitled story'}</option>)}
          </select>
        </label>
      )}
      <button className={`btn ${story ? 'btn-small' : 'btn-primary'}`} type="button" disabled={creating} onClick={() => void create()}>
        <Plus size={15} aria-hidden="true" /> {creating ? 'Creating…' : 'New story'}
      </button>
      {error && <p className="story-error" role="alert">Couldn’t create the story. Try again.</p>}
    </div>
  );

  return story ? <StoryBook key={story.id} original={story} demo={demo} picker={picker} models={models} /> : (
    <section className="panel story-empty">
      <BookOpen size={22} aria-hidden="true" />
      <h2>Start a story</h2>
      <p className="muted">Your stories are saved on this device.</p>
      {picker}
    </section>
  );
}

type FieldEdit = { change: StoryEdit; failed?: boolean };

function StoryBook({ original, demo, picker, models }: { original: Story; demo: boolean; picker: ReactNode; models: StoryModel[] }) {
  const [fields, setFields] = useState<Record<string, FieldEdit>>({});
  const [chapterId, setChapterId] = useState(original.id === DEMO_STORY.id ? original.chapters.at(-1)?.id : original.chapters[0].id);
  const [chapterBusy, setChapterBusy] = useState(false);
  const [chapterError, setChapterError] = useState(false);
  const story = Object.values(fields).reduce((value, entry) => entry.change(value), original);
  const chapter = story.chapters.find((entry) => entry.id === chapterId) ?? story.chapters[0];
  const index = story.chapters.indexOf(chapter);
  const counts = story.chapters.map(({ text }) => wordCount(text));
  const failed = Object.entries(fields).filter(([, entry]) => entry.failed);

  function saveField(key: string, change: StoryEdit) {
    const entry = { change };
    setFields((previous) => ({ ...previous, [key]: entry }));
    void editStory(demo, original.id, change).then(() => {
      setFields((previous) => {
        if (previous[key] !== entry) return previous;
        const next = { ...previous };
        delete next[key];
        return next;
      });
    }, () => {
      setFields((previous) => previous[key] === entry ? { ...previous, [key]: { change, failed: true } } : previous);
    });
  }

  async function addOrMove(move?: -1 | 1) {
    setChapterBusy(true);
    setChapterError(false);
    try {
      const next = move ? null : newChapter(story.chapters.length + 1);
      await editStory(demo, story.id, (stored) => {
        const chapters = [...stored.chapters];
        if (next) chapters.push(next);
        if (move) {
          const from = chapters.findIndex(({ id }) => id === chapter.id);
          const to = from + move;
          if (from < 0 || to < 0 || to >= chapters.length) return stored;
          const [moving] = chapters.splice(from, 1);
          chapters.splice(to, 0, moving);
        }
        return { ...stored, chapters };
      });
      if (next) setChapterId(next.id);
    } catch {
      setChapterError(true);
    } finally {
      setChapterBusy(false);
    }
  }

  function download(format: 'md' | 'txt') {
    const file = exportStory(story, format);
    const url = URL.createObjectURL(new Blob([file.text], { type: format === 'md' ? 'text/markdown;charset=utf-8' : 'text/plain;charset=utf-8' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = file.name;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const saveChapterField = (field: 'title' | 'text' | 'recap', text: string) =>
    saveField(`${chapter.id}/${field}`, (stored) => editChapter(stored, chapter.id, (current) => ({ ...current, [field]: text })));

  return (
    <div className="story-board">
      <div className="story-layout">
        <aside className="panel story-index" aria-label="Story and chapters">
          {picker}
          <div className="story-chapter-index">
            <h2>Chapters</h2>
            <ol>
              {story.chapters.map((entry, i) => (
                <li key={entry.id}>
                  <button
                    type="button"
                    className="story-chapter-tab"
                    aria-current={entry.id === chapter.id ? 'true' : undefined}
                    onClick={() => setChapterId(entry.id)}
                  >
                    <span className="story-chapter-number" aria-hidden="true">{i + 1}</span>
                    <span>{entry.title.trim() || `Chapter ${i + 1}`}</span>
                    <span className="faint story-count">{counts[i].toLocaleString()} words</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="story-buttons">
              <button className="btn btn-small" type="button" disabled={chapterBusy} onClick={() => void addOrMove()}>
                <Plus size={14} aria-hidden="true" /> Add chapter
              </button>
              {story.chapters.length > 1 && (
                <>
                  <button className="btn btn-small" type="button" aria-label="Move chapter earlier" disabled={chapterBusy || index === 0} onClick={() => void addOrMove(-1)}>↑</button>
                  <button className="btn btn-small" type="button" aria-label="Move chapter later" disabled={chapterBusy || index === story.chapters.length - 1} onClick={() => void addOrMove(1)}>↓</button>
                </>
              )}
            </div>
            {chapterError && <p className="story-error" role="alert">Couldn’t update chapters. Try again.</p>}
          </div>
          <div className="story-export">
            <p className="faint story-count">{counts.reduce((sum, count) => sum + count, 0).toLocaleString()} words in story</p>
            <div className="story-buttons" aria-label="Export story" role="group">
              <button className="btn btn-small" type="button" aria-label="Export Markdown" onClick={() => download('md')}><Download size={14} aria-hidden="true" /> Markdown</button>
              <button className="btn btn-small" type="button" aria-label="Export plain text" onClick={() => download('txt')}>Plain text</button>
            </div>
          </div>
        </aside>

        <section className="story-document" aria-label="Manuscript">
          <label className="field">
            Story title
            <input className="input story-title" value={story.title} maxLength={120}
              onChange={(event) => {
                const title = event.currentTarget.value;
                saveField('title', (stored) => ({ ...stored, title }));
              }}
            />
          </label>
          <div className="story-save">
            {failed.length > 0 ? (
              <>
                <span className="story-error" role="status">Some edits couldn’t be saved.</span>
                <button className="btn btn-small" type="button" onClick={() => failed.forEach(([key, entry]) => saveField(key, entry.change))}>Retry save</button>
              </>
            ) : <span>{Object.keys(fields).length ? 'Saving…' : 'Saved on this device'}</span>}
          </div>
          <StoryChapterEditor key={chapter.id} story={story} chapter={chapter} words={counts[index]} saveField={saveChapterField} models={models} />
        </section>

        <StoryBiblePanel bible={story.bible} chapter={chapter} save={saveField} saveRecap={(text) => saveChapterField('recap', text)} />
      </div>
    </div>
  );
}

function StoryBiblePanel({
  bible, chapter, save, saveRecap,
}: {
  bible: StoryBible;
  chapter: Story['chapters'][number];
  save: (key: string, edit: StoryEdit) => void;
  saveRecap: (text: string) => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    setOpen(window.matchMedia('(min-width: 1250px)').matches);
  }, []);
  return (
    <details className="panel story-bible" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
      <summary>Story bible</summary>
      <div className="story-bible-fields">
        {(Object.keys(BIBLE_FIELDS) as (keyof StoryBible)[]).map((field) => (
          <label className="field" key={field}>
            {BIBLE_FIELDS[field]}
            <textarea className="textarea" rows={field === 'cast' ? 3 : 2} value={bible[field]} onChange={(event) => {
              const value = event.currentTarget.value;
              save(field, (stored) => ({ ...stored, bible: { ...stored.bible, [field]: value } }));
            }} />
          </label>
        ))}
        <label className="field">
          Current chapter recap
          <textarea className="textarea" rows={4} value={chapter.recap} onChange={(event) => saveRecap(event.currentTarget.value)} />
        </label>
        <p className="faint story-recap-help">Used as context in later chapters.</p>
      </div>
    </details>
  );
}

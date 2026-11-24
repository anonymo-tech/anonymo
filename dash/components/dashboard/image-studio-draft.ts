import type { PictureSettings } from '@/lib/anonymo/chat-modes';

// One handoff between pages in this tab. The prompt stays out of the URL and browser storage.
let draft: { demo: boolean; prompt: string; settings: PictureSettings } | null = null;

export function giveStudioDraft(demo: boolean, prompt: string, settings: PictureSettings) {
  draft = { demo, prompt, settings };
}

export function takeStudioDraft(demo: boolean) {
  const next = draft;
  draft = null;
  return next?.demo === demo ? next : null;
}

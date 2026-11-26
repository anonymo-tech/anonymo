import { RESEARCH_CHAT } from './askmo.ts';

// Only known workspace tools and their opaque local IDs can be carried through setup.
const tools = new Map([
  ['/dashboard/chat', 'chat'], ['/dashboard/party', 'Party'], ['/dashboard/call', 'Night Call'],
  ['/dashboard/mo-voice', 'Mo Voice'], ['/dashboard/voices', 'Voices'],
  ['/dashboard/images', 'Image studio'], ['/dashboard/video', 'Video studio'],
  ['/dashboard/side-by-side', 'Side by side'], ['/dashboard/story', 'Story Studio'],
  ['/dashboard/characters', 'Character studio'], ['/dashboard/move-in', 'Move in'],
  ['/dashboard/usage', 'Usage & limits'], ['/dashboard/presets', 'frontend presets'],
  ['/dashboard/ventures', 'Ventures'],
]);

const characterId = /^[a-f0-9]{16}$/;
const storyId = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

const characterParam = { chat: 'character', call: 'character', 'mo-voice': 'character', characters: 'face', 'move-in': 'character' } as const;

export function characterDestination(tool: keyof typeof characterParam, id?: string | null) {
  const path = `/dashboard/${tool}`;
  if (!id || !characterId.test(id)) return path;
  return `${path}?${characterParam[tool]}=${id}`;
}

export function storyDestination(story: string, chapter: string) {
  if (!(storyId.test(story) || story === 'sample-story') || !(storyId.test(chapter) || /^sample-chapter-(one|two)$/.test(chapter))) return '/dashboard/story';
  return `/dashboard/story?story=${story}&chapter=${chapter}`;
}

export function setupReturn(value: string | null | undefined): { href: string; label: string; needsCredit: boolean } | null {
  if (!value || /[\s#\\%]/.test(value)) return null;
  if (value === RESEARCH_CHAT || value === '/dashboard/ask') return { href: RESEARCH_CHAT, label: 'Research', needsCredit: true };
  const [path, query, extra] = value.split('?');
  if (extra !== undefined) return null;
  if (query === undefined && /^\/dashboard\/ventures\/v_(?:[a-f0-9]{24}|demo[a-f0-9]{12})$/.test(path)) {
    return { href: path, label: 'venture board', needsCredit: false };
  }
  const label = tools.get(path);
  if (!label) return null;
  if (query !== undefined) {
    const params = new URLSearchParams(query);
    if (path === '/dashboard/story') {
      if (value !== storyDestination(params.get('story') ?? '', params.get('chapter') ?? '')) return null;
    } else {
      const tool = path.slice('/dashboard/'.length);
      if (tool !== 'chat' && tool !== 'call' && tool !== 'mo-voice' && tool !== 'characters' && tool !== 'move-in') return null;
      if (value !== characterDestination(tool, params.get(characterParam[tool]))) return null;
    }
  }
  return { href: value, label: path === '/dashboard/chat' && query ? 'character chat' : label, needsCredit: path !== '/dashboard/presets' && path !== '/dashboard/usage' };
}

export function setupHref(step: 'key' | 'funds' | 'redeem', destination?: string | null) {
  const target = setupReturn(destination);
  const path = step === 'redeem' ? '/redeem' : `/dashboard/${step}`;
  return `${path}${target ? `?returnTo=${encodeURIComponent(target.href)}` : ''}`;
}

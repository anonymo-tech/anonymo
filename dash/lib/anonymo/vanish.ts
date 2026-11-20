export const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const durations = { hour: HOUR_MS, day: 24 * HOUR_MS, week: 7 * 24 * HOUR_MS };
export type ExpiryChoice = 'never' | keyof typeof durations;
export const NEUTRAL_PAGE = 'https://en.wikipedia.org/wiki/Special:Random';

export function expiryChoice(value: unknown): ExpiryChoice {
  return value === 'hour' || value === 'day' || value === 'week' ? value : 'never';
}

export function expiresAfter(updatedAt: string, choice: ExpiryChoice): number | undefined {
  const at = Date.parse(updatedAt);
  return choice === 'never' || !Number.isFinite(at) ? undefined : at + durations[choice];
}

type Expiring = { expiresAt?: number };

export function savedExpiry(chat: Expiring & { updatedAt: string }): ExpiryChoice {
  if (chat.expiresAt === undefined) return 'never';
  const duration = chat.expiresAt - Date.parse(chat.updatedAt);
  if (duration === durations.hour) return 'hour';
  if (duration === durations.day) return 'day';
  if (duration === durations.week) return 'week';
  return 'never';
}

export function chatTiming(prior: SavedChat | undefined, message: SavedTurn, now: number, newChatDefault: ExpiryChoice | null) {
  const previous = prior?.turns.at(-1);
  const sameMessage = previous?.id === message.id && previous.content === message.content && previous.prompt === message.prompt;
  const trackMessages = newChatDefault !== null || prior?.expiresAt !== undefined;
  const updatedAt = prior && trackMessages && sameMessage ? prior.updatedAt : new Date(now).toISOString();
  const expiresAt = expiresAfter(updatedAt, prior ? savedExpiry(prior) : newChatDefault ?? 'never');
  return expiresAt === undefined ? { updatedAt } : { updatedAt, expiresAt };
}

export const hasExpired = ({ expiresAt }: Expiring, now = Date.now()): boolean =>
  typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= now;

export const sweepExpired = <T extends Expiring>(chats: T[], now = Date.now()): T[] =>
  chats.filter((chat) => !hasExpired(chat, now));

export function timeLeft(expiresAt: number, now = Date.now()): string {
  const ms = expiresAt - now;
  if (ms <= 0) return 'Due now';
  if (ms >= durations.day) return `${Math.floor(ms / durations.day)} d left`;
  if (ms >= HOUR_MS) return `${Math.floor(ms / HOUR_MS)} h left`;
  return `${Math.ceil(ms / MINUTE_MS)} min left`;
}

export function neutralUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !/^https:\/\//i.test(value.trim())) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}

export type VanishPrefs = { defaultExpiry: ExpiryChoice; panicOn: boolean; neutralPage: string; wipeOnPanic: boolean };

export function readVanishPrefs(value: Partial<VanishPrefs> | null): VanishPrefs {
  return {
    defaultExpiry: expiryChoice(value?.defaultExpiry),
    panicOn: value?.panicOn !== false,
    neutralPage: neutralUrl(value?.neutralPage) ?? NEUTRAL_PAGE,
    wipeOnPanic: value?.wipeOnPanic === true,
  };
}

export function panicSequence() {
  let first = 0;
  let count = 0;
  const reset = () => { count = 0; };
  return {
    reset,
    press(event: { key: string; isComposing?: boolean; repeat?: boolean }, now: number): boolean {
      if (event.isComposing || event.key !== 'Escape') {
        reset();
        return false;
      }
      if (event.repeat) return false;
      if (count === 0 || now - first > 1500) {
        first = now;
        count = 0;
      }
      if (++count < 3) return false;
      reset();
      return true;
    },
  };
}
import type { SavedChat, SavedTurn } from './history.ts';


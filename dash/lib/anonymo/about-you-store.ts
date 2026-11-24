import { useEffect, useSyncExternalStore } from 'react';
import { aboutYouFits, aboutYouLength, buildAboutYouNote, cleanAboutYou, readAboutYou, type AboutYou } from './about-you.ts';
import { updateOn } from './updates.ts';
import { startVault, vault } from './vault-browser.ts';
import { VaultLocked } from './vault.ts';

const ignore = () => () => {};
const serverNote = () => '';
const subscribe = (listener: () => void) => vault.subscribe(listener);
export const aboutYouReadable = (mode: ReturnType<typeof vault.state>['mode']) => mode === 'off' || mode === 'unlocked';

export const savedAboutYou = (demo: boolean) => readAboutYou(vault.snapshotAboutYou(demo));

export function currentAboutYouNote(demo: boolean) {
  return updateOn('aboutyou', demo) && aboutYouReadable(vault.state().mode) ? buildAboutYouNote(savedAboutYou(demo)) : '';
}

// A chat opened directly can send before the first device read finishes.
export function loadAboutYouForChat(demo: boolean) {
  if (!updateOn('aboutyou', demo)) return;
  startVault();
  if (vault.state().mode === 'loading') return vault.refresh().catch(() => {});
}

export function useAboutYouNote(on: boolean, demo: boolean) {
  useEffect(() => { if (on) startVault(); }, [on]);
  return useSyncExternalStore(on ? subscribe : ignore, on ? () => currentAboutYouNote(demo) : serverNote, serverNote);
}

export async function saveAboutYou(demo: boolean, session: number, base: AboutYou, profile: AboutYou) {
  const next = cleanAboutYou(profile);
  if (!aboutYouFits(next)) throw new Error('Trim your profile to fit the limits.');
  await vault.updateAboutYou(demo, (stored) => {
    if (session !== vault.session()) throw new VaultLocked();
    if (JSON.stringify(readAboutYou(stored)) !== JSON.stringify(base)) throw new Error('About you changed in another tab. Reload your profile and try again.');
    return aboutYouLength(next) ? next : undefined;
  });
}

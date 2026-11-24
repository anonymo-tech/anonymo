import { DEFAULT_MODE_PREFS, readModePrefs, type ModePrefs } from './chat-modes';
import { deviceStore, readJson, useDeviceStore, writeJson } from './device-store';

const slots = ['anonymo.chat-modes.v1', 'anonymo.demo.chat-modes.v1'];
const inMemory: (ModePrefs | null)[] = [null, null];
const stores = slots.map((slot, index) => deviceStore(() => inMemory[index] ?? readModePrefs(readJson(slot, null)), DEFAULT_MODE_PREFS));

export function useModePrefs(demo: boolean) {
  return useDeviceStore(stores[Number(demo)]);
}

export function setModePrefs<K extends keyof ModePrefs>(demo: boolean, mode: K, value: ModePrefs[K]) {
  const index = Number(demo);
  const next = { ...stores[index].get(), [mode]: value };
  inMemory[index] = writeJson(slots[index], next) ? null : next;
  stores[index].changed();
}

// Update "pricetag": per-chat spending limits, kept in this browser only (live and demo apart). "Wipe this device"
// removes them with every other anonymo.* key.

import { deviceStore, readJson, writeJson } from './device-store.ts';
import { limitSlot, readLimits, withLimit, type Limits } from './pricetag.ts';
import type { MicroUsd } from './types.ts';

// When this browser will not store a limit, it still holds for this page.
const thisPage: { live: Limits | null; demo: Limits | null } = { live: null, demo: null };
const read = (demo: boolean) => thisPage[demo ? 'demo' : 'live'] ?? readLimits(readJson(limitSlot(demo), {}));

const stores = {
  live: deviceStore<Limits>(() => read(false), {}),
  demo: deviceStore<Limits>(() => read(true), {}),
};

export const limitsStore = (demo: boolean) => (demo ? stores.demo : stores.live);

/** Sets one chat's limit, or removes it with null. False when this browser would not store it (it holds for this page). */
export function setChatLimit(demo: boolean, chatId: string, musd: MicroUsd | null): boolean {
  const store = limitsStore(demo);
  const next = withLimit(store.get(), chatId, musd);
  const ok = writeJson(limitSlot(demo), next);
  thisPage[demo ? 'demo' : 'live'] = ok ? null : next;
  store.changed();
  return ok;
}

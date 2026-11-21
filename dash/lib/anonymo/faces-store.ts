// Update "faces": where faces and backdrops are kept. They live in this browser only (IndexedDB, because six faces a
// character would not fit in localStorage next to the saved chats) and are never sent to Anonymo. "Wipe this device"
// deletes the whole database (wipeFaces), and removing a character removes its faces.
//
// Per character: the look sentence, the style, the six cut faces with their labels, the sheet as it was painted (it
// still carries its AI-made label and watermark, which the cut faces lose), and the art that came inside the card.
// Per chat: the backdrop and its scene sentence. Painted things are kept apart for demo and live mode, as saved chats
// are; a card's own art is the same file either way.

import {
  defaultLabels,
  isExpression,
  isFaceStyle,
  type Expression,
  type FaceStyle,
} from './faces.ts';

import { isPlush, readPlush, type Plush } from './plush.ts';

export const FACES_DB = 'anonymo.faces.v1';
const META = 'meta';
const BLOBS = 'blobs';
/** Backdrops are large, so only the newest few chats keep theirs. */
export const MAX_SCENES = 12;

export type FaceMeta = {
  look: string;
  style: FaceStyle;
  /** Which face shows in chat when both exist: the card's own art, or the painted faces. */
  use: 'card' | 'painted' | 'plush';
  plush?: Plush;
  /** The mood each cut face shows, in sheet order; null until faces are painted. */
  labels: Expression[] | null;
  updatedAt: string;
};
export type FaceSet = {
  meta: FaceMeta | null;
  art: Blob | null;
  sheet: Blob | null;
  tiles: Blob[];
  plushTiles: Blob[];
};
export type SceneMeta = { scene: string; style: FaceStyle; updatedAt: string };
export type Scene = { meta: SceneMeta; image: Blob };

const mode = (demo: boolean) => (demo ? 'demo' : 'live');
const faceKey = (demo: boolean, id: string) => `${mode(demo)}|face|${id}`;
const tileKey = (demo: boolean, id: string, i: number) =>
  `${faceKey(demo, id)}|tile|${i}`;
const plushKey = (demo: boolean, id: string, i: number) =>
  `${faceKey(demo, id)}|plush|${i}`;
const sheetKey = (demo: boolean, id: string) => `${faceKey(demo, id)}|sheet`;
const artKey = (id: string) => `art|${id}`;
const sceneKey = (demo: boolean, chatId: string) =>
  `${mode(demo)}|scene|${chatId}`;
const TILES = 6;

// ---- a tiny change signal, so every open view re-reads after a save ---------------------------------------------------

const listeners = new Set<() => void>();
let version = 0;
let channel: BroadcastChannel | null | undefined;
function otherTabs(): BroadcastChannel | null {
  if (channel !== undefined) return channel;
  try {
    channel =
      typeof BroadcastChannel === 'undefined'
        ? null
        : new BroadcastChannel(FACES_DB);
    if (channel) channel.onmessage = () => bump();
  } catch {
    channel = null;
  }
  return channel;
}
function bump() {
  version++;
  for (const l of listeners) l();
}
function changed() {
  bump();
  try {
    otherTabs()?.postMessage(1);
  } catch {
    // another tab will simply re-read later
  }
}
/** For useSyncExternalStore: a number that goes up whenever anything kept here changes, in this tab or another. */
export const facesVersion = {
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    otherTabs();
    return () => {
      listeners.delete(listener);
    };
  },
  get: () => version,
  server: () => 0,
};

// ---- IndexedDB -------------------------------------------------------------------------------------------------------

let opened: Promise<IDBDatabase> | null = null;
function open(): Promise<IDBDatabase> {
  opened ??= new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(FACES_DB, 1);
    } catch (error) {
      reject(
        error instanceof Error
          ? error
          : new Error('Storage is blocked in this browser.'),
      );
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(BLOBS)) db.createObjectStore(BLOBS);
    };
    request.onsuccess = () => {
      const db = request.result;
      // Another tab is wiping or upgrading: let go, and open again on the next call.
      db.onversionchange = () => {
        db.close();
        opened = null;
      };
      resolve(db);
    };
    request.onerror = () =>
      reject(request.error ?? new Error('Storage is blocked in this browser.'));
    request.onblocked = () =>
      reject(new Error('Storage is busy in another tab.'));
  }).catch((error: unknown) => {
    opened = null;
    throw error;
  });
  return opened;
}

type Stores = { meta: IDBObjectStore; blobs: IDBObjectStore };
async function work<T>(write: boolean, run: (s: Stores) => T): Promise<T> {
  const db = await open();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction([META, BLOBS], write ? 'readwrite' : 'readonly');
    const result = run({
      meta: tx.objectStore(META),
      blobs: tx.objectStore(BLOBS),
    });
    tx.oncomplete = () => resolve(result);
    tx.onerror = () =>
      reject(tx.error ?? new Error('This browser would not store that.'));
    tx.onabort = () =>
      reject(
        tx.error ??
          new Error(
            'This browser would not store that. It may be out of space.',
          ),
      );
  });
}
const read = <T>(request: IDBRequest): { value: T | undefined } => {
  const box: { value: T | undefined } = { value: undefined };
  request.onsuccess = () => {
    box.value = request.result as T | undefined;
  };
  return box;
};
const asBlob = (v: unknown): Blob | null => (v instanceof Blob ? v : null);

function validMeta(v: unknown): FaceMeta | null {
  const m = v as Partial<FaceMeta> | undefined;
  if (!m || typeof m.look !== 'string' || !isFaceStyle(m.style)) return null;
  const labels =
    Array.isArray(m.labels) &&
    m.labels.length === TILES &&
    m.labels.every(isExpression)
      ? m.labels
      : null;
  const plush = readPlush(m.plush);
  return {
    look: m.look,
    style: m.style,
    plush,
    use:
      m.use === 'plush' && plush
        ? 'plush'
        : m.use === 'card'
          ? 'card'
          : 'painted',
    labels,
    updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : '',
  };
}

// ---- faces -----------------------------------------------------------------------------------------------------------

/** Everything kept for one character in this mode. Empty (never an error) when there is nothing or storage is blocked. */
export async function loadFaces(demo: boolean, id: string): Promise<FaceSet> {
  try {
    const got = await work(false, (s) => ({
      meta: read<unknown>(s.meta.get(faceKey(demo, id))),
      art: read<unknown>(s.blobs.get(artKey(id))),
      sheet: read<unknown>(s.blobs.get(sheetKey(demo, id))),
      plush: Array.from({ length: TILES }, (_, i) =>
        read<unknown>(s.blobs.get(plushKey(demo, id, i))),
      ),
      tiles: Array.from({ length: TILES }, (_, i) =>
        read<unknown>(s.blobs.get(tileKey(demo, id, i))),
      ),
    }));
    const meta = validMeta(got.meta.value);
    const tiles = got.tiles.map((t) => asBlob(t.value));
    const whole = meta?.labels && tiles.every((t) => t !== null);
    const plush = got.plush.map((t) => asBlob(t.value));
    return {
      plushTiles: plush.every((t) => t !== null) ? (plush as Blob[]) : [],
      meta: meta && !whole ? { ...meta, labels: null } : meta,
      art: asBlob(got.art.value),
      sheet: whole ? asBlob(got.sheet.value) : null,
      tiles: whole ? (tiles as Blob[]) : [],
    };
  } catch {
    return { meta: null, art: null, sheet: null, tiles: [], plushTiles: [] };
  }
}

const stamp = () => new Date().toISOString();

/** Keeps the look sentence and style as they are typed, before anything is painted. */
export async function saveLook(
  demo: boolean,
  id: string,
  look: string,
  style: FaceStyle,
): Promise<void> {
  await patchMeta(demo, id, { look, style });
}

// Read and update metadata in the same write transaction as its tiles, including across tabs.
function updateMeta(
  s: Stores,
  demo: boolean,
  id: string,
  update: (prior: FaceMeta) => Partial<FaceMeta>,
) {
  const key = faceKey(demo, id);
  const request = s.meta.get(key);
  request.onsuccess = () => {
    const prior: FaceMeta = validMeta(request.result) ?? {
      look: '',
      style: 'plush',
      use: 'painted',
      labels: null,
      updatedAt: '',
    };
    s.meta.put({ ...prior, ...update(prior), updatedAt: stamp() }, key);
  };
}

export async function savePainted(
  demo: boolean,
  id: string,
  painted: { look: string; style: FaceStyle; sheet: Blob; tiles: Blob[] },
): Promise<void> {
  if (painted.tiles.length !== TILES)
    throw new Error('The sheet did not cut into six faces.');
  await work(true, (s) => {
    updateMeta(s, demo, id, () => ({
      look: painted.look,
      style: painted.style,
      use: 'painted',
      labels: defaultLabels(),
    }));
    s.blobs.put(painted.sheet, sheetKey(demo, id));
    painted.tiles.forEach((tile, i) => s.blobs.put(tile, tileKey(demo, id, i)));
  });
  changed();
}

export async function savePlush(
  demo: boolean,
  id: string,
  plush: Plush,
  tiles: Blob[],
) {
  if (!isPlush(plush) || tiles.length !== TILES)
    throw new Error('The plush could not be saved.');
  await work(true, (s) => {
    updateMeta(s, demo, id, () => ({ plush, use: 'plush' }));
    tiles.forEach((tile, i) => s.blobs.put(tile, plushKey(demo, id, i)));
  });
  changed();
}

async function patchMeta(
  demo: boolean,
  id: string,
  patch: Partial<FaceMeta>,
): Promise<void> {
  await work(true, (s) => updateMeta(s, demo, id, () => patch));
  changed();
}
/** Changes which mood each cut face shows (when the model drew them in another order, or one reads differently). */
export const setLabels = (demo: boolean, id: string, labels: Expression[]) =>
  patchMeta(demo, id, { labels });
export const setUse = (demo: boolean, id: string, use: FaceMeta['use']) =>
  patchMeta(demo, id, { use });

/** Keeps the art that came inside an imported card. */
export async function saveArt(id: string, art: Blob): Promise<void> {
  await work(true, (s) => {
    s.blobs.put(art, artKey(id));
  });
  changed();
}

function dropPainted(s: Stores, demo: boolean, id: string) {
  s.blobs.delete(sheetKey(demo, id));
  for (let i = 0; i < TILES; i++) s.blobs.delete(tileKey(demo, id, i));
}

/** Removes the painted faces for this mode; the look sentence and the card's own art stay. */
export async function removePainted(demo: boolean, id: string): Promise<void> {
  await work(true, (s) => {
    dropPainted(s, demo, id);
    updateMeta(s, demo, id, (prior) => ({
      labels: null,
      use: prior.use === 'painted' && prior.plush ? 'plush' : prior.use,
    }));
  });
  changed();
}

/** Removes everything kept for a character, in both modes. Called when the character is removed. */
export async function removeFaces(id: string): Promise<void> {
  try {
    await work(true, (s) => {
      for (const demo of [false, true]) {
        s.meta.delete(faceKey(demo, id));
        dropPainted(s, demo, id);
        for (let i = 0; i < TILES; i++) s.blobs.delete(plushKey(demo, id, i));
      }
      s.blobs.delete(artKey(id));
    });
  } catch {
    // nothing was kept
  }
  changed();
}

// ---- backdrops -------------------------------------------------------------------------------------------------------

export async function loadScene(
  demo: boolean,
  chatId: string,
): Promise<Scene | null> {
  try {
    const got = await work(false, (s) => ({
      meta: read<SceneMeta>(s.meta.get(sceneKey(demo, chatId))),
      image: read<unknown>(s.blobs.get(sceneKey(demo, chatId))),
    }));
    const image = asBlob(got.image.value);
    const meta = got.meta.value;
    return image && meta && typeof meta.scene === 'string'
      ? {
          meta: {
            scene: meta.scene,
            style: isFaceStyle(meta.style) ? meta.style : 'painted',
            updatedAt: String(meta.updatedAt ?? ''),
          },
          image,
        }
      : null;
  } catch {
    return null;
  }
}

/** Keeps a chat's backdrop, and lets go of the oldest ones past MAX_SCENES. */
export async function saveScene(
  demo: boolean,
  chatId: string,
  scene: string,
  style: FaceStyle,
  image: Blob,
): Promise<void> {
  const prefix = `${mode(demo)}|scene|`;
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([META, BLOBS], 'readwrite');
    const meta = tx.objectStore(META),
      blobs = tx.objectStore(BLOBS);
    meta.put(
      { scene, style, updatedAt: stamp() } satisfies SceneMeta,
      sceneKey(demo, chatId),
    );
    blobs.put(image, sceneKey(demo, chatId));
    const all = meta.getAll(IDBKeyRange.bound(prefix, `${prefix}￿`));
    const keys = meta.getAllKeys(IDBKeyRange.bound(prefix, `${prefix}￿`));
    keys.onsuccess = () => {
      const rows = (keys.result as string[]).map((key, i) => ({
        key,
        at: String((all.result as SceneMeta[])[i]?.updatedAt ?? ''),
      }));
      rows.sort((a, b) => b.at.localeCompare(a.at));
      for (const old of rows.slice(MAX_SCENES)) {
        meta.delete(old.key);
        blobs.delete(old.key);
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () =>
      reject(tx.error ?? new Error('This browser would not store that.'));
    tx.onabort = () =>
      reject(
        tx.error ??
          new Error(
            'This browser would not store that. It may be out of space.',
          ),
      );
  });
  changed();
}

export async function removeScene(
  demo: boolean,
  chatId: string,
): Promise<void> {
  try {
    await work(true, (s) => {
      s.meta.delete(sceneKey(demo, chatId));
      s.blobs.delete(sceneKey(demo, chatId));
    });
  } catch {
    // nothing was kept
  }
  changed();
}

// ---- wipe ------------------------------------------------------------------------------------------------------------

/** "Wipe this device": deletes every face, sheet, card image and backdrop kept in this browser. */
export async function wipeFaces(): Promise<void> {
  try {
    (await opened)?.close();
  } catch {
    // it never opened
  }
  opened = null;
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.deleteDatabase(FACES_DB);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error ?? new Error('Could not clear saved faces.'));
    request.onblocked = () => reject(new Error('Close other workspace tabs and try again.'));
  });
  changed();
}

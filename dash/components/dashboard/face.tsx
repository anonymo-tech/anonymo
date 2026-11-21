'use client';

// Update "faces": reading a character's faces (and a chat's backdrop) from this device and showing them. The pictures
// are files in this browser (lib/anonymo/faces-store.ts), handed to <img> as object URLs that are let go when they change.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Photo } from '@/components/photo';
import { EXPRESSIONS, EXPRESSION_LABEL, moodOf, tileFor, type Expression } from '@/lib/anonymo/faces';
import { facesVersion, loadFaces, loadScene, type FaceMeta, type SceneMeta } from '@/lib/anonymo/faces-store';
import type { Turn } from './chat-types';
import './faces.css';

export type Faces = {
  id: string;
  meta: FaceMeta | null;
  /** The art that came inside the card, if it was a PNG. */
  art: string | null;
  /** The six cut faces in sheet order; empty until they are painted. */
  tiles: string[];
  plushTiles: string[];
  /** The sheet as it was painted, for download. */
  sheet: string | null;
};

/** Hands out object URLs for one load, and lets the previous load's go a moment later (they may still be on screen). */
function useUrls() {
  const held = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const u of held.current) URL.revokeObjectURL(u);
      held.current = [];
    },
    [],
  );
  return useCallback((blobs: (Blob | null)[]): (string | null)[] => {
    const old = held.current;
    const urls = blobs.map((b) => (b ? URL.createObjectURL(b) : null));
    held.current = urls.filter((u): u is string => u !== null);
    window.setTimeout(() => old.forEach((u) => URL.revokeObjectURL(u)), 2000);
    return urls;
  }, []);
}

/** A character's faces on this device, or null while loading and when `id` is null. Re-reads when they change. */
export function useFaces(demo: boolean, id: string | null): Faces | null {
  const version = useSyncExternalStore(facesVersion.subscribe, facesVersion.get, facesVersion.server);
  const [loaded, setLoaded] = useState<(Faces & { demo: boolean }) | null>(null);
  const urls = useUrls();
  useEffect(() => {
    if (!id) return;
    let stale = false;
    void loadFaces(demo, id).then((set) => {
      if (stale) return;
      const [art, sheet, ...tiles] = urls([set.art, set.sheet, ...set.tiles, ...set.plushTiles]);
      setLoaded({ id, demo, meta: set.meta, art, sheet, tiles: tiles.slice(0, set.tiles.length) as string[], plushTiles: tiles.slice(set.tiles.length) as string[] });
    });
    return () => {
      stale = true;
    };
  }, [demo, id, version, urls]);
  return loaded && loaded.id === id && loaded.demo === demo ? loaded : null;
}

export type SceneView = { url: string; meta: SceneMeta };

/** A chat's backdrop on this device, or null. */
export function useScene(demo: boolean, chatId: string | null): SceneView | null {
  const version = useSyncExternalStore(facesVersion.subscribe, facesVersion.get, facesVersion.server);
  const [loaded, setLoaded] = useState<{ key: string; view: SceneView | null } | null>(null);
  const urls = useUrls();
  const key = chatId ? `${demo ? 'demo' : 'live'}|${chatId}` : null;
  useEffect(() => {
    if (!chatId || !key) return;
    let stale = false;
    void loadScene(demo, chatId).then((scene) => {
      if (stale) return;
      const [url] = urls([scene?.image ?? null]);
      setLoaded({ key, view: scene && url ? { url, meta: scene.meta } : null });
    });
    return () => {
      stale = true;
    };
  }, [demo, chatId, key, version, urls]);
  return loaded && loaded.key === key ? loaded.view : null;
}

function activeTiles(faces: Faces) {
  if (faces.meta?.use === 'card' && faces.art) return [];
  if (faces.meta?.use === 'plush' && faces.plushTiles.length) return faces.plushTiles;
  if (faces.tiles.length) return faces.tiles;
  return faces.art ? [] : faces.plushTiles;
}

function moodIndex(faces: Faces, tiles: string[], mood: Expression) {
  return tiles === faces.plushTiles ? EXPRESSIONS.indexOf(mood) : tileFor(faces.meta?.labels ?? [], mood);
}

export function faceSrc(faces: Faces | null, mood: Expression): string | null {
  if (!faces) return null;
  const tiles = activeTiles(faces);
  return tiles[moodIndex(faces, tiles, mood)] ?? faces.art;
}
export const hasFace = (faces: Faces | null) => !!faceSrc(faces, 'calm');

/** One still face. Renders nothing when there is none, so the caller can show the mascot instead. */
export function FaceAvatar({ faces, mood = 'calm', alt = '', className }: { faces: Faces | null; mood?: Expression; alt?: string; className?: string }) {
  const src = faceSrc(faces, mood);
  if (!src) return null;
  return <Photo className={className ? `face ${className}` : 'face'} src={src} alt={alt} loading="eager" />;
}

/** A face that fades from mood to mood: all six are stacked and the current one is shown. */
export function FacePortrait({ faces, mood, name, className }: { faces: Faces | null; mood: Expression; name: string; className?: string }) {
  if (!faces || !hasFace(faces)) return null;
  const cls = className ? `face-stack ${className}` : 'face-stack';
  const tiles = activeTiles(faces);
  if (!tiles.length)
    return (
      <span className={cls}>
        <Photo src={faces.art ?? faces.tiles[0]} alt={name} data-on="true" loading="eager" />
      </span>
    );
  const on = moodIndex(faces, tiles, mood);
  return (
    <span className={cls} data-mood={mood}>
      {tiles.map((src, i) => (
        <Photo key={src} src={src} alt={i === on ? `${name}, ${EXPRESSION_LABEL[mood].toLowerCase()}` : ''} aria-hidden={i === on ? undefined : true} data-on={i === on} loading="eager" />
      ))}
    </span>
  );
}

/**
 * The picture beside one answer in the thread: the character's face in that reply's mood (fading while the reply is
 * still being written), or the mascot when the reply was not from the character whose faces are loaded.
 */
export function TurnFace({ faces, turn, size = 52 }: { faces: Faces | null; turn: Turn; size?: number }) {
  const mood = useMemo(() => (turn.status === 'error' ? 'calm' : moodOf(turn.content)), [turn.status, turn.content]);
  if (!hasFace(faces)) return <Photo src="/mascot/avatar.jpg" alt="" width={size} height={size} />;
  if (turn.status === 'streaming') return <FacePortrait faces={faces} mood={mood} name={turn.character ?? ''} className="face-sm" />;
  return <FaceAvatar faces={faces} mood={mood} />;
}

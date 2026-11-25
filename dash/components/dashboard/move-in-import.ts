'use client';

// Runs one Move In import: in a worker when the drop is large, on the page when it is small (or when a worker cannot
// be used). Either way the files are read in this browser and written to the on-device archive.

import { loadArchive, sweepOrphans } from '@/lib/anonymo/movein/archive';
import { idbDisk } from '@/lib/anonymo/movein/archive-idb';
import { lifeboatCardCheck } from '@/lib/anonymo/movein/floor';
import { importFiles, ImportStopped, type DropFile, type ImportProgress, type ImportSummary } from '@/lib/anonymo/movein/importer';
import { dropReady, makeReadyWhereFree } from '@/lib/anonymo/movein/ready';
import { archiveChanged, archiveDisk, beginWrite, importRunning, moveInPersists } from '@/lib/anonymo/movein/store';
import { updateOn } from '@/lib/anonymo/updates';
import type { ImportReply, ImportRequest } from './movein.worker';
// oxlint-disable-next-line import/default -- Vite's worker URL loader supplies this default export.
import importWorkerUrl from './movein.worker.ts?worker&url';

/** Past this, parsing would hold up the page, so it moves to a worker. */
const WORKER_BYTES = 1_500_000;

export type RunningImport = { done: Promise<ImportSummary>; stop: () => void };

function onPage(files: DropFile[], demo: boolean, onProgress: (p: ImportProgress) => void): RunningImport {
  const abort = new AbortController();
  return {
    done: importFiles(files, archiveDisk(), demo, {
      onProgress, signal: abort.signal, aboutYou: updateOn('aboutyou', demo),
      checkCard: updateOn('lifeboat', demo) ? lifeboatCardCheck(demo) : undefined,
    }),
    stop: () => abort.abort(),
  };
}

function inWorker(files: DropFile[], demo: boolean, onProgress: (p: ImportProgress) => void): RunningImport {
  let stop = () => {};
  const done = new Promise<ImportSummary>((resolve, reject) => {
    let worker: Worker | null = null;
    let heard = false;
    let fallback: RunningImport | null = null;
    // A worker that cannot start (blocked, or its script did not load) is replaced by reading on the page.
    const viaPage = () => {
      fallback = onPage(files, demo, onProgress);
      fallback.done.then(resolve, reject);
    };
    stop = () => {
      if (fallback) return fallback.stop();
      worker?.terminate();
      // The worker was cut off mid-write: remove the chat text no character lists yet.
      void sweepOrphans(idbDisk, demo).catch(() => undefined);
      reject(new ImportStopped());
    };
    try {
      worker = new Worker(importWorkerUrl, { type: 'module' });
    } catch {
      return viaPage();
    }
    const started = worker;
    started.onmessage = (event: MessageEvent<ImportReply>) => {
      heard = true;
      const reply = event.data;
      if (reply.type === 'progress') return onProgress(reply.progress);
      started.terminate();
      if (reply.type === 'done') resolve(reply.summary);
      else reject(new Error(reply.message));
    };
    started.onerror = () => {
      started.terminate();
      if (!heard && !fallback) viaPage();
      else reject(new Error('The import stopped unexpectedly. Try again.'));
    };
    const request: ImportRequest = { files, demo, aboutYou: updateOn('aboutyou', demo), lifeboat: updateOn('lifeboat', demo) };
    started.postMessage(request);
  });
  return { done, stop: () => stop() };
}

/**
 * Reads the dropped files into the archive, then makes the new characters ready for chat where the list has room.
 * `done` rejects with ImportStopped after stop(), or after a wipe.
 */
export function startImport(files: DropFile[], demo: boolean, onProgress: (p: ImportProgress) => void): RunningImport {
  let running: RunningImport | null = null;
  let stopped = false;
  const stop = () => {
    stopped = true;
    running?.stop();
  };
  importRunning(stop);
  const done = (async () => {
    try {
      if (!(await beginWrite()) || stopped) throw new ImportStopped();
      const size = files.reduce((sum, file) => sum + file.blob.size, 0);
      running = size > WORKER_BYTES && moveInPersists() && typeof Worker !== 'undefined' ? inWorker(files, demo, onProgress) : onPage(files, demo, onProgress);
      const summary = await running.done;
      await archiveChanged(demo);
      const view = await loadArchive(archiveDisk(), demo);
      const touched = new Set(summary.ids);
      dropReady(summary.replaced.map((r) => r.from));
      makeReadyWhereFree(view.characters.filter((c) => touched.has(c.id)));
      return summary;
    } finally {
      importRunning(null);
    }
  })();
  return { done, stop };
}

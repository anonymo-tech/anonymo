// Update "movein": a large export is read here, off the main thread, so the page stays responsive while hundreds of
// megabytes are unpacked and parsed. The worker reads the dropped files and writes straight to the on-device archive
// (IndexedDB). Only the optional floor check can send card text to the gateway.

import { idbDisk } from '../../lib/anonymo/movein/archive-idb.ts';
import { importFiles, type DropFile, type ImportProgress, type ImportSummary } from '../../lib/anonymo/movein/importer.ts';
import { lifeboatCardCheck } from '../../lib/anonymo/movein/floor.ts';

export type ImportRequest = { files: DropFile[]; demo: boolean; aboutYou: boolean; lifeboat: boolean };
export type ImportReply = { type: 'progress'; progress: ImportProgress } | { type: 'done'; summary: ImportSummary } | { type: 'failed'; message: string };

declare const self: {
  onmessage: ((event: MessageEvent<ImportRequest>) => void) | null;
  postMessage: (reply: ImportReply) => void;
};

if (typeof self !== 'undefined' && typeof document === 'undefined') {
  self.onmessage = (event) => {
    let last = 0;
    importFiles(event.data.files, idbDisk, event.data.demo, {
      aboutYou: event.data.aboutYou,
      checkCard: event.data.lifeboat ? lifeboatCardCheck(event.data.demo) : undefined,
      onProgress: (progress) => {
        const now = Date.now();
        if (now - last < 120) return;
        last = now;
        self.postMessage({ type: 'progress', progress });
      },
    }).then(
      (summary) => self.postMessage({ type: 'done', summary }),
      (error: unknown) => self.postMessage({ type: 'failed', message: error instanceof Error ? error.message : 'The import could not be finished.' }),
    );
  };
}

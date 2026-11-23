'use client';

import { useCallback, useEffect, useRef } from 'react';
import type { GuardScanResult } from '../../lib/guards/index';
import type { PersonalFinding } from '../../lib/guards/personal';

export type ContentScan = GuardScanResult & { personal?: PersonalFinding[] };

/** True when the text could not be checked at all (worker missing, crashed, timed out or refused the input). */
export const scanFailed = (result: GuardScanResult) => result.findings.some((finding) => finding.type === 'input');
// oxlint-disable-next-line import/default -- Vite's worker URL loader supplies this default export.
import guardWorkerUrl from './content-guard.worker.ts?worker&url';

/** Keep the checksum dictionaries and scanning work off the UI thread. */
export function useContentGuard() {
  const worker = useRef<Worker | null>(null);
  const pending = useRef(
    new Map<
      string,
      {
        resolve: (result: ContentScan) => void;
        timer: ReturnType<typeof setTimeout>;
      }
    >(),
  );
  const unavailable = useCallback(
    (): ContentScan => ({
      findings: [
        {
          start: 0,
          end: 0,
          type: 'input',
          severity: 'block',
          code: 'input.scan-unavailable',
          message:
            'The content check is unavailable. Nothing has been sent. Try again.',
        },
      ],
      redacted: '',
    }),
    [],
  );
  const stop = useCallback(() => {
    worker.current?.terminate();
    worker.current = null;
    for (const request of pending.current.values()) {
      clearTimeout(request.timer);
      request.resolve(unavailable());
    }
    pending.current.clear();
  }, [unavailable]);
  useEffect(() => stop, [stop]);
  return useCallback(
    (text: string, options: { personal?: boolean } = {}): Promise<ContentScan> => {
      try {
        if (!worker.current) {
          const created = new Worker(guardWorkerUrl, { type: 'module' });
          created.onmessage = (event: MessageEvent<unknown>) => {
            const result = event.data as ContentScan & { id?: string };
            if (!result || typeof result.id !== 'string') {
              stop();
              return;
            }
            const request = pending.current.get(result.id);
            if (!request) return;
            clearTimeout(request.timer);
            pending.current.delete(result.id);
            if (
              !Array.isArray(result.findings) ||
              typeof result.redacted !== 'string' ||
              (result.personal !== undefined && !Array.isArray(result.personal))
            )
              request.resolve(unavailable());
            else request.resolve(result);
          };
          created.onerror = () => stop();
          created.onmessageerror = () => stop();
          worker.current = created;
        }
        return new Promise((resolve) => {
          const id = crypto.randomUUID();
          const timer = setTimeout(stop, 30000);
          pending.current.set(id, { resolve, timer });
          worker.current!.postMessage({ id, text, personal: options.personal === true });
        });
      } catch {
        stop();
        return Promise.resolve(unavailable());
      }
    },
    [stop, unavailable],
  );
}

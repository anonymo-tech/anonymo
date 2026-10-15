import { publicInferenceErrorCode } from './public-inference.ts';
import { createDatabase, one } from '../db/database.ts';
import { getSession } from './session.ts';
import { uuidField } from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import { configuredKeyring, decryptText } from '../core/encryption.ts';
import { rateLimit } from '../core/rate-limit.ts';

/** Bounded SSE connections resume from durable snapshots; the worker owns inference. */
export async function callEventStream(
  request: Request,
  databaseUrl: string,
  callId: string,
) {
  const id = uuidField(callId),
    pool = createDatabase(databaseUrl, 1);
  try {
    const session = await getSession(pool, request);
    await rateLimit(pool, `events:${session.accountId}`, 30);
    const owned = await one(
      pool,
      'SELECT id FROM calls WHERE id=$1 AND account_id=$2',
      [id, session.accountId],
    );
    requireCondition(
      owned,
      404,
      'CALL_NOT_FOUND',
      'This request is unavailable.',
    );
    const keyring = configuredKeyring();
    const encoder = new TextEncoder();
    let cancelled = false;
    let finishWait: (() => void) | undefined;
    const stop = () => {
      cancelled = true;
      finishWait?.();
    };
    request.signal.addEventListener('abort', stop, { once: true });
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        let cursor = request.headers.get('last-event-id') ?? '';
        const deadline = Date.now() + 25_000;
        const send = (event: string, value: unknown, eventId?: string) => {
          if (!cancelled)
            controller.enqueue(
              encoder.encode(
                `${eventId ? `id: ${eventId}\n` : ''}event: ${event}\ndata: ${JSON.stringify(value)}\n\n`,
              ),
            );
        };
        try {
          if (request.signal.aborted) stop();
          while (!cancelled && Date.now() < deadline) {
            if ((controller.desiredSize ?? 0) <= 0) {
              await new Promise<void>((resolve) => {
                const timer = setTimeout(resolve, 250);
                finishWait = () => {
                  clearTimeout(timer);
                  resolve();
                };
                if (cancelled) finishWait();
              });
              finishWait = undefined;
              continue;
            }
            await getSession(pool, request);
            const call = await one<{
              state: string;
              error_code: string | null;
              output_ciphertext: string | null;
              version: string;
              maximum_usd6: string;
              captured_usd6: string | null;
              billing_state: string;
              cancel_requested: boolean;
              blind: boolean;
            }>(
              pool,
              // The hold's row version is part of the cursor, so a cancellation
              // request is visible before the worker next writes the call.
              `SELECT c.state,c.error_code,c.output_ciphertext,c.xmin::text || '.' || h.xmin::text AS version,h.maximum_usd6,h.captured_usd6,h.state AS billing_state,
                 h.cancel_requested_at IS NOT NULL AS cancel_requested,
                 EXISTS(SELECT 1 FROM comparison_calls cc JOIN comparisons co ON co.id=cc.comparison_id WHERE cc.call_id=c.id AND co.blind AND co.revealed_at IS NULL) AS blind
               FROM calls c JOIN holds h ON h.id=c.hold_id WHERE c.id=$1 AND c.account_id=$2`,
              [id, session.accountId],
            );
            requireCondition(
              call,
              404,
              'CALL_NOT_FOUND',
              'This request is unavailable.',
            );
            if (cursor !== call.version) {
              const output = call.output_ciphertext
                ? await decryptText(
                    call.output_ciphertext,
                    `${session.accountId}:call-output:${id}`,
                    keyring,
                  )
                : '';
              send(
                'snapshot',
                {
                  id,
                  state: call.state,
                  errorCode: publicInferenceErrorCode(call.error_code),
                  output,
                  // Additive: true once a stop was requested. A running call
                  // with this flag is settling: output is frozen while the
                  // provider reports the final usage.
                  cancelRequested: call.cancel_requested,
                  billing: {
                    state: call.billing_state,
                    maximumUsd6: call.blind ? null : call.maximum_usd6,
                    actualUsd6: call.blind ? null : call.captured_usd6,
                  },
                },
                call.version,
              );
              cursor = call.version;
            }
            if (!['queued', 'running'].includes(call.state)) {
              send('complete', { id });
              break;
            }
            if (!cancelled)
              controller.enqueue(encoder.encode(': heartbeat\n\n'));
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, 500);
              finishWait = () => {
                clearTimeout(timer);
                resolve();
              };
              if (cancelled) finishWait();
            });
            finishWait = undefined;
          }
        } catch {
          send('unavailable', {
            code: 'STREAM_UNAVAILABLE',
            message: 'Reconnect to read this request’s latest status.',
          });
        } finally {
          request.signal.removeEventListener('abort', stop);
          await pool.end();
          if (!cancelled) controller.close();
        }
      },
      cancel() {
        stop();
      },
    });
    return new Response(body, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    await pool.end();
    throw error;
  }
}

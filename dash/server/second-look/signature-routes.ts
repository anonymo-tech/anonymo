import type { Pool } from 'pg';
import {
  inspectSignature,
  parseSignatureInput,
  signatureCapability,
} from './signature.ts';
import { serviceConfig } from '../core/config.ts';
import { jsonResponse, readJson } from '../core/http.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { rpcBuckets } from '../routes/solana.ts';
import { createPaymentRpc } from '../solana/payment-rpc.ts';
import { SolanaError } from '../solana/validation.ts';
import { ServiceError } from '../core/errors.ts';

export async function signatureRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path === 'second-look/signature/capabilities' && request.method === 'GET')
    return jsonResponse(signatureCapability());
  if (path !== 'second-look/signature/inspect' || request.method !== 'POST')
    return null;
  await rateLimit(pool, `signature-inspect:${accountId}`, 10);
  try {
    const input = parseSignatureInput(await readJson(request, 54000));
    if (input.kind !== 'transaction' && input.kind !== 'action')
      return jsonResponse({
        report: await inspectSignature(input, { signal: request.signal }),
      });
    await rpcBuckets(pool, request, accountId);
    const config = serviceConfig();
    if (!config.rpcUrl || !config.cluster)
      throw new ServiceError(
        503,
        'RPC_UNAVAILABLE',
        'A Solana reader is not configured.',
      );
    const rpc = createPaymentRpc({
      rpcUrl: config.rpcUrl,
      cluster: config.cluster,
    });
    return jsonResponse({
      report: await inspectSignature(input, {
        cluster: config.cluster,
        rpc: (method, params, signal) => rpc.call(method, params, signal),
        signal: request.signal,
      }),
    });
  } catch (error) {
    if (error instanceof SolanaError)
      throw new ServiceError(
        [
          'invalid_input',
          'unsupported_transaction',
          'sensitive_input',
        ].includes(error.code)
          ? 400
          : 503,
        'SIGNATURE_INSPECTION_UNAVAILABLE',
        'The transaction could not be inspected under the supported Solana rules.',
      );
    throw error;
  }
}

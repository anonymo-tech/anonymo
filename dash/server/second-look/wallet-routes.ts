import type { Pool } from 'pg';
import {
  jsonResponse,
  readJson,
  stringField,
  uuidField,
} from '../core/http.ts';
import { requireCondition } from '../core/errors.ts';
import { walletCapability } from './wallet-config.ts';
import {
  getWallet,
  linkWallet,
  listWallets,
  unlinkWallet,
  queueWalletSync,
  walletPnl,
} from './wallet-store.ts';
import { address } from '../solana/validation.ts';
export async function walletRoutes(
  pool: Pool,
  request: Request,
  path: string,
  accountId: string,
): Promise<Response | null> {
  if (path === 'second-look/wallets') {
    if (request.method === 'GET')
      return jsonResponse({
        wallets: await listWallets(pool, accountId),
        capability: walletCapability(),
      });
    if (request.method === 'POST') {
      const body = await readJson(request, 2048);
      requireCondition(
        Object.keys(body).every((k) => k === 'address' || k === 'label'),
        400,
        'INVALID_WALLET_INPUT',
        'Send a public wallet address and optional label.',
      );
      let wallet: string;
      try {
        wallet = address(stringField(body, 'address', 44));
      } catch {
        requireCondition(
          false,
          400,
          'INVALID_WALLET_ADDRESS',
          'Enter a canonical Solana public address.',
        );
      }
      const label =
        body.label === undefined
          ? 'Read-only wallet'
          : stringField(body, 'label', 80);
      return jsonResponse(
        {
          wallet: await linkWallet(pool, accountId, wallet!, label),
          capability: walletCapability(),
        },
        201,
      );
    }
  }
  const match = /^second-look\/wallets\/([^/]+)(?:\/(pnl|sync))?$/.exec(path);
  if (!match) return null;
  const id = uuidField(match[1]);
  if (!match[2] && request.method === 'GET')
    return jsonResponse({
      wallet: await getWallet(pool, accountId, id),
      capability: walletCapability(),
    });
  if (!match[2] && request.method === 'DELETE') {
    await unlinkWallet(pool, accountId, id);
    return jsonResponse({ deleted: true });
  }
  if (match[2] === 'pnl' && request.method === 'GET')
    return jsonResponse({ pnl: await walletPnl(pool, accountId, id) });
  if (match[2] === 'sync' && request.method === 'POST') {
    const body = await readJson(request, 64);
    requireCondition(
      Object.keys(body).length === 0,
      400,
      'INVALID_SYNC_INPUT',
      'No additional sync input is supported.',
    );
    requireCondition(
      walletCapability().configured,
      503,
      'WALLET_INGEST_UNAVAILABLE',
      'Wallet history ingestion is not configured.',
    );
    return jsonResponse(
      {
        wallet: await queueWalletSync(pool, accountId, id),
        capability: walletCapability(),
      },
      202,
    );
  }
  return null;
}

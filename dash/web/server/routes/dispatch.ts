import { gatewayConfigured } from '../gateway/origin.ts';
import { handleApi, jsonResponse, assertSameOrigin } from '../core/http.ts';
import { serviceConfig, requireService } from '../core/config.ts';
import { ServiceError } from '../core/errors.ts';
import { withDatabase } from '../db/database.ts';
import { authRoute } from './auth.ts';
import { getSession } from './session.ts';
import { labelledBalance } from '../ledger/test-credits.ts';
import { ledgerRoutes } from './ledger.ts';
import { projectRoutes } from './projects.ts';
import { rateLimit } from '../core/rate-limit.ts';
import { callRoutes } from './calls.ts';
import { callEventStream } from './call-events.ts';
import { solanaRoutes } from './solana.ts';
import { receiptRoutes } from './receipts.ts';
import { comparisonRoutes } from './comparisons.ts';
import { crosscheckRoutes } from './crosscheck.ts';
import { briefDocumentRoutes } from './brief-documents.ts';
import { depositCapability } from '../solana/deposit-config.ts';
import { mediaCapability, mediaStorageConfigured } from '../media/contract.ts';
import { mediaRoutes } from './media.ts';
import { configuredKeyring } from '../core/encryption.ts';
import { mediaContentRoute } from './media-content.ts';
import { passkeyRoutes } from './passkeys.ts';
import { accountSecurityRoutes } from './account-security.ts';
import { passkeyCapability } from '../auth/passkey.ts';
import { briefSynthesisRoutes } from '../briefs/routes.ts';
import { autoRoutingRoutes } from './auto-routing.ts';
import { tokenRoutes } from './token.ts';
import { tokenDepositRoutes } from './token-deposits.ts';

export async function dispatch(request: Request) {
  return handleApi(async () => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, '').replace(/\/$/, '');
    const config = serviceConfig();
    if (path === 'capabilities' && request.method === 'GET') {
      const configured =
        config.mode === 'service' && !!config.origin && !!config.databaseUrl;
      return jsonResponse({
        mode: configured ? 'service' : 'preview',
        // Configuration is not a health check. /auth/session tests the actual connection.
        // `siws` (wallet `solana:signIn`) is required when a wallet offers it;
        // `siws-plain-v1` (exact-text `signMessage`) is the fallback.
        walletSignIn: {
          configured,
          format: 'siws',
          formats: ['siws', 'siws-plain-v1'],
        },
        passkeys: passkeyCapability(),
        chat: {
          configured:
            configured &&
            gatewayConfigured() &&
            config.inferenceEnabled &&
            !!process.env.CONCLAVE_DATA_KEYS &&
            !!process.env.CONCLAVE_ACTIVE_DATA_KEY,
          reason: !gatewayConfigured()
            ? 'PROVIDER_KEY_REQUIRED'
            : !config.inferenceEnabled
              ? 'INFERENCE_DISABLED'
              : 'CHECK_ROUTE_AVAILABILITY',
        },
        projects: { configured },
        studio: mediaCapability(process.env, mediaStorageConfigured()),
        deposits: depositCapability(),
        sealedRoutes: { configured: false },
        receipts: { configured: false },
        chapters: { configured: false },
      });
    }
    const active = requireService(config);
    if (!['GET', 'HEAD'].includes(request.method))
      assertSameOrigin(request, active.origin);
    const events = /^calls\/([^/]+)\/events$/.exec(path);
    if (events && request.method === 'GET')
      return callEventStream(request, active.databaseUrl, events[1]);
    const assetContent = /^media\/assets\/([^/]+)\/content$/.exec(path);
    if (assetContent && ['GET', 'HEAD'].includes(request.method))
      return mediaContentRoute(
        request,
        active.databaseUrl,
        assetContent[1],
        active.origin,
      );
    return withDatabase(active.databaseUrl, async (pool) => {
      const passkeys = await passkeyRoutes(pool, request, path, active.origin);
      if (passkeys) return passkeys;
      const security = await accountSecurityRoutes(
        pool,
        request,
        path,
        active.origin,
      );
      if (security) return security;
      const auth = await authRoute(pool, request, path, active.origin);
      if (auth) return auth;
      const session = await getSession(pool, request);
      await rateLimit(pool, `account:${session.accountId}`, 120);
      if (path === 'balance' && request.method === 'GET')
        return jsonResponse(await labelledBalance(pool, session.accountId));
      if (path === 'routes' && request.method === 'GET') {
        const result =
          await pool.query(`SELECT id AS "versionId",route_id AS id,version,model_id AS "modelId",family,modality,card,pricing,
          (enabled AND expires_at>now()) AS available,expires_at AS "expiresAt" FROM route_versions
          WHERE modality='chat' AND id IN (SELECT DISTINCT ON (route_id) id FROM route_versions ORDER BY route_id,version DESC) ORDER BY route_id`);
        return jsonResponse({ routes: result.rows });
      }
      const ledger = await ledgerRoutes(pool, request, path, session.accountId);
      if (ledger) return ledger;
      const token = await tokenRoutes(pool, request, path);
      if (token) return token;
      const tokenDeposits = await tokenDepositRoutes(
        pool,
        request,
        path,
        session.accountId,
      );
      if (tokenDeposits) return tokenDeposits;
      const synthesis = await briefSynthesisRoutes(
        pool,
        request,
        path,
        session.accountId,
      );
      if (synthesis) return synthesis;
      const document = await briefDocumentRoutes(
        pool,
        request,
        path,
        session.accountId,
      );
      if (document) return document;
      const projects = await projectRoutes(
        pool,
        request,
        path,
        session.accountId,
      );
      if (projects) return projects;
      if (path.startsWith('media/')) {
        const media = await mediaRoutes(
          pool,
          request,
          path,
          session.accountId,
          configuredKeyring(),
          { storageReady: mediaStorageConfigured() },
        );
        if (media) return media;
      }
      const routing = await autoRoutingRoutes(
        pool,
        request,
        path,
        session.accountId,
        gatewayConfigured() && active.inferenceEnabled,
      );
      if (routing) return routing;
      const comparison = await comparisonRoutes(
        pool,
        request,
        path,
        session.accountId,
        gatewayConfigured() && active.inferenceEnabled,
      );
      if (comparison) return comparison;
      const calls = await callRoutes(
        pool,
        request,
        path,
        session.accountId,
        gatewayConfigured() && active.inferenceEnabled,
      );
      if (calls) return calls;
      const solana = await solanaRoutes(pool, request, path, session.accountId);
      if (solana) return solana;
      const crosscheck = await crosscheckRoutes(
        pool,
        request,
        path,
        session.accountId,
      );
      if (crosscheck) return crosscheck;
      const receipts = await receiptRoutes(
        pool,
        request,
        path,
        session.accountId,
      );
      if (receipts) return receipts;
      throw new ServiceError(
        404,
        'ENDPOINT_NOT_FOUND',
        'This endpoint is unavailable.',
      );
    });
  });
}

import { secondLookToolOn } from '../../lib/second-look/releases.ts';
import { publicFomoRoute } from '../second-look/fomo-snapshots.ts';
import { fomoRoutes } from '../second-look/fomo.ts';
import { stockTokenRoutes } from '../second-look/stock-token-routes.ts';
import { perpRoutes } from '../second-look/perp-routes.ts';
import { cachedPublicFlywheel, ownerFlywheel } from "../flywheel/service.ts";
import { assertEndpointReleased, releasedChatRoute } from "../core/feature-release.ts";
import { publicListedRoute } from "./public-inference.ts";
import { featureOn } from "../../components/dashboard/feature-switches.ts";
import { handleApi, jsonResponse, assertSameOrigin } from "../core/http.ts";
import { serviceConfig, requireService } from "../core/config.ts";
import { ServiceError } from "../core/errors.ts";
import { withDatabase } from "../db/database.ts";
import { authRoute } from "./auth.ts";
import { getSession } from "./session.ts";
import { labelledBalance } from "../ledger/test-credits.ts";
import { ledgerRoutes } from "./ledger.ts";
import { recallRoutes } from "./recall.ts";
import { projectRoutes } from "./projects.ts";
import { rateLimit } from "../core/rate-limit.ts";
import { callRoutes } from "./calls.ts";
import { callEventStream } from "./call-events.ts";
import { solanaRoutes } from "./solana.ts";
import { receiptRoutes } from "./receipts.ts";
import { comparisonRoutes } from "./comparisons.ts";
import { crosscheckRoutes } from "./crosscheck.ts";
import { briefDocumentRoutes } from "./brief-documents.ts";
import { depositCapability } from "../solana/deposit-config.ts";
import { mediaCapability, mediaStorageConfigured } from "../media/contract.ts";
import { mediaRoutes } from "./media.ts";
import { configuredKeyring } from "../core/encryption.ts";
import { mediaContentRoute } from "./media-content.ts";
import { passkeyRoutes } from "./passkeys.ts";
import { accountSecurityRoutes } from "./account-security.ts";
import { passkeyCapability } from "../auth/passkey.ts";
import { briefSynthesisRoutes } from "../briefs/routes.ts";
import { autoRoutingRoutes } from "./auto-routing.ts";
import { chapterRoutes, agentRoutes, connectionRoutes } from "../workspace/services.ts";
import { tokenRoutes } from "./token.ts";
import { tokenDepositRoutes } from "./token-deposits.ts";

import { tokenRoutes as secondLookTokenRoutes, tokenCapability } from "../second-look/token.ts";
import { walletRoutes } from "../second-look/wallet-routes.ts";
import { planningRoutes } from "../second-look/planning-routes.ts";
import { signatureRoutes } from "../second-look/signature-routes.ts";
import { signatureCapability } from "../second-look/signature.ts";
import { telegramRoutes, telegramWebhook, telegramCapability } from "../second-look/telegram.ts";

export async function dispatch(request: Request) {
  return handleApi(async () => {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\//, "").replace(/\/$/, "");
    assertEndpointReleased(path, request.method);
    const config = serviceConfig();
    if (path === "capabilities" && request.method === "GET") {
      const configured = config.mode === "service" && !!config.origin && !!config.databaseUrl;
      return jsonResponse({
        mode: configured ? "service" : "preview",
        // Configuration is not a health check. /auth/session tests the actual connection.
        // `siws` (wallet `solana:signIn`) is required when a wallet offers it;
        // `siws-plain-v1` (exact-text `signMessage`) is the fallback.
        walletSignIn: {
          configured,
          format: "siws",
          formats: ["siws", "siws-plain-v1"],
        },
        passkeys: passkeyCapability(),
        chat: {
          configured:
            configured &&
            !!config.ppqKey &&
            config.inferenceEnabled &&
            !!process.env.CONCLAVE_DATA_KEYS &&
            !!process.env.CONCLAVE_ACTIVE_DATA_KEY,
          reason: !config.ppqKey
            ? "PROVIDER_KEY_REQUIRED"
            : !config.inferenceEnabled
              ? "INFERENCE_DISABLED"
              : "CHECK_ROUTE_AVAILABILITY",
        },
        projects: { configured: configured && featureOn("projects") },
        studio: featureOn("studio")
          ? mediaCapability(process.env, mediaStorageConfigured())
          : { ...mediaCapability({}, false), reason: "FEATURE_UNAVAILABLE" },
        deposits: featureOn("purse")
          ? depositCapability()
          : { ...depositCapability({}), reason: "FEATURE_UNAVAILABLE" },
        sealedRoutes: { configured: false },
        receipts: {
          configured: featureOn("receipts") && process.env.CONCLAVE_RECEIPTS_ENABLED === "true",
        },
        chapters: { configured: configured && featureOn("chapters") },
        agents: { configured: configured && featureOn("agents") },
        connections: { configured: configured && featureOn("connections") },
      });
    }
    if (path === "second-look/capabilities" && request.method === "GET")
      return jsonResponse({
        fomo: { configured: secondLookToolOn('fomo') && config.mode === 'service' && !!config.databaseUrl },
        token: secondLookToolOn('token') ? tokenCapability() : { configured: false, reason: 'FEATURE_UNAVAILABLE' },
        signature: secondLookToolOn('signature') ? signatureCapability() : { configured: false, reason: 'FEATURE_UNAVAILABLE' },
        telegram: secondLookToolOn('telegram') ? telegramCapability() : { configured: false, reason: 'FEATURE_UNAVAILABLE' },
      });
    const active = requireService(config);
    if (path === "second-look/telegram/webhook" && request.method === "POST")
      return withDatabase(active.databaseUrl, (pool) => telegramWebhook(pool, request));
    if (!["GET", "HEAD"].includes(request.method)) assertSameOrigin(request, active.origin);
    const events = /^calls\/([^/]+)\/events$/.exec(path);
    if (events && request.method === "GET")
      return callEventStream(request, active.databaseUrl, events[1]);
    const assetContent = /^media\/assets\/([^/]+)\/content$/.exec(path);
    if (assetContent && ["GET", "HEAD"].includes(request.method))
      return mediaContentRoute(request, active.databaseUrl, assetContent[1], active.origin);
    return withDatabase(active.databaseUrl, async (pool) => {
      const publicFomo = await publicFomoRoute(pool, request, path);
      if (publicFomo) return publicFomo;
      if (path === "flywheel" && request.method === "GET")
        return jsonResponse(await cachedPublicFlywheel(pool));
      const passkeys = await passkeyRoutes(pool, request, path, active.origin);
      if (passkeys) return passkeys;
      const security = await accountSecurityRoutes(pool, request, path, active.origin);
      if (security) return security;
      const auth = await authRoute(pool, request, path, active.origin);
      if (auth) return auth;
      const session = await getSession(pool, request);
      await rateLimit(pool, `account:${session.accountId}`, 120);
      const flywheel = await ownerFlywheel(pool, request, path, session);
      if (flywheel) return flywheel;
      for (const handler of [chapterRoutes, agentRoutes, connectionRoutes]) {
        const result = await handler(pool, request, path, session.accountId);
        if (result) return result;
      }
      if (path.startsWith("second-look/")) {
        const fomo = await fomoRoutes(pool, request, path, session.accountId);
        if (fomo) return fomo;
        const stockToken = await stockTokenRoutes(pool, request, path, session.accountId);
        if (stockToken) return stockToken;
        const perp = await perpRoutes(pool, request, path, session.accountId);
        if (perp) return perp;
        const planning = await planningRoutes(pool, request, path, session.accountId);
        if (planning) return planning;
        const token = await secondLookTokenRoutes(
          pool,
          request,
          path.split("/"),
          session.accountId,
        );
        if (token) return token;
        const wallet = await walletRoutes(pool, request, path, session.accountId);
        if (wallet) return wallet;
        const signature = await signatureRoutes(pool, request, path, session.accountId);
        if (signature) return signature;
        const telegram = await telegramRoutes(pool, request, path, session.accountId);
        if (telegram) return telegram;
      }
      if (path === "balance" && request.method === "GET")
        return jsonResponse(await labelledBalance(pool, session.accountId));
      if (path === "routes" && request.method === "GET") {
        const result =
          await pool.query(`SELECT id AS "versionId",route_id AS id,version,model_id AS "modelId",family,modality,card,pricing,
          (enabled AND expires_at>now()) AS available,expires_at AS "expiresAt" FROM route_versions
          WHERE modality='chat' AND id IN (SELECT DISTINCT ON (route_id) id FROM route_versions ORDER BY route_id,version DESC) ORDER BY route_id`);
        return jsonResponse({
          routes: result.rows
            .filter((route) => releasedChatRoute({ family: route.family, model_id: route.modelId }))
            .map(publicListedRoute),
        });
      }
      const ledger = await ledgerRoutes(pool, request, path, session.accountId);
      if (ledger) return ledger;
      const token = await tokenRoutes(pool, request, path);
      if (token) return token;
      const tokenDeposits = await tokenDepositRoutes(pool, request, path, session.accountId);
      if (tokenDeposits) return tokenDeposits;
      const synthesis = await briefSynthesisRoutes(pool, request, path, session.accountId);
      if (synthesis) return synthesis;
      const document = await briefDocumentRoutes(pool, request, path, session.accountId);
      if (document) return document;
      const recall = await recallRoutes(pool, request, path, session.accountId);
      if (recall) return recall;
      const projects = await projectRoutes(pool, request, path, session.accountId);
      if (projects) return projects;
      if (path.startsWith("media/")) {
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
        !!active.ppqKey && active.inferenceEnabled,
      );
      if (routing) return routing;
      const comparison = await comparisonRoutes(
        pool,
        request,
        path,
        session.accountId,
        !!active.ppqKey && active.inferenceEnabled,
      );
      if (comparison) return comparison;
      const calls = await callRoutes(
        pool,
        request,
        path,
        session.accountId,
        !!active.ppqKey && active.inferenceEnabled,
      );
      if (calls) return calls;
      const solana = await solanaRoutes(pool, request, path, session.accountId);
      if (solana) return solana;
      const crosscheck = await crosscheckRoutes(pool, request, path, session.accountId);
      if (crosscheck) return crosscheck;
      const receipts = await receiptRoutes(pool, request, path, session.accountId);
      if (receipts) return receipts;
      throw new ServiceError(404, "ENDPOINT_NOT_FOUND", "This endpoint is unavailable.");
    });
  });
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { createGatewayClient } from '../server/gateway/index.ts';
import { transport } from '../server/gateway/transport.ts';
import {
  gatewayApiOrigin,
  gatewayCatalogUrl,
  gatewayConfigured,
  gatewayEvidenceOrigins,
  gatewayEvidenceUrl,
  parseGatewayOrigin,
} from '../server/gateway/origin.ts';
import {
  fetchRouteCatalog,
  routeCatalogUrl,
} from '../server/routes/route-registry.ts';
import { downloadGatewayMedia } from '../server/media/download.ts';
import { runNextMediaIngest } from '../server/media/ingest.ts';
import { mediaCapability } from '../server/media/contract.ts';
import { briefSynthesisConfigured } from '../server/briefs/execution.ts';
import { crossCheckExecutionConfigured } from '../server/crosscheck/execution.ts';

const origin = 'https://isolated.inference.invalid';
const evidence = 'https://policy.inference.invalid';
const key = 'test-key-not-a-credential';
const env = {
  GATEWAY_API_KEY: key,
  GATEWAY_API_ORIGIN: origin,
  GATEWAY_EVIDENCE_ORIGINS: JSON.stringify([evidence]),
};
const json = (value) =>
  new Response(JSON.stringify(value), {
    headers: { 'content-type': 'application/json' },
  });
const noNetwork = () => {
  throw new Error('Unexpected network request');
};
async function withEnv(values, work) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, process.env[key]]),
  );
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    return await work();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test('exact HTTPS DNS origins reject parser normalization, local addresses and URL parts', () => {
  assert.equal(parseGatewayOrigin(origin), origin);
  assert.equal(parseGatewayOrigin(`${origin}:8443`), `${origin}:8443`);
  for (const value of [
    null,
    {},
    '',
    `${origin}/`,
    `${origin}:443`,
    `${origin}?x=1`,
    `${origin}#a`,
    `${origin}/v1`,
    'http://api.inference.invalid',
    'https://API.inference.invalid',
    'https://user:password@api.inference.invalid',
    'https://127.0.0.1',
    'https://[::1]',
    'https://localhost',
    'https://api.localhost',
    'https://api.local',
    'https://api.internal',
    'https://api.inference.invalid.',
    ' https://api.inference.invalid',
    'https://api.inference.invalid\\@elsewhere.invalid',
  ]) {
    assert.equal(parseGatewayOrigin(value), null);
  }
});

test('configuration has no default and evidence must be a complete bounded explicit set', () => {
  assert.equal(gatewayApiOrigin({}), null);
  assert.equal(gatewayCatalogUrl({}), null);
  assert.equal(gatewayConfigured({}), false);
  assert.equal(gatewayConfigured(env), true);
  assert.equal(gatewayCatalogUrl(env), `${origin}/v1/models?type=all`);
  for (const value of [
    undefined,
    '[]',
    'null',
    '{}',
    'not-json',
    JSON.stringify([evidence, evidence]),
    JSON.stringify([evidence, 'http://policy.inference.invalid']),
    JSON.stringify(
      Array.from({ length: 9 }, (_, i) => `https://p${i}.inference.invalid`),
    ),
  ]) {
    assert.deepEqual(
      gatewayEvidenceOrigins({ ...env, GATEWAY_EVIDENCE_ORIGINS: value }),
      [],
    );
    assert.equal(
      gatewayConfigured({ ...env, GATEWAY_EVIDENCE_ORIGINS: value }),
      false,
    );
  }
  assert.equal(
    gatewayConfigured({ ...env, GATEWAY_API_KEY: 'invalid key' }),
    false,
  );
  assert.equal(gatewayEvidenceUrl(`${evidence}/privacy`, env), true);
  for (const url of [
    `${evidence}.other.invalid/privacy`,
    `${evidence}/privacy?token=x`,
    `${evidence}/privacy#part`,
    'https://elsewhere.invalid/privacy',
  ])
    assert.equal(gatewayEvidenceUrl(url, env), false);
});

test('missing or invalid API origin blocks authenticated requests before fetch', async () => {
  await withEnv({ GATEWAY_API_ORIGIN: undefined }, async () => {
    const client = createGatewayClient({ apiKey: key, fetch: noNetwork });
    assert.equal(client.configured, false);
    await assert.rejects(client.catalog(), { code: 'unavailable' });
  });
  const client = createGatewayClient({
    apiKey: key,
    apiOrigin: 'https://127.0.0.1',
    fetch: noNetwork,
  });
  assert.equal(client.configured, false);
  await assert.rejects(client.catalog(), { code: 'unavailable' });
});

test('explicit API origin is captured and receives credentials only through fixed trusted paths', async () => {
  let requests = 0;
  const client = createGatewayClient({
    apiKey: key,
    apiOrigin: origin,
    fetch: async (url, options) => {
      requests++;
      assert.equal(url, `${origin}/v1/models?type=all`);
      assert.equal(options.headers.Authorization, `Bearer ${key}`);
      assert.equal(options.redirect, 'error');
      assert.equal(options.credentials, 'omit');
      return json({ data: [] });
    },
  });
  await withEnv(
    { GATEWAY_API_ORIGIN: 'https://different.inference.invalid' },
    () => client.catalog(),
  );
  assert.equal(requests, 1);
  const request = transport(key, noNetwork, origin);
  for (const path of [
    '//elsewhere.invalid/v1',
    '/\\elsewhere.invalid/v1',
    '/v1#fragment',
  ])
    await assert.rejects(request(path, { timeoutMs: 100 }), {
      code: 'invalid_request',
    });
});

test('changed response endpoint cannot be accepted as a successful authenticated response', async () => {
  const client = createGatewayClient({
    apiKey: key,
    apiOrigin: origin,
    fetch: async () => {
      const response = json({ data: [] });
      Object.defineProperty(response, 'url', {
        value: 'https://different.inference.invalid/v1/models?type=all',
      });
      return response;
    },
  });
  await assert.rejects(client.catalog(), { code: 'provider_unavailable' });
});

test('catalog acquisition is unauthenticated and fails closed without a configured origin', async () => {
  await withEnv({ GATEWAY_API_ORIGIN: undefined }, async () => {
    assert.throws(routeCatalogUrl, { code: 'ROUTE_CATALOG_UNAVAILABLE' });
    await assert.rejects(fetchRouteCatalog({ fetch: noNetwork }), {
      code: 'ROUTE_CATALOG_UNAVAILABLE',
    });
  });
  await withEnv({ GATEWAY_API_ORIGIN: origin }, async () => {
    const snapshot = await fetchRouteCatalog({
      fetch: async (url, options) => {
        assert.equal(url, `${origin}/v1/models?type=all`);
        assert.equal(options.headers.Authorization, undefined);
        assert.equal(options.redirect, 'error');
        return json({ data: [] });
      },
    });
    assert.equal(snapshot.sourceUrl, routeCatalogUrl());
  });
});

test('media results and acquisition bind to the same configured exact origin', async () => {
  const body = (url) => ({
    status: 'completed',
    data: [{ url, content_type: 'image/png' }],
    cost: '0.001',
  });
  const input = {
    modelId: 'nano-banana-2',
    prompt: 'A local test',
    clientRequestId: 'origin_test',
  };
  const signed = `${origin}/v1/media/test_result/0?sig=test&exp=1`;
  const client = createGatewayClient({
    apiKey: key,
    apiOrigin: origin,
    fetch: async () => json(body(signed)),
  });
  const result = await client.generateImage(input);
  assert.equal(result.media[0].url, signed);
  const wrong = createGatewayClient({
    apiKey: key,
    apiOrigin: origin,
    fetch: async () =>
      json(
        body(
          'https://other.inference.invalid/v1/media/test_result/0?sig=test&exp=1',
        ),
      ),
  });
  await assert.rejects(wrong.generateImage(input), {
    code: 'invalid_response',
    billingAmbiguous: true,
  });
  await assert.rejects(
    downloadGatewayMedia(result.media[0], {
      apiOrigin: 'https://other.inference.invalid',
      fetch: noNetwork,
    }),
    { code: 'invalid_url' },
  );
  const png = new Uint8Array(33);
  png.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(png.buffer);
  view.setUint32(8, 13);
  png.set(new TextEncoder().encode('IHDR'), 12);
  view.setUint32(16, 1);
  view.setUint32(20, 1);
  const acquired = await downloadGatewayMedia(result.media[0], {
    apiOrigin: origin,
    fetch: async (url, options) => {
      assert.equal(url, signed);
      assert.equal(options.headers.Authorization, undefined);
      assert.equal(options.redirect, 'error');
      return new Response(png, {
        headers: { 'content-type': 'image/png', 'content-length': '33' },
      });
    },
  });
  assert.deepEqual(acquired.bytes, png);
});

test('missing origin cannot claim or fail an existing media import job', async () => {
  await withEnv({ GATEWAY_API_ORIGIN: undefined }, async () => {
    await assert.rejects(
      runNextMediaIngest(
        { connect: noNetwork, query: noNetwork },
        {},
        { fetch: noNetwork },
      ),
      { code: 'MEDIA_CONFIGURATION_REQUIRED' },
    );
    await assert.rejects(
      downloadGatewayMedia(
        {
          url: `${origin}/v1/media/test/0?sig=test&exp=1`,
          contentType: 'image/png',
        },
        { fetch: noNetwork },
      ),
      { code: 'unavailable' },
    );
  });
});

test('paid feature gates cannot be enabled by a credential alone', () => {
  const incomplete = {
    CONCLAVE_MODE: 'service',
    CONCLAVE_INFERENCE_ENABLED: 'true',
    CONCLAVE_MEDIA_ENABLED: 'true',
    CONCLAVE_BRIEF_SYNTHESIS_ENABLED: 'true',
    CONCLAVE_CROSSCHECK_ENABLED: 'true',
    CONCLAVE_APP_ORIGIN: 'https://app.inference.invalid',
    CONCLAVE_DATABASE_URL: 'synthetic-database-configuration',
    GATEWAY_API_KEY: key,
  };
  assert.equal(mediaCapability(incomplete, true).configured, false);
  assert.equal(briefSynthesisConfigured(incomplete), false);
  assert.equal(crossCheckExecutionConfigured(incomplete), false);
});

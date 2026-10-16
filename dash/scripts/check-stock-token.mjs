import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  decodeStockTokenMint,
  parseStockTokenInput,
  stockTokenControl,
  stockTokenMultiplier,
  stockTokenResponse,
  isStockTokenAddress,
} from '../lib/second-look/stock-token.ts';
import { STOCK_TOKEN_ISSUERS } from '../lib/second-look/stock-token-issuers.ts';
import {
  createStockTokenLimiter,
  readStockTokenCard,
  stockTokenRoutes,
} from '../server/second-look/stock-token-routes.ts';

// All fixture identities are synthetic byte patterns, never verified issuers.
const load = (name) =>
  JSON.parse(
    readFileSync(
      new URL(`./fixtures/stock-token/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
const mint =
  load('issuer-style').value.data.parsed.info.extensions[4].state.mint;
const now = 1_800_000_000_000;
const decode = (name) => decodeStockTokenMint(load(name), mint, now);
const info = (f) => f.value.data.parsed.info;

test('issuer-style Token-2022 snapshot is compact, exact and has all four powers', () => {
  const card = decode('issuer-style');
  assert.equal(card.program, 'Token-2022');
  assert.equal(card.decimals, 9);
  assert.equal(card.supply, '18446744073709551615');
  assert.ok(
    card.freezeAuthority &&
      card.mintAuthority &&
      card.pause.authority &&
      card.permanentDelegate.delegate &&
      card.transferHook.programId,
  );
  assert.equal(card.pause.paused, false);
  assert.equal(card.metadata.symbol, 'DEMO');
  assert.equal(card.metadata.uri, 'https://metadata.invalid/sample.json');
  assert.deepEqual(card.unknownExtensions, ['metadataPointer']);
  assert.ok(!JSON.stringify(card).includes('metadataAddress'));
  assert.ok(!Object.hasOwn(card, 'raw'));
  assert.ok(stockTokenResponse({ card }));
  assert.equal(stockTokenControl(card, []).kind, 'controller');
  assert.ok(STOCK_TOKEN_ISSUERS.every((issuer) => issuer.authorities.length >= 2));
  const sampleIssuer = {
    issuer: 'Sample issuer',
    programme: 'Sample programme',
    authorities: [{ kind: 'mintAuthority', address: card.mintAuthority }],
    notFor: 'Sample restriction',
    termsUrl: 'https://issuer.invalid/terms',
  };
  assert.equal(stockTokenControl(card, [sampleIssuer]).kind, 'issuer');
  assert.equal(
    stockTokenControl(card, [
      {
        ...sampleIssuer,
        authorities: [
          { kind: 'updateAuthority', address: card.metadata.updateAuthority },
        ],
      },
    ]).kind,
    'issuer',
  );
  assert.equal(
    stockTokenControl(card, [{ ...sampleIssuer, authorities: [] }]).kind,
    'controller',
  );
  assert.deepEqual(stockTokenMultiplier(card, now), {
    current: '0.01',
    pending: null,
  });
});

test('paused state, classic mint and scheduled multiplier retain their distinctions', () => {
  assert.equal(decode('paused').pause.paused, true);
  const classic = decode('classic');
  assert.equal(classic.program, 'SPL Token');
  assert.equal(classic.freezeAuthority, null);
  assert.equal(classic.mintAuthority, null);
  assert.equal(classic.metadata, null);
  assert.equal(stockTokenControl(classic).kind, 'none');
  assert.equal(stockTokenMultiplier(classic, now), null);
  assert.ok(stockTokenResponse({ card: classic }));
  const pending = decode('pending-multiplier');
  assert.deepEqual(stockTokenMultiplier(pending, now), {
    current: '0.01',
    pending: { multiplier: '0.02', timestamp: '2000000000' },
  });
  assert.deepEqual(stockTokenMultiplier(pending, 2_000_000_000_000), {
    current: '0.02',
    pending: null,
  });
});

test('each isolated controller power is reported; mint issuance alone is not that classification', () => {
  const card = decode('classic'),
    authority = decode('issuer-style').mintAuthority;
  for (const power of [
    { pause: { authority, paused: false } },
    { pause: { authority: null, paused: true } },
    { permanentDelegate: { delegate: authority } },
    { freezeAuthority: authority },
    { transferHook: { authority: null, programId: authority } },
    { transferHook: { authority, programId: null } },
  ]) {
    assert.equal(stockTokenControl({ ...card, ...power }).kind, 'controller');
  }
  assert.equal(
    stockTokenControl({ ...card, mintAuthority: authority }).kind,
    'none',
  );
});

test('strict parser rejects malformed fields rather than implying missing powers', () => {
  assert.throws(() => decode('malformed'));
  const mutations = [
    (f) => {
      f.value = null;
    },
    (f) => {
      f.context.slot = -1;
    },
    (f) => {
      f.value.executable = true;
    },
    (f) => {
      f.value.owner = mint;
    },
    (f) => {
      f.value.data = ['AAAA', 'base64'];
    },
    (f) => {
      f.value.data.parsed.type = 'account';
    },
    (f) => {
      f.value.data.program = 'spl-token';
    },
    (f) => {
      info(f).isInitialized = false;
    },
    (f) => {
      info(f).decimals = 256;
    },
    (f) => {
      info(f).supply = '18446744073709551616';
    },
    (f) => {
      info(f).supply = 100;
    },
    (f) => {
      delete info(f).freezeAuthority;
    },
    (f) => {
      info(f).mintAuthority = 'bad';
    },
    (f) => {
      info(f).extensions = null;
    },
    (f) => {
      info(f).extensions.push(info(f).extensions[0]);
    },
    (f) => {
      info(f).extensions[1].state.delegate = 'bad';
    },
    (f) => {
      info(f).extensions[2].state.programId = {};
    },
    (f) => {
      info(f).extensions[3].state.multiplier = 'Infinity';
    },
    (f) => {
      info(f).extensions[3].state.newMultiplier = 0;
    },
    (f) => {
      info(f).extensions[3].state.newMultiplierEffectiveTimestamp = 1.5;
    },
    (f) => {
      info(f).extensions[4].state.mint = info(f).mintAuthority;
    },
    (f) => {
      info(f).extensions[4].state.name = 'Sample\u202e';
    },
    (f) => {
      info(f).extensions[4].state.uri = 'x'.repeat(2049);
    },
    (f) => {
      info(f).extensions[4].state.additionalMetadata = [{}];
    },
  ];
  for (const mutate of mutations) {
    const f = load('issuer-style');
    mutate(f);
    assert.throws(() => decodeStockTokenMint(f, mint, now));
  }
  assert.equal(isStockTokenAddress('1'.repeat(33)), false);
  const unknown = load('issuer-style');
  info(unknown).extensions.push({
    extension: 'futureExtension',
    state: { untrusted: 'ignored' },
  });
  assert.ok(
    decodeStockTokenMint(unknown, mint, now).unknownExtensions.includes(
      'futureExtension',
    ),
  );
});

test('supported mint and link forms extract locally and reject hostile or ambiguous input', () => {
  for (const link of [
    mint,
    ` ${mint} `,
    `solscan.io/token/${mint}`,
    `https://solscan.io/token/${mint}?cluster=mainnet-beta`,
    `https://explorer.solana.com/address/${mint}`,
    `https://jup.ag/tokens/${mint}`,
    `https://jup.ag/swap/SOL-${mint}`,
    `https://jup.ag/swap/USDC_${mint}`,
    `https://jup.ag/swap/${mint}/${mint}`,
    `https://jup.ag/swap?outputMint=${mint}`,
  ])
    assert.equal(parseStockTokenInput(link), mint);
  for (const link of [
    '',
    {},
    '1'.repeat(33),
    `http://solscan.io/token/${mint}`,
    `https://solscan.io.evil.invalid/token/${mint}`,
    `https://solscan.io@evil.invalid/token/${mint}`,
    `https://solscan.io:444/token/${mint}`,
    `https://explorer.solana.com/address/${mint}?cluster=devnet`,
    `https://jup.ag/swap?outputMint=${mint}&outputMint=${mint}`,
    `https://jup.ag/swap?outputMint=${mint}&url=https://example.invalid`,
    `https://jup.ag/${mint}`,
    `https://solscan.io/token/${mint}#fragment`,
  ])
    assert.throws(() => parseStockTokenInput(link));
});

test('client response contract rejects corrupt snapshots', () => {
  for (const mutate of [
    (c) => {
      delete c.pause;
    },
    (c) => {
      c.supply = 1;
    },
    (c) => {
      c.observedAt = 'invalid';
    },
    (c) => {
      c.unknownExtensions = [{}];
    },
    (c) => {
      c.metadata.updateAuthority = 'bad';
    },
  ]) {
    const card = decode('issuer-style');
    mutate(card);
    assert.equal(stockTokenResponse({ card }), false);
  }
});

test('in-memory quotas are bounded, expire and never use the database', async () => {
  const limit = createStockTokenLimiter();
  for (let i = 0; i < 10; i++) limit('sample-account', 1000);
  assert.throws(
    () => limit('sample-account', 1000),
    (e) => e.status === 429,
  );
  for (let i = 0; i < 15; i++) limit('sample-account-' + i, 1000);
  assert.throws(
    () => limit('another-account', 1000),
    (e) => e.status === 429,
  );
  assert.doesNotThrow(() => limit('sample-account', 61000));
  const pool = {
    query() {
      throw Error('Database writes are forbidden');
    },
  };
  assert.equal(
    await stockTokenRoutes(
      pool,
      new Request('https://app.invalid/api/second-look/stock-tokens/check'),
      'second-look/stock-tokens/check',
      'sample-account',
    ),
    null,
  );
  await assert.rejects(
    stockTokenRoutes(
      pool,
      new Request('https://app.invalid/api/second-look/stock-tokens/check', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ mint, extra: true }),
      }),
      'second-look/stock-tokens/check',
      'sample-account',
    ),
    (e) => e.status === 400,
  );
});

test('RPC uses only exact read requests; URI is never fetched, errors fail closed', async () => {
  const savedUrl = process.env.CONCLAVE_SOLANA_RPC_URL,
    savedCluster = process.env.CONCLAVE_SOLANA_CLUSTER;
  process.env.CONCLAVE_SOLANA_RPC_URL = 'https://rpc.invalid';
  process.env.CONCLAVE_SOLANA_CLUSTER = 'mainnet-beta';
  const calls = [];
  const fetcher = async (url, init) => {
    assert.equal(url, 'https://rpc.invalid/');
    assert.equal(init.method, 'POST');
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    const body = JSON.parse(init.body);
    calls.push(body);
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(typeof body.id, 'string');
    return Response.json({
      jsonrpc: '2.0',
      id: body.id,
      result:
        body.method === 'getGenesisHash'
          ? '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'
          : load('issuer-style'),
    });
  };
  try {
    const card = await readStockTokenCard(mint, undefined, fetcher);
    assert.equal(card.metadata.symbol, 'DEMO');
    assert.deepEqual(
      calls.map(({ method, params }) => ({ method, params })),
      [
        { method: 'getGenesisHash', params: [] },
        {
          method: 'getAccountInfo',
          params: [mint, { encoding: 'jsonParsed', commitment: 'finalized' }],
        },
      ],
    );
    await assert.rejects(
      readStockTokenCard(mint, undefined, async (_url, init) =>
        Response.json({
          jsonrpc: '2.0',
          id: JSON.parse(init.body).id,
          result: 'wrong-genesis',
        }),
      ),
      (e) => e.status === 503,
    );
    await assert.rejects(
      readStockTokenCard(mint, undefined, async () =>
        Response.json({ jsonrpc: '2.0', id: 'wrong', result: {} }),
      ),
      (e) => e.status === 503,
    );
    await assert.rejects(
      readStockTokenCard(
        mint,
        undefined,
        async () => new Response('x'.repeat(65_537)),
      ),
      (e) => e.status === 503,
    );
  } finally {
    if (savedUrl === undefined) delete process.env.CONCLAVE_SOLANA_RPC_URL;
    else process.env.CONCLAVE_SOLANA_RPC_URL = savedUrl;
    if (savedCluster === undefined) delete process.env.CONCLAVE_SOLANA_CLUSTER;
    else process.env.CONCLAVE_SOLANA_CLUSTER = savedCluster;
  }
});

test('an issuer is recognised only when every listed authority matches', async () => {
  const { stockTokenControl } = await import('../lib/second-look/stock-token.ts');
  const issuers = [{ issuer: 'Issuer', programme: 'P', authorities: [{ kind: 'mintAuthority', address: 'A' }, { kind: 'updateAuthority', address: 'B' }], notFor: 'x', termsUrl: 'https://issuer.invalid/terms' }];
  const base = { mintAuthority: 'A', freezeAuthority: 'F', metadata: { updateAuthority: 'B' } };
  assert.equal(stockTokenControl(base, issuers).issuer?.issuer, 'Issuer');
  assert.equal(stockTokenControl({ ...base, metadata: { updateAuthority: 'Z' } }, issuers).issuer, null);
  assert.equal(stockTokenControl({ ...base, mintAuthority: 'Z' }, issuers).issuer, null);
});

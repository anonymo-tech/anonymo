import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import {
  parsePythSolSpot,
  readPythSolSpot,
  PYTH_SOL_ACCOUNT,
} from '../server/second-look/wallet-pyth.ts';
import { SOL_MINT, USDC_MINT } from '../server/second-look/trade-parser.ts';
import { noMarket, valueUsd6 } from '../server/second-look/pnl.ts';
import {
  createWalletSource,
  readWalletPrice,
} from '../server/second-look/ingest-source.ts';
import { walletIngestConfig } from '../server/second-look/wallet-config.ts';
import { SOLANA_NETWORKS } from '../server/solana/validation.ts';

const now = Date.parse('2026-10-12T12:00:00.000Z'),
  at = new Date(now).toISOString();
function fixture() {
  const data = Buffer.alloc(134);
  createHash('sha256')
    .update('account:PriceUpdateV2')
    .digest()
    .copy(data, 0, 0, 8);
  data[40] = 1;
  Buffer.from(
    'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d',
    'hex',
  ).copy(data, 41);
  data.writeBigInt64LE(15012345678n, 73);
  data.writeBigUInt64LE(1000000n, 81);
  data.writeInt32LE(-8, 89);
  data.writeBigInt64LE(BigInt(now / 1000 - 15), 93);
  data.writeBigInt64LE(BigInt(now / 1000 - 45), 101);
  data.writeBigUInt64LE(100n, 125);
  return data;
}
function response(data = fixture(), account = {}, slot = 110) {
  return {
    context: { slot },
    value: {
      owner: 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ',
      executable: false,
      data: [data.toString('base64'), 'base64'],
      ...account,
    },
  };
}

await test('sponsored SOL quote preserves exact decimals and does not invent market evidence', () => {
  const price = parsePythSolSpot(response(), at, now);
  assert.equal(price.priceUsd, '150.12345678');
  assert.equal(valueUsd6(1000000000n, 9, price.priceUsd), 150123456n);
  assert.equal(price.estimated, true);
  assert.equal(price.lastTradeAt, null);
  assert.equal(price.liquidityUsd, null);
  assert.equal(noMarket(price, new Date(now)), false);
});

await test('wrong account owner, executable account, discriminator, feed and partial verification fail closed', () => {
  for (const patch of [
    { owner: SOL_MINT },
    { executable: true },
    { data: ['@@@@', 'base64'] },
  ])
    assert.throws(() => parsePythSolSpot(response(fixture(), patch), at, now));
  for (const offset of [0, 40, 41]) {
    const data = fixture();
    data[offset] ^= 1;
    assert.throws(() => parsePythSolSpot(response(data), at, now));
  }
  assert.throws(() =>
    parsePythSolSpot(response(fixture().subarray(0, 120)), at, now),
  );
});

await test('stale, future, out-of-slot, wide-confidence and nonpositive oracle quotes are rejected', () => {
  for (const change of [
    (d) => d.writeBigInt64LE(BigInt(now / 1000 - 301), 93),
    (d) => d.writeBigInt64LE(BigInt(now / 1000 + 61), 93),
    (d) => d.writeBigUInt64LE(111n, 125),
    (d) => d.writeBigUInt64LE(0n, 125),
    (d) => d.writeBigUInt64LE(10000000000n, 81),
    (d) => d.writeBigInt64LE(0n, 73),
    (d) => d.writeBigInt64LE(-1n, 73),
    (d) => d.writeInt32LE(-19, 89),
    (d) => d.writeBigInt64LE(BigInt(now / 1000 + 1), 101),
  ]) {
    const data = fixture();
    change(data);
    assert.throws(() => parsePythSolSpot(response(data), at, now));
  }
});

await test('spot source never backfills old prices or silently pegs stablecoins', async () => {
  const fail = () => {
    throw new Error('No RPC should be called');
  };
  assert.equal(
    await readPythSolSpot(fail, SOL_MINT, '2026-09-01T00:00:00.000Z', now),
    null,
  );
  assert.equal(await readPythSolSpot(fail, USDC_MINT, at, now), null);
});

await test('spot source pins mainnet and the sponsored account in finalized read-only calls', async () => {
  const calls = [];
  const price = await readPythSolSpot(
    async (method, params) => {
      calls.push({ method, params });
      return method === 'getGenesisHash'
        ? SOLANA_NETWORKS['mainnet-beta'].genesisHash
        : response();
    },
    SOL_MINT,
    at,
    now,
  );
  assert.equal(price.source, 'pyth_solana_spot');
  assert.deepEqual(calls, [
    { method: 'getGenesisHash', params: [] },
    {
      method: 'getAccountInfo',
      params: [
        PYTH_SOL_ACCOUNT,
        { commitment: 'finalized', encoding: 'base64' },
      ],
    },
  ]);
  await assert.rejects(
    readPythSolSpot(async () => 'wrong-network', SOL_MINT, at, now),
  );
});

await test('pricing transport is opt-in and rejects mismatched JSON-RPC response identity', async () => {
  const env = { CONCLAVE_WALLET_RPC_URL: 'https://rpc.example.test' };
  assert.equal(
    await readWalletPrice(walletIngestConfig(env), SOL_MINT, at),
    null,
  );
  const cfg = walletIngestConfig({
    ...env,
    CONCLAVE_WALLET_SOL_SPOT_ENABLED: 'true',
  });
  assert.equal(cfg.solSpotEnabled, true);
  await assert.rejects(
    readWalletPrice(cfg, SOL_MINT, new Date().toISOString(), async () =>
      Response.json({
        jsonrpc: '2.0',
        id: 'wrong',
        result: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
      }),
    ),
  );
});

await test('history source verifies network once per bounded source and retries a failed verification', async () => {
  const methods = [];
  let failGenesis = true;
  const source = createWalletSource(
    walletIngestConfig({
      CONCLAVE_WALLET_RPC_URL: 'https://rpc.example.test',
      CONCLAVE_WALLET_INGEST_ENABLED: 'true',
    }),
    async (_url, init) => {
      const request = JSON.parse(init.body);
      methods.push(request.method);
      const result =
        request.method === 'getGenesisHash'
          ? failGenesis
            ? 'wrong'
            : SOLANA_NETWORKS['mainnet-beta'].genesisHash
          : [];
      return Response.json({ jsonrpc: '2.0', id: request.id, result });
    },
  );
  await assert.rejects(source.page(SOL_MINT, null, null));
  failGenesis = false;
  await source.page(SOL_MINT, null, null);
  await source.page(SOL_MINT, null, null);
  assert.deepEqual(methods, [
    'getGenesisHash',
    'getGenesisHash',
    'getSignaturesForAddress',
    'getSignaturesForAddress',
  ]);
});

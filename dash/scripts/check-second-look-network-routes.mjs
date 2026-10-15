import test from 'node:test';
import assert from 'node:assert/strict';
import { networkRoutes } from '../server/second-look/network-routes.ts';
const pool = new Proxy(
  {},
  {
    get() {
      throw Error('Receipt routes must not read the database.');
    },
  },
);
const path = 'second-look/networks/robinhood/receipt';
const make = (body) =>
  new Request('https://conclave.example/api/' + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const wallet = '0x' + 'a'.repeat(40),
  transactionHash = '0x' + 'b'.repeat(64);
const keys = [
  'CONCLAVE_ROBINHOOD_READ_ENABLED',
  'CONCLAVE_ROBINHOOD_RPC_URL',
  'CONCLAVE_ROBINHOOD_SOURCE_ID',
];
test('network routes disclose unavailable coverage and refuse receipt reads before activation', async () => {
  const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
  try {
    for (const k of keys) delete process.env[k];
    const r = await networkRoutes(
      pool,
      new Request('https://conclave.example/api/second-look/networks'),
      'second-look/networks',
      'fixture',
    );
    const { robinhood } = await r.json();
    assert.equal(robinhood.receiptReadsConfigured, false);
    assert.equal(robinhood.completeWalletHistory, false);
    await assert.rejects(
      networkRoutes(pool, make({ wallet, transactionHash }), path, 'fixture'),
      (e) => e.status === 503 && e.code === 'NETWORK_UNAVAILABLE',
    );
  } finally {
    for (const k of keys)
      saved[k] === undefined
        ? delete process.env[k]
        : (process.env[k] = saved[k]);
  }
});
test('receipt input rejects provider overrides non-public addresses oversized fields and unknown keys', async () => {
  for (const body of [
    { wallet: 'secret', transactionHash },
    { wallet, transactionHash: 'a'.repeat(1000) },
    { wallet, transactionHash, rpcUrl: 'https://attacker.example' },
    { wallet, transactionHash, privateKey: 'fixture' },
  ])
    await assert.rejects(
      networkRoutes(pool, make(body), path, 'fixture'),
      (e) => e.status === 400 || e.status === 413,
    );
  assert.equal(
    await networkRoutes(
      pool,
      new Request('https://conclave.example/api/unknown'),
      'unknown',
      'fixture',
    ),
    null,
  );
});

import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import {
  createRoomCapture,
  roomHourBuys,
} from '../server/second-look/rooms-evidence.ts';
import { SOLANA_NETWORKS, TOKEN_PROGRAM } from '../server/solana/validation.ts';
import {
  sharedHistory,
  verifySharedHistory,
  signRoomOwnership,
} from '../lib/client/rooms.ts';
import { createHash, randomUUID } from 'node:crypto';
import {
  capturedRoomOutcome,
  capturedCallerStats,
} from '../lib/second-look/room-metrics.ts';
const key = (n) => bs58.encode(Buffer.alloc(32, n)),
  caller = key(1),
  mint = key(2),
  at = new Date('2026-10-14T12:00:00.000Z');
const env = {
  CONCLAVE_ROOMS_CAPTURE_ENABLED: 'true',
  CONCLAVE_ROOMS_RPC_URL: 'https://rpc.example.test',
  CONCLAVE_ROOMS_JUPITER_API_KEY: 'test-only',
};
const noDb = {
  query() {
    throw Error('No database access expected');
  },
};
function provider({
  wrongGenesis = false,
  age = 10,
  duplicate = false,
  priceSlot = 990,
  price = 1.23456789,
  badOwner = false,
} = {}) {
  const calls = [];
  const account = (id, amount) => ({
    pubkey: key(id),
    account: {
      owner: TOKEN_PROGRAM,
      data: {
        parsed: {
          type: 'account',
          info: {
            mint,
            owner: badOwner ? key(7) : caller,
            tokenAmount: { amount },
          },
        },
      },
    },
  });
  const fetcher = async (url, init) => {
    calls.push(url);
    let value;
    if (url.startsWith('https://api.jup.ag/')) {
      assert.equal(init.method, 'GET');
      assert.equal(init.body, undefined);
      value = { [mint]: { usdPrice: price, blockId: priceSlot, decimals: 6 } };
    } else {
      const b = JSON.parse(init.body);
      let result;
      if (b.method === 'getGenesisHash')
        result = wrongGenesis
          ? 'wrong'
          : SOLANA_NETWORKS['mainnet-beta'].genesisHash;
      else if (b.method === 'getTokenAccountsByOwner')
        result = {
          context: { slot: 1000 },
          value: [account(3, '1000000'), account(duplicate ? 3 : 4, '2000000')],
        };
      else if (b.method === 'getBlockTime') result = at.getTime() / 1000 - age;
      else throw Error('Unexpected method');
      value = { jsonrpc: '2.0', id: 1, result };
    }
    return new Response(JSON.stringify(value), {
      headers: { 'content-type': 'application/json' },
    });
  };
  return { fetcher, calls };
}
test('disabled Rooms capture performs no database or provider work', async () => {
  const capture = createRoomCapture(noDb, {}, () => {
    throw Error('Unexpected fetch');
  });
  const result = await capture({ mint, caller, at });
  assert.equal(result.heldAtoms, null);
  assert.equal(result.source, null);
});
test('capture sums exact finalized holdings and records bounded source prices without claiming missing history', async () => {
  const p = provider(),
    capture = createRoomCapture(noDb, env, p.fetcher),
    r = await capture({ mint, caller, at });
  assert.equal(r.heldAtoms, '3000000');
  assert.equal(r.priceUsd6, '1234567');
  assert.equal(r.slot, '1000');
  assert.equal(r.bought60mAtoms, null);
  assert.equal(p.calls.length, 4);
});
test('wrong-chain, stale, duplicate and mismatched-owner holdings remain unavailable', async () => {
  for (const options of [
    { wrongGenesis: true },
    { age: 31 },
    { duplicate: true },
    { badOwner: true },
  ]) {
    const p = provider(options),
      r = await createRoomCapture(noDb, env, p.fetcher)({ mint, caller, at });
    assert.equal(r.heldAtoms, null);
    assert.equal(r.priceUsd6, null);
    assert.equal(
      p.calls.some((x) => x.startsWith('https://api.jup.ag/')),
      false,
    );
  }
});
test('future, stale, zero and unrepresentable prices are never substituted with zero', async () => {
  for (const options of [
    { priceSlot: 1001 },
    { priceSlot: 900 },
    { price: 0 },
    { price: 0.00000001 },
  ]) {
    const p = provider(options),
      r = await createRoomCapture(noDb, env, p.fetcher)({ mint, caller, at });
    assert.equal(r.heldAtoms, '3000000');
    assert.equal(r.priceUsd6, null);
  }
});
test('an incomplete owned index cannot claim zero recent buys', async () => {
  for (const coverage of [
    null,
    {
      genesis_hash: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
      scanned_through: '999',
      earliest: new Date(at.getTime() - 7200000),
      missing: 0,
    },
    {
      genesis_hash: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
      scanned_through: '1000',
      earliest: new Date(at.getTime() - 3000000),
      missing: 0,
    },
  ]) {
    assert.equal(
      await roomHourBuys(
        { query: async () => ({ rows: coverage ? [coverage] : [] }) },
        'fixture',
        caller,
        mint,
        at,
        1000,
      ),
      null,
    );
  }
  let reads = 0;
  const db = {
    query: async () => ({
      rows: reads++
        ? []
        : [
            {
              genesis_hash: SOLANA_NETWORKS['mainnet-beta'].genesisHash,
              scanned_through: '1000',
              earliest: new Date(at.getTime() - 7200000),
              missing: 0,
            },
          ],
    }),
  };
  assert.equal(await roomHourBuys(db, 'fixture', caller, mint, at, 1000), '0');
});
test('browser history verification detects edited, truncated or reordered records', async () => {
  const roomId = randomUUID(),
    body = {
      schema: 1,
      environment: 'captured',
      roomId,
      sequence: '1',
      mint,
      caller,
      note: 'Original',
      at: at.toISOString(),
      ownership: 'wallet_signature',
      evidence: {
        slot: null,
        priceUsd6: null,
        heldAtoms: null,
        bought60mAtoms: null,
        source: null,
        unavailable: [],
      },
      previousHash: '0'.repeat(64),
    },
    hash = createHash('sha256').update(JSON.stringify(body)).digest('hex'),
    call = { ...body, hash };
  assert.ok(
    sharedHistory({
      calls: [call],
      nextAfter: null,
      headHash: hash,
      headSequence: '1',
      anchored: false,
    }),
  );
  assert.ok(await verifySharedHistory([call], roomId, hash, '1'));
  assert.equal(
    await verifySharedHistory([{ ...call, note: 'Edited' }], roomId, hash, '1'),
    false,
  );
  assert.equal(await verifySharedHistory([], roomId, hash, '1'), false);
});
test('browser refuses an ownership request for another origin before invoking a wallet', async () => {
  await assert.rejects(
    signRoomOwnership(
      {},
      {
        id: randomUUID(),
        address: caller,
        message: 'Please sign an unrelated message',
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      },
      randomUUID(),
      caller,
      'https://workspace.example.test',
    ),
    /invalid/,
  );
});
test('captured outcomes never look ahead and caller rates use covered denominators', () => {
  const point = (minutes, price, slot) => ({
    at: new Date(at.getTime() + minutes * 60000).toISOString(),
    priceUsd6: String(price),
    slot: String(slot),
  });
  const observations = [
    point(59, 1200000, 1),
    point(61, 9000000, 2),
    point(1439, 800000, 3),
    point(1441, 5000000, 4),
  ];
  const result = capturedRoomOutcome(
    '1000000',
    at.toISOString(),
    observations,
    new Date(at.getTime() + 2 * 86400000).toISOString(),
  );
  assert.equal(result.oneHourBps, '2000');
  assert.equal(result.oneDayBps, '-2000');
  assert.equal(result.oneWeekBps, null);
  assert.equal(result.completePricePath, false);
  assert.equal(
    capturedRoomOutcome(
      null,
      at.toISOString(),
      observations,
      new Date(at.getTime() + 2 * 86400000).toISOString(),
    ).oneDayBps,
    null,
  );
  assert.equal(capturedCallerStats(Array(9).fill(result)).medianDayBps, null);
  const stats = capturedCallerStats([
    ...Array(10).fill({ ...result, soldIntoCallBps: '0' }),
    { ...result, oneDayBps: null, soldIntoCallBps: null },
  ]);
  assert.equal(stats.calls, 11);
  assert.equal(stats.pricedDayCalls, 10);
  assert.equal(stats.saleCoverageCalls, 10);
  assert.equal(stats.medianDayBps, '-2000');
  assert.equal(stats.hitRateBps, '0');
  assert.equal(stats.soldIntoCallRateBps, '0');
  assert.throws(
    () =>
      capturedRoomOutcome(
        '1000000',
        at.toISOString(),
        [point(1, 100, 1), point(1, 101, 1)],
        new Date(at.getTime() + 100000).toISOString(),
      ),
    /Conflicting/,
  );
});

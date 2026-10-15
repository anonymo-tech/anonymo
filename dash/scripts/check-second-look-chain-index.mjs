import test from 'node:test';
import assert from 'node:assert/strict';
import bs58 from 'bs58';
import { randomUUID } from 'node:crypto';
import {
  chainIndexConfig,
  parseIndexedBlock,
  requireBlockContinuity,
} from '../server/second-look/chain-index.ts';
import { runChainIndexOnce } from '../server/second-look/chain-index-worker.ts';
import {
  createChainIndexSource,
  walletIngestSource,
} from '../server/second-look/chain-index-source.ts';
import { createDatabase } from '../server/db/database.ts';
import { SOLANA_NETWORKS } from '../server/solana/validation.ts';
import { migrate } from './migrate.mjs';
import { linkWallet, getWallet } from '../server/second-look/wallet-store.ts';
import { runWalletIngestOnce } from '../server/second-look/ingest.ts';
import { addFollowTrader } from '../server/second-look/follow-store.ts';
import { runFollowIngestOnce } from '../server/second-look/follow-ingest.ts';
import { parseWalletTrade } from '../server/second-look/trade-parser.ts';
const key = (n) => bs58.encode(Buffer.alloc(32, n));
const sig = (n) => bs58.encode(Buffer.alloc(64, n));
const wallet = key(1),
  owner = key(2),
  account = key(3),
  mint = key(4);
function tx(n) {
  return {
    version: 0,
    transaction: {
      signatures: [sig(n)],
      message: {
        accountKeys: [
          { pubkey: wallet, signer: true },
          { pubkey: account, signer: false },
        ],
        instructions: [],
      },
    },
    meta: {
      err: null,
      fee: 5000,
      preBalances: [1000000000, 2039280],
      postBalances: [999995000, 2039280],
      preTokenBalances: [
        {
          accountIndex: 1,
          programId: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
          mint,
          owner,
          uiTokenAmount: { decimals: 6, amount: '1000000' },
        },
      ],
      postTokenBalances: [],
      innerInstructions: [],
    },
  };
}
function block(slot = 10, count = 2, parent = 9) {
  return {
    blockhash: key(slot),
    previousBlockhash: key(parent),
    parentSlot: parent,
    blockTime: 1791979200 + slot,
    transactions: Array.from({ length: count }, (_, i) => tx(i + 1)),
  };
}
test('index configuration is disabled by default and bounds requests bytes and start slot', () => {
  assert.equal(chainIndexConfig({}).enabled, false);
  assert.equal(chainIndexConfig({}).startSlot, null);
  for (const env of [
    { CONCLAVE_CHAIN_INDEX_SLOTS_PER_RUN: '65' },
    { CONCLAVE_CHAIN_INDEX_START_SLOT: '0' },
    { CONCLAVE_CHAIN_INDEX_DAILY_RPC_CALLS: 'Infinity' },
    { CONCLAVE_CHAIN_INDEX_SOURCE_ID: '../../escape' },
  ])
    assert.throws(() => chainIndexConfig(env));
});
test('full blocks retain exact ordinals and pre-close owners outside transaction keys', () => {
  const b = parseIndexedBlock(block(), 10);
  assert.equal(b.transactions[1].index, 1);
  assert.ok(b.transactions[0].addresses.includes(owner));
  assert.equal(b.transactions[0].payload.slot, 10);
  assert.equal(b.transactions[0].payload.transactionIndex, 0);
  assert.equal(b.digest, parseIndexedBlock(block(), 10).digest);
});
test('duplicate signatures missing owners unknown versions and incomplete metadata stop indexing', () => {
  const values = [block(), block(), block(), block()];
  values[0].transactions[1] = values[0].transactions[0];
  delete values[1].transactions[0].meta.preTokenBalances[0].owner;
  values[2].transactions[0].version = 1;
  values[3].transactions[0].meta = null;
  for (const value of values) assert.throws(() => parseIndexedBlock(value, 10));
});
test('a skipped slot can link but an omitted block or changed parent cannot', () => {
  const b = parseIndexedBlock(block(12, 0, 10), 12);
  assert.doesNotThrow(() =>
    requireBlockContinuity(b, { slot: 10, hash: key(10) }, 10),
  );
  assert.throws(() => requireBlockContinuity(b, { slot: 9, hash: key(9) }, 10));
  assert.throws(() =>
    requireBlockContinuity(b, { slot: 10, hash: key(9) }, 10),
  );
  assert.throws(() => requireBlockContinuity(b, null, 10));
});
test('disabled worker does not acquire a database or call a provider', async () => {
  const result = await runChainIndexOnce(
    {
      connect() {
        throw Error('unexpected');
      },
    },
    {
      config: chainIndexConfig({}),
      fetcher() {
        throw Error('unexpected');
      },
    },
  );
  assert.equal(result.state, 'disabled');
});
const connection = process.env.CONCLAVE_TEST_DATABASE_URL;
test(
  'durable index resumes snapshots budgets gaps and address coverage in isolated PostgreSQL',
  { skip: !connection },
  async () => {
    const endpoint = new URL(connection);
    assert.ok(
      ['localhost', '127.0.0.1', '[::1]'].includes(endpoint.hostname) &&
        endpoint.pathname.endsWith('_test'),
    );
    const pool = createDatabase(connection, 4);
    const sourceId = 'index-' + randomUUID();
    const config = {
      enabled: true,
      sourceId,
      rpcUrl: 'https://rpc.example.test',
      startSlot: 10,
      slotsPerRun: 1,
      dailyRpcCalls: 100,
      maxPayloadBytes: 1048576,
    };
    const calls = [];
    let head = 10;
    const blocks = new Map([[10, block(10, 27)]]);
    const fetcher = async (_url, init) => {
      const body = JSON.parse(init.body);
      calls.push(body.method);
      let result;
      switch (body.method) {
        case 'getGenesisHash':
          result = SOLANA_NETWORKS['mainnet-beta'].genesisHash;
          break;
        case 'getSlot':
          result = head;
          break;
        case 'getFirstAvailableBlock':
          result = 1;
          break;
        case 'getBlocks':
          result = [...blocks.keys()].filter(
            (n) => n >= body.params[0] && n <= body.params[1],
          );
          break;
        case 'getBlock':
          result = blocks.get(body.params[0]);
          break;
        default:
          throw Error('Unexpected RPC');
      }
      return new Response(
        JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      );
    };
    try {
      await migrate(pool);
      assert.deepEqual(await runChainIndexOnce(pool, { config, fetcher }), {
        state: 'indexed',
        blocks: 1,
        transactions: 27,
      });
      assert.equal(
        (await runChainIndexOnce(pool, { config, fetcher })).state,
        'idle',
      );
      const source = createChainIndexSource(pool, sourceId),
        first = await source.page(owner, null, null);
      assert.equal(first.entries.length, 25);
      assert.equal(first.entries[0].transactionIndex, 26);
      assert.equal(first.coverage, null);
      assert.equal(first.exhausted, false);
      process.env.CONCLAVE_ACTIVE_DATA_KEY = 'chain-fixture';
      process.env.CONCLAVE_DATA_KEYS = JSON.stringify({
        'chain-fixture': Buffer.alloc(32, 92).toString('base64'),
      });
      const accountId = randomUUID();
      await pool.query('INSERT INTO accounts(id) VALUES($1)', [accountId]);
      const linked = await linkWallet(
        pool,
        accountId,
        owner,
        'Archive fixture',
      );
      const ingestConfig = {
        enabled: true,
        localIndexSourceId: sourceId,
        rpcUrl: null,
        archiveUrl: null,
        archiveSourceId: null,
        priceUrl: null,
        feePolicyId: null,
        jitoAccounts: [],
        platformAccounts: [],
      };
      assert.doesNotThrow(() =>
        parseWalletTrade(
          first.entries[0].transaction,
          owner,
          first.entries[0].signature,
          { transactionIndex: first.entries[0].transactionIndex },
        ),
      );
      assert.equal(
        (await runWalletIngestOnce(pool, { config: ingestConfig }))
          .transactions,
        25,
      );
      assert.equal(
        (await getWallet(pool, accountId, linked.id)).sync.signatures,
        25,
      );
      const trader = await addFollowTrader(
        pool,
        accountId,
        owner,
        'Follow fixture',
      );
      assert.equal(
        (await runFollowIngestOnce(pool, { config: ingestConfig })).state,
        'queued',
      );
      // A replacement source must clear old completeness and restart pagination.
      await pool.query(
        "UPDATE second_look_follow_jobs SET source_revision=$2,coverage_ciphertext='obsolete',cursor_ciphertext='obsolete',next_run_at=now() WHERE trader_id=$1",
        [trader.id, '0'.repeat(64)],
      );
      assert.equal(
        (await runFollowIngestOnce(pool, { config: ingestConfig })).state,
        'queued',
      );
      assert.equal(
        (
          await pool.query(
            'SELECT coverage_ciphertext FROM second_look_follow_jobs WHERE trader_id=$1',
            [trader.id],
          )
        ).rows[0].coverage_ciphertext,
        null,
      );
      head = 11;
      const next = block(11, 1, 10);
      next.transactions[0] = tx(40);
      blocks.set(11, next);
      assert.equal(
        (await runChainIndexOnce(pool, { config, fetcher })).state,
        'indexed',
      );
      const second = await source.page(
        owner,
        first.nextCursor,
        first.snapshotId,
      );
      assert.equal(second.entries.length, 2);
      assert.equal(second.exhausted, true);
      assert.equal(second.snapshotId, first.snapshotId);
      assert.equal(
        (await source.page(owner, null, null)).entries[0].signature,
        sig(40),
      );
      await assert.rejects(
        source.page(wallet, first.nextCursor, first.snapshotId),
      );
      await assert.rejects(source.page(owner, first.nextCursor, null));
      assert.equal(
        (await source.statuses([sig(40), sig(99)])).values[0].state,
        'finalized',
      );
      assert.equal((await source.statuses([sig(99)])).values[0], null);
      assert.equal(
        walletIngestSource(pool, {
          enabled: true,
          localIndexSourceId: sourceId,
        }).kind,
        'archive',
      );
      head = 12;
      blocks.set(12, block(12, 1, 9));
      await assert.rejects(
        runChainIndexOnce(pool, { config, fetcher }),
        /COVERAGE_GAP/,
      );
      assert.equal(
        (
          await pool.query(
            'SELECT last_block_slot FROM second_look_chain_sources WHERE id=$1',
            [sourceId],
          )
        ).rows[0].last_block_slot,
        '11',
      );
      await pool.query(
        'UPDATE second_look_chain_budget SET calls=100 WHERE source_id=$1',
        [sourceId],
      );
      const previousCalls = calls.length;
      assert.equal(
        (await runChainIndexOnce(pool, { config, fetcher })).state,
        'rpc_budget',
      );
      assert.equal(calls.length, previousCalls);
      await pool.query(
        'UPDATE second_look_chain_sources SET payload_bytes=1048576 WHERE id=$1',
        [sourceId],
      );
      assert.equal(
        (await runChainIndexOnce(pool, { config, fetcher })).state,
        'storage_budget',
      );
      assert.equal(calls.length, previousCalls);
      const security = await pool.query(
        "SELECT bool_and(relrowsecurity) AS protected FROM pg_class WHERE relname LIKE 'second_look_chain_%' AND relkind='r'",
      );
      assert.equal(security.rows[0].protected, true);
      assert.ok(
        calls.every((m) =>
          [
            'getGenesisHash',
            'getSlot',
            'getFirstAvailableBlock',
            'getBlocks',
            'getBlock',
          ].includes(m),
        ),
      );
    } finally {
      await pool.end();
    }
  },
);

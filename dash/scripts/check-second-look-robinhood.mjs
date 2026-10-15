import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRobinhoodReceipt,
  readRobinhoodReceipt,
  attributeRelayRobinhoodRequest,
  robinhoodCapability,
  robinhoodConfig,
} from '../server/second-look/follow-robinhood.ts';
const a = (n) => '0x' + n.toString(16).padStart(40, '0');
const h = (n) => '0x' + n.toString(16).padStart(64, '0');
const topic = (n) => '0x' + a(n).slice(2).padStart(64, '0');
const transfer =
  '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
function fixture() {
  const hash = h(10),
    blockHash = h(20),
    wallet = a(1);
  const logs = [
    [3, 1, 2, 100n],
    [4, 2, 1, 150n],
    [5, 2, 6, 7n],
  ].map(([asset, from, to, amount], i) => ({
    address: a(asset),
    topics: [transfer, topic(from), topic(to)],
    data: '0x' + amount.toString(16).padStart(64, '0'),
    blockHash,
    transactionHash: hash,
    logIndex: '0x' + i.toString(16),
    removed: false,
  }));
  return {
    wallet,
    hash,
    sourceId: 'reviewed-rpc',
    receipt: {
      transactionHash: hash,
      blockHash,
      blockNumber: '0x100',
      from: wallet,
      status: '0x1',
      gasUsed: '0x100',
      effectiveGasPrice: '0x20000000000001',
      logs,
    },
    transaction: {
      hash,
      blockHash,
      blockNumber: '0x100',
      from: wallet,
      to: a(2),
      value: '0x0',
      chainId: '0x1237',
    },
    block: { hash: blockHash, number: '0x100', timestamp: '0x67000000' },
    finalizedBlock: { number: '0x101' },
  };
}
function request() {
  const amount = (asset, n) => ({
    currency: { chainId: 4663, address: a(asset), decimals: 18 },
    amount: String(n),
  });
  return {
    id: h(200),
    status: 'success',
    sender: a(1),
    recipient: a(1),
    data: {
      route: {
        actual: {
          origin: {
            inputCurrency: amount(3, 100),
            outputCurrency: amount(4, 150),
          },
          destination: null,
        },
      },
      inTxs: [{ chainId: 4663, txHash: h(10), status: 'success' }],
      outTxs: [],
    },
  };
}
test('receipt parser preserves exact atoms and gas, excluding unrelated solver transfers', () => {
  const r = parseRobinhoodReceipt(fixture());
  assert.equal(r.transfers.length, 2);
  assert.equal(r.networkFeeWei, (256n * 9007199254740993n).toString());
  assert.equal(r.finalized, true);
  assert.equal(r.coverage.completeWalletHistory, false);
});
test('wrong chain, reorged receipt, unrelated wallet and duplicate logs fail closed', () => {
  for (const modify of [
    (f) => {
      f.transaction.chainId = '0x1';
    },
    (f) => {
      f.receipt.blockHash = h(999);
    },
    (f) => {
      f.wallet = a(99);
    },
    (f) => {
      f.receipt.logs.push(f.receipt.logs[0]);
    },
  ]) {
    const f = fixture();
    modify(f);
    assert.throws(() => parseRobinhoodReceipt(f));
  }
});
test('provisional and failed receipts cannot verify completed Relay fills', () => {
  let f = fixture();
  f.finalizedBlock.number = '0xff';
  assert.equal(
    attributeRelayRobinhoodRequest(request(), a(1), [parseRobinhoodReceipt(f)])
      .status,
    'unavailable',
  );
  f = fixture();
  f.receipt.status = '0x0';
  const failed = parseRobinhoodReceipt(f);
  assert.equal(failed.transfers.length, 0);
  assert.notEqual(failed.networkFeeWei, '0');
  assert.equal(
    attributeRelayRobinhoodRequest(request(), a(1), [failed]).status,
    'unavailable',
  );
});
test('Relay attribution requires actual user-bound deposit and fill amounts; never the shared solver', () => {
  const receipts = [parseRobinhoodReceipt(fixture())];
  const result = attributeRelayRobinhoodRequest(request(), a(1), receipts);
  assert.equal(result.status, 'verified');
  assert.equal(result.actor, a(1));
  assert.equal(result.inputAtoms, '100');
  assert.equal(result.outputAtoms, '150');
  for (const modify of [
    (r) => {
      r.sender = a(2);
    },
    (r) => {
      r.data.route.actual.origin.outputCurrency.amount = '151';
    },
    (r) => {
      r.data.route.quoted = r.data.route.actual;
      delete r.data.route.actual;
    },
    (r) => {
      r.data.inTxs[0].txHash = h(99);
    },
    (r) => {
      r.data.route.actual.origin.inputCurrency.currency.chainId = 1;
    },
  ]) {
    const r = request();
    modify(r);
    assert.equal(
      attributeRelayRobinhoodRequest(r, a(1), receipts).status,
      'unavailable',
    );
  }
});
test('RPC adapter pins mainnet and uses only bounded read methods, never transaction writes', async () => {
  const f = fixture(),
    methods = [],
    values = {
      eth_chainId: '0x1237',
      eth_getTransactionReceipt: f.receipt,
      eth_getTransactionByHash: f.transaction,
    };
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    methods.push(body.method);
    const result =
      body.method === 'eth_getBlockByNumber'
        ? body.params[0] === 'finalized'
          ? f.finalizedBlock
          : f.block
        : values[body.method];
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
    );
  };
  const r = await readRobinhoodReceipt(f.wallet, f.hash, {
    config: {
      enabled: true,
      rpcUrl: 'https://rpc.example.test',
      sourceId: 'fixture',
    },
    fetcher,
  });
  assert.equal(r.finalized, true);
  assert.equal(methods.length, 5);
  assert.ok(
    methods.every((m) =>
      [
        'eth_chainId',
        'eth_getTransactionReceipt',
        'eth_getTransactionByHash',
        'eth_getBlockByNumber',
      ].includes(m),
    ),
  );
  await assert.rejects(
    readRobinhoodReceipt(f.wallet, f.hash, {
      config: {
        enabled: true,
        rpcUrl: 'https://rpc.example.test',
        sourceId: 'fixture',
      },
      fetcher: async () =>
        new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' })),
    }),
    /WRONG_CHAIN/,
  );
});
test('configuration and readiness never advertise complete wallet history from a receipt endpoint', () => {
  assert.equal(
    robinhoodCapability(robinhoodConfig({})).receiptReadsConfigured,
    false,
  );
  const c = robinhoodConfig({
    CONCLAVE_ROBINHOOD_READ_ENABLED: 'true',
    CONCLAVE_ROBINHOOD_RPC_URL: 'https://rpc.example.test',
    CONCLAVE_ROBINHOOD_SOURCE_ID: 'existing-rpc',
  });
  assert.equal(robinhoodCapability(c).receiptReadsConfigured, true);
  assert.equal(robinhoodCapability(c).followMetricsReady, false);
  assert.equal(robinhoodCapability(c).arbitraryRelayHistory, false);
  assert.equal(
    robinhoodConfig({
      CONCLAVE_ROBINHOOD_RPC_URL: 'https://user:secret@example.test',
    }).rpcUrl,
    null,
  );
});

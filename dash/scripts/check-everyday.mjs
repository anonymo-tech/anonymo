import assert from 'node:assert/strict';
import test from 'node:test';
import { createAnonymoClient } from '../lib/anonymo/client.ts';
import { moveStake, stakeControls } from '../lib/anonymo/everyday.ts';
import { parseUpdates, RELEASED, updateOn } from '../lib/anonymo/updates.ts';

const address = '0xabababababababababababababababababababab'; // gitleaks:allow

test('passes and stake are opt-in with a demo preview', () => {
  assert.deepEqual([...parseUpdates('passes,stake')], ['passes', 'stake']);
  assert.equal(parseUpdates('').has('passes'), false);
  assert.equal(parseUpdates('').has('stake'), false);
  assert.equal(RELEASED.has('passes'), false);
  assert.equal(RELEASED.has('stake'), false);
  assert.equal(updateOn('passes', true), true);
  assert.equal(updateOn('stake', true), true);
});

test('Unstake stays enabled while paused, makes no allowance call and does not read pause or gateway state', async () => {
  assert.deepEqual(stakeControls(50n, { paused: true, staked: 50n }, false), { stake: false, unstake: true });
  assert.equal(stakeControls(50n, { paused: null, staked: 50n }, false).unstake, true);
  assert.equal(stakeControls(51n, { paused: true, staked: 50n }, false).unstake, false);
  const seen = [];
  const hash = `0x${'ab'.repeat(32)}`; // gitleaks:allow
  const connection = {
    account: address,
    pub: {
      readContract: async () => { throw new Error('Paused'); },
      simulateContract: async (call) => {
        seen.push([call.functionName, call.address, call.args]);
        return { request: call };
      },
      waitForTransactionReceipt: async ({ hash: submitted }) => {
        assert.equal(submitted, hash);
        return { status: 'success' };
      },
    },
    wallet: {
      writeContract: async (call) => { assert.equal(call.functionName, 'unstake'); return hash; },
    },
  };
  await moveStake(connection, address, 'unstake', 50n, (submitted) => assert.equal(submitted, hash));
  assert.deepEqual(seen, [['unstake', address, [50n]]]);
});

test('contract discovery works without a key, while orders carry the key only in authorization', async () => {
  const key = 'anm_live_sample-key'; // gitleaks:allow
  const requests = [];
  const client = createAnonymoClient({
    baseUrl: 'https://gateway.example.invalid',
    key,
    fetch: async (url, init) => {
      requests.push({ path: new URL(url).pathname, headers: init.headers, body: init.body });
      return new Response('{}');
    },
  });
  await client.stakeContract();
  await client.passOrder('PASS30', address);
  assert.equal(requests[0].path, '/v1/everyday/stake/contract');
  assert.equal(requests[0].headers.get('authorization'), null);
  assert.equal(requests[1].headers.get('authorization'), `Bearer ${key}`);
  assert.deepEqual(JSON.parse(requests[1].body), { sku: 'PASS30', wallet: address });
});

test('the two pass rails use the reviewed amount and the order reference', async () => {
  const { buyPass } = await import('../lib/anonymo/everyday.ts');
  const { domainSeparator, keccak256, stringToHex } = await import('viem');
  const { privateKeyToAccount } = await import('viem/accounts');
  const signer = privateKeyToAccount(keccak256(stringToHex('sample-checkout-signer'))); // gitleaks:allow
  const usdg = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd'; // gitleaks:allow
  const nymo = '0xefefefefefefefefefefefefefefefefefefefef'; // gitleaks:allow
  const checkout = { address, usdg, nymo, paused: false };
  const ref = keccak256(stringToHex('sample-checkout-order'));
  const order = { ref, orderId: ref, checkout: address, sku: 'PASS30' };
  const domain = { name: 'USDG', version: '2', chainId: 4663, verifyingContract: usdg };
  const signed = [];
  const submitted = [];
  const paid = [];
  let nymoPrice = 96n;
  const wallet = {
    chain: { id: 4663 },
    signTypedData: async ({ account, ...input }) => {
      assert.equal(account, signer.address);
      signed.push(input);
      return signer.signTypedData(input);
    },
    writeContract: async (request) => { submitted.push(request); return ref; },
  };
  const pub = {
    getBlock: async () => ({ timestamp: 10n }),
    readContract: async ({ functionName }) => {
      const values = { usdg, nymo, priceOf: 12_000_000n, quoteNYMO: nymoPrice, paused: false,
        DOMAIN_SEPARATOR: domainSeparator({ domain }), name: 'USDG', version: '2', orderNonce: ref, allowance: 0n };
      if (!(functionName in values)) throw new Error('Unavailable in fixture');
      return values[functionName];
    },
    simulateContract: async (request) => ({ request }),
    waitForTransactionReceipt: async () => ({ status: 'success' }),
  };
  const connection = { account: signer.address, pub, wallet };
  await buyPass(connection, checkout, order, 'USDG', 12_000_000n, (hash) => paid.push(hash));
  assert.equal(signed[0].primaryType, 'ReceiveWithAuthorization');
  assert.deepEqual(signed[0].message, { from: signer.address, to: address, value: 12_000_000n, validAfter: 0n, validBefore: 610n, nonce: ref });
  assert.equal(submitted[0].functionName, 'payUSDG');
  assert.equal(submitted[0].args[2].orderRef, ref);
  await buyPass(connection, checkout, order, 'NYMO', 96n, (hash) => paid.push(hash));
  assert.equal(submitted[1].functionName, 'approve');
  assert.deepEqual(submitted[1].args, [address, 96n]);
  assert.equal(submitted[2].functionName, 'payNYMO');
  assert.equal(submitted[2].args[2].value, 96n);
  assert.deepEqual(paid, [ref, ref]);
  nymoPrice = 97n;
  await assert.rejects(buyPass(connection, checkout, order, 'NYMO', 96n, () => assert.fail('No payment expected')), /price changed/);
  assert.equal(submitted.length, 3);
});

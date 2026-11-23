// 08 What am I signing? Parsing, decoding and the read-only simulation, with the brief's fixtures. No real funds, no
// wallet: the module has no provider, and the RPC used for simulation is a fake that refuses anything but reads.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { encodeFunctionData, keccak256, maxUint256, stringToHex, toFunctionSelector } from 'viem';
import { ERC20_PERMIT_ABI } from '../lib/anonymo/wallet.ts';
import {
  amountText, fingerprintOf, isStale, limitedPreview, parseEip681Number, parseWalletRequest, reviewRequest, rpcClient,
  simulateApproval, simulationDisclosure, verifiedFromContracts, SIMULATION_FRESH_MS,
} from '../lib/anonymo/wallet-request.ts';

const USDG = '0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168';
const ROUTER = '0x00000000000000000000000000000000000000d1';
const SPENDER = '0x7777777777777777777777777777777777777777';
const ACCOUNT = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
const UNKNOWN_TOKEN = '0x1111111111111111111111111111111111111111';
const contracts = { paused: false, chains: [{ chain: 'rhc', router: ROUTER, confirmations: 3, tokens: [{ symbol: 'USDG', address: USDG.toLowerCase(), decimals: 6 }] }], coin: null };
const ids = { rhc: 4663, base: 8453, arbitrum: 42161 };
const networks = [{ chain: 'rhc', chainId: 4663, name: 'Robinhood Chain' }, { chain: 'base', chainId: 8453, name: 'Base' }];
const ctx = { networks, ...verifiedFromContracts(contracts, c => ids[c]) };
const approve = (spender, amount) => encodeFunctionData({ abi: ERC20_PERMIT_ABI, functionName: 'approve', args: [spender, amount] });
const tx = (o = {}) => JSON.stringify({ from: ACCOUNT, to: USDG, chainId: '0x1237', data: approve(SPENDER, 25_000_000n), ...o });
const review = (text) => {
  const p = parseWalletRequest(text);
  assert.equal(p.ok, true, p.message);
  const r = reviewRequest(p.request, ctx);
  assert.equal(r.ok, true, r.message);
  return r.review;
};

void test('08 fixture: a limited approval names the verified token, the raw spender address and the exact amount', () => {
  const r = review(tx());
  assert.equal(r.chain.name, 'Robinhood Chain');
  assert.equal(r.token.verified.symbol, 'USDG');
  assert.equal(r.spender.label, null, 'an unverified spender gets no familiar name');
  assert.equal(r.spender.address.toLowerCase(), SPENDER);
  assert.equal(r.amount.text, '25 USDG');
  assert.equal(r.account.toLowerCase(), ACCOUNT);
  // The Anonymo router is the only spender given a name, because the gateway vouches for it.
  assert.equal(review(tx({ data: approve(ROUTER, 1n) })).spender.label, 'Anonymo deposit router');
});

void test('08 fixture: an unlimited approval says unlimited; a zero approval is a revocation', () => {
  const unlimited = review(tx({ data: approve(SPENDER, maxUint256) }));
  assert.equal(unlimited.amount.unlimited, true);
  assert.equal(unlimited.amount.text, 'Unlimited USDG');
  const zero = review(tx({ data: approve(SPENDER, 0n) }));
  assert.equal(zero.amount.zero, true);
  assert.equal(zero.amount.text, '0 USDG');
});

void test('08 fixture: an unexpected chain and an unknown token are shown as unverified, never guessed', () => {
  const mainnet = review(tx({ chainId: 1 }));
  assert.equal(mainnet.chain.supported, false);
  assert.equal(mainnet.token.verified, null, 'USDG is only verified on the chain the gateway lists it on');
  assert.equal(mainnet.amount.text, '25000000 units (decimals unknown)');
  const unknown = review(tx({ to: UNKNOWN_TOKEN }));
  assert.equal(unknown.chain.supported, true);
  assert.equal(unknown.token.verified, null);
  assert.match(unknown.amount.text, /units \(decimals unknown\)/);
});

void test('08 fixture: signature requests and other calls are refused with a reason', () => {
  for (const method of ['eth_signTypedData_v4', 'personal_sign', 'eth_sign'])
    assert.equal(parseWalletRequest(JSON.stringify({ method, params: [ACCOUNT, '{}'] })).code, 'signature');
  assert.equal(parseWalletRequest(JSON.stringify({ types: {}, primaryType: 'Permit', domain: {}, message: {} })).code, 'signature');
  const transfer = encodeFunctionData({ abi: [{ type: 'function', name: 'transfer', inputs: [{ type: 'address' }, { type: 'uint256' }], outputs: [{ type: 'bool' }], stateMutability: 'nonpayable' }], functionName: 'transfer', args: [SPENDER, 1n] });
  const p = parseWalletRequest(tx({ data: transfer }));
  assert.equal(reviewRequest(p.request, ctx).code, 'call');
  assert.equal(parseWalletRequest(tx({ chainId: undefined })).code, 'chain');
  assert.equal(parseWalletRequest('').code, 'empty');
  assert.equal(parseWalletRequest('approve everything please').code, 'format');
  assert.equal(parseWalletRequest(tx({ data: toFunctionSelector('approve(address,uint256)') + '00' })).ok, true);
  assert.equal(reviewRequest(parseWalletRequest(tx({ data: toFunctionSelector('approve(address,uint256)') + '00' })).request, ctx).code, 'data');
});

void test('08 EIP-681 approve links decode to the same review as the transaction', () => {
  const link = `ethereum:${USDG}@4663/approve?address=${SPENDER}&uint256=2.5e7`;
  const fromLink = review(link);
  const fromJson = review(tx());
  assert.equal(fromLink.amount.text, fromJson.amount.text);
  assert.equal(fromLink.request.data, fromJson.request.data);
  assert.equal(fromLink.account, null);
  assert.equal(parseWalletRequest(`ethereum:${USDG}/approve?address=${SPENDER}&uint256=1`).code, 'chain');
  assert.equal(parseWalletRequest(`ethereum:${USDG}@4663/transfer?address=${SPENDER}&uint256=1`).code, 'call');
  assert.equal(parseEip681Number('1.5e0'), null, 'fractions of a unit are refused');
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 30n }), fc.integer({ min: 0, max: 12 }), (n, e) => {
    const s = n.toString();
    const text = e && s.length > e ? `${s.slice(0, -e)}.${s.slice(-e)}e${e}` : s;
    return parseEip681Number(text) === n;
  }));
});

void test('08 amounts use integer arithmetic for every value and decimals (property)', () => {
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: maxUint256 - 1n }), fc.integer({ min: 0, max: 30 }), (raw, decimals) => {
    const text = amountText(raw, { symbol: 'TKN', decimals });
    const [num] = text.split(' ');
    const [whole, frac = ''] = num.replaceAll(',', '').split('.');
    return BigInt(whole + frac.padEnd(decimals, '0')) === raw;
  }));
});

void test('08 the limit preview is illustrative and only offered when it is actually smaller', () => {
  const unlimited = review(tx({ data: approve(SPENDER, maxUint256) }));
  const p = limitedPreview(unlimited, 10n);
  assert.equal(p.text, '10 USDG');
  assert.equal(p.data, approve(unlimited.spender.address, 10_000_000n));
  assert.equal(limitedPreview(review(tx({ data: approve(SPENDER, 5_000_000n) })), 10n), null);
  assert.equal(limitedPreview(review(tx({ to: UNKNOWN_TOKEN })), 10n), null, 'no preview without verified decimals');
});

function fakeRpc({ allowance = 0n, simulate } = {}) {
  const calls = [];
  const fetcher = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.method);
    const reply = (result) => ({ json: async () => ({ jsonrpc: '2.0', id: body.id, result }) });
    if (body.method === 'eth_call') return reply('0x' + allowance.toString(16).padStart(64, '0'));
    return simulate(body, reply);
  };
  return { calls, rpc: rpcClient('https://rpc.example.test', fetcher) };
}
const approvalLog = (value) => ({ address: USDG, topics: [keccak256(stringToHex('Approval(address,address,uint256)')), '0x' + ACCOUNT.slice(2).padStart(64, '0'), '0x' + SPENDER.slice(2).padStart(64, '0')], data: '0x' + value.toString(16).padStart(64, '0') });

void test('08 simulation: zero immediate change, allowance after, staleness, failure and unsupported states', async () => {
  const r = review(tx({ data: approve(SPENDER, maxUint256) }));
  const ok = fakeRpc({ allowance: 3n, simulate: (_b, reply) => reply([{ calls: [{ status: '0x1', logs: [approvalLog(maxUint256)] }] }]) });
  const s = await simulateApproval(r, ACCOUNT, ok.rpc, () => 1000);
  assert.deepEqual([s.kind, s.currentAllowance, s.allowanceAfter, s.balanceChange, s.nativeChange], ['ok', 3n, maxUint256, 0n, 0n]);
  assert.deepEqual(ok.calls, ['eth_call', 'eth_simulateV1']);
  assert.equal(isStale(s, r, 1000 + SIMULATION_FRESH_MS - 1), false);
  assert.equal(isStale(s, r, 1000 + SIMULATION_FRESH_MS + 1), true, 'old results are stale');
  const changed = review(tx({ data: approve(SPENDER, 1n) }));
  assert.notEqual(fingerprintOf(changed.request), fingerprintOf(r.request));
  assert.equal(isStale(s, changed, 1000), true, 'a changed request invalidates the simulation');

  const reverted = fakeRpc({ simulate: (_b, reply) => reply([{ calls: [{ status: '0x0', error: { message: 'execution reverted' } }] }]) });
  const f = await simulateApproval(r, ACCOUNT, reverted.rpc);
  assert.equal(f.kind, 'failed');
  assert.match(f.message, /would fail/);

  const unsupported = fakeRpc({ simulate: (b) => ({ json: async () => ({ jsonrpc: '2.0', id: b.id, error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } }) }) });
  assert.equal((await simulateApproval(r, ACCOUNT, unsupported.rpc)).kind, 'unsupported');

  const down = rpcClient('https://rpc.example.test', async () => { throw new Error('network down'); });
  assert.equal((await simulateApproval(r, ACCOUNT, down)).kind, 'failed');
});

void test('08 the simulation client only ever reads, and the disclosure names everything it sends', async () => {
  const rpc = rpcClient('https://rpc.example.test', async () => { throw new Error('must not be reached'); });
  for (const method of ['eth_sendTransaction', 'eth_sendRawTransaction', 'personal_sign', 'eth_signTypedData_v4'])
    await assert.rejects(rpc(method, []), /read-only/);
  const r = review(tx());
  const d = simulationDisclosure(r, 'https://rpc.mainnet.chain.robinhood.com', ACCOUNT);
  assert.equal(d.host, 'rpc.mainnet.chain.robinhood.com');
  assert.deepEqual(d.fields.map(([k]) => k), ['Your wallet address', 'Token contract', 'Spender', 'Amount', 'Chain']);
});

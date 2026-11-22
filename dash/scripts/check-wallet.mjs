// The browser-wallet payment helpers: coin quotes (rounded up, capped, refused without a price), stablecoin units,
// the ABI fragments against the gateway's compiled DepositRouter ABI, permit-domain detection, and chain switching.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { decodeFunctionData, domainSeparator, toFunctionSelector, toHex } from 'viem';
import { DepositRouterAbi } from '../../gateway/src/chain/abis.ts';
import { COIN_PAY_ABI, DEPOSIT_ROUTER_ABI, depositStablecoin, describeWalletError, ensureChain, formatUnits, permitDomain, quoteCoins, rowForTx, stableUnits } from '../lib/anonymo/wallet.ts';

const COIN = { price_usd: '0.0125', max_usd_per_payment: '250', token: { decimals: 18 } };

void test('coin quote: usd / price, rounded up to the smallest unit, never short', () => {
  const q = quoteCoins(10_000_000, COIN);
  assert.equal(q.ok, true);
  assert.equal(q.coins, 800n * 10n ** 18n, '$10 at $0.0125 is exactly 800 ANMO');
  const odd = quoteCoins(1, { ...COIN, price_usd: '3' });
  assert.equal(odd.coins, 333_333_333_334n, '$0.000001 at $3 rounds up');
  fc.assert(
    fc.property(fc.integer({ min: 1, max: 250_000_000 }), fc.integer({ min: 1, max: 10 ** 9 }), fc.integer({ min: 0, max: 8 }), (musd, p, scale) => {
      const digits = String(p).padStart(scale + 1, '0');
      const price = scale ? `${digits.slice(0, -scale)}.${digits.slice(-scale)}` : digits;
      const r = quoteCoins(musd, { ...COIN, price_usd: price });
      if (!r.ok) return false;
      const [i, f = ''] = price.split('.');
      const priceNum = BigInt(i + f);
      const priceScale = BigInt(f.length);
      // coins * price >= usd, and one unit fewer would fall short
      const paid = (c) => c * priceNum * 1_000_000n; // compare in units of 10^-(18+scale) USD x 1e6
      const owed = BigInt(musd) * 10n ** 18n * 10n ** priceScale;
      return paid(r.coins) >= owed && paid(r.coins - 1n) < owed;
    }),
  );
});

void test('coin quote: refuses above max_usd_per_payment, and everything while price_usd is null', () => {
  const over = quoteCoins(250_000_001, COIN);
  assert.deepEqual([over.ok, over.reason, over.maxMusd], [false, 'over_max', 250_000_000]);
  assert.equal(quoteCoins(250_000_000, COIN).ok, true);
  assert.equal(quoteCoins(1_000_000, { ...COIN, price_usd: null }).reason, 'unavailable');
  assert.equal(quoteCoins(0, COIN).reason, 'invalid_amount');
});

void test('stablecoin units are 1:1 with USD', () => {
  assert.equal(stableUnits(12_345_678, 6), 12_345_678n);
  assert.equal(stableUnits(1_000_000, 18), 10n ** 18n);
  assert.throws(() => stableUnits(0, 6));
  assert.equal(formatUnits(12_345_678n, 6), '12.345678');
  assert.equal(formatUnits(800n * 10n ** 18n, 18), '800');
  assert.equal(formatUnits(1n, 18), '0.000000000000000001');
});

void test('DepositRouter fragment matches the gateway ABI compiled from the contract', () => {
  const sig = (f) => `${f.name}(${f.inputs.map((i) => i.type).join(',')})`;
  const gateway = new Set(DepositRouterAbi.filter((f) => f.type === 'function').map((f) => toFunctionSelector(sig(f))));
  for (const f of DEPOSIT_ROUTER_ABI) assert.ok(gateway.has(toFunctionSelector(sig(f))), `${sig(f)} is on the DepositRouter`);
  assert.deepEqual(
    COIN_PAY_ABI.map(sig),
    ['pay(uint256,bytes32)', 'payWithPermit(uint256,bytes32,uint256,uint8,bytes32,bytes32)'],
  );
});

const TOKEN = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
function fakeToken({ name = 'Global Dollar', version = '1', reads = {} } = {}) {
  const separator = domainSeparator({ domain: { name, version, chainId: 4663, verifyingContract: TOKEN } });
  const values = { DOMAIN_SEPARATOR: separator, name, ...reads };
  return {
    readContract: async ({ functionName }) => {
      if (!(functionName in values) || values[functionName] instanceof Error) throw new Error('execution reverted');
      return values[functionName];
    },
  };
}

void test('permit domain: only a domain that hashes to the token DOMAIN_SEPARATOR is used', async () => {
  assert.deepEqual(await permitDomain(fakeToken(), TOKEN, 4663), { name: 'Global Dollar', version: '1', chainId: 4663, verifyingContract: TOKEN });
  const v2 = await permitDomain(fakeToken({ version: '2' }), TOKEN, 4663);
  assert.equal(v2.version, '2');
  const viaVersion = await permitDomain(fakeToken({ version: '7', reads: { version: '7' } }), TOKEN, 4663);
  assert.equal(viaVersion.version, '7');
  assert.equal(await permitDomain(fakeToken({ version: '9' }), TOKEN, 4663), null, 'an unguessable domain falls back to approve');
  assert.equal(await permitDomain(fakeToken({ reads: { DOMAIN_SEPARATOR: new Error() } }), TOKEN, 4663), null, 'no EIP-2612');
  assert.equal(await permitDomain(fakeToken(), TOKEN, 1), null, 'another chain id is another domain');
});

void test('ensureChain switches, adds an unknown chain, and confirms the result', async () => {
  const calls = [];
  let chain = 1;
  let known = false;
  const provider = {
    request: async ({ method, params }) => {
      calls.push(method);
      if (method === 'eth_chainId') return `0x${chain.toString(16)}`;
      if (method === 'wallet_switchEthereumChain') {
        if (!known) throw Object.assign(new Error('Unrecognized chain'), { code: 4902 });
        chain = Number.parseInt(params[0].chainId, 16);
        return null;
      }
      if (method === 'wallet_addEthereumChain') {
        assert.equal(params[0].chainId, '0x1237');
        assert.deepEqual(params[0].rpcUrls, ['https://rpc.example']);
        known = true;
        chain = 4663;
        return null;
      }
      throw new Error(`unexpected ${method}`);
    },
  };
  const net = { chainId: 4663, name: 'Robinhood Chain', rpcUrl: 'https://rpc.example', explorer: null, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } };
  await ensureChain(provider, net);
  assert.deepEqual(calls, ['eth_chainId', 'wallet_switchEthereumChain', 'wallet_addEthereumChain', 'eth_chainId']);
  calls.length = 0;
  await ensureChain(provider, net);
  assert.deepEqual(calls, ['eth_chainId'], 'already on the chain: nothing asked');
  known = false; // the wallet does not know the testnet either
  await assert.rejects(ensureChain(provider, { ...net, chainId: 46630, rpcUrl: '' }), /no RPC address/);
});

void test('the deposit row for a transaction is found by its hash in the ref', () => {
  const rows = [{ ref: 'rhc:0xabc:0' }, { ref: 'coin:0xdef:1' }];
  assert.equal(rowForTx(rows, '0xDEF').ref, 'coin:0xdef:1');
  assert.equal(rowForTx(rows, '0x123'), undefined);
});

// Phones: no browser wallet, so Funds opens /pay inside a wallet app. The link names the key only by its keyCommit.
import { isMobileBrowser, parsePayLink, payUrl, walletAppLinks } from '../lib/anonymo/wallet-links.ts';

void test('pay links: round trip, only the keyCommit, wallet app links wrap the whole URL, and phones are detected', async () => {
  const keyCommit = `0x${'ab'.repeat(32)}`;
  const url = payUrl('https://anonymo.example/', { keyCommit, chain: 'rhc', token: 'USDG', amount: '25.50' });
  assert.equal(url, `https://anonymo.example/pay?k=${keyCommit}&chain=rhc&token=USDG&amount=25.50`);
  assert.deepEqual(parsePayLink(new URL(url).search), { keyCommit, chain: 'rhc', token: 'USDG', amount: '25.50' });
  assert.ok(!url.includes('anm_'), 'a pay link never carries the key');

  // Malformed links ask for a fresh one instead of paying something else.
  for (const bad of ['?k=0x12&chain=rhc&token=USDG', `?k=${keyCommit}&chain=mainnet&token=USDG`, `?k=${keyCommit}&chain=rhc&token=`]) assert.equal(parsePayLink(bad), null);
  for (const amount of ['', '0', '1e9', '-5', '0.0000001']) {
    assert.equal(payUrl('https://anonymo.example', { keyCommit, chain: 'rhc', token: 'USDG', amount }), '');
    assert.equal(parsePayLink(`?k=${keyCommit}&chain=rhc&token=USDG&amount=${amount}`), null);
  }
  const small = payUrl('https://anonymo.example', { keyCommit, chain: 'rhc', token: 'USDG', amount: '0.000125' });
  assert.equal(parsePayLink(new URL(small).search)?.amount, '0.000125');

  const links = walletAppLinks(url);
  assert.deepEqual(links.map((l) => l.name), ['MetaMask', 'Coinbase Wallet', 'Trust Wallet']);
  assert.equal(links[0].href, `https://link.metamask.io/dapp/anonymo.example/pay?k=${keyCommit}&chain=rhc&token=USDG&amount=25.50`);
  for (const l of links.slice(1)) assert.ok(l.href.endsWith(encodeURIComponent(url)));

  assert.equal(isMobileBrowser({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Mobile/15E148', maxTouchPoints: 5 }), true);
  assert.equal(isMobileBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 5 }), true);
  assert.equal(isMobileBrowser({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', maxTouchPoints: 0 }), false);
});


// Every RPC in this fixture terminates in memory, including both transaction submissions.
void test('stablecoin payment sends the selected units and commitment to the router, and reports only the deposit hash', async () => {
  const from = `0x${'11'.repeat(20)}`;
  const router = `0x${'22'.repeat(20)}`;
  const token = { address: `0x${'33'.repeat(20)}`, symbol: 'USDC', decimals: 6 };
  const keyCommit = `0x${'ab'.repeat(32)}`;
  const approvalHash = `0x${'44'.repeat(32)}`;
  const depositHash = `0x${'55'.repeat(32)}`;
  const network = { chainId: 8453, name: 'Base', rpcUrl: '', explorer: null, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } };
  const amount = stableUnits(25_125_000, token.decimals);
  const sent = [];
  const events = [];
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_requestAccounts') return [from];
      if (method === 'eth_chainId') return '0x2105';
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_call') {
        const selector = params[0].data.slice(0, 10);
        if (selector === toFunctionSelector('balanceOf(address)')) return toHex(amount, { size: 32 });
        if (selector === toFunctionSelector('allowance(address,address)')) return toHex(0, { size: 32 });
        if (selector === toFunctionSelector('DOMAIN_SEPARATOR()')) return '0x';
      }
      if (method === 'eth_sendTransaction') {
        sent.push(params[0]);
        return sent.length === 1 ? approvalHash : depositHash;
      }
      if (method === 'eth_getTransactionReceipt') {
        events.push(`receipt ${params[0]}`);
        return { status: '0x1', logs: [], transactionHash: params[0] };
      }
      throw new Error(`Unexpected wallet RPC ${method}`);
    },
  };
  const options = {
    provider, token, network, router, keyCommit, amount,
    onBroadcast: (hash) => events.push(`broadcast ${hash}`),
    onStep: (step) => events.push(step),
  };
  const result = await depositStablecoin(options);
  assert.equal(result.hash, depositHash);
  assert.equal(result.method, 'approve');
  assert.equal(sent.length, 2);
  assert.equal(sent[0].to, token.address);
  assert.equal(sent[1].to, router);
  assert.equal(sent[1].from, from);
  const deposit = decodeFunctionData({ abi: DEPOSIT_ROUTER_ABI, data: sent[1].data });
  assert.equal(deposit.functionName, 'deposit');
  assert.deepEqual(deposit.args, [token.address, amount, keyCommit]);
  assert.deepEqual(events, ['connecting', 'switching', 'checking', 'approving', `receipt ${approvalHash}`, 'sending', `broadcast ${depositHash}`, 'confirming', `receipt ${depositHash}`, 'submitted']);
  events.length = 0;
  await assert.rejects(depositStablecoin({
    ...options, provider: { request: async () => { throw Object.assign(new Error('User rejected'), { code: 4001 }); } },
  }), (error) => /declined/.test(describeWalletError(error)));
  assert.deepEqual(events, ['connecting']);
});

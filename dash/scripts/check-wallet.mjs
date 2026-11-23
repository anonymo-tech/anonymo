// The browser-wallet payment helpers: coin quotes (rounded up, capped, refused without a price), stablecoin units,
// the ABI fragments against the gateway's compiled DepositRouter ABI, permit-domain detection, and chain switching.
import assert from 'node:assert/strict';
import test from 'node:test';
import fc from 'fast-check';
import { decodeFunctionData, domainSeparator, toFunctionSelector, toHex } from 'viem';
import { readNymoQuote, sameNymoQuote } from '../lib/anonymo/nymo-quote.ts';
import { DepositRouterAbi } from '../../gateway/src/chain/abis.ts';
import { COIN_PAY_ABI, DEPOSIT_ROUTER_ABI, depositStablecoin, describeWalletError, ensureChain, formatUnits, payWithCoin, permitDomain, quoteCoins, rowForTx, stableUnits } from '../lib/anonymo/wallet.ts';

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
import { availableNymoRail, isMobileBrowser, parsePayLink, payUrl, walletAppLinks } from '../lib/anonymo/wallet-links.ts';

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

const NYMO = '0xafe293638b064d7786c5326a071520358c3f3198';
const publicCoinRail = {
  chain: 'rhc', chain_id: 4663, token: { address: NYMO, symbol: 'NYMO', decimals: 18 },
  coin_pay: `0x${'cc'.repeat(20)}`, confirmations: 12, price_usd: '0.0125', max_usd_per_payment: '250',
};

void test('NYMO wallet links carry only the key commitment, chain, symbol and chosen USD amount', () => {
  const keyCommit = `0x${'ab'.repeat(32)}`;
  const handoff = { keyCommit, chain: 'rhc', token: 'NYMO', amount: '25.50' };
  const url = new URL(payUrl('https://anonymo.example', handoff));
  assert.deepEqual([...url.searchParams.keys()], ['k', 'chain', 'token', 'amount']);
  for (const key of ['coin_pay', 'token_address', 'price_usd', 'quote', 'chain_id', 'key_commit', 'understood']) {
    url.searchParams.set(key, 'untrusted');
  }
  assert.deepEqual(parsePayLink(url.search), handoff);
  for (const chain of ['base', 'arbitrum']) {
    assert.equal(payUrl('https://anonymo.example', { ...handoff, chain }), '');
    url.searchParams.set('chain', chain);
    assert.equal(parsePayLink(url.search), null);
  }
});

void test('only a correctly configured NYMO payment contract and a usable gateway quote authorize payment', () => {
  assert.equal(availableNymoRail(publicCoinRail), true);
  for (const bad of [null, undefined,
    ...[{ chain: 'base' }, { chain_id: 46630 }, { coin_pay: NYMO }, { coin_pay: '' },
      { coin_pay: `0x${'0'.repeat(40)}` }, { coin_pay: `0x${'0'.repeat(36)}dead` },
      { max_usd_per_payment: 'bad' }].map(fields => ({ ...publicCoinRail, ...fields })),
    ...[{ address: `0x${'11'.repeat(20)}` }, { decimals: 6 }, { symbol: 'ANMO' }]
      .map(fields => ({ ...publicCoinRail, token: { ...publicCoinRail.token, ...fields } })),
  ]) assert.equal(availableNymoRail(bad), false);
  assert.equal(quoteCoins(10_000_000, { ...publicCoinRail, price_usd: null }).ok, false);
  assert.equal(quoteCoins(999_000_000, publicCoinRail).ok, false);
});

void test('an executable NYMO quote binds the exact burn, contract, chain and credit terms', async () => {
  const quote = { ...publicCoinRail, amount_raw: '1999999999999999997', estimated_credit_usd: '1.2345', price_usd: '0.61725' };
  const read = response => readNymoQuote({ nymoQuote: async target => {
    assert.equal(target, '1.2345');
    return response;
  } }, publicCoinRail, 1_234_500);
  assert.deepEqual(await read(quote), quote);
  assert.equal(sameNymoQuote(quote, { ...quote, block: 123, estimated_credit_usd: '1.234500' }), true);
  for (const terms of [{ amount_raw: '2' }, { estimated_credit_usd: '1.2' }, { coin_pay: `0x${'ce'.repeat(20)}` }, { confirmations: 13 }]) {
    assert.equal(sameNymoQuote(quote, { ...quote, ...terms }), false);
  }
  for (const invalid of [{ amount_raw: '0' }, { amount_raw: String(2n ** 256n) }, { amount_raw: '1.2' },
    { chain_id: 1 }, { token: null }, { coin_pay: NYMO }, { coin_pay: `0x${'ce'.repeat(20)}` },
    { confirmations: 0 }, { estimated_credit_usd: '0' }, { price_usd: '0x5' }]) {
    await assert.rejects(read({ ...quote, ...invalid }));
  }
});

void test('NYMO wallet signs the quoted burn for the configured CoinPay, and rejection sends no payment', async () => {
  const amount = 78_012_345_678_901_234_567n;
  const hash = `0x${'dd'.repeat(32)}`;
  const keyCommit = `0x${'ab'.repeat(32)}`;
  const from = `0x${'12'.repeat(20)}`;
  const broadcast = [];
  const requests = [];
  let declined = true;
  const provider = {
    async request({ method, params }) {
      if (method === 'eth_requestAccounts') return [from];
      if (method === 'eth_chainId') return '0x1237';
      if (method === 'eth_getCode') return '0x6000';
      if (method === 'eth_call') {
        assert.equal(params[0].to.toLowerCase(), NYMO);
        assert.ok(['balanceOf(address)', 'allowance(address,address)'].some(fn => toFunctionSelector(fn) === params[0].data.slice(0, 10)));
        return toHex(amount, { size: 32 });
      }
      if (method === 'eth_sendTransaction') {
        requests.push(params[0]);
        if (declined) throw Object.assign(new Error('User rejected request'), { code: 4001 });
        return hash;
      }
      if (method === 'eth_getTransactionReceipt') return { status: '0x1', logs: [], transactionHash: hash };
      throw new Error(`Unexpected wallet RPC ${method}`);
    },
  };
  const options = { provider, token: publicCoinRail.token, coinPay: publicCoinRail.coin_pay, amount, keyCommit,
    beforeBurn: async () => {},
    network: { chainId: 4663, name: 'Robinhood Chain', rpcUrl: '', explorer: null, nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 } },
    onBroadcast: value => broadcast.push(value),
  };
  await assert.rejects(payWithCoin({ ...options, beforeBurn: async () => { throw new Error('Quote changed'); } }), /Quote changed/);
  assert.deepEqual(requests, []);
  await assert.rejects(payWithCoin(options), error => /declined/.test(describeWalletError(error)));
  assert.deepEqual(broadcast, []);
  declined = false;
  const result = await payWithCoin(options);
  assert.equal(result.hash, hash);
  assert.deepEqual(broadcast, [hash]);
  assert.equal(requests.length, 2);
  for (const request of requests) {
    assert.equal(request.to.toLowerCase(), publicCoinRail.coin_pay);
    const call = decodeFunctionData({ abi: COIN_PAY_ABI, data: request.data });
    assert.equal(call.functionName, 'pay');
    assert.deepEqual(call.args, [amount, keyCommit]);
  }
});

// ---- 04 Track my top-up: the open attempt and what may finish it ---------------------------------------------------
import { matchAttempt, newAttempt, parseAttempt, refHasTx, topupView, heldReason, pollDelay, attemptSlot, clearAllAttempts, WALLET_DELAY_MS } from '../lib/anonymo/topup-attempt.ts';

const COMMIT_A = '0x' + 'a1'.repeat(32);
const T0 = Date.parse('2026-11-22T12:00:00Z');
const hex64 = fc.stringMatching(/^[0-9a-f]{64}$/).map(h => '0x' + h);
const row = (o) => ({ ref: `rhc:0x${'e'.repeat(64)}:0`, chain: 'rhc', token: 'USDG', amount_usd: '25', from: '0x' + 'cd'.repeat(20), status: 'credited', created_at: new Date(T0 + 60_000).toISOString(), ...o });
const attempt = (o = {}) => ({ ...newAttempt({ keyCommit: COMMIT_A, rail: 'evm', chain: 'rhc', token: 'USDG', amount: '25', musd: 25_000_000, rows: [], now: T0, id: 'fixed' }), ...o });

void test('04 top-up: only the matching row finishes it; earlier, other-chain, other-token and other-amount rows never do', () => {
  assert.equal(matchAttempt(attempt(), []).kind, 'none');
  const exact = row({ ref: 'rhc:0x01:0' });
  assert.deepEqual(matchAttempt(attempt(), [exact]), { kind: 'found', row: exact, by: 'amount' });
  for (const other of [
    row({ amount_usd: '10' }), row({ token: 'USDC' }), row({ chain: 'base' }), row({ chain: 'coin', token: 'NYMO' }),
    row({ created_at: new Date(T0 - 10 * 60_000).toISOString() }),
  ]) assert.notEqual(matchAttempt(attempt(), [other]).kind, 'found', JSON.stringify(other));
  // A row that existed before the top-up started can never finish it, whatever its amount.
  assert.equal(matchAttempt(attempt({ knownRefs: [exact.ref] }), [exact]).kind, 'none');
  // Two equal deposits are ambiguous: the person chooses, nothing is assumed.
  assert.equal(matchAttempt(attempt(), [row({ ref: 'rhc:0x01:0' }), row({ ref: 'rhc:0x02:0' })]).kind, 'candidates');
  // A coin credit depends on the price at confirmation, so it never matches on amount alone.
  const coinRow = row({ chain: 'coin', token: 'NYMO', ref: 'coin:0x03:0' });
  assert.equal(matchAttempt(attempt({ rail: 'coin', token: 'NYMO' }), [coinRow]).kind, 'candidates');
  assert.deepEqual(matchAttempt(attempt({ rail: 'coin', token: 'NYMO', claimedRef: coinRow.ref }), [coinRow]), { kind: 'found', row: coinRow, by: 'you' });
});

void test('04 top-up: with a hash only that exact transaction counts (property)', () => {
  fc.assert(fc.property(hex64, hex64, fc.constantFrom('credited', 'held'), (mine, other, status) => {
    fc.pre(mine !== other && !other.includes(mine.slice(2)));
    const a = attempt({ hash: mine, submittedAt: T0 });
    const theirs = row({ ref: `rhc:${other}:0`, status });
    // Same chain, token and amount, after the start: still not ours, because the hash differs.
    if (matchAttempt(a, [theirs]).kind !== 'none') return false;
    const ours = row({ ref: `rhc:${mine.toUpperCase().replace('0X', '0x')}:3`, status, amount_usd: '1' });
    const m = matchAttempt(a, [theirs, ours]);
    return m.kind === 'found' && m.row === ours && m.by === 'hash';
  }));
  assert.equal(refHasTx('rhc:0xabc:0', '0xab'), false, 'a hash prefix is not a match');
});

void test('04 top-up: a matched row decides the stage; time alone only marks it delayed (property)', () => {
  fc.assert(fc.property(fc.integer({ min: 0, max: 48 * 3600_000 }), fc.boolean(), (elapsed, opened) => {
    const a = attempt({ walletOpenedAt: opened ? T0 : null });
    const v = topupView(a, [], T0 + elapsed);
    return v.stage === 'wallet' && v.row === null && v.delayed === elapsed > WALLET_DELAY_MS;
  }));
  const held = row({ ref: 'rhc:0x09:0', status: 'held', reason: 'sanctioned' });
  assert.equal(topupView(attempt(), [held], T0).stage, 'held');
  assert.equal(topupView(attempt({ hash: '0x' + '7'.repeat(64), submittedAt: T0 }), [], T0).stage, 'network');
  for (const reason of ['over_cap', 'sanctioned', 'screening_unavailable', 'market_depth', 'market_transition', 'over_invoice', null, 'new_reason'])
    assert.ok(heldReason(reason).length > 10);
  fc.assert(fc.property(fc.integer({ min: 0, max: 10 ** 9 }), ms => pollDelay(ms) >= 5_000 && pollDelay(ms) <= 30_000));
});

void test('04 top-up: storage holds one nonsecret attempt per key and rail, and rejects anything else', () => {
  const a = attempt();
  const raw = JSON.stringify(a);
  assert.deepEqual(parseAttempt(raw, COMMIT_A, 'evm'), a);
  assert.equal(parseAttempt(raw, '0x' + 'b2'.repeat(32), 'evm'), null, 'another key never sees it');
  assert.equal(parseAttempt(raw, COMMIT_A, 'coin'), null, 'another rail never sees it');
  for (const bad of ['', '{', 'null', JSON.stringify({ ...a, v: 2 }), JSON.stringify({ ...a, musd: 0 }), JSON.stringify({ ...a, hash: '0x12' }), JSON.stringify({ ...a, knownRefs: [1] })])
    assert.equal(parseAttempt(bad, COMMIT_A, 'evm'), null, bad);
  assert.ok(!/anm_(live|test)_/.test(raw), 'no key material');
  // NYMO: the typed amount is dollars; the quoted coin amount rides along for display, and only a plain number is kept.
  const c = newAttempt({ keyCommit: COMMIT_A, rail: 'coin', chain: 'rhc', token: 'NYMO', amount: '3', musd: 3_000_000, coinAmount: '256,323.87', rows: [], now: T0, id: 'coin' });
  assert.deepEqual(parseAttempt(JSON.stringify(c), COMMIT_A, 'coin'), c);
  assert.equal(parseAttempt(JSON.stringify({ ...c, coinAmount: '<b>9</b>' }), COMMIT_A, 'coin').coinAmount, undefined);
  assert.equal('coinAmount' in parseAttempt(raw, COMMIT_A, 'evm'), false);
  assert.equal(attemptSlot(COMMIT_A.toUpperCase().replace('0X', '0x'), 'evm'), attemptSlot(COMMIT_A, 'evm'));
  const map = new Map([[attemptSlot(COMMIT_A, 'evm'), raw], ['anonymo.key', 'kept']]);
  const storage = { get length() { return map.size; }, key: i => [...map.keys()][i] ?? null, removeItem: k => map.delete(k) };
  clearAllAttempts(storage);
  assert.deepEqual([...map.keys()], ['anonymo.key']);
});

void test('04 top-up: a touch-only phone in desktop mode still gets wallet apps', () => {
  const desktopMode = { userAgent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131 Safari/537.36', maxTouchPoints: 5 };
  assert.equal(isMobileBrowser(desktopMode, true), true);
  assert.equal(isMobileBrowser(desktopMode, false), false);
  assert.equal(isMobileBrowser({ userAgent: desktopMode.userAgent, maxTouchPoints: 0 }, true), false, 'a desktop with no touch stays a desktop');
});

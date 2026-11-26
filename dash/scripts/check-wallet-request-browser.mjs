// 08 What am I signing? on a phone: paste a request, read the permission, run the optional read-only check, and prove
// the page never asks the injected wallet for anything at all. Run against a local demo dashboard.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, devices } from 'playwright-core';
import { encodeFunctionData, maxUint256 } from 'viem';
import { ERC20_PERMIT_ABI } from '../lib/anonymo/wallet.ts';

const origin = new URL(process.env.WALLET_REVIEW_TEST_URL ?? process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
const RPC_HOST = 'rpc.mainnet.chain.robinhood.com';
const USDG = '0x5fc5360d0400a0fd4f2af552add042d716f1d168';
const SPENDER = '0x7777777777777777777777777777777777777777';
const ACCOUNT = '0xcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcdcd';
const approve = (amount) => encodeFunctionData({ abi: ERC20_PERMIT_ABI, functionName: 'approve', args: [SPENDER, amount] });
const request = (amount, extra = {}) => JSON.stringify({ from: ACCOUNT, to: USDG, chainId: 4663, data: approve(amount), ...extra });
const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH, channel: process.env.BROWSER_CHANNEL || undefined });

async function open(browser, { simulation = 'ok' } = {}) {
  const context = await browser.newContext({ ...devices['Pixel 7'], viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
  const rpc = [];
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin === origin.origin) return route.continue();
    if (url.hostname === RPC_HOST) {
      const body = route.request().postDataJSON();
      rpc.push(body);
      const reply = (result) => route.fulfill({ json: { jsonrpc: '2.0', id: body.id, result }, headers: { 'access-control-allow-origin': '*' } });
      if (body.method === 'eth_call') return reply('0x' + '0'.repeat(64));
      if (simulation === 'unsupported') return route.fulfill({ json: { jsonrpc: '2.0', id: body.id, error: { code: -32601, message: 'the method eth_simulateV1 does not exist/is not available' } }, headers: { 'access-control-allow-origin': '*' } });
      if (simulation === 'revert') return reply([{ calls: [{ status: '0x0', error: { message: 'execution reverted' } }] }]);
      return reply([{ calls: [{ status: '0x1', logs: [] }] }]);
    }
    return route.abort();
  });
  // A wallet that records every request. The page must never call it.
  await context.addInitScript(() => {
    window.walletCalls = [];
    window.ethereum = { request: async (args) => { window.walletCalls.push(args.method); throw new Error('test wallet: no calls expected'); } };
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12000);
  await page.goto(new URL('/dashboard/wallet-review?demo=1', origin).href);
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
  await page.getByRole('button', { name: 'I am 18 or older' }).tap();
  const main = page.getByRole('main');
  await main.getByRole('heading', { level: 1, name: 'What am I signing?' }).waitFor();
  return { context, page, main, rpc };
}

async function paste(main, text) {
  await main.getByLabel('Wallet request', { exact: true }).fill(text);
  await main.getByRole('button', { name: 'Review request' }).tap();
}

const facts = main => main.locator('.wr-facts');

test('08 an unlimited approval: the lasting permission, a zero immediate change, and no wallet call', async () => {
  const browser = await launch();
  try {
    const { page, main, rpc } = await open(browser);
    await paste(main, request(maxUint256));
    await main.getByText('This lets an app spend your USDG.').waitFor();
    assert.match(await facts(main).innerText(), /Unlimited USDG/);
    assert.match(await facts(main).innerText(), /Not a contract Anonymo can identify/);
    await main.getByText(/could move any amount of your USDG/).waitFor();
    // Full address on demand.
    await facts(main).getByRole('button', { name: 'Show full address' }).first().tap();
    await facts(main).getByText(/0x7777777777777777777777777777777777777777/i).waitFor();

    // Nothing is sent before the person sees what goes where.
    assert.equal(rpc.length, 0);
    await main.getByText(`A check sends these to ${RPC_HOST}`, { exact: false }).waitFor();
    await main.getByRole('button', { name: `Check with ${RPC_HOST}` }).tap();
    await main.locator('.wr-sim-result').getByText('0 USDG', { exact: true }).waitFor();
    await main.getByText(/This approval moves no tokens now/).waitFor();
    assert.deepEqual(rpc.map(r => r.method), ['eth_call', 'eth_simulateV1']);
    assert.equal(rpc[1].params[0].blockStateCalls[0].calls[0].data, approve(maxUint256));

    await main.getByRole('button', { name: 'Preview a 10 USDG limit' }).tap();
    await main.getByText(/Illustrative only/).waitFor();

    // Any change to the request makes everything above unreliable until it is reviewed again.
    await main.getByLabel('Wallet request', { exact: true }).fill(request(5n));
    await main.getByText('The request changed. Review it again before relying on anything below.').waitFor();
    assert.equal(await main.getByText(/This approval moves no tokens now/).count(), 0);
    await main.getByRole('button', { name: 'Review request' }).tap();
    assert.match(await facts(main).innerText(), /0\.000005 USDG/);
    assert.equal(await main.locator('.wr-sim-result').count(), 0, 'the old simulation does not carry over');

    await main.getByRole('button', { name: 'Return to wallet' }).tap();
    await main.getByText(/Nothing was signed here/).waitFor();
    assert.deepEqual(await page.evaluate(() => window.walletCalls), [], 'the review never calls the wallet');
    // Long addresses and amounts wrap: nothing in the page is wider than the phone.
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.querySelector('main').scrollWidth <= innerWidth));
  } finally {
    await browser.close();
  }
});

test('08 failure states: failed and unsupported simulation, signature requests, unknown chains, and a chat hand-off', async () => {
  const browser = await launch();
  try {
    const failed = await open(browser, { simulation: 'revert' });
    await paste(failed.main, request(25_000_000n));
    await failed.main.getByRole('button', { name: `Check with ${RPC_HOST}` }).tap();
    await failed.main.getByRole('alert').filter({ hasText: /would fail on chain/ }).waitFor();
    await failed.context.close();

    const { page, main } = await open(browser, { simulation: 'unsupported' });
    await paste(main, request(0n));
    await main.getByText(/This removes the address 0x7777…777777’s permission to spend your USDG/i).waitFor();
    await main.getByRole('button', { name: `Check with ${RPC_HOST}` }).tap();
    await main.getByRole('alert').filter({ hasText: /cannot simulate transactions/ }).waitFor();

    await paste(main, JSON.stringify({ method: 'eth_signTypedData_v4', params: [ACCOUNT, '{}'] }));
    await main.getByRole('alert').filter({ hasText: /Signatures are not supported here yet/ }).waitFor();

    await paste(main, request(1n, { chainId: 1, to: '0x1111111111111111111111111111111111111111' }));
    await main.getByText(/This request is for chain 1\./).waitFor();
    assert.match(await facts(main).innerText(), /1 units \(decimals unknown\)/);
    assert.match(await facts(main).innerText(), /Unverified token/);
    await main.getByText(/only available on the chains Anonymo supports/).waitFor();

    // Chat hands a request over in sessionStorage, never in the URL.
    await page.evaluate(r => sessionStorage.setItem('anonymo.wallet-review.draft', r), request(maxUint256));
    await page.reload();
    await main.getByText('This lets an app spend your USDG.').waitFor();
    assert.equal(new URL(page.url()).search, '?demo=1');
    assert.equal(await page.evaluate(() => sessionStorage.getItem('anonymo.wallet-review.draft')), null);
    assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
  } finally {
    await browser.close();
  }
});

test('08 from chat and Settings: a pasted request opens the review without reaching a model, and both pages are listed under Developers', async () => {
  const browser = await launch();
  try {
    const { page, main } = await open(browser);
    // Chat needs a key: create one the ordinary way, which opens chat.
    await page.goto(new URL('/dashboard/key', origin).href);
    await main.getByRole('button', { name: 'Create key', exact: true }).tap();
    await page.getByLabel('I have stored this key somewhere safe').tap();
    await main.getByRole('button', { name: 'Open chat', exact: true }).tap();
    await page.waitForURL('**/dashboard/chat*');
    const composer = page.locator('#composer');
    await page.waitForFunction(() => { const c = document.querySelector('#composer'); return c && !c.disabled; });
    await composer.fill(request(maxUint256));
    await page.getByRole('button', { name: 'Review this request' }).tap();
    await page.waitForURL('**/dashboard/wallet-review*');
    assert.equal(new URL(page.url()).search, '', 'the request never goes into the URL');
    await main.getByText('This lets an app spend your USDG.').waitFor();
    // The demo gateway keeps every chat turn it served: none was made from this request.
    const gens = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('anonymo.demo.state.v2') ?? '{"keys":{}}').keys).flatMap(k => k.gens ?? []));
    assert.equal(gens.length, 0);
    // Both destinations are listed on the Developers page, reached from Settings in the phone menu (on in demo mode).
    await page.getByRole('button', { name: 'More', exact: true }).tap();
    const menu = page.getByRole('dialog', { name: 'Workspace menu' });
    await menu.getByRole('link', { name: 'Settings', exact: true }).tap();
    await page.waitForURL('**/dashboard/settings');
    await page.getByRole('navigation', { name: 'Settings', exact: true }).getByRole('link', { name: 'Developers' }).tap();
    const tools = page.getByRole('navigation', { name: 'Developer tools' });
    await tools.getByRole('link', { name: /Pair a coding tool/ }).waitFor();
    await tools.getByRole('link', { name: /Wallet request/ }).waitFor();
    assert.deepEqual(await page.evaluate(() => window.walletCalls), []);
  } finally {
    await browser.close();
  }
});

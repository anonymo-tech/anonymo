// Use a local live-mode build with its API pointed at another loopback port. Every wallet call is simulated.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, devices } from 'playwright-core';
import { decodeFunctionData } from 'viem';
import { COIN_PAY_ABI } from '../lib/anonymo/wallet.ts';

const origin = new URL(process.env.NYMO_TEST_URL ?? 'http://127.0.0.1:49893');
const loopback = host => ['localhost', '127.0.0.1', '[::1]'].includes(host);
assert.ok(loopback(origin.hostname));
const commit = `0x${'ab'.repeat(32)}`;
const token = { symbol: 'NYMO', decimals: 18, address: '0xafe293638b064d7786c5326a071520358c3f3198' };
const receiver = `0x${'cd'.repeat(20)}`;
const raw = '11000000000000000001';
const coin = { chain: 'rhc', chain_id: 4663, coin_pay: receiver, token, confirmations: 12, price_usd: '1', max_usd_per_payment: '25' };

function installWallet() {
  window.testWallet = { calls: [], sent: [] };
  window.ethereum = { request: async ({ method, params }) => {
    const log = window.testWallet;
    log.calls.push(method);
    if (method === 'eth_requestAccounts') return [`0x${'12'.repeat(20)}`];
    if (method === 'eth_chainId') return '0x1237';
    if (method === 'eth_getCode') return '0x6000';
    if (method === 'eth_call') {
      const selector = params[0].data.slice(0, 10);
      if (selector === '0x70a08231') return `0x${'f'.repeat(64)}`;
      if (selector === '0xdd62ed3e') return `0x${'0'.repeat(64)}`;
      return '0x';
    }
    if (method === 'eth_sendTransaction') {
      log.sent.push(params[0]);
      return `0x${String(log.sent.length).padStart(64, '0')}`;
    }
    if (method === 'eth_getTransactionReceipt') return { status: '0x1', logs: [], transactionHash: params[0] };
    throw new Error(`Unexpected test wallet method ${method}`);
  } };
}

await test('Mobile NYMO checkout rechecks executable amounts through approval and burn', async t => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, channel: process.env.BROWSER_CHANNEL || undefined });
  t.after(() => browser.close());
  for (const scenario of ['stable', 'changed after approval', 'changed receiver', 'partial', 'unavailable', 'over limit']) await t.test(scenario, async () => {
    const page = await browser.newPage({ ...devices['Pixel 7'], serviceWorkers: 'block' });
    try {
      let quotes = 0;
      let contracts = 0;
      const newReceiver = `0x${'ef'.repeat(20)}`;
      page.setDefaultTimeout(15000);
      await page.route('**/*', async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin.origin) return route.continue();
        if (!loopback(url.hostname)) return route.abort();
        const json = (data, status = 200) => route.fulfill({ json: data, status, headers: { 'access-control-allow-origin': '*', 'cache-control': 'no-store' } });
        if (url.pathname === '/deposits/contracts') {
          contracts++;
          return json({ paused: false, chains: [], coin: { ...coin, coin_pay: scenario === 'changed receiver' && contracts > 1 ? newReceiver : receiver } });
        }
        if (url.pathname === '/deposits/coin/quote') {
          assert.equal(route.request().headers().authorization, undefined);
          assert.equal(url.searchParams.toString(), 'amount_usd=5');
          quotes++;
          if (scenario === 'unavailable') return json({ error: { type: 'coin_quote_unavailable', message: 'Unavailable' } }, 503);
          if (scenario === 'over limit') return json({ error: { type: 'coin_quote_limit', message: 'Limit' } }, 422);
          return json({ ...coin, coin_pay: scenario === 'changed receiver' && contracts > 1 ? newReceiver : receiver, amount_raw: scenario === 'changed after approval' && quotes >= 3 ? String(BigInt(raw) + 1n) : raw,
            estimated_credit_usd: scenario === 'partial' ? '4.75' : '5.000000', price_usd: '0.45', block: quotes });
        }
        return json({ data: [] });
      });
      await page.addInitScript(installWallet);
      await page.goto(new URL(`/pay?chain=rhc&token=NYMO&amount=5&k=${commit}`, origin).href);
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
      await page.getByRole('button', { name: 'I am 18 or older', exact: true }).tap();
      const main = page.getByRole('main');
      if (scenario === 'unavailable' || scenario === 'over limit') {
        await main.getByRole('status').filter({ hasText: scenario === 'unavailable' ? /quote is unavailable/ : /payment limit/ }).waitFor();
        assert.equal(await main.getByRole('checkbox').count(), 0);
        assert.deepEqual(await page.evaluate(() => window.testWallet.calls), []);
        return;
      }
      await main.getByText('11.000000000000000001 NYMO', { exact: true }).waitFor();
      if (scenario === 'partial') {
        await main.getByText(/covers \$4.75 of your \$5 request/).waitFor();
        assert.deepEqual(await page.evaluate(() => window.testWallet.calls), []);
        return;
      }
      const confirm = main.getByRole('button', { name: 'Confirm NYMO burn in wallet' });
      await main.getByRole('checkbox').check();
      await confirm.tap();
      if (scenario === 'changed receiver') {
        await main.getByRole('alert').filter({ hasText: `The payment contract changed to ${newReceiver}` }).waitFor();
        await main.getByRole('checkbox').waitFor();
        assert.equal(await confirm.isDisabled(), true);
        assert.deepEqual(await page.evaluate(() => window.testWallet.calls), []);
        return;
      }
      if (scenario === 'changed after approval') {
        await main.getByRole('alert').filter({ hasText: /allowance may already exist/ }).waitFor();
        await main.getByText('11.000000000000000002 NYMO', { exact: true }).waitFor();
        assert.equal(await confirm.isDisabled(), true);
      } else await main.getByText(/is mined/).waitFor();
      const sent = await page.evaluate(() => window.testWallet.sent);
      assert.equal(sent[0].to.toLowerCase(), token.address);
      assert.equal(sent[0].data.slice(0, 10), '0x095ea7b3');
      assert.equal(sent.length, scenario === 'stable' ? 2 : 1);
      if (sent.length === 2) {
        assert.equal(sent[1].to.toLowerCase(), receiver);
        const burn = decodeFunctionData({ abi: COIN_PAY_ABI, data: sent[1].data });
        assert.equal(burn.functionName, 'pay');
        assert.deepEqual(burn.args, [BigInt(raw), commit]);
      }
    } finally { await page.close(); }
  });
});

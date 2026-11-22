// Run against a local demo dashboard. Wallet app requests are intercepted before leaving the browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, devices } from 'playwright-core';

const origin = new URL(process.env.FUNDS_TEST_URL ?? process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
const handoffHost = 'link.metamask.io';
const launch = () => chromium.launch({
  executablePath: process.env.CHROMIUM_PATH,
  channel: process.env.BROWSER_CHANNEL || undefined,
});

async function newPhone(browser) {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 740 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin.origin) return route.continue();
    if (url.hostname === handoffHost && route.request().isNavigationRequest()) {
      return route.fulfill({ contentType: 'text/plain', body: 'Wallet handoff intercepted.' });
    }
    return route.abort();
  });
  return context;
}

async function setUpFromFunds(page) {
  page.setDefaultTimeout(12000);
  await page.goto(new URL('/dashboard/funds?demo=1', origin).href);
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
  await page.getByRole('button', { name: 'I am 18 or older' }).tap();
  await page.getByText(/Data comes from a mock gateway/).first().waitFor();
  const main = page.getByRole('main');
  await main.getByRole('heading', { level: 1, name: 'Add funds' }).waitFor();
  await main.getByRole('link', { name: 'Set up your key' }).tap();
  await page.waitForURL('**/dashboard/key*');
  await main.getByRole('button', { name: 'Create key', exact: true }).tap();
  await page.getByLabel('I have stored this key somewhere safe').tap();
  await main.getByRole('button', { name: 'Open chat', exact: true }).tap();
  await page.waitForURL('**/dashboard/chat*');
  await page.goto(new URL('/dashboard/funds', origin).href);
  await main.getByRole('heading', { level: 1, name: 'Add funds', exact: true }).waitFor();
  await main.getByRole('button', { name: 'Continue to wallet', exact: true }).or(main.getByRole('button', { name: 'Pay 10 USDG', exact: true })).waitFor();
  return main;
}

async function expectBalance(main, amount) {
  const balance = main.getByRole('region', { name: 'Available credit' });
  await balance.getByText(amount, { exact: true }).waitFor();
}

test('a phone user sets up Funds, opens a private payment link and sees confirmed demo credit', async () => {
  const browser = await launch();
  try {
    const context = await newPhone(browser);
    const page = await context.newPage();
    const main = await setUpFromFunds(page);
    await expectBalance(main, '$0.00');
    await main.getByRole('button', { name: 'Withdraw', exact: true }).tap();
    await main.getByRole('heading', { name: 'Withdraw funds', exact: true }).waitFor();
    await main.getByRole('button', { name: 'Account activity', exact: true }).tap();
    await main.getByText('Deposits and withdrawals will appear here.').waitFor();
    await main.getByRole('button', { name: 'Add funds', exact: true }).tap();

    const method = main.getByRole('combobox', { name: 'Payment method' });
    await main.getByRole('button', { name: 'NYMO', exact: true }).tap();
    await main.getByText('800 NYMO', { exact: true }).waitFor();
    await main.getByText('This preview uses a simulated coin payment.').waitFor();
    assert.equal(await main.getByRole('link', { name: /Review NYMO payment/ }).count(), 0);
    await method.selectOption('btc');
    await main.getByRole('button', { name: 'Get invoice' }).waitFor();
    await method.selectOption('evm');
    const amount = main.getByLabel('Amount (USD)', { exact: true });
    await main.getByRole('button', { name: '$25', exact: true }).tap();
    assert.equal(await amount.inputValue(), '25');
    await main.getByRole('button', { name: 'Custom', exact: true }).tap();
    await amount.fill('0');
    assert.equal(await main.getByRole('button', { name: 'Continue to wallet' }).isEnabled(), false);
    assert.equal(await main.getByRole('link', { name: 'MetaMask', exact: true }).count(), 0);
    await amount.fill('1.000125');
    await main.getByRole('button', { name: 'Continue to wallet' }).tap();
    await main.getByRole('button', { name: 'Edit amount' }).tap();
    assert.equal(await amount.inputValue(), '1.000125');
    await main.getByRole('button', { name: 'Continue to wallet' }).tap();

    // Check the navigation actually attempted by the touch gesture, including the stored key's public commitment.
    const commitment = await page.evaluate(() => {
      const demo = JSON.parse(localStorage.getItem('anonymo.demo.state.v2'));
      return Object.values(demo.keys)[0].keyCommit;
    });
    assert.match(commitment, /^0x[0-9a-f]{64}$/i);
    const walletLink = main.getByRole('link', { name: 'MetaMask', exact: true });
    const [handoff, popup] = await Promise.all([
      context.waitForEvent('request', req => req.isNavigationRequest() && new URL(req.url()).hostname === handoffHost),
      context.waitForEvent('page'),
      walletLink.tap(),
    ]);
    const url = new URL(handoff.url());
    assert.ok(!/anm_(?:test|live)_/.test(url.href), 'wallet link must omit API keys');
    assert.ok(url.protocol === 'https:' && !url.hash && !url.username && !url.password);
    assert.equal(url.pathname, '/dapp/' + origin.host + '/pay');
    assert.deepEqual([...url.searchParams.keys()].sort(), ['amount', 'chain', 'k', 'token']);
    assert.equal(url.searchParams.get('k'), commitment);
    assert.equal(url.searchParams.get('amount'), '1.000125');
    assert.equal(url.searchParams.get('chain'), 'rhc');
    assert.equal(url.searchParams.get('token'), 'USDG');
    const headers = await handoff.allHeaders();
    assert.ok(!headers.authorization && !headers.referer, 'wallet app receives no credential or referrer');
    await popup.getByText('Wallet handoff intercepted.', { exact: true }).waitFor();
    await popup.close();

    // The receiving wallet starts with an independent browser store. The handoff must work without a dashboard key.
    const walletContext = await newPhone(browser);
    const walletPage = await walletContext.newPage();
    const destination = new URL('/pay', origin);
    destination.search = url.search;
    await walletPage.goto(destination.href);
    await walletPage.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
    await walletPage.getByRole('button', { name: 'I am 18 or older' }).tap();
    const linkedAmount = walletPage.getByLabel('Amount (USD)', { exact: true });
    await linkedAmount.waitFor();
    assert.equal(await linkedAmount.inputValue(), '1.000125');
    await walletPage.getByText('USDG on Robinhood Chain', { exact: true }).waitFor();
    await walletContext.close();
    await page.bringToFront();

    // Opening a wallet is not a deposit. Only the mock gateway's confirmed deposit should change the balance.
    await main.getByRole('status').filter({ hasText: /Checking for a deposit/ }).waitFor();
    await expectBalance(main, '$0.00');
    await main.getByRole('button', { name: 'Send test USDG' }).tap();
    await expectBalance(main, '$10.00');
    await main.getByRole('status').filter({ hasText: /\$10\.00 credited from .*Robinhood Chain/ }).waitFor();
    await main.getByRole('button', { name: 'Account activity', exact: true }).tap();
    await main.getByRole('heading', { name: 'Recent deposits' }).waitFor();
    const credited = main.getByRole('listitem').filter({ hasText: 'USDG' });
    assert.match(await credited.innerText(), /10\.00/);
    await main.getByRole('button', { name: 'Add funds', exact: true }).tap();
    await main.getByRole('link', { name: /Continue to chat/ }).waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  } finally {
    await browser.close();
  }
});

test('the injected wallet waits for a tap and lets the user retry after declining', async () => {
  const browser = await launch();
  try {
    const context = await newPhone(browser);
    await context.addInitScript(() => {
      window.fundsWalletRequests = [];
      window.ethereum = {
        async request({ method }) {
          window.fundsWalletRequests.push({ method, gesture: navigator.userActivation.isActive });
          if (method === 'eth_requestAccounts') {
            throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
          }
          throw new Error('Unexpected test wallet request.');
        },
      };
    });
    const page = await context.newPage();
    const main = await setUpFromFunds(page);
    const pay = main.getByRole('button', { name: 'Pay 10 USDG', exact: true });
    await pay.waitFor();
    assert.deepEqual(await page.evaluate(() => window.fundsWalletRequests), []);
    assert.equal(await main.getByRole('link', { name: 'MetaMask', exact: true }).count(), 0);

    for (const attempt of [1, 2]) {
      await pay.tap();
      await main.getByRole('alert').filter({ hasText: /declined|cancelled/i }).waitFor();
      const requests = await page.evaluate(() => window.fundsWalletRequests);
      assert.deepEqual(requests, Array.from({ length: attempt }, () => ({ method: 'eth_requestAccounts', gesture: true })));
      assert.equal(await pay.isEnabled(), true);
      await expectBalance(main, '$0.00');
    }
  } finally {
    await browser.close();
  }
});

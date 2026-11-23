// 04 Track my top-up: one tap from Funds to the wallet, the return tab and the matching ledger row, on a phone.
// Run against a local demo dashboard. Wallet app requests are intercepted before leaving the browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, devices } from 'playwright-core';

const origin = new URL(process.env.FUNDS_TEST_URL ?? process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
const handoffHosts = new Set(['link.metamask.io', 'go.cb-w.com', 'link.trustwallet.com']);
// Android Chrome with "Desktop site" on: no "Mobile" in the user agent, but still a touch phone.
const DESKTOP_MODE_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH, channel: process.env.BROWSER_CHANNEL || undefined });

async function newPhone(browser, overrides = {}) {
  const context = await browser.newContext({
    ...devices['Pixel 7'],
    viewport: { width: 360, height: 740 },
    reducedMotion: 'reduce',
    serviceWorkers: 'block',
    ...overrides,
  });
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin.origin) return route.continue();
    if (handoffHosts.has(url.hostname) && route.request().isNavigationRequest()) {
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
  await main.getByRole('link', { name: 'Set up your key' }).tap();
  await page.waitForURL('**/dashboard/key*');
  await main.getByRole('button', { name: 'Create key', exact: true }).tap();
  await page.getByLabel('I have stored this key somewhere safe').tap();
  await main.getByRole('button', { name: 'Open chat', exact: true }).tap();
  await page.waitForURL('**/dashboard/chat*');
  await page.goto(new URL('/dashboard/funds', origin).href);
  await main.getByRole('heading', { level: 1, name: 'Add funds', exact: true }).waitFor();
  return main;
}

async function balanceIs(main, amount) {
  await main.getByRole('region', { name: 'Available credit' }).getByText(amount, { exact: true }).waitFor();
}

const tracker = main => main.getByRole('region', { name: 'Payment status' });

async function startHandoff(main, amount) {
  if (amount !== '10') {
    await main.getByRole('button', { name: 'Custom', exact: true }).tap();
    await main.getByLabel('Amount (USD)', { exact: true }).fill(amount);
  }
  await main.getByRole('button', { name: 'Continue to wallet', exact: true }).tap();
}

test('04 a phone in desktop mode gets a visible wallet chooser on the first tap', async () => {
  const browser = await launch();
  try {
    const context = await newPhone(browser, { userAgent: DESKTOP_MODE_UA });
    const page = await context.newPage();
    const main = await setUpFromFunds(page);
    await startHandoff(main, '10');
    // Something usable must be on screen without opening a folded section.
    await main.getByRole('link', { name: 'MetaMask', exact: true }).waitFor({ state: 'visible' });
    await main.getByRole('button', { name: 'Copy payment link' }).waitFor({ state: 'visible' });
    await tracker(main).getByText('Confirm in wallet').waitFor();
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  } finally {
    await browser.close();
  }
});

test('04 cancelling keeps the amount and currency, and a duplicate tap resumes the same top-up', async () => {
  const browser = await launch();
  try {
    const context = await newPhone(browser);
    const page = await context.newPage();
    const main = await setUpFromFunds(page);
    await startHandoff(main, '25');
    await tracker(main).getByText('25 USDG').waitFor();
    await main.getByRole('button', { name: 'Cancel top-up' }).tap();
    assert.equal(await main.getByLabel('Amount (USD)', { exact: true }).inputValue(), '25');
    await main.getByRole('button', { name: 'Continue to wallet', exact: true }).tap();
    const attempt = await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('anonymo.topup.')));
    assert.equal(attempt.length, 1, 'one open top-up per key and rail');
    // Opening a wallet twice must not start a second top-up.
    for (const _ of [1, 2]) {
      const [popup] = await Promise.all([context.waitForEvent('page'), main.getByRole('link', { name: 'MetaMask', exact: true }).tap()]);
      await popup.close();
    }
    const ids = await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith('anonymo.topup.')).map(([, v]) => JSON.parse(v).id));
    assert.equal(ids.length, 1);
    assert.equal(await tracker(main).count(), 1);
  } finally {
    await browser.close();
  }
});

test('04 a reload during confirmation keeps tracking, and only the matching credit finishes it', async () => {
  const browser = await launch();
  try {
    const context = await newPhone(browser);
    const page = await context.newPage();
    await page.clock.install();
    const main = await setUpFromFunds(page);
    await startHandoff(main, '25');
    const [popup] = await Promise.all([context.waitForEvent('page'), main.getByRole('link', { name: 'MetaMask', exact: true }).tap()]);
    await popup.close();

    await page.reload();
    await tracker(main).getByText('25 USDG').waitFor();
    await tracker(main).getByText('Confirm in wallet').waitFor();

    // An unrelated $10 deposit lands on the key: it adds credit but is not this top-up.
    await main.getByRole('button', { name: 'Send test USDG' }).tap();
    await balanceIs(main, '$10.00');
    assert.equal(await tracker(main).getByText(/added to your balance/).count(), 0, 'an unrelated deposit must not finish the top-up');
    // A different amount is offered for the person to claim, never taken on their behalf.
    await tracker(main).getByText(/A \$10\.00 USDG deposit reached this key/).waitFor();

    // The tracker keeps checking long past the old two-minute cutoff, and says plainly that nothing has arrived.
    await page.clock.fastForward('16:00');
    await tracker(main).getByText(/No payment has reached this key yet/).waitFor();
    assert.equal(await main.getByText('Automatic checks finished').count(), 0);

    await main.getByRole('button', { name: 'Confirm test payment' }).tap();
    await tracker(main).getByRole('listitem').filter({ hasText: /\$25\.00 added to your balance/ }).waitFor();
    await balanceIs(main, '$35.00');
    await main.getByRole('link', { name: /Continue to chat/ }).waitFor();

    // Coming back to the tab again changes nothing.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await balanceIs(main, '$35.00');
    const credited = await page.evaluate(() => {
      const demo = JSON.parse(localStorage.getItem('anonymo.demo.state.v2'));
      return Object.values(demo.keys)[0].deposits.filter(d => d.status === 'credited').map(d => d.amount_usd);
    });
    // One credit for the unrelated deposit, exactly one for this top-up: returning twice credited nothing twice.
    assert.deepEqual(credited.map(Number).sort((a, b) => a - b), [10, 25]);
  } finally {
    await browser.close();
  }
});

test('04 held credit says it is held and why, and never shows as available', async () => {
  const browser = await launch();
  try {
    const context = await newPhone(browser);
    const page = await context.newPage();
    const main = await setUpFromFunds(page);
    await startHandoff(main, '10');
    await main.getByRole('button', { name: 'Hold test payment' }).tap();
    const held = tracker(main).getByRole('listitem').filter({ hasText: 'Credit held' });
    await held.waitFor();
    assert.match(await held.innerText(), /not spendable yet\. The sending wallet needs a compliance check first\./);
    await tracker(main).getByRole('button', { name: 'Close' }).waitFor();
    await balanceIs(main, '$0.00');
    assert.equal(await tracker(main).getByText(/added to your balance/).count(), 0);
  } finally {
    await browser.close();
  }
});

// A fake injected wallet: enough EIP-1193 for the approve-then-deposit path. It records every request so the test can
// count debits. Options: start on the wrong chain and refuse the first switch, or hold no tokens.
function fakeWallet({ startChain = '0x1237', refuseFirstSwitch = false, balance = 10n ** 12n } = {}) {
  return ({ startChain, refuseFirstSwitch, balance }) => {
    const account = '0xabababababababababababababababababababab';
    const word = (n) => '0x' + BigInt(n).toString(16).padStart(64, '0');
    let chain = startChain;
    let switches = 0;
    let txs = 0;
    window.walletLog = [];
    window.ethereum = {
      async request({ method, params }) {
        window.walletLog.push({ method, data: params?.[0]?.data?.slice(0, 10) ?? null, to: params?.[0]?.to ?? null });
        switch (method) {
          case 'eth_requestAccounts': case 'eth_accounts': return [account];
          case 'eth_chainId': return chain;
          case 'wallet_switchEthereumChain':
            if (refuseFirstSwitch && switches++ === 0) throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
            chain = params[0].chainId;
            return null;
          case 'eth_getCode': return '0x6001';
          case 'eth_blockNumber': return '0x100';
          case 'eth_call': {
            const sel = params[0].data.slice(0, 10);
            if (sel === '0x70a08231') return word(BigInt(balance)); // balanceOf
            if (sel === '0xdd62ed3e') return word(0); // allowance: none, so approve first
            throw Object.assign(new Error('execution reverted'), { code: 3 }); // no permit support
          }
          case 'eth_sendTransaction': {
            txs += 1;
            return '0x' + String(txs).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, 'a');
          }
          case 'eth_getTransactionReceipt':
            return {
              status: '0x1', transactionHash: params[0], blockNumber: '0x100', blockHash: '0x' + 'b'.repeat(64), transactionIndex: '0x0',
              from: account, to: null, logs: [], logsBloom: '0x' + '0'.repeat(512), gasUsed: '0x1', cumulativeGasUsed: '0x1',
              effectiveGasPrice: '0x1', contractAddress: null, type: '0x2',
            };
          case 'eth_getTransactionByHash': return null;
          default: throw new Error('Unexpected test wallet request: ' + method);
        }
      },
    };
  };
}

async function walletPhone(browser, options) {
  const context = await newPhone(browser);
  await context.addInitScript(fakeWallet(options), { startChain: options?.startChain ?? '0x1237', refuseFirstSwitch: !!options?.refuseFirstSwitch, balance: String(options?.balance ?? 10n ** 12n) });
  return context;
}

test('04 in a wallet browser: wrong chain recovers, approval then deposit is one debit, and only its credit finishes it', async () => {
  const browser = await launch();
  try {
    const context = await walletPhone(browser, { startChain: '0x1', refuseFirstSwitch: true });
    const page = await context.newPage();
    const main = await setUpFromFunds(page);
    await main.getByRole('button', { name: 'Pay 10 USDG', exact: true }).tap();
    await main.getByRole('alert').filter({ hasText: /declined/ }).waitFor();
    await tracker(main).getByRole('listitem').filter({ hasText: 'Confirm in wallet' }).waitFor();
    assert.equal(await page.evaluate(() => window.walletLog.filter(r => r.method === 'eth_sendTransaction').length), 0, 'a refused switch sends nothing');

    await tracker(main).getByRole('button', { name: 'Pay 10 USDG' }).tap();
    await tracker(main).getByRole('listitem').filter({ hasText: /Waiting for \d+ confirmation/ }).waitFor();
    const sends = await page.evaluate(() => window.walletLog.filter(r => r.method === 'eth_sendTransaction').map(r => r.data));
    assert.deepEqual(sends.map(d => d === '0x095ea7b3' ? 'approve' : 'deposit'), ['approve', 'deposit'], 'one approval, then one deposit');
    const hash = await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith('anonymo.topup.'))?.[1]).then(v => JSON.parse(v).hash);
    assert.match(hash, /^0x[0-9a-f]{64}$/);

    // A reload while the network confirms keeps the same transaction.
    await page.reload();
    await tracker(main).getByRole('listitem').filter({ hasText: /Waiting for \d+ confirmation/ }).waitFor();
    await balanceIs(main, '$0.00');

    await main.getByRole('button', { name: 'Confirm test payment' }).tap();
    await tracker(main).getByRole('listitem').filter({ hasText: '$10.00 added to your balance.' }).waitFor();
    await balanceIs(main, '$10.00');
    const rows = await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('anonymo.demo.state.v2')).keys)[0].deposits);
    assert.equal(rows.length, 1, 'one matching credit');
    assert.ok(rows[0].ref.toLowerCase().includes(hash.toLowerCase()));
    // The log restarted with the reload: nothing was sent again after it.
    assert.equal(await page.evaluate(() => window.walletLog.filter(r => r.method === 'eth_sendTransaction').length), 0);
  } finally {
    await browser.close();
  }
});

test('04 an empty wallet is told why, nothing is sent, and the top-up can be retried or cancelled', async () => {
  const browser = await launch();
  try {
    const context = await walletPhone(browser, { balance: 0n });
    const page = await context.newPage();
    const main = await setUpFromFunds(page);
    await main.getByRole('button', { name: 'Pay 10 USDG', exact: true }).tap();
    await main.getByRole('alert').filter({ hasText: /This wallet holds 0 USDG; 10 is needed/ }).waitFor();
    assert.equal(await page.evaluate(() => window.walletLog.filter(r => r.method === 'eth_sendTransaction').length), 0);
    assert.equal(await tracker(main).getByRole('button', { name: 'Pay 10 USDG' }).isEnabled(), true);
    await main.getByRole('button', { name: 'Cancel top-up' }).tap();
    await main.getByRole('button', { name: 'Custom', exact: true }).waitFor();
    assert.equal(await tracker(main).count(), 0);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('anonymo.topup.')).length), 0);
  } finally {
    await browser.close();
  }
});

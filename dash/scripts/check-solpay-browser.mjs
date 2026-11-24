// Run against local live-mode dashboards with NEXT_PUBLIC_ANONYMO_API=https://api.solpay.example.
// The default ports are 5180 with solpay enabled and 5181 with it disabled. No wallet or gateway is needed.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium, devices } from 'playwright-core';
import { encodeQr, qrPath } from '../lib/anonymo/qr.ts';
import { solanaPayUrl } from '../lib/anonymo/solana-pay.ts';

const on = new URL(process.env.SOLPAY_TEST_URL ?? 'http://127.0.0.1:5180');
const off = new URL(process.env.SOLPAY_OFF_TEST_URL ?? 'http://127.0.0.1:5181');
for (const origin of [on, off]) assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));

const api = 'https://api.solpay.example';
const solana = {
  cluster: 'mainnet-beta',
  recipient_wallet: 'US517G5965aydkZ46HS38QLi7UQiSojurfbQfKCELFx',
  reference: 'cGfHiC6Kgg3FpFZvgwGcswsCRtp4aBP2fzuXRQPizuN',
  tokens: [
    { symbol: 'USDT', mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', token_account: 'MnVorf8KKPzHgQpa6exLfKpam8YkTn8WpeUuuFwgsob' }, // gitleaks:allow (public Solana fixture addresses)
    { symbol: 'USDC', mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', token_account: '7EJSueeCjseYzghxU2XhcGEUn7RJDh43Z2dL6dvGy9mw' }, // gitleaks:allow (public Solana fixture addresses)
  ],
  how: 'Include the reference as a read-only key.',
};
const [usdt, usdc] = solana.tokens;
const launch = () => chromium.launch({ executablePath: process.env.CHROMIUM_PATH, channel: process.env.BROWSER_CHANNEL || undefined });

async function openFunds(browser, origin, phone = false) {
  const context = await browser.newContext(phone ? devices['Pixel 7'] : {});
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const rows = [];
  await context.addInitScript(() => sessionStorage.setItem('anonymo.key', 'anm_test_fixture_only_value'));
  await context.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === origin.origin) return route.continue();
    if (url.origin !== api) return route.abort();
    const amount = rows[0]?.amount_usd ?? '0';
    const body = {
      '/balance': { balance_usd: amount, available_usd: amount, held_usd: '0', withdraw_to: [] },
      '/deposits': { data: rows, instructions: { paused: false, solana, stablecoins_credit: '1:1 USD' } },
    }[url.pathname] ?? { data: [] };
    return route.fulfill({
      status: 200, json: body, headers: {
        'access-control-allow-origin': origin.origin,
        'access-control-allow-headers': 'authorization, content-type',
      },
    });
  });
  await page.goto(new URL('/dashboard/funds', origin).href);
  const adult = page.getByRole('button', { name: 'I am 18 or older' });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
  await adult.click();
  return { page, rows, context };
}

test('desktop offers the exact payment QR and tracks the matching credit after reload', async () => {
  const browser = await launch();
  try {
    const { page, rows } = await openFunds(browser, on);
    const token = page.getByRole('combobox', { name: 'Token on Solana' });
    const pay = page.getByRole('button', { name: 'Pay with a Solana wallet' });
    await token.waitFor();
    assert.equal(await token.inputValue(), usdc.mint);
    assert.equal(await page.getByText('USDC token account', { exact: true }).isVisible(), false);
    await page.getByText('Pay by hand instead', { exact: true }).click();
    await page.getByText('USDC token account', { exact: true }).waitFor();
    await page.getByText('Pay by hand instead', { exact: true }).click();
    await page.getByRole('button', { name: '$25', exact: true }).click();
    assert.equal(await page.getByLabel('Amount (USD)').inputValue(), '25');
    await page.getByRole('button', { name: 'Custom', exact: true }).click();
    await page.getByLabel('Amount (USD)').fill('0');
    assert.equal(await pay.isEnabled(), false);
    await page.getByLabel('Amount (USD)').fill('25.125');
    await token.selectOption(usdt.mint);
    await pay.click();
    const qr = page.getByLabel('Solana Pay QR code');
    await qr.waitFor();
    assert.equal(await qr.locator('path').getAttribute('d'), qrPath(encodeQr(solanaPayUrl(solana, usdt.mint, '25.125'))));
    await page.reload();
    await qr.waitFor();
    rows.unshift({
      ref: 'solana:sample-signature:2', chain: 'solana', token: 'USDT', amount_usd: '25.125',
      created_at: new Date().toISOString(), status: 'credited',
    });
    await page.getByText('$25.12 added to your balance.', { exact: true }).waitFor();
    assert.equal(await qr.count(), 0);
  } finally {
    await browser.close();
  }
});

test('mobile offers the Solana Pay link alongside the existing tracker', async () => {
  const browser = await launch();
  try {
    const { page } = await openFunds(browser, on, true);
    const href = solanaPayUrl(solana, usdc.mint, '10');
    await page.getByRole('button', { name: 'Pay with a Solana wallet' }).tap();
    const link = page.getByRole('link', { name: 'Open wallet' });
    assert.equal(await link.getAttribute('href'), href);
    await page.getByText('Confirm in wallet', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('Solana Pay QR code').count(), 0);
  } finally {
    await browser.close();
  }
});

test('with the switch off, the Solana rail shows the original manual details', async () => {
  const browser = await launch();
  try {
    const { page } = await openFunds(browser, off);
    await page.getByText('USDC token account', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Copy reference' }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Pay with a Solana wallet' }).count(), 0);
    assert.equal(await page.getByText('Pay by hand instead', { exact: true }).count(), 0);
  } finally {
    await browser.close();
  }
});

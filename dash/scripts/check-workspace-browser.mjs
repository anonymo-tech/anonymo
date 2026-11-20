// Run against a local dash server. Every key, payment and chat in this test uses the in-browser demo gateway.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const origin = new URL(
  process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173',
);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));

test('a visitor can connect a key, fund it, chat and inspect the receipt from mobile navigation', async () => {
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || undefined,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(20000);
    // Do not allow this workflow to make requests to an external gateway.
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === origin.origin || url.protocol === 'data:'
        ? route.continue()
        : route.abort();
    });
    await page.goto(new URL('/dashboard?demo=1', origin).href);
    const adult = page.getByRole('button', { name: 'I am 18 or older' });
    await adult.waitFor();
    for (let i = 0; i < 3 && (await adult.isVisible()); i++) {
      await adult.click();
      await adult.waitFor({ state: 'hidden', timeout: 800 }).catch(() => {});
    }
    await page.getByText('Demo mode.', { exact: true }).waitFor();
    await page
      .getByRole('heading', { name: 'Your private workspace' })
      .waitFor();
    const quick = page.getByRole('navigation', { name: 'Quick navigation' });
    const more = quick.getByRole('button', { name: 'More' });
    await more.click();
    const menu = page.getByRole('dialog', { name: 'Workspace menu' });
    await menu.getByRole('link', { name: 'Usage & limits' }).waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.ok(await more.evaluate((el) => document.activeElement === el));
    await more.click();
    await menu.getByRole('link', { name: 'API key' }).click();

    await page.getByRole('button', { name: 'Use an existing key' }).click();
    await page.getByLabel('API key', { exact: true }).fill('invalid');
    await page.getByRole('button', { name: 'Use this key' }).click();
    await page.getByRole('alert').waitFor();
    await page
      .getByRole('button', { name: 'Create a key', exact: true })
      .click();
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    const next = page.getByRole('button', { name: 'View funding options' });
    await next.waitFor();
    assert.equal(await next.isDisabled(), true);
    await page.getByLabel('I have stored this key somewhere safe').check();
    await next.click();
    await page.getByRole('heading', { name: 'Deposit', exact: true }).waitFor();
    await quick.getByRole('link', { name: 'Overview' }).click();
    await page.getByRole('heading', { name: 'Fund your key' }).waitFor();
    await page.getByRole('link', { name: 'View funding options' }).click();
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await page.getByRole('heading', { name: 'Withdraw to source' }).waitFor();
    await page.getByRole('button', { name: 'Activity', exact: true }).click();
    await page
      .getByText('Deposits and withdrawals will appear here.')
      .waitFor();
    await page.getByRole('button', { name: 'Deposit', exact: true }).click();
    await page.getByRole('button', { name: 'Send test USDG' }).click();
    await page.getByRole('link', { name: 'Continue to chat' }).waitFor();
    await quick.getByRole('link', { name: 'Overview' }).click();
    await page
      .getByRole('heading', { name: 'Start your first chat' })
      .waitFor();
    await page.getByRole('link', { name: 'Open chat', exact: true }).click();
    await page.locator('#composer').fill('Give me a short greeting.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.thread[aria-busy="false"] .answer-body').waitFor();
    await quick.getByRole('link', { name: 'Overview' }).click();
    await page.getByRole('heading', { name: 'Back to chat' }).waitFor();
    await page.locator('main table a').first().click();
    await page.getByRole('heading', { name: 'Inclusion proof' }).waitFor();

    await page.setViewportSize({ width: 1440, height: 900 });
    const nav = page.getByRole('navigation', {
      name: 'Workspace',
      exact: true,
    });
    assert.equal(
      await nav
        .getByRole('link', { name: 'Receipts' })
        .getAttribute('aria-current'),
      'page',
    );
    await nav.getByRole('link', { name: 'Image studio' }).click();
    const options = page.locator('details.studio-options');
    await options.locator('summary').click();
    await options.getByRole('button', { name: '2', exact: true }).click();
    await options.locator('summary').click();
    assert.match(await options.locator('summary').innerText(), /2 images/);
    await page.getByRole('button', { name: /Make 2 images/ }).waitFor();
    await nav.getByRole('link', { name: 'Receipts' }).click();
    await page.getByText('Where to find the ID', { exact: true }).click();
    await page.locator('details code').first().waitFor();
    await nav.getByRole('link', { name: 'API key' }).click();
    await page.getByRole('heading', { name: 'Key on this device' }).waitFor();
  } finally {
    await browser.close();
  }
});

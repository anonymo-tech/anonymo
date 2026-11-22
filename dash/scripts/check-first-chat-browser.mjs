// Isolated dashboard fixture. All off-origin requests are blocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const origin = new URL(process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));

test('a new phone user chats, funds at the second message, and returns to send their draft', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.BROWSER_CHANNEL || undefined,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
    await page.goto(new URL('/dashboard/key?demo=1', origin).href);
    const confirmAge = page.getByRole('button', { name: 'I am 18 or older' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
    await confirmAge.tap();
    await confirmAge.waitFor({ state: 'hidden' });
    const main = page.getByRole('main');
    await main.getByRole('button', { name: 'Create key', exact: true }).tap();
    await page.getByLabel('I have stored this key somewhere safe').check();
    await main.getByRole('button', { name: 'Open chat', exact: true }).tap();
    await page.waitForURL('**/dashboard/chat');
    const message = page.locator('#composer');
    const send = page.getByRole('button', { name: 'Send', exact: true });
    await message.fill('Say hello in one sentence.');
    await send.tap();
    await main.locator('.thread[aria-busy="false"] .answer-body').waitFor();
    assert.equal(await main.getByText('Add funds to continue this chat.').count(), 0);
    await page.reload();
    const next = 'Tell me another greeting.';
    await message.fill(next);
    await send.tap();
    await main.getByText('Add funds to continue this chat.').waitFor();
    await main.getByRole('link', { name: 'Add funds', exact: true }).tap();
    await page.waitForURL(url => url.pathname === '/dashboard/funds' && url.searchParams.get('returnTo') === '/dashboard/chat');
    await main.getByRole('button', { name: 'Send test USDG' }).tap();
    await main.getByRole('region', { name: 'Available credit' }).getByText('$10.00', { exact: true }).waitFor();
    await main.getByRole('link', { name: /back to chat|return to chat|continue to chat/i }).tap();
    await page.waitForURL('**/dashboard/chat');
    assert.equal(await message.inputValue(), next);
    await send.tap();
    const retried = main.locator('.thread[aria-busy="false"] article.turn').filter({ has: page.getByText(next, { exact: true }) }).last();
    await retried.locator('.answer-body').waitFor();
    assert.ok((await retried.locator('.answer-body').innerText()).trim());
    await retried.getByRole('link', { name: /receipt/i }).waitFor();
  } finally {
    await browser.close();
  }
});

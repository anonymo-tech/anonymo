// Isolated dashboard fixture. All off-origin requests are blocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const origin = new URL(process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));

test('a new phone user writes first, funds at Send, and returns to send their draft', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || undefined,
    channel: process.env.BROWSER_CHANNEL || undefined,
  });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
    await page.goto(new URL('/dashboard/chat?demo=1', origin).href);
    const confirmAge = page.getByRole('button', { name: 'I am 18 or older' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
    await confirmAge.tap();
    await confirmAge.waitFor({ state: 'hidden' });
    const main = page.getByRole('main');
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const sheet = page.getByRole('region', { name: 'Set up chat' });
    const next = 'Say hello in one sentence.';
    const slot = 'anonymo.chat-setup-draft';
    await main.getByRole('button', { name: 'Give me three ideas for a short mystery story.' }).tap();
    assert.match(await message.inputValue(), /mystery story/);
    await message.fill(next);
    assert.equal(await page.evaluate((slot) => sessionStorage.getItem(slot), slot), null);
    await send.tap();
    await sheet.getByText('Your message is ready.', { exact: false }).waitFor();
    assert.equal(await main.locator('.turn').count(), 0);
    assert.equal(await page.evaluate((slot) => JSON.parse(sessionStorage.getItem(slot)).text, slot), next);
    assert.equal(await page.evaluate((text) => Object.values(localStorage).some(value => value.includes(text)), next), false);
    await sheet.getByRole('button', { name: 'Not now' }).tap();
    await sheet.waitFor({ state: 'hidden' });
    assert.equal(await message.inputValue(), next);
    await message.fill('');
    assert.equal(await page.evaluate((slot) => sessionStorage.getItem(slot), slot), null);
    await message.fill(next);
    await send.tap();
    await sheet.getByRole('link', { name: 'Create a free key' }).tap();
    await page.waitForURL(url => url.pathname === '/dashboard/key' && url.searchParams.get('returnTo') === '/dashboard/chat');
    await main.getByRole('button', { name: 'Create key', exact: true }).tap();
    await page.getByLabel('I have stored this key somewhere safe').check();
    await main.getByRole('button', { name: 'Open chat', exact: true }).tap();
    await page.waitForURL('**/dashboard/chat');
    const waiting = page.getByText('Your message is waiting. Press send.', { exact: true });
    await waiting.waitFor();
    assert.equal(await message.inputValue(), next);
    await page.getByRole('link', { name: 'Balance $0.00' }).waitFor();
    await send.tap();
    await sheet.getByText('Add a little balance to send this.').waitFor();
    assert.equal(await main.locator('.turn').count(), 0);
    await sheet.getByRole('link', { name: 'Add funds', exact: true }).tap();
    await page.waitForURL(url => url.pathname === '/dashboard/funds' && url.searchParams.get('returnTo') === '/dashboard/chat');
    await page.reload();
    await main.getByRole('button', { name: 'Send test USDG' }).tap();
    await main.getByRole('region', { name: 'Available credit' }).getByText('$10.00', { exact: true }).waitFor();
    await main.getByRole('link', { name: /back to chat|return to chat|continue to chat/i }).tap();
    await page.waitForURL('**/dashboard/chat');
    await waiting.waitFor();
    assert.equal(await message.inputValue(), next);
    await page.waitForFunction(() => document.activeElement?.id === 'composer');
    assert.equal(await page.evaluate((slot) => sessionStorage.getItem(slot), slot), null);
    assert.equal(await main.locator('.turn').count(), 0);
    await send.tap();
    const answer = main.locator('.thread[aria-busy="false"] article.turn').filter({ has: page.getByText(next, { exact: true }) });
    await answer.locator('.answer-body').waitFor();
    assert.ok((await answer.locator('.answer-body').innerText()).trim());
    await answer.getByRole('link', { name: /receipt/i }).waitFor();
  } finally {
    await browser.close();
  }
});

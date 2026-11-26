// Isolated dashboard fixture. All off-origin requests are blocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const origin = new URL(process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));

test('a guest chats for free, uses the allowance, then funds a key and sends the saved draft', async () => {
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
    const welcome = page.getByRole('dialog', { name: 'Choose your chat model' });
    await welcome.getByRole('listitem').first().waitFor();
    await welcome.getByRole('button', { name: 'Close model chooser' }).tap();
    const main = page.getByRole('main');
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    const send = page.getByRole('button', { name: 'Send', exact: true });
    const sheet = page.getByRole('region', { name: 'Set up chat' });
    const next = 'Say hello in one sentence.';
    const slot = 'anonymo.chat-setup-draft';
    await page.getByText(/^Free today: 10 left/).waitFor();
    for (let left = 9; left >= 0; left--) {
      await message.fill('Tell me about a quiet morning.');
      await send.tap();
      await page.getByText(new RegExp(`^Free today: ${left} left`)).waitFor();
      await main.locator('.thread[aria-busy="false"] article.turn').nth(9 - left).getByRole('link', { name: /receipt/i }).waitFor();
    }
    await page.reload();
    await page.getByText('Free today: 0 left', { exact: true }).waitFor();
    await message.fill(next);
    await send.tap();
    const waiting = page.getByText('Your message is waiting. Press send.', { exact: true });
    await main.getByText(next, { exact: true }).waitFor();
    const welcomeReply = main.locator('.thread[aria-busy="false"] article.turn');
    await welcomeReply.getByRole('button', { name: 'Reply details' }).tap();
    await welcomeReply.getByRole('link', { name: /receipt/i }).waitFor();
    await message.fill(next);
    await send.tap();
    await sheet.getByText('Add a little balance to send this.').waitFor();
    assert.equal(await main.locator('.turn').count(), 1);
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
    await answer.getByRole('link', { name: /receipt/i }).first().waitFor();
  } finally {
    await browser.close();
  }
});

test('Open app creates a tab-only key on model selection and sponsors one direct text reply', async t => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
  await page.addInitScript(() => {
    localStorage.setItem('anonymo.chat-model-welcome.v1', 'true');
    localStorage.setItem('anonymo.model.v1', JSON.stringify('anonymo-1'));
  });
  await page.goto(origin.href);
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
  await page.getByRole('button', { name: 'I am 18 or older' }).click();
  await page.getByRole('link', { name: 'Open app', exact: true }).click();
  const chooser = page.getByRole('dialog', { name: 'Choose your chat model' });
  await chooser.getByRole('listitem').first().getByRole('button').click();
  await page.getByText('Your first message is on us.', { exact: true }).waitFor();
  assert.ok(await page.evaluate(() => !!sessionStorage.getItem('anonymo.demo.key') && !localStorage.getItem('anonymo.demo.key')));
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Explain a rainbow.');
  await message.press('Enter');
  const reply = page.locator('.thread[aria-busy="false"] article.turn').first();
  await reply.getByRole('button', { name: 'Copy your key', exact: true }).waitFor();
  assert.equal(await page.locator('.dock-composer').getByRole('button', { name: 'Copy your key' }).count(), 0);
  const byline = reply.locator('.reply-byline');
  const modelName = (await byline.innerText()).trim();
  assert.ok(modelName);
  await page.locator('.mode-bar').getByRole('button', { name: `Choose model: ${modelName}`, exact: true }).waitFor();
  assert.equal(await byline.locator('.model-logo').count(), 1);
  assert.equal(await page.getByText('Memory suggestions are unavailable for this reply.').count(), 0);
  const toggle = reply.getByRole('button', { name: 'Reply details' });
  const receipt = reply.getByRole('link', { name: 'Signed receipt', includeHidden: true });
  assert.equal(await receipt.isVisible(), false);
  await toggle.focus();
  await page.keyboard.press('Enter');
  await receipt.waitFor();
  await toggle.click();
  assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
  assert.ok((await reply.locator('.answer-body').innerText()).trim());
  assert.equal(await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('anonymo.demo.state.v2') ?? 'null');
    return state?.receipts ? Object.values(state.receipts)[0]?.view.receipt.cost : undefined;
  }), '0');
  await page.reload();
  await message.fill('Another question.');
  await message.press('Enter');
  await page.getByRole('region', { name: 'Set up chat' }).getByRole('link', { name: 'Add funds' }).waitFor();
});

test('a returning funded key gets the fresh offer once, reusing the key and keeping its balance', async t => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL, executablePath: process.env.CHROMIUM_PATH });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
  await page.addInitScript(() => localStorage.setItem('anonymo.adult.v1', 'true'));
  await page.goto(new URL('/dashboard/key?demo=1', origin).href);
  await page.getByRole('button', { name: 'Create key', exact: true }).click();
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Open chat', exact: true }).click();
  await page.waitForURL('**/dashboard/chat');
  // Recreate a pre-campaign key. Older demo records have no campaign field.
  await page.evaluate(() => {
    const slot = 'anonymo.demo.state.v2';
    const state = JSON.parse(localStorage.getItem(slot));
    const account = Object.values(state.keys)[0];
    account.firstChatAvailable = false;
    delete account.firstChatCampaign;
    account.balance = 5_000_000;
    localStorage.setItem(slot, JSON.stringify(state));
    localStorage.setItem('anonymo.chat-model-welcome.v1', 'true');
  });
  await page.reload();
  const offer = page.getByText('Your first message is on us.', { exact: true });
  await offer.waitFor();
  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  await message.fill('Tell me a fun fact.');
  await message.press('Enter');
  await page.getByRole('button', { name: 'Reply details' }).waitFor();
  const check = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('anonymo.demo.state.v2'));
    return [Object.keys(state.keys).length, Object.values(state.keys)[0].balance, Object.values(state.receipts)[0].view.receipt.cost];
  });
  assert.deepEqual(check, [1, 5_000_000, '0']);
  await page.reload();
  await message.fill('One more fact.');
  await message.press('Enter');
  await page.getByRole('link', { name: 'Signed receipt' }).waitFor();
  assert.equal(await offer.count(), 0);
  assert.ok(await page.evaluate(() => Object.values(JSON.parse(localStorage.getItem('anonymo.demo.state.v2')).keys)[0].balance < 5_000_000));
});

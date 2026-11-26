// Local demo only. Off-origin traffic is blocked.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { useUpDemoFreeChat } from './free-chat-fixture.mjs';

const origin = new URL(process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));

test('chat modes stay opt-in per message, survive setup, and put results in the thread', async (t) => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH, channel: process.env.BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
  await page.addInitScript(() => localStorage.setItem('anonymo.adult.v1', 'true'));
  await useUpDemoFreeChat(page);
  await page.goto(new URL('/dashboard/chat?demo=1', origin).href);

  const message = page.getByRole('textbox', { name: 'Message', exact: true });
  const makePicture = page.getByRole('button', { name: 'Make picture', exact: true });
  const picture = 'Draw a fox in the rain.';
  const plus = page.getByRole('button', { name: 'Modes and tools' });
  const sheet = page.getByRole('region', { name: 'Set up chat' });
  const turns = page.locator('article.turn');
  await message.fill(picture);
  const suggestion = page.getByRole('button', { name: 'Picture? Tab' });
  await suggestion.waitFor();
  assert.equal(await page.locator('.mode-mirror mark').textContent(), 'Draw');
  assert.equal(await makePicture.count(), 0);
  await message.press('Tab');
  await makePicture.waitFor();
  assert.equal(await message.inputValue(), picture);
  await page.getByLabel('How many', { exact: true }).selectOption('2');
  await makePicture.tap();
  await sheet.getByRole('link', { name: 'Create a free key' }).tap();
  await page.getByRole('button', { name: 'Create key', exact: true }).tap();
  await page.getByLabel('I have stored this key somewhere safe').check();
  await page.getByRole('button', { name: 'Open chat', exact: true }).tap();
  await makePicture.waitFor();
  assert.equal(await message.inputValue(), picture);
  assert.equal(await page.getByLabel('How many', { exact: true }).inputValue(), '2');
  await makePicture.tap();
  await sheet.getByRole('link', { name: 'Add funds', exact: true }).tap();
  await page.getByRole('button', { name: 'Send test USDG' }).tap();
  await page.getByRole('region', { name: 'Available credit' }).getByText('$10.00', { exact: true }).waitFor();
  await page.getByRole('link', { name: /back to chat|return to chat|continue to chat/i }).tap();
  await makePicture.waitFor();
  assert.equal(await turns.count(), 0);
  await makePicture.tap();

  await turns.first().getByRole('button', { name: 'Change and redo' }).waitFor();
  assert.equal(await turns.first().locator('.mode-pictures img').count(), 2);
  await turns.first().getByRole('button', { name: 'Change and redo' }).tap();
  assert.equal(await message.inputValue(), picture);
  assert.equal(await page.getByLabel('How many', { exact: true }).inputValue(), '2');
  await page.getByRole('button', { name: 'More options' }).tap();
  await page.waitForURL('**/dashboard/images');
  await page.waitForFunction((draft) => document.querySelector('.studio-prompt')?.value === draft, picture);
  assert.equal(new URL(page.url()).search, '');

  await page.goBack();
  await message.waitFor();
  await page.setViewportSize({ width: 1200, height: 820 });
  await plus.click();
  await page.getByRole('button', { name: 'Ask 3 AIs', exact: true }).click();
  await message.fill('Compare the benefits of two kinds of gardens.');
  await page.getByLabel('Answers', { exact: true }).selectOption('merged');
  await page.getByRole('button', { name: 'Ask 3', exact: true }).click();
  const comparison = turns.filter({ hasText: 'Compare the benefits of two kinds of gardens.' });
  await comparison.getByRole('button', { name: 'Change and redo' }).waitFor();
  assert.equal(await comparison.locator('.mode-columns .mode-column').count(), 3);
  await comparison.getByText('Merged', { exact: true }).waitFor();
  assert.equal(await comparison.getByRole('link', { name: 'Signed receipt' }).count(), 4);

  await plus.click();
  await page.getByRole('button', { name: 'Talk', exact: true }).click();
  await page.getByLabel('Replies', { exact: true }).selectOption('text');
  const mic = page.getByRole('button', { name: 'Hold to talk' });
  await mic.focus();
  await page.keyboard.down('Space');
  await page.getByRole('meter', { name: 'Microphone level' }).waitFor();
  await page.keyboard.up('Space');
  await page.waitForFunction(() => document.querySelector('#composer')?.value.includes('quiet morning beside the ocean'));
  assert.equal(await turns.count(), 2);
  await page.getByRole('button', { name: 'Send', exact: true }).click();
  await page.waitForFunction(() => document.querySelectorAll('article.turn').length === 3);
  await turns.last().getByRole('button', { name: 'Change and redo' }).waitFor();
  assert.match(await turns.last().locator('.mode-result-meta').innerText(), /Text only · \$/);
});

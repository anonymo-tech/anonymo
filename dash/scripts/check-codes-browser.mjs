// Run against a local demo dashboard.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { DEMO_CODE } from '../lib/anonymo/codes.ts';
import { useUpDemoFreeChat } from './free-chat-fixture.mjs';

const origin = new URL(process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));

async function openPage(browser, path) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.route('**/*', (route) => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
  await page.goto(new URL(path, origin).href);
  // The gate focuses its button once the page is interactive; a tap before that does nothing.
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
  await page.getByRole('button', { name: 'I am 18 or older' }).tap();
  await page.locator('.age-gate').waitFor({ state: 'hidden' });
  return page;
}

test('a voucher from chat setup makes a funded key and restores the draft after key save', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await openPage(browser, '/dashboard/chat');
    // A picture needs prepaid credit even when ordinary text chat has an introductory reply.
    await useUpDemoFreeChat(page);
    await page.reload();
    await page.getByText('Free today: 0 left', { exact: true }).waitFor();
    const message = page.getByRole('textbox', { name: 'Message', exact: true });
    const draft = 'Tell me about a lighthouse.';
    await message.fill(draft);
    await page.getByRole('button', { name: 'Modes and tools' }).tap();
    await page.getByRole('button', { name: 'Picture', exact: true }).tap();
    await page.getByRole('button', { name: 'Make picture', exact: true }).tap();
    await page.getByRole('link', { name: 'Have a code?' }).tap();
    await page.waitForURL((url) => url.pathname === '/redeem');
    const code = page.getByRole('textbox', { name: 'Anonymo Code' });
    const redeem = page.getByRole('button', { name: 'Redeem code', exact: true });
    await code.fill(DEMO_CODE.slice(0, -1) + (DEMO_CODE.endsWith('Z') ? 'Y' : 'Z'));
    assert.equal(await redeem.isDisabled(), true);
    await code.fill(DEMO_CODE.replace(/-/g, '').toLowerCase());
    assert.equal(await code.inputValue(), DEMO_CODE);
    await redeem.tap();
    await page.getByRole('heading', { name: '$25 added', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Copy key', exact: true }).waitFor();
    const onward = page.getByRole('button', { name: 'Continue to chat', exact: true });
    assert.equal(await onward.isDisabled(), true);
    await page.getByLabel('I have stored this key somewhere safe').check();
    await onward.tap();
    await page.waitForURL((url) => url.pathname === '/dashboard/chat');
    await page.getByText('Your message is waiting. Press send.').waitFor();
    assert.equal(await message.inputValue(), draft);
  } finally {
    await browser.close();
  }
});

test('Balance links to redemption and a scanned voucher credits the key that is already installed', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await openPage(browser, '/dashboard/key');
    await page.getByRole('button', { name: 'Create key', exact: true }).tap();
    await page.getByLabel('I have stored this key somewhere safe').check();
    await page.getByRole('button', { name: 'Open chat', exact: true }).tap();
    await page.waitForURL((url) => url.pathname === '/dashboard/chat');
    await page.goto(new URL('/dashboard/funds', origin).href);
    await page.getByRole('link', { name: 'Have a code?' }).tap();
    await page.waitForURL((url) => url.pathname === '/redeem');
    await page.goto(new URL(`/redeem#code=${DEMO_CODE}`, origin).href);
    const code = page.getByRole('textbox', { name: 'Anonymo Code' });
    await page.waitForFunction((expected) => document.querySelector('.redeem-input')?.value === expected, DEMO_CODE);
    assert.equal(await code.inputValue(), DEMO_CODE);
    assert.equal(new URL(page.url()).hash, '');
    await page.getByRole('button', { name: 'Redeem code', exact: true }).tap();
    await page.getByRole('heading', { name: '$25 added', exact: true }).waitFor();
    await page.getByRole('link', { name: 'Continue to chat', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Copy key', exact: true }).count(), 0);
    await page.goto(new URL('/dashboard/funds', origin).href);
    await page.getByRole('region', { name: 'Available credit' }).getByText('$25.00', { exact: true }).waitFor();
  } finally {
    await browser.close();
  }
});

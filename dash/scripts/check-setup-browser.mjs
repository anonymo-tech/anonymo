// Run against a local demo dashboard. This test simulates credit in the browser.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';
import { useUpDemoFreeChat } from './free-chat-fixture.mjs';

const origin = new URL(process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));

test('character chat survives key creation, funding, and reloading the original phone tab', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    await page.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === origin.origin || url.protocol === 'data:' ? route.continue() : route.abort();
    });
    await useUpDemoFreeChat(page);
    await page.goto(new URL('/dashboard/characters', origin).href);
    await page.getByText('Demo mode.', { exact: true }).waitFor();
    const consent = page.getByRole('button', { name: 'I am 18 or older' });
    await consent.tap();
    await consent.waitFor({ state: 'hidden' });
    await page.getByLabel('Character name').fill('Sample traveler');
    await page.getByRole('button', { name: 'Save character', exact: true }).tap();
    const chat = page.locator('main').getByRole('link', { name: 'Chat', exact: true });
    const destination = await chat.getAttribute('href');
    assert.match(destination, /^\/dashboard\/chat\?character=[a-f0-9]{16}$/);
    await chat.tap();
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    const draft = 'Where should we travel next?';
    await composer.fill(draft);
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    await page.getByRole('button', { name: 'Reply details' }).waitFor();
    await composer.fill(draft);
    await page.getByRole('button', { name: 'Send', exact: true }).tap();
    await page.getByRole('region', { name: 'Set up chat' }).getByRole('link', { name: 'Add funds' }).tap();
    await page.waitForURL(url => url.pathname === '/dashboard/funds');
    await page.getByRole('heading', { name: 'Add funds', exact: true }).waitFor();
    assert.equal(new URL(page.url()).searchParams.get('returnTo'), destination);
    await page.reload();
    await page.getByRole('button', { name: 'Send test USDG' }).tap();
    await page.getByRole('link', { name: 'Back to chat' }).tap();
    await page.waitForURL(new URL(destination, origin).href);
    await page.getByText('Your message is waiting. Press send.').waitFor();
    assert.equal(await composer.inputValue(), draft);
  } finally {
    await browser.close();
  }
});

test('frontend presets are reachable with a new zero-balance key', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
    const destination = '/dashboard/presets';
    const query = new URLSearchParams({ returnTo: destination });
    await page.goto(new URL(`/dashboard/key?${query}`, origin).href);
    await page.getByText('Demo mode.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'I am 18 or older' }).tap();
    await page.getByRole('button', { name: 'Create key', exact: true }).tap();
    await page.getByLabel('I have stored this key somewhere safe').check();
    await page.getByRole('button', { name: 'Return to frontend presets' }).tap();
    await page.waitForURL(new URL(destination, origin).href);
    await page.goto(new URL(`/dashboard/funds?${query}`, origin).href);
    await page.getByRole('link', { name: 'Return to frontend presets' }).tap();
    await page.waitForURL(new URL(destination, origin).href);
  } finally {
    await browser.close();
  }
});

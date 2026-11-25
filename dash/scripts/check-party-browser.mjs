import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const origin = new URL(process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)); // gitleaks:allow

test('Party hosts and guests share a scene, see a commit before the roll, and resume a saved campaign', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome' });
  try {
    const context = await browser.newContext({ permissions: ['clipboard-read', 'clipboard-write'] });
    await context.route('**/*', (route) => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
    const host = await context.newPage();
    await host.goto(new URL('/dashboard/party', origin).href);
    await host.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
    await host.getByRole('button', { name: 'I am 18 or older' }).click();
    await host.getByRole('link', { name: 'Set up a host key' }).click();
    await host.getByRole('button', { name: 'Create key', exact: true }).click();
    await host.getByLabel('I have stored this key somewhere safe').check();
    await host.getByRole('button', { name: 'Return to Party' }).click();
    await host.getByRole('button', { name: 'Create room' }).click();
    await host.getByRole('button', { name: 'Copy invite link' }).click();
    const invite = await host.evaluate(() => navigator.clipboard.readText());
    assert.match(invite, /#invite=[a-f0-9-]+\.[a-f0-9]{64}$/);
    const guest = await context.newPage({ viewport: { width: 390, height: 844 } });
    await guest.goto(invite);
    await guest.getByRole('button', { name: 'Join room' }).click();
    await guest.getByText('Player 2 · You', { exact: true }).waitFor();
    await host.getByText('Player 2', { exact: true }).waitFor();
    await guest.getByRole('button', { name: 'Commit roll' }).click();
    await host.getByText('d20 committed').waitFor();
    await guest.getByRole('button', { name: 'Reveal roll' }).click();
    await host.getByRole('button', { name: 'Verify roll' }).click();
    await host.getByText('Roll verified').waitFor();
    await guest.getByLabel('What do you do?').fill('I want to die.');
    await guest.getByRole('button', { name: 'Take a turn' }).click();
    await guest.getByRole('link', { name: 'Call or text 988' }).waitFor();
    await guest.getByLabel('What do you do?').fill('I open the ferry house door.');
    await guest.getByRole('button', { name: 'Take a turn' }).click();
    await host.getByText(/left a brass key on the sill/).first().waitFor();
    await host.getByRole('button', { name: 'Close room' }).click();
    await guest.getByRole('alert').getByText('This Party room has closed.').waitFor();
    const selector = host.getByLabel('Campaign', { exact: true });
    await selector.selectOption({ index: 1 });
    await host.getByRole('button', { name: 'Resume campaign' }).click();
    await host.getByText(/left a brass key on the sill/).first().waitFor();
  } finally {
    await browser.close();
  }
});

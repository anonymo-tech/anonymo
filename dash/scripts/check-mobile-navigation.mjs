// This first-visit flow runs against a local site and uses only device storage.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const origin = new URL(process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173');
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));

for (const [width, height, outfit] of [[320, 667, 'Pilot'], [360, 844, 'Astronaut'], [390, 844, 'Captain']]) {
  test(`first visit and character controls at ${width} × ${height}`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    try {
      const page = await browser.newPage({
        viewport: { width, height }, isMobile: true, hasTouch: true, reducedMotion: 'reduce',
      });
      page.setDefaultTimeout(10000);
      const button = (name) => page.getByRole('button', { name, exact: true });
      await page.goto(new URL('/dashboard', origin).href);
      const confirm = button('I am 18 or older');
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
      await confirm.tap();
      await confirm.waitFor({state: 'hidden'});
      const preview = button('See an example chat');
      const sample = page.getByRole('dialog', { name: 'Example chat', exact: true });
      await preview.tap();
      await sample.getByRole('heading', { name: 'Illustrative receipt' }).waitFor();
      assert.match(await sample.innerText(), /At low tide/);
      const realReceipt = sample.getByRole('link', { name: /View a real \$0 refusal receipt/ });
      assert.equal(new URL(await realReceipt.getAttribute('href')).hostname, 'anonymo.tech');
      await sample.getByRole('button', { name: 'Close example' }).tap();
      await sample.waitFor({ state: 'hidden' });
      assert.ok(await preview.evaluate((el) => document.activeElement === el));

      await page.getByRole('link', { name: 'Try chat' }).tap();
      await page.waitForURL((url) => url.pathname === '/dashboard/chat');
      await page.goBack();
      await preview.tap();
      await page.keyboard.press('Escape');
      await sample.waitFor({ state: 'hidden' });
      await page.getByRole('link', { name: 'Create a free character' }).tap();
      await page.getByRole('heading', { name: 'Character studio' }).waitFor();
      const choose = button(outfit);
      // Test the real contact point, including any foreground element that intercepts a tap.
      await choose.scrollIntoViewIfNeeded();
      const tile = await choose.boundingBox();
      await page.touchscreen.tap(tile.x + tile.width / 2, tile.y + tile.height / 2);
      assert.equal(await choose.getAttribute('aria-pressed'), 'true');
      assert.equal(await page.locator('.mascot-panel').count(), 0);

      const name = page.getByPlaceholder('Choose a name');
      await name.fill('Sample character');
      await button('Save character').tap();
      await page.getByText('Sample character is saved in your collection.').waitFor();
      await page.getByRole('button', { name: /Collection 1/ }).tap();
      await page.waitForURL('**/dashboard/characters?view=collection');
      await page.reload();
      await page.getByRole('heading', { name: 'Your collection' }).waitFor();
      await page.getByText('Sample character', { exact: true }).waitFor();
      await page.goBack();
      await page.getByRole('heading', { name: 'Character studio' }).waitFor();

      const quick = page.getByRole('navigation', { name: 'Quick navigation' });
      const navBox = await quick.boundingBox();
      for (const action of await quick.locator('a,button').all()) {
        const bounds = await action.boundingBox();
        assert.ok(bounds.width >= 44 && bounds.height >= 44);
      }
      const mascot = button('Open Anonymo chat');
      const mascotBox = await mascot.boundingBox();
      const more = button('More');
      const moreBox = await more.boundingBox();
      assert.ok(mascotBox.x >= moreBox.x + moreBox.width && mascotBox.y >= navBox.y);
      assert.ok(mascotBox.y + mascotBox.height <= navBox.y + navBox.height);
      await mascot.tap();
      await page.getByRole('dialog', { name: 'Anonymo chat' }).waitFor();
      await button('Minimize chat').tap();

      const menu = page.getByRole('dialog', { name: 'Workspace menu' });
      await more.tap();
      await menu.waitFor();
      await page.goBack();
      await menu.waitFor({ state: 'hidden' });
      assert.equal(new URL(page.url()).pathname, '/dashboard/characters');
      await more.tap();
      await menu.getByRole('link', { name: 'API key', exact: true }).tap();
      await page.waitForURL('**/dashboard/key');
      await page.goBack();
      await page.getByRole('heading', { name: 'Character studio' }).waitFor();
      assert.equal(await menu.isVisible(), false);
    } finally {
      await browser.close();
    }
  });
}

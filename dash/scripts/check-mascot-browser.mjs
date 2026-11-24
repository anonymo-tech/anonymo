// Run against a local demo build. The test creates a throwaway browser context and uses simulated funds.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const base = process.env.MASCOT_TEST_URL ?? 'http://127.0.0.1:3000';
assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname));

for (const width of [1250, 390]) {
  test(`mascot chat across routes at ${width}px`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.CHROMIUM_PATH,
    });
    try {
      const page = await browser.newPage({
        viewport: { width, height: width === 390 ? 844 : 920 },
        reducedMotion: width === 390 ? 'reduce' : 'no-preference',
      });
      page.setDefaultTimeout(6500);
      const errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      const btn = (name) => page.getByRole('button', { name, exact: true });
      const pop = page.getByRole('dialog', { name: 'Anonymo chat' });
      const launcher = btn('Open Anonymo chat');
      await page.goto(base + '/docs');
      await page.waitForFunction(
        () =>
          document.activeElement?.textContent?.trim() === 'I am 18 or older',
      );
      assert.equal(await launcher.count(), 0);
      await btn('I am 18 or older').click();
      await page
        .getByText(/Data comes from a mock gateway/)
        .first()
        .waitFor();
      const motion = await launcher.evaluate(
        (el) => getComputedStyle(el).animationName,
      );
      assert.equal(
        motion,
        width === 390 ? 'none' : 'mascot-stroll, mascot-routine',
      );
      const sprite = launcher.locator('.mascot-sprite');
      assert.equal(await sprite.getAttribute('data-mood'), 'roam');
      const asset = await sprite.evaluate(async (el) => {
        const img = new Image();
        img.src =
          getComputedStyle(el).backgroundImage.match(/url\("(.+)"\)/)[1];
        await img.decode();
        const canvas = document.createElement('canvas');
        canvas.width = img.width;
        canvas.height = img.height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const tile = img.width / 4,
          frames = [];
        for (let y = 0; y < 6; y++) {
          for (let x = 0; x < 4; x++) {
            const { data } = ctx.getImageData(tile * x, tile * y, tile, tile);
            if (
              data[3] > 10 ||
              data[
                4 * (tile * Math.floor(tile / 2) + Math.floor(tile / 2)) + 3
              ] < 200
            )
              throw Error('Invalid sprite alpha');
            let hash = 0;
            for (let i = 0; i < data.length; i += 16)
              hash = (Math.imul(hash, 31) + data[i]) | 0;
            frames.push(hash);
          }
        }
        return [img.height / tile, new Set(frames).size];
      });
      assert.deepEqual(asset, [6, 24]);
      if (width !== 390) {
        const poses = await launcher.evaluate((el) => {
          const animations = el.getAnimations();
          animations.forEach((a) => a.pause());
          const rows = [5, 25, 40, 62, 83].map((percent) => {
            animations.forEach(
              (a) => (a.currentTime = (22000 * percent) / 100),
            );
            return getComputedStyle(el.querySelector('.mascot-sprite'))
              .backgroundPositionY;
          });
          animations.forEach((a) => {
            a.currentTime = 0;
            a.play();
          });
          return rows;
        });
        assert.deepEqual(poses, ['40%', '0%', '20%', '0%', '100%']);
      }
      await launcher.click();
      const input = pop.getByRole('textbox', { name: 'Message', exact: true });
      await input.fill('A quiet morning in the park');
      await pop.getByRole('button', { name: 'Send', exact: true }).click();
      await pop.getByRole('link', { name: 'Create a free key' }).click();
      await btn('Create key').click();
      await page.getByLabel('I have stored this key somewhere safe').check();
      await btn('Open chat').click();
      await page.waitForURL('**/dashboard/chat');
      await page.goto(base + '/dashboard/funds');
      await btn('Send test USDG').click();
      await page.getByRole('link', { name: 'Continue to chat', exact: true }).waitFor();
      await launcher.click();
      assert.equal(
        await pop
          .locator('.mascot-head .mascot-sprite')
          .getAttribute('data-mood'),
        'listen',
      );
      await page.locator('.mascot-launcher').evaluate((el) => {
        window.mascotReactions = [];
        new MutationObserver(() =>
          window.mascotReactions.push(el.firstElementChild.dataset.mood),
        ).observe(el.firstElementChild, {
          attributes: true,
          attributeFilter: ['data-mood'],
        });
      });
      await input.fill('A quiet morning in the park');
      await pop.getByRole('button', { name: 'Send', exact: true }).click();
      await pop.locator('.prompt').waitFor();
      await btn('Minimize chat').click();
      if (width === 390) await btn('More').click();
      // Docs sits in the folded "For developers" group of the sidebar.
      const developers = page.locator('details.nav-fold').filter({ visible: true }).filter({ hasText: 'For developers' }).first();
      if (!(await developers.evaluate((el) => el.open))) await developers.locator('summary').click();
      await page
        .getByRole('link', { name: 'Docs', exact: true })
        .filter({ visible: true })
        .first()
        .click();
      await launcher.click();
      await pop.locator('.answer-body').filter({ hasText: /\w/ }).waitFor();
      await pop.locator('.thread[aria-busy="false"]').waitFor();
      await page.waitForFunction(() =>
        ['think', 'reply', 'joy'].every((state) =>
          window.mascotReactions.includes(state),
        ),
      );
      assert.match(await pop.locator('.prompt').innerText(), /quiet morning/);
      assert.equal(
        await page.evaluate(
          () =>
            JSON.stringify(localStorage).includes('A quiet morning') ||
            JSON.stringify(sessionStorage).includes('A quiet morning'),
        ),
        false,
      );
      await btn('Start new chat').click();
      const select = pop.getByLabel('Chat session');
      assert.equal(await select.locator('option').count(), 2);
      await select.selectOption({ label: 'A quiet morning in the park' });
      await input.fill('A draft for later');
      await input.press('Escape');
      await launcher.waitFor();
      await page.waitForFunction(
        () =>
          document.activeElement?.getAttribute('aria-label') ===
          'Open Anonymo chat',
      );
      // The brief, whitepaper and roadmap load as fresh documents on purpose, so a tab's chat does not
      // follow into them. Every other link navigates in place; the model manifest stands for those.
      await page
        .locator('footer')
        .getByRole('link', { name: 'Model manifest' })
        .click();
      await launcher.click();
      assert.equal(await input.inputValue(), 'A draft for later');
      if (width === 390) {
        // The public header has no menu at phone width: minimise the chat and go by the footer.
        await input.press('Escape');
        await page
          .locator('footer')
          .getByRole('link', { name: 'API docs', exact: true })
          .click();
        await page.waitForURL('**/docs');
        await launcher.click();
      } else {
        await page
          .getByRole('navigation', { name: 'Public pages' })
          .getByRole('link', { name: 'Docs', exact: true })
          .click();
        await page.waitForURL('**/docs');
      }
      assert.equal(await input.inputValue(), 'A draft for later');
      assert.equal(await pop.locator('.prompt').count(), 1);
      await pop.getByRole('link', { name: 'Open full chat' }).click();
      const full = page.getByRole('textbox', { name: 'Message' });
      await full.waitFor();
      assert.equal(await full.inputValue(), 'A draft for later');
      await launcher.click();
      assert.equal(
        await page.getByRole('textbox', { name: 'Message' }).count(),
        1,
      );
      assert.equal(await input.inputValue(), 'A draft for later');
      await btn('Minimize chat').click();
      assert.equal(await full.inputValue(), 'A draft for later');
      // Keep the background navigable with the panel open, and restore locally saved sessions after refresh.
      await launcher.click();
      await pop.getByRole('button', { name: /^Chats/ }).click();
      await page
        .getByRole('switch', { name: 'Keep chats on this device' })
        .check();
      await page
        .locator('.drawer')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await pop.getByRole('button', { name: 'Send', exact: true }).click();
      await pop
        .locator('.prompt')
        .filter({ hasText: 'A draft for later' })
        .waitFor();
      await pop.locator('.thread[aria-busy="false"]').waitFor();
      await page.reload();
      await launcher.click();
      await pop
        .getByLabel('Chat session')
        .selectOption({ label: 'A quiet morning in the park' });
      assert.equal(await pop.locator('.prompt').count(), 2);

      await pop.locator('.answer-body').last().waitFor();
      const rect = await pop.boundingBox();
      assert.ok(rect.x >= 0 && rect.x + rect.width <= width + 1);
      await btn('Minimize chat').click();
      if (width === 390) {
        const dock = await page.getByRole('navigation', { name: 'Quick navigation' }).boundingBox();
        const icon = await launcher.boundingBox();
        assert.ok(icon.y >= dock.y && icon.y + icon.height <= dock.y + dock.height);
        await launcher.focus();
        await launcher.press('ArrowRight');
        assert.deepEqual(await launcher.boundingBox(), icon);
      } else {
        const initial = await launcher.boundingBox();
        await page.mouse.move(initial.x + 20, initial.y + 20);
        await page.mouse.down();
        await page.mouse.move(initial.x - 80, initial.y + 90, { steps: 5 });
        await page.mouse.up();
        assert.equal(await pop.count(), 0);
        const moved = await launcher.boundingBox();
        assert.ok(moved.x < initial.x - 60);
        await launcher.focus();
        await launcher.press('ArrowRight');
        assert.ok((await launcher.boundingBox()).x > moved.x + 25);
      }
      assert.deepEqual(errors, []);
    } finally {
      await browser.close();
    }
  });
}

test('feature reminders rotate after three visible minutes across pages and can be browsed or paused', async () => {
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH,
  });
  try {
    const page = await browser.newPage({
      reducedMotion: 'reduce',
      viewport: { width: 390, height: 844 },
    });
    page.setDefaultTimeout(6500);
    const start = new Date('2030-01-01T12:00:00Z');
    await page.clock.install({ time: start });
    await page.clock.pauseAt(new Date(start.getTime() + 1000));
    await page.goto(base + '/docs');
    const button = (name) => page.getByRole('button', { name, exact: true });
    const tip = page.getByRole('complementary', { name: 'Mascot feature tip' });
    await page.waitForFunction(
      () => document.activeElement?.textContent?.trim() === 'I am 18 or older',
    );
    await page.clock.fastForward(180000);
    assert.equal(await tip.count(), 0);
    await button('I am 18 or older').click();
    await button('Open Anonymo chat').waitFor();
    await page.clock.fastForward(90000);
    await page
      .locator('footer')
      .getByRole('link', { name: 'Model manifest', exact: true })
      .click();
    await page.waitForURL('**/manifest');
    // Simulate tab visibility because headless Chromium keeps all tabs visible.
    const visibility = (hidden) =>
      page.evaluate((value) => {
        Object.defineProperty(document, 'hidden', {
          configurable: true,
          value,
        });
        document.dispatchEvent(new Event('visibilitychange'));
      }, hidden);
    await visibility(true);
    await page.clock.fastForward(360000);
    assert.equal(await tip.count(), 0);
    await visibility(false);
    await page.clock.fastForward(89999);
    assert.equal(await tip.count(), 0);
    await page.clock.fastForward(1);
    await tip.getByRole('link', { name: 'Signed receipts' }).waitFor();
    const geometry = await tip.boundingBox();
    assert.ok(
      geometry.x >= 0 &&
        geometry.x + geometry.width <= 390 &&
        geometry.y >= 0 &&
        geometry.y + geometry.height <= 844,
    );
    await tip.getByRole('button', { name: 'Dismiss tip' }).click();
    await button('Open Anonymo chat').click();
    await page.clock.fastForward(180000);
    await page
      .getByRole('dialog', { name: 'Anonymo chat' })
      .getByRole('link', { name: 'Paper Trail', exact: true })
      .waitFor();
    await button('All feature tips').click();
    const guide = page.getByRole('region', { name: 'Feature guide' });
    assert.equal(await guide.getByRole('listitem').count(), 9);
    const checkbox = guide.getByRole('checkbox');
    await checkbox.uncheck();
    await button('Back to chat').click();
    await page.clock.fastForward(360000);
    assert.equal(await tip.count(), 0);
    await button('Feature guide').click();
    await checkbox.check();
    await button('Back to chat').click();
    await page.clock.fastForward(180000);
    await tip.getByRole('link', { name: 'Character cards' }).click();
    await page.waitForURL('**/dashboard/characters');
    await page.clock.runFor(32);
    await page
      .getByRole('dialog', { name: 'Anonymo chat' })
      .waitFor({ state: 'hidden' });
    assert.equal(await tip.count(), 0);
    // At phone widths a workspace tip stays in the companion so it never covers editor controls.
    await page.clock.fastForward(180000);
    assert.equal(await tip.count(), 0);
    assert.equal(await button('Open Anonymo chat').getAttribute('data-tip'), 'true');
    await button('Open Anonymo chat').click();
    await tip.getByRole('link', { name: 'Frontend presets' }).waitFor();
    // Finish the rotation, then start again with the first feature.
    for (const title of [
      'Refusal Catch',
      'Refusal leaderboard',
      'Chat exports',
      'Catch me up',
      'Spending limits',
      'Signed receipts',
    ]) {
      await page.clock.fastForward(180000);
      await tip.getByRole('link', { name: title }).waitFor();
    }
  } finally {
    await browser.close();
  }
});

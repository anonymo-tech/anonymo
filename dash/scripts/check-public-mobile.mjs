import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const base = process.env.PUBLIC_TEST_URL ?? process.env.WORKSPACE_PREVIEW_URL ?? 'http://127.0.0.1:3000';

for (const [width, height] of [[320, 568], [390, 844], [1280, 800]]) {
  test(`Docs section links and history at ${width}px`, async () => {
    const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH });
    const mobile = width < 900;
    try {
      const page = await browser.newPage({ viewport: { width, height }, isMobile: mobile, hasTouch: mobile });
      page.setDefaultTimeout(10000);
      await page.goto(new URL('/docs', base).href);
      await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
      await page.getByRole('button', { name: 'I am 18 or older' }).click();
      await page.locator('.age-gate').waitFor({ state: 'hidden' });
      await page.evaluate(() => document.fonts.ready);

      for (const [label, id] of [['Authentication', 'auth'], ['Chat completions', 'chat'], ['Receipts', 'receipts']]) {
        const anchor = page.locator('.docs-nav').getByRole('link', { name: label, exact: true });
        if (mobile) await anchor.tap();
        else await anchor.click();
        await page.waitForFunction(sectionId => {
          const title = document.querySelector(`#${sectionId} h2`);
          const box = title.getBoundingClientRect();
          return box.top >= document.querySelector('.public-head').getBoundingClientRect().bottom
            && box.bottom < innerHeight && title.contains(document.elementFromPoint(box.x + 5, box.y + box.height / 2));
        }, id);
      }
      // A direct URL gets its first fragment jump before hydration and fonts have settled on WebKit.
      await page.goto(base);
      await page.goto(new URL('/docs#chat', base).href);
      await page.locator('.age-gate').waitFor({ state: 'hidden' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() => {
        const box = document.querySelector('#chat h2').getBoundingClientRect();
        return box.top >= document.querySelector('.public-head').getBoundingClientRect().bottom && box.bottom < innerHeight;
      });

      const models = page.locator('.docs-nav a[href="#models"]');
      await models.focus();
      await page.keyboard.press('Enter');
      await page.waitForURL('**/docs#models');
      await page.goBack();
      await page.waitForURL('**/docs#chat');
      await page.waitForFunction(() => {
        const title = document.querySelector('#chat h2').getBoundingClientRect();
        return title.top >= document.querySelector('.public-head').getBoundingClientRect().bottom && title.bottom < innerHeight;
      });
      // The router restores a history fragment on the next frame after popstate.
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const restoredPosition = await page.evaluate(() => scrollY);
      await page.mouse.move(width / 2, height * 0.7);
      await page.mouse.wheel(0, 160);
      await page.waitForFunction(start => scrollY > start + 80, restoredPosition);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.ok(await page.evaluate(start => scrollY > start + 80, restoredPosition), 'reader controls the scroll after Back');
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    } finally {
      await browser.close();
    }
  });
}

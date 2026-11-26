// Run against a local dash server. Every key, payment and chat in this test uses the in-browser demo gateway.
import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright-core';

const origin = new URL(
  process.env.WORKSPACE_PREVIEW_URL ?? 'http://localhost:5173',
);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname));

test('sidebar folds remember manual choices and open for the current page', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
    await page.goto(new URL('/dashboard?demo=1', origin).href);
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
    await page.getByRole('button', { name: 'I am 18 or older' }).click();
    await page.getByText('Demo mode.', { exact: true }).waitFor();

    const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
    const more = nav.locator('summary').filter({ hasText: /^More$/ });
    const developers = nav.locator('summary').filter({ hasText: /^For developers$/ });
    const story = nav.getByRole('link', { name: 'Story Studio' });
    const presets = nav.getByRole('link', { name: 'Frontend presets' });
    const history = nav.getByRole('link', { name: 'History' });
    const savedMore = (value) => page.waitForFunction((value) => localStorage.getItem('anonymo:workspace-nav:more') === value, value);
    assert.deepEqual(await nav.getByRole('link').allTextContents(), ['Overview', 'Chat', 'Ask Mo', 'Characters', 'API key', 'Balance', 'History']);
    await more.press('Enter');
    await story.waitFor();
    await savedMore('open');
    await page.reload();
    await story.waitFor();
    await more.press('Space');
    await story.waitFor({ state: 'hidden' });
    await savedMore('closed');
    await page.reload();
    await page.getByText('Demo mode.', { exact: true }).waitFor();
    assert.equal(await story.isVisible(), false);

    await page.goto(new URL('/dashboard/story', origin).href);
    await story.waitFor();
    assert.equal(await story.getAttribute('aria-current'), 'page');
    await more.press('Enter');
    await story.waitFor({ state: 'hidden' });
    await page.reload();
    await story.waitFor();
    await history.click();
    await page.getByRole('heading', { name: 'History', exact: true }).waitFor();
    await page.waitForFunction(() => document.title === 'History — Anonymo');
    await savedMore('closed');
    assert.equal(await story.isVisible(), false);

    await page.goto(new URL('/dashboard/presets', origin).href);
    await presets.waitFor();
    assert.equal(await presets.getAttribute('aria-current'), 'page');
    await nav.getByRole('link', { name: 'Balance', exact: true }).click();
    await page.waitForURL('**/dashboard/funds');
    await page.waitForFunction(() => document.title === 'Balance — Anonymo');
    assert.equal(await presets.isVisible(), false);
    await developers.press('Enter');
    await presets.waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole('navigation', { name: 'Quick navigation' }).getByRole('button', { name: 'More' }).click();
    await page.getByRole('dialog', { name: 'Workspace menu' }).getByRole('link', { name: 'Frontend presets' }).waitFor();
  } finally {
    await browser.close();
  }
});

test('sidebar folds work when preference storage is blocked', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.route('**/*', (route) => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
    await page.addInitScript(() => {
      for (const method of ['getItem', 'setItem']) {
        const original = Storage.prototype[method];
        Storage.prototype[method] = function (key, ...args) {
          if (key.startsWith('anonymo:workspace-nav:')) throw new DOMException('Storage is blocked', 'SecurityError');
          return original.call(this, key, ...args);
        };
      }
    });
    const errors = [];
    page.on('pageerror', (error) => errors.push(error));
    await page.goto(new URL('/dashboard?demo=1', origin).href);
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
    await page.getByRole('button', { name: 'I am 18 or older' }).click();
    const nav = page.getByRole('navigation', { name: 'Workspace', exact: true });
    const summary = nav.locator('summary').filter({ hasText: /^More$/ });
    const call = nav.getByRole('link', { name: 'Night Call' });
    await summary.click();
    await call.waitFor();
    await summary.click();
    await call.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
  }
});

test('a visitor can connect a key, fund it, chat and inspect the receipt from mobile navigation', async () => {
  const browser = await chromium.launch({
    channel: process.env.BROWSER_CHANNEL || undefined,
  });
  try {
    const page = await browser.newPage({
      viewport: { width: 390, height: 844 },
      reducedMotion: 'reduce',
    });
    page.setDefaultTimeout(20000);
    // Do not allow this workflow to make requests to an external gateway.
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      return url.origin === origin.origin || url.protocol === 'data:'
        ? route.continue()
        : route.abort();
    });
    await page.goto(new URL('/dashboard?demo=1', origin).href);
    const adult = page.getByRole('button', { name: 'I am 18 or older' });
    await adult.waitFor();
    for (let i = 0; i < 3 && (await adult.isVisible()); i++) {
      await adult.click();
      await adult.waitFor({ state: 'hidden', timeout: 800 }).catch(() => {});
    }
    await page.getByText('Demo mode.', { exact: true }).waitFor();
    await page
      .getByRole('heading', { name: 'Your private workspace' })
      .waitFor();
    const quick = page.getByRole('navigation', { name: 'Quick navigation' });
    const more = quick.getByRole('button', { name: 'More' });
    await more.click();
    const menu = page.getByRole('dialog', { name: 'Workspace menu' });
    for (const name of ['Overview', 'Chat', 'Balance']) {
      assert.equal(await menu.getByRole('link', { name, exact: true }).count(), 0);
    }
    await menu.locator('summary').filter({ hasText: /^More$/ }).click();
    await menu.getByRole('link', { name: 'Usage & limits' }).waitFor();
    await page.keyboard.press('Escape');
    await menu.waitFor({ state: 'hidden' });
    assert.ok(await more.evaluate((el) => document.activeElement === el));
    await more.click();
    await menu.getByRole('link', { name: 'API key' }).click();

    await page.getByRole('button', { name: 'Use an existing key' }).click();
    await page.getByLabel('API key', { exact: true }).fill('invalid');
    await page.getByRole('button', { name: 'Use this key' }).click();
    await page.getByRole('alert').waitFor();
    await page
      .getByRole('button', { name: 'Create a key', exact: true })
      .click();
    await page.getByRole('button', { name: 'Create key', exact: true }).click();
    const next = page.getByRole('button', { name: 'Open chat', exact: true });
    await next.waitFor();
    assert.equal(await next.isDisabled(), true);
    await page.getByLabel('I have stored this key somewhere safe').check();
    await next.click();
    await page.waitForURL('**/dashboard/chat');
    await quick.getByRole('link', { name: 'Overview' }).click();
    await page.getByRole('heading', { name: 'Start your first chat' }).waitFor();
    await page.getByRole('link', { name: 'Open Balance' }).click();
    await page.getByRole('button', { name: 'Withdraw', exact: true }).click();
    await page.getByRole('heading', { name: 'Withdraw funds', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Account activity', exact: true }).click();
    await page
      .getByText('Deposits and withdrawals will appear here.')
      .waitFor();
    await page.getByRole('button', { name: 'Add funds', exact: true }).click();
    await page.getByRole('button', { name: 'Send test USDG' }).click();
    await page.getByRole('link', { name: 'Continue to chat' }).waitFor();
    await quick.getByRole('link', { name: 'Overview' }).click();
    await page
      .getByRole('heading', { name: 'Start your first chat' })
      .waitFor();
    await page.getByRole('link', { name: 'Open chat', exact: true }).click();
    // A funded key also gets its first ordinary reply on the house.
    await page.locator('#composer').waitFor();
    await page.getByText('Your first message is on us.', { exact: true }).waitFor();
    await page.locator('#composer').fill('Give me a short greeting.');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await page.locator('.thread[aria-busy="false"] .answer-body').waitFor();
    await quick.getByRole('link', { name: 'Overview' }).click();
    await page.getByRole('heading', { name: 'Back to chat' }).waitFor();
    await page.locator('main table a').first().click();
    await page.getByRole('heading', { name: 'Inclusion proof' }).waitFor();

    await page.setViewportSize({ width: 1440, height: 900 });
    const nav = page.getByRole('navigation', {
      name: 'Workspace',
      exact: true,
    });
    assert.equal(
      await nav
        .getByRole('link', { name: 'History' })
        .getAttribute('aria-current'),
      'page',
    );
    await nav.getByRole('link', { name: 'Image studio' }).click();
    const options = page.locator('details.studio-options');
    await options.locator('summary').click();
    await options.getByRole('button', { name: '2', exact: true }).click();
    await options.locator('summary').click();
    assert.match(await options.locator('summary').innerText(), /2 images/);
    await page.getByRole('button', { name: /Make 2 images/ }).waitFor();
    await nav.getByRole('link', { name: 'History' }).click();
    await page.getByText('Where to find the ID', { exact: true }).click();
    await page.locator('details code').first().waitFor();
    await nav.getByRole('link', { name: 'API key' }).click();
    await page.getByRole('heading', { name: 'Key on this device' }).waitFor();
  } finally {
    await browser.close();
  }
});

test('the public receipt story keeps its original desktop and phone layouts alongside the redesigned dashboard', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    for (const width of [1440, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
      await page.goto(new URL('/?demo=1', origin).href);
      await page.waitForFunction(() => document.querySelector('.app-root')?.inert);
      await page.getByRole('button', { name: 'I am 18 or older' }).click();
      const story = page.getByRole('region', { name: 'How Anonymo works' });
      const hero = story.locator('h1');
      await hero.waitFor();
      assert.match(await hero.innerText(), /Ask anything\.\s*Keep the receipt\./);
      await page.evaluate(() => document.fonts.ready);
      assert.ok(await hero.evaluate(el => getComputedStyle(el).fontFamily.includes('Space Grotesk')));
      if (width === 1440) {
        await story.locator('.story-steps button').filter({ hasText: 'Refusals' }).click();
        await story.locator('button[aria-current="step"]').filter({ hasText: 'Refusals' }).waitFor();
        await story.locator('.rx-now .rx-stamp').waitFor();
      } else {
        assert.equal(await story.locator('.story-steps').isVisible(), false);
        assert.equal(await story.locator('.story-beat h2:visible').count(), 6);
        assert.ok(await story.locator('.printer .paper').isVisible());
      }
      await page.locator('.public-head').getByRole('link', { name: 'Open app' }).click();
      await page.waitForURL('**/dashboard/chat');
      await page.getByRole('dialog', { name: 'Choose your chat model' }).getByRole('listitem').first().waitFor();
      await page.close();
    }
  } finally {
    await browser.close();
  }
});

test('phone onboarding offers a preset template, validates receipt IDs and carries the selected amount into a wallet app', async () => {
  const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || undefined });
  try {
    const page = await browser.newPage({
      viewport: { width: 360, height: 740 },
      isMobile: true,
      hasTouch: true,
      reducedMotion: 'reduce',
      userAgent: 'Mozilla/5.0 (Linux; Android 14; Mobile) AppleWebKit/537.36 Chrome/140.0 Mobile Safari/537.36',
    });
    await page.route('**/*', route => new URL(route.request().url()).origin === origin.origin ? route.continue() : route.abort());
    await page.goto(new URL('/presets', origin).href);
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'I am 18 or older');
    await page.getByRole('button', { name: 'I am 18 or older' }).tap();
    await page.getByRole('button', { name: 'Copy setup template' }).waitFor();
    const getKey = page.getByRole('link', { name: 'Get an API key' });
    assert.equal(new URL(await getKey.getAttribute('href'), origin).pathname, '/dashboard/key');
    const field = page.locator('.preset-field').filter({ hasText: 'anm_live_YOUR_KEY' });
    assert.equal(await field.getByRole('button').count(), 0);
    await page.goto(new URL('/dashboard/receipts', origin).href);
    const id = page.getByLabel('Receipt id', { exact: true });
    await id.waitFor();
    for (const empty of ['', '  ']) {
      await id.fill(empty);
      await page.getByRole('button', { name: 'Open', exact: true }).tap();
      assert.equal(await id.evaluate(el => el.validity.valid), false);
      assert.equal(new URL(page.url()).pathname, '/dashboard/receipts');
    }
    await page.goto(new URL('/dashboard/key', origin).href);
    await page.getByText('Funding options for later', { exact: true }).tap();
    await page.getByText(/Wallet funding supports .*Robinhood Chain/).waitFor();
    await page.getByRole('button', { name: 'Create key', exact: true }).tap();
    await page.getByLabel('I have stored this key somewhere safe').check();
    await page.getByRole('button', { name: 'Open chat', exact: true }).tap();
    await page.waitForURL('**/dashboard/chat');
    await page.getByRole('navigation', { name: 'Quick navigation' }).getByRole('link', { name: 'Balance' }).tap();
    const walletLink = page.getByRole('link', { name: 'MetaMask', exact: true });
    const review = page.getByRole('button', { name: 'Continue to wallet' });
    await review.waitFor();
    assert.equal(await walletLink.count(), 0);
    const amount = page.getByLabel('Amount (USD)', { exact: true }).first();
    await amount.fill('0');
    assert.equal(await walletLink.count(), 0);
    await amount.fill('1.000125');
    await review.tap();
    await walletLink.waitFor();
    const open = new URL(await walletLink.getAttribute('href'));
    assert.equal(open.hostname, 'link.metamask.io');
    assert.equal(open.pathname, '/dapp/' + origin.host + '/pay');
    assert.equal(open.searchParams.get('amount'), '1.000125');
    assert.ok(!open.href.includes('anm_live_'));
    await page.goto(new URL('/pay' + open.search, origin).href);
    await walletLink.waitFor();
    const payAmount = page.getByLabel('Amount (USD)', { exact: true });
    assert.equal(await payAmount.inputValue(), '1.000125');
    await payAmount.fill('2.25');
    assert.equal(new URL(await walletLink.getAttribute('href')).searchParams.get('amount'), '2.25');
  } finally {
    await browser.close();
  }
});

// Run against the local dashboard dev server with an isolated Playwright Browser.
// The temporary context owns all test characters and is closed after the check.
import assert from 'node:assert/strict';

export async function checkCharacterStudio(browser, baseURL) {
  const context = await browser.newContext({
    baseURL,
    viewport: { width: 390, height: 844 },
    reducedMotion: 'reduce',
  });
  try {
    const page = await context.newPage();
    const button = (name) => page.getByRole('button', { name, exact: true });
    const nav = (name) =>
      page
        .getByRole('navigation', { name: 'Character workspace' })
        .getByRole('button', { name });
    await page.goto('/dashboard/characters?demo=1');
    await page.getByRole('heading', { name: 'Character studio' }).waitFor();
    await button('I am 18 or older').click();
    await page.locator('.portrait-picture img').waitFor();
    await button('Save character').click();
    const name = page.getByLabel('Character name');
    assert.equal(
      await name.evaluate((input) => input === document.activeElement),
      true,
    );
    await name.fill('Sample captain');
    await button('Explorer').click();
    await page.getByLabel('Custom outfit dye color').fill('#9767bd');
    await nav(/Collection/).click();
    await page
      .getByText('Characters you save or import will appear here.')
      .waitFor();
    await nav('Studio').click();
    assert.equal(await name.inputValue(), 'Sample captain');
    assert.equal(await button('Explorer').getAttribute('aria-pressed'), 'true');
    await button('Save character').click();
    await page
      .getByText('Sample captain is saved in your collection.')
      .waitFor();
    await page.reload();
    await nav(/Collection/).click();
    await button('Customize').click();
    await page.locator('.portrait-picture img').waitFor();
    assert.equal(
      await page.getByLabel('Custom outfit dye color').inputValue(),
      '#9767bd',
    );
    assert.equal(await button('Explorer').getAttribute('aria-pressed'), 'true');
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    await button('Image painter').click();
    await button('Describe from the card').waitFor();
    await nav('Import').click();
    await page.locator('input[type=file]').setInputFiles({
      name: 'sample.json',
      mimeType: 'application/json',
      buffer: Buffer.from(
        JSON.stringify({
          name: 'Sample navigator',
          description: 'An adult navigator.',
        }),
      ),
    });
    await button('Keep on this device').click();
    await page
      .locator('.character-cards')
      .getByText('Sample navigator')
      .waitFor();
  } finally {
    await context.close();
  }
}

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track I: data sources. The preview backend answers with fictional data and draws placeholder
// artwork locally, so these tests never touch the network (asserted below).

async function open(page: Page, query = '?reduced') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('request', (r) => {
    const u = r.url();
    if (!u.startsWith('http://localhost') && !u.startsWith('data:') && !u.startsWith('blob:')) external.push(u);
  });
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm, .onb').first()).toBeVisible();
  return { errors, external };
}

async function openGame(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
  await page.getByLabel('Filter library').fill(title);
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('art picker (SteamGridDB)', () => {
  test('browse, filter, preview by keyboard, apply and reset — without leaving the machine', async ({ page }) => {
    const { errors, external } = await open(page);
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Artwork' }).click();
    await page.getByRole('button', { name: 'Browse SteamGridDB…' }).first().click();

    const dialog = page.getByRole('dialog', { name: /Choose a cover from SteamGridDB/ });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('status').filter({ hasText: 'Matched by Steam app ID' })).toBeVisible();
    const grid = dialog.getByRole('listbox', { name: 'Cover options' });
    const options = grid.getByRole('option');
    await expect(options.first()).toBeVisible();
    expect(await options.count()).toBeGreaterThan(5);
    // Previews arrive through the bridge (art.thumb) and render as local images.
    await expect(options.first().locator('img')).toHaveAttribute('src', /^data:image\/svg\+xml/);

    // Style filter.
    const blurred = dialog.getByRole('button', { name: 'Blurred' });
    await blurred.click();
    await expect(blurred).toHaveAttribute('aria-pressed', 'true');
    await expect(options.first()).toBeVisible();
    await expect(dialog.getByRole('option', { name: /^Blurred/ }).first()).toBeVisible();
    await blurred.click();
    await expect(blurred).toHaveAttribute('aria-pressed', 'false');
    await expect(grid).not.toHaveAttribute('aria-busy', 'true');
    await expect(dialog.getByRole('option', { name: /^Alternate/ }).first()).toBeVisible();

    // Keyboard: focus the grid, move, select.
    await options.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(options.nth(1)).toBeFocused();
    await page.keyboard.press('Space');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(dialog.locator('.artpick__stage img')).toBeVisible();
    await expect(dialog.getByText('Artist', { exact: true })).toBeVisible();

    await settled(page);
    await noSeriousViolations(page, '.dialog');

    await dialog.getByRole('button', { name: 'Use this cover' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Cover updated')).toBeVisible();
    await expect(page.getByText(/Your choice · from SteamGridDB by/)).toBeVisible();

    await page.getByRole('button', { name: 'Reset to default' }).click();
    await expect(page.getByText('Back to the default artwork')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reset to default' })).toHaveCount(0);

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('a game without a Steam ID offers SteamGridDB candidates to choose from', async ({ page }) => {
    await open(page);
    await openGame(page, 'Hollow Lantern'); // GOG only; even-length title → no exact match in preview
    await page.getByRole('tab', { name: 'Artwork' }).click();
    await page.getByRole('button', { name: 'Browse SteamGridDB…' }).nth(1).click();
    const dialog = page.getByRole('dialog', { name: /Choose a background/ });
    const choices = dialog.getByRole('group', { name: 'Choose the right game on SteamGridDB' });
    await expect(choices).toBeVisible();
    await choices.getByRole('button').first().click();
    await expect(dialog.getByRole('listbox', { name: 'Background options' }).getByRole('option').first()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
  });
});

test.describe('game page data', () => {
  test('deals, compatibility, details and identity show their sources', async ({ page }) => {
    const { errors, external } = await open(page);
    await openGame(page, 'Nebula Drift');
    const deals = page.getByRole('region', { name: 'Deals' });
    await expect(deals).toBeVisible();
    await expect(deals.getByText('Best price now')).toBeVisible();
    await expect(deals.getByRole('button', { name: 'CheapShark.com' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'From IGDB' })).toBeVisible();
    await expect(page.getByLabel('Time to beat')).toBeVisible();
    await settled(page);
    await noSeriousViolations(page, '.gx');

    await page.getByRole('tab', { name: /Versions/ }).click();
    const identity = page.getByRole('region', { name: 'Same game elsewhere' });
    await expect(identity).toBeVisible();
    await expect(identity.getByRole('button', { name: 'Open on Steam' })).toBeVisible();
    await expect(identity.getByText(/Wikidata Q\d+/)).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

test.describe('data sources settings', () => {
  test('connect is tested first, disconnect needs a hold, and the page has no serious violations', async ({ page }) => {
    const { errors, external } = await open(page);
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Library & stores' }).click();
    const section = page.getByRole('region', { name: /Data sources/ });
    await expect(section).toBeVisible();
    await expect(section.getByRole('article', { name: 'SteamGridDB' }).getByText('Connected', { exact: true })).toBeVisible();

    const rawg = section.getByRole('article', { name: 'RAWG' });
    const keyField = rawg.getByLabel('RAWG API key');
    await keyField.fill('bad0123456789abcdef0123456789ab');
    await rawg.getByRole('button', { name: 'Connect' }).click();
    await expect(rawg.getByText('Key not accepted')).toBeVisible();
    await expect(rawg.getByText('Not connected', { exact: true })).toBeVisible();

    await keyField.fill('0123456789abcdef0123456789abcdef');
    await rawg.getByRole('button', { name: 'Connect' }).click();
    await expect(rawg.getByText('Connected', { exact: true })).toBeVisible();
    await expect(rawg.getByText('••••cdef')).toBeVisible();
    // The page never shows the key itself.
    await expect(page.getByText('0123456789abcdef0123456789abcdef')).toHaveCount(0);

    const igdb = section.getByRole('article', { name: 'IGDB' });
    await expect(igdb.getByText('Your Twitch app')).toBeVisible();

    await settled(page);
    await noSeriousViolations(page, '.dsrc');

    await rawg.getByRole('button', { name: 'Disconnect' }).click();
    const dialog = page.getByRole('dialog', { name: 'Disconnect RAWG?' });
    await expect(dialog).toBeVisible();
    const hold = dialog.getByRole('button', { name: 'Disconnect' });
    await page.waitForTimeout(400); // let the dialog settle (it moves focus in on open)
    await hold.focus();
    await page.keyboard.down('Enter');
    await expect(hold).toHaveAttribute('data-hold', 'holding');
    await page.waitForTimeout(1150);
    await page.keyboard.up('Enter');
    await expect(dialog).toBeHidden();
    await expect(rawg.getByText('Not connected', { exact: true })).toBeVisible();

    // Keyless sources can be switched off.
    const cheapshark = section.getByRole('article', { name: 'CheapShark' });
    await cheapshark.getByRole('switch', { name: 'Use CheapShark' }).click();
    await expect(cheapshark.getByText('Off', { exact: true })).toBeVisible();

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

test.describe('journal: library value', () => {
  test('shows an honest cumulative value chart that moves by keyboard', async ({ page }) => {
    const { errors, external } = await open(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Journal' }).click();
    await page.getByRole('tab', { name: 'Library value' }).click();
    await expect(page.getByText('Current price, not what you paid.')).toBeVisible();
    await expect(page.getByText(/of \d+ games priced/)).toBeVisible({ timeout: 10_000 });
    const chart = page.locator('.lv-chart');
    await expect(chart).toBeVisible();
    await chart.focus();
    await page.keyboard.press('End');
    await expect(page.locator('.lv-tip')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Top value' })).toBeVisible();
    await settled(page);
    await noSeriousViolations(page, '.lv');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

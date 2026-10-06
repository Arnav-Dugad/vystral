import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track Q: the library health check (?health = many issues; healthy by default) and the game page's
// Controls tab (?controls = fictional Steam Input layouts). Preview data only.

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

async function openHealthFromLibrary(page: Page) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
  await page.getByRole('button', { name: 'Library health' }).click();
  await expect(page.getByRole('img', { name: /Health score \d+ out of 100/ })).toBeVisible();
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

async function openGame(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
  await page.getByLabel('Filter library').fill(title);
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

test.describe('library health check', () => {
  test('a healthy library gets a full score and a calm all-clear', async ({ page }) => {
    const { errors, external } = await open(page);
    await openHealthFromLibrary(page);
    await expect(page.getByRole('img', { name: 'Health score 100 out of 100: In great shape' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Your library is in perfect health' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Fix \d+ safe/ })).toHaveCount(0);
    await noSeriousViolations(page, '.health');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('lists grouped issues with fixes, dismisses with undo, and fixes the safe ones with progress', async ({ page }) => {
    const { errors, external } = await open(page, '?health&reduced');
    await openHealthFromLibrary(page);
    await expect(page.getByRole('heading', { name: /Needs a little care|Needs attention|In good shape/, level: 1 })).toBeVisible();

    // Sections, most serious first, each collapsible with counts.
    const launch = page.getByRole('region', { name: 'Games that can’t start' });
    await expect(launch).toBeVisible();
    await expect(launch.getByRole('heading', { name: /Lumen Garden can’t start/ })).toBeVisible();
    await expect(launch.getByRole('button', { name: 'Locate the program…' })).toBeVisible();
    for (const name of ['Drives that aren’t connected', 'Duplicates', 'Artwork', 'Play sessions', 'Game details', 'Installs and stores'])
      await expect(page.getByRole('region', { name })).toBeVisible();
    await noSeriousViolations(page, '.health');

    const art = page.getByRole('region', { name: 'Artwork' });
    const toggle = art.getByRole('button', { name: /^Artwork/ });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(art.getByRole('heading', { name: /Glasswing/ })).toBeHidden();
    await toggle.click();
    await expect(art.getByRole('heading', { name: /Glasswing’s cover is a placeholder/ })).toBeVisible();

    // Dismiss with undo.
    const dupes = page.getByRole('region', { name: 'Duplicates' });
    await dupes.getByRole('button', { name: /Dismiss “Nebula Drift is in 2 Steam libraries”/ }).click();
    await expect(dupes.getByRole('heading', { name: /Nebula Drift is in 2 Steam libraries/ })).toBeHidden();
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(dupes.getByRole('heading', { name: /Nebula Drift is in 2 Steam libraries/ })).toBeVisible();

    // One fix on its own.
    await page.getByRole('region', { name: 'Play sessions' }).getByRole('button', { name: 'Close it' }).click();
    await expect(page.getByText('Session closed — its time now counts')).toBeVisible();

    // Fix all safe issues: progress, then fewer issues and a higher score.
    const before = Number((await page.locator('.hring__num').textContent()) ?? '0');
    const fixAll = page.getByRole('button', { name: /^Fix \d+ safe issues/ });
    await expect(fixAll).toBeVisible();
    await fixAll.click();
    await expect(page.getByRole('progressbar', { name: 'Fixing safe issues' })).toBeVisible();
    await expect(page.getByText(/^Fixed \d+ issues/)).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: /Glasswing’s cover is a placeholder/ })).toBeHidden();
    await expect(launch.getByRole('heading', { name: /Lumen Garden can’t start/ })).toBeVisible(); // not a safe fix: left for you
    await expect.poll(async () => Number((await page.locator('.hring__num').textContent()) ?? '0')).toBeGreaterThan(before);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('reachable from the command palette and Settings', async ({ page }) => {
    await open(page, '?health&reduced');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox').fill('health');
    await page.getByRole('option', { name: /Check library health/ }).click();
    await expect(page.getByRole('img', { name: /Health score/ })).toBeVisible();

    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Settings/ }).click();
    await page.getByRole('button', { name: 'Library & stores' }).click();
    await expect(page.getByText(/things to look at/)).toBeVisible();
    await page.getByRole('button', { name: 'Open health check' }).click();
    await expect(page.getByRole('img', { name: /Health score/ })).toBeVisible();
  });

  test('High contrast keeps the page readable', async ({ page }) => {
    await open(page, '?health&reduced');
    await page.evaluate(() => { document.documentElement.dataset.theme = 'contrast'; });
    await openHealthFromLibrary(page);
    await page.evaluate(() => { document.documentElement.dataset.theme = 'contrast'; });
    await noSeriousViolations(page, '.health');
  });
});

test.describe('game page: Steam Input controls', () => {
  test('a personal layout: diagram callouts, set and layer switcher, table', async ({ page }) => {
    const { errors, external } = await open(page, '?controls&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Controls' }).click();
    await expect(page.getByRole('heading', { name: 'My layout' })).toBeVisible();
    await expect(page.getByText('Your own layout')).toBeVisible();
    await expect(page.locator('.pad__callout')).not.toHaveCount(0);
    const table = page.getByRole('table');
    await expect(table.getByRole('row', { name: /^A Jump/ })).toBeVisible();

    await page.getByRole('radio', { name: 'Menus' }).click();
    await expect(table.getByRole('row', { name: /^A Select/ })).toBeVisible();
    await page.getByRole('radio', { name: 'On foot' }).click();
    await page.getByRole('button', { name: 'Driving', pressed: false }).click();
    await expect(table.getByRole('row', { name: /^A Handbrake/ })).toBeVisible();
    await expect(page.getByText(/Changed while “Driving” is on/)).toBeVisible();
    await expect(table.getByRole('row', { name: 'Left stick Joystick Move' })).toBeVisible(); // inherited from the set
    await noSeriousViolations(page, '.controls');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('a template is named, and games without a layout say they use their own support', async ({ page }) => {
    await open(page, '?controls&reduced');
    await openGame(page, 'Starfall Tactics');
    await page.getByRole('tab', { name: 'Controls' }).click();
    await expect(page.getByText('Steam template')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Keyboard (WASD) and Mouse' })).toBeVisible();

    await openGame(page, 'Hollow Lantern'); // a GOG game
    await page.getByRole('tab', { name: 'Controls' }).click();
    await expect(page.getByRole('heading', { name: 'Controls come from the game' })).toBeVisible();
  });

  test('without ?controls a Steam game uses its own controller support', async ({ page }) => {
    await open(page);
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Controls' }).click();
    await expect(page.getByRole('heading', { name: 'Uses the game’s own controller support' })).toBeVisible();
    await noSeriousViolations(page, '.controls');
  });
});

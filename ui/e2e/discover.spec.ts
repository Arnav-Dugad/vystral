import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track U: universal search and pages for games you don't own, on the preview backend's FICTIONAL catalogue
// (labelled "Preview · fictional results"). `?discover` opens the Discover page; `?discoverSlow` slows the sources down.
// Nothing is ever launched or installed, and the preview never touches the network.

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

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('command bar', () => {
  test('library first, then “Not in your library” streams in with highlights, and opens a page', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&discoverSlow');
    await page.keyboard.press('Control+k');
    const bar = page.getByRole('dialog', { name: 'Command bar' });
    await page.getByRole('combobox', { name: 'Search' }).fill('echoes');
    await expect(bar.getByText('In your library', { exact: true })).toBeVisible();
    await expect(page.getByRole('option').first()).toContainText('Echoes of Vael');
    await expect(bar.getByText('Not in your library', { exact: true })).toBeVisible();
    // While the sources answer: shimmering placeholder rows and a "searching" line.
    await expect(bar.locator('.cmd__item--skeleton').first()).toBeVisible();
    const deep = page.getByRole('option', { name: /Echoes of the Deep/ });
    await expect(deep).toBeVisible({ timeout: 15_000 });
    await expect(bar.locator('.cmd__item--skeleton')).toHaveCount(0);
    await expect(deep.locator('mark.hl')).toHaveText('Echoes');
    await expect(page.getByRole('option', { name: /Search everywhere for “echoes”/ })).toBeVisible();
    await expect(bar.getByText(/Also asking/)).toBeVisible();
    await noSeriousViolations(page, '.cmd');

    await deep.click();
    await expect(page.getByRole('heading', { name: 'Echoes of the Deep', level: 1 })).toBeVisible();
    await expect(page.locator('.ddhero__route')).toContainText('Not in your library');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('launching and filter words stay local; “Search everywhere” opens Discover', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Search' });
    await input.fill('launch nebula');
    await expect(page.getByRole('option').first()).toContainText('Launch Nebula Drift');
    await expect(page.getByRole('option', { name: /Search everywhere/ })).toHaveCount(0);
    await input.fill('installed racing games');
    await expect(page.getByRole('option', { name: /Search everywhere/ })).toHaveCount(0);

    await input.fill('paper');
    await page.getByRole('option', { name: /Search everywhere for “paper”/ }).click();
    await expect(page.getByRole('heading', { name: 'Discover', level: 1 })).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search every source' })).toHaveValue('paper');
    await expect(page.locator('.dcard[data-discover-key]').filter({ hasText: 'Paper Comets' })).toBeVisible();
  });
});

test.describe('Discover page', () => {
  test('is labelled as preview data, shows library games first, filters and scrolls for more', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&discover=of');
    await expect(page.getByText('Preview · fictional results')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole('heading', { name: 'In your library', exact: true })).toBeVisible();
    const sources = page.getByRole('list', { name: 'Sources' });
    await expect(sources).toContainText('RAWG: not connected');
    await expect(sources).toContainText(/Steam: \d+ match/);
    const cards = page.locator('section[aria-labelledby="disc-rest"] .dcard');
    await expect(cards.first()).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('section[aria-labelledby="disc-rest"]')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
    const before = await cards.count();

    // Infinite scroll: IGDB has more pages for “of”.
    await page.getByRole('button', { name: 'Show more results' }).scrollIntoViewIfNeeded();
    await expect.poll(async () => cards.count(), { timeout: 20_000 }).toBeGreaterThan(before);

    // Filters narrow the list and can be cleared (count once every source has answered the new page).
    await expect(page.locator('section[aria-labelledby="disc-rest"]')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
    const all = await cards.count();
    await page.getByRole('group', { name: 'Store' }).getByRole('button', { name: 'GOG' }).click();
    await expect.poll(async () => cards.count()).toBeLessThan(all);
    await expect(page.getByRole('group', { name: 'Store' }).getByRole('button', { name: 'GOG' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('combobox', { name: 'Release year' }).selectOption('older');
    await expect(cards.filter({ hasText: 'Tower of the Tin King' })).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect.poll(async () => cards.count()).toBe(all);

    await noSeriousViolations(page);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('a page for a game you don’t own: facts, prices, where to get it, and Watching', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&discover=starfall');
    const card = page.locator('.dcard').filter({ hasText: 'Starfall Tactics II' });
    await card.click();
    await expect(page.getByRole('heading', { name: 'Starfall Tactics II', level: 1 })).toBeVisible();
    await expect(page.locator('.ddhero__route')).toContainText('Discover');
    await expect(page.getByText('Verified', { exact: false }).first()).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Time to beat' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Prices and deals' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Where to get it' })).toBeVisible();
    await expect(page.getByRole('button', { name: /Steam store page\. Opens in your browser/ })).toBeVisible();
    await expect(page.getByText('Turn on cloud play to see whether')).toBeVisible();

    // Where to get it: official store pages only, opened in the browser.
    await page.getByRole('button', { name: 'Where to get it' }).click();
    await expect(page.getByRole('menuitem', { name: 'Steam store page' })).toBeVisible();
    await expect(page.getByRole('menuitem', { name: 'GOG store page' })).toBeVisible();
    await page.keyboard.press('Escape');

    await page.getByRole('button', { name: 'Watch price' }).click();
    await expect(page.getByRole('button', { name: 'Watching' })).toHaveAttribute('aria-pressed', 'true');
    await noSeriousViolations(page);

    // The Watching list shows on Discover with nothing typed.
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('searchbox', { name: 'Search every source' }).fill('');
    await expect(page.getByRole('heading', { name: /Watching/ })).toBeVisible();
    await expect(page.locator('.dwatch').filter({ hasText: 'Starfall Tactics II' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop watching Starfall Tactics II' }).click();
    await expect(page.locator('.dwatch')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('cloud play on: “Streamable on …” from the cached catalogue', async ({ page }) => {
    await open(page, '?reduced&cloud&discover=echoes of the deep');
    await page.locator('.dcard').filter({ hasText: 'Echoes of the Deep' }).click();
    await expect(page.getByText('Streamable on GeForce NOW')).toBeVisible();
    await expect(page.getByText('Streamable on Xbox Cloud Gaming')).toBeVisible();
    await expect(page.getByText('Likely match', { exact: true })).toBeVisible();
  });

  test('explains Offline mode, the off switch and missing keys', async ({ page }) => {
    await open(page, '?reduced&discoverNoKeys&discover');
    await expect(page.getByText(/Get more results with IGDB and RAWG/)).toBeVisible({ timeout: 20_000 });
    await page.getByRole('button', { name: 'Connect sources' }).click();
    await expect(page.getByRole('heading', { name: /Data sources/ })).toBeVisible();
    await page.getByLabel('Search stores and game databases').click();

    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Discover/ }).click();
    await page.getByRole('searchbox', { name: 'Search every source' }).fill('echoes');
    await expect(page.getByText('Searching stores and game databases is off')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'In your library', exact: true })).toBeVisible(); // the library is still searched
    await page.getByRole('button', { name: 'Turn on' }).click();
    await expect(page.locator('.dcard').filter({ hasText: 'Echoes of Starlight' })).toBeVisible();

    await page.keyboard.press('Control+,');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: /Privacy/ }).click();
    await page.getByLabel('Offline mode').first().click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Discover/ }).click();
    await page.getByRole('searchbox', { name: 'Search every source' }).fill('echoes of');
    await expect(page.getByText('Offline mode is on', { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Not in your library', exact: true })).toHaveCount(0);
  });

  test('shows a shimmer while sources answer, and is keyboard reachable from the sidebar', async ({ page }) => {
    await open(page, '?reduced&discoverSlow');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Discover/ }).click();
    const box = page.getByRole('searchbox', { name: 'Search every source' });
    await expect(box).toBeFocused();
    await page.keyboard.type('tales');
    await expect(page.locator('.dcard--skeleton').first()).toBeVisible();
    await expect(page.locator('.disc-source[data-state="pending"]').first()).toBeVisible();
    await expect(page.locator('.dcard').filter({ hasText: 'Tales of the Ninth Moon' })).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.dcard--skeleton')).toHaveCount(0);
    // Tab reaches the first result, Enter opens it.
    const first = page.locator('section[aria-labelledby="disc-rest"] .dcard').first();
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.ddhero')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('heading', { name: 'Discover', level: 1 })).toBeVisible();
  });
});

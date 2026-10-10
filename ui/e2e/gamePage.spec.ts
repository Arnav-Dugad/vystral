import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track C4: visually helpful game pages on the preview backend (fictional data only).
// ?reviews (=down | =few | =offline), ?tags (=loading), ?franchise (=noKey | =none).

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

const nav = (page: Page, name: RegExp | string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

async function openGame(page: Page, title: string) {
  await nav(page, /Library/);
  await page.getByLabel('Filter library').fill(title);
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeAttached();
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

const glance = (page: Page) => page.getByRole('region', { name: 'At a glance' });

test.describe('library game page: at a glance', () => {
  test('stat tiles, review snapshot, tags and the series timeline, each with its source; axe-clean', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&reviews&tags&franchise');
    await openGame(page, 'Starfall Tactics');
    const grid = glance(page);
    await expect(grid).toBeVisible();
    await expect(grid.getByRole('region', { name: 'Playtime' })).toBeVisible();

    const reviews = grid.getByRole('region', { name: 'Steam reviews' });
    await expect(reviews).toContainText('positive');
    await expect(reviews).toContainText(/in the last 30 days|Too few recent reviews/);
    await expect(reviews.getByRole('img', { name: /All time: .*% positive/ })).toBeVisible();
    await expect(reviews).toContainText('Steam user reviews, all languages');

    const price = grid.getByRole('region', { name: /Price in your region/ });
    await expect(price).toContainText('Lowest ever');
    await expect(price).toContainText('history: prices VYSTRAL saw on this PC');
    await expect(price.getByRole('img', { name: /Steam price seen by VYSTRAL/ })).toBeVisible();

    const ratings = grid.getByRole('region', { name: 'Ratings' });
    await expect(ratings).toContainText('IGDB');
    await expect(grid.getByRole('region', { name: 'Achievements' })).toContainText('/');
    await expect(grid.getByRole('region', { name: 'Size on disk' })).toBeVisible();

    // Community tags.
    const tags = page.getByRole('region', { name: 'What players call it' });
    await expect(tags.getByRole('button', { name: /^Strategy\./ })).toBeVisible();
    await expect(tags).toContainText('Community tags applied by Steam players');

    // The series timeline: owned games lit, the others open Discover; arrow keys move between games.
    const timeline = page.getByRole('region', { name: 'The Starfall series' });
    await timeline.scrollIntoViewIfNeeded();
    await expect(timeline).toContainText('2 of 4 in your library');
    const here = timeline.getByRole('button', { name: /^Starfall Tactics, 2019/ });
    await expect(here).toHaveAttribute('aria-current', 'page');
    await noSeriousViolations(page, '.gi');
    await noSeriousViolations(page, '.gi-ft');
    await noSeriousViolations(page, '.gi-tags');

    await here.focus();
    await page.keyboard.press('ArrowRight');
    await expect(timeline.getByRole('button', { name: /^Deep Field/ })).toBeFocused();
    await page.keyboard.press('End');
    await expect(timeline.getByRole('button', { name: /^Children of the Comet/ })).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    const sequel = timeline.getByRole('button', { name: /^Starfall Tactics II.*opens its Discover page/ });
    await expect(sequel).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Starfall Tactics II', level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('an owned game in the series opens its own page', async ({ page }) => {
    await open(page, '?reduced&franchise');
    await openGame(page, 'Starfall Tactics');
    const timeline = page.getByRole('region', { name: 'The Starfall series' });
    await timeline.getByRole('button', { name: /^Deep Field.*In your library/ }).click();
    await expect(page.getByRole('heading', { name: 'Deep Field', level: 1 })).toBeAttached();
    await expect(page.getByRole('region', { name: 'The Starfall series' }).getByRole('button', { name: /^Deep Field/ })).toHaveAttribute('aria-current', 'page');
  });

  test('recent reviews dropping shows a down arrow in words', async ({ page }) => {
    await open(page, '?reduced&reviews=down');
    await openGame(page, 'Nebula Drift');
    await expect(glance(page).getByRole('region', { name: 'Steam reviews' })).toContainText(/Down \d+(\.\d)? points in the last 30 days/);
  });

  test('too few recent reviews means no trend is claimed', async ({ page }) => {
    await open(page, '?reduced&reviews=few');
    await openGame(page, 'Nebula Drift');
    await expect(glance(page).getByRole('region', { name: 'Steam reviews' })).toContainText('Too few recent reviews (4) to call a trend');
  });

  test('saved reviews in Offline mode say so', async ({ page }) => {
    await open(page, '?reduced&reviews=offline');
    await openGame(page, 'Nebula Drift');
    await expect(glance(page).getByRole('region', { name: 'Steam reviews' })).toContainText('couldn’t refresh, showing saved reviews');
  });

  test('a game from another store has no Steam tiles, and nothing is invented', async ({ page }) => {
    const { errors } = await open(page, '?reduced&reviews&tags&franchise');
    await openGame(page, 'Hollow Lantern');
    await expect(glance(page).getByRole('region', { name: 'Playtime' })).toBeVisible();
    await expect(glance(page).getByRole('region', { name: 'Steam reviews' })).toHaveCount(0);
    await expect(glance(page).getByRole('region', { name: /Price/ })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'What players call it' })).toHaveCount(0);
    await expect(page.getByTestId('franchise-timeline')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('without IGDB the timeline invites you to connect it', async ({ page }) => {
    await open(page, '?reduced&franchise=noKey');
    await openGame(page, 'Starfall Tactics');
    await expect(page.getByRole('complementary', { name: 'Series timeline' })).toContainText('Connect IGDB');
  });

  test('turning the review snapshot off removes it', async ({ page }) => {
    await open(page, '?reduced&reviews');
    await nav(page, /Settings/);
    await page.getByRole('button', { name: 'Library & stores' }).click();
    const toggle = page.getByRole('switch', { name: 'Review snapshot' });
    await toggle.scrollIntoViewIfNeeded();
    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await openGame(page, 'Nebula Drift');
    await expect(glance(page).getByRole('region', { name: 'Playtime' })).toBeVisible();
    await expect(glance(page).getByRole('region', { name: 'Steam reviews' })).toHaveCount(0);
  });
});

test.describe('discover game page: at a glance', () => {
  test('tiles, reviews, tags and the series with your owned games lit; axe-clean', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&reviews&tags&franchise&discover=starfall');
    await page.locator('.dcard').filter({ hasText: 'Starfall Tactics II' }).click();
    await expect(page.getByRole('heading', { name: 'Starfall Tactics II', level: 1 })).toBeVisible();
    const grid = glance(page);
    await expect(grid.getByRole('region', { name: 'Released' })).toBeVisible();
    await expect(grid.getByRole('region', { name: /Price in your region/ })).toContainText('$29.99');
    await expect(grid.getByRole('region', { name: 'Time to beat' })).toContainText('IGDB player estimates');
    await expect(grid.getByRole('region', { name: 'Steam reviews' })).toContainText('positive');
    await expect(grid.getByRole('region', { name: 'Compatibility' })).toContainText('Deck Verified');
    await expect(page.getByRole('region', { name: 'What players call it' })).toBeVisible();
    const timeline = page.getByRole('region', { name: 'The Starfall series' });
    await expect(timeline.getByRole('button', { name: /^Starfall Tactics II/ })).toHaveAttribute('aria-current', 'page');
    await noSeriousViolations(page, '.gi');
    await noSeriousViolations(page, '.gi-ft');
    await timeline.getByRole('button', { name: /^Starfall Tactics, 2019.*In your library/ }).click();
    await expect(page.getByRole('heading', { name: 'Starfall Tactics', level: 1 })).toBeAttached();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

test.describe('library: community tag filters', () => {
  test('a tag picker narrows the library; chips remove tags; axe-clean', async ({ page }) => {
    const { errors } = await open(page, '?reduced&tags');
    await nav(page, /Library/);
    const cards = page.locator('.vgrid [data-game-id]');
    await expect(cards.first()).toBeVisible();
    const all = await cards.count();
    await page.getByRole('button', { name: /^Tags/ }).click();
    const picker = page.getByRole('dialog', { name: 'Filter by community tags' });
    await expect(picker).toContainText('Steam games tagged');
    await picker.getByRole('combobox', { name: 'Find a tag' }).fill('raci');
    await expect(picker.getByRole('option', { name: /^Racing/ })).toBeVisible();
    await noSeriousViolations(page, '.lib-tags');
    await page.keyboard.press('Enter');
    await expect(picker.getByRole('option', { name: /^Racing/ })).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(picker).toHaveCount(0);
    await expect.poll(async () => cards.count()).toBeLessThan(all);
    await expect(cards.filter({ hasText: 'Nebula Drift' })).toBeVisible();
    await page.getByRole('button', { name: 'Remove tag filter Racing' }).click();
    await expect.poll(async () => cards.count()).toBe(all);
    expect(errors).toEqual([]);
  });

  test('“#tag” and “tagged …” work in the filter box', async ({ page }) => {
    await open(page, '?reduced&tags');
    await nav(page, /Library/);
    const cards = page.locator('.vgrid [data-game-id]');
    await expect(cards.first()).toBeVisible();
    const all = await cards.count();
    await page.getByLabel('Filter library').fill('#racing');
    await expect(page.locator('.lib-chips')).toContainText('Tagged Racing');
    await expect.poll(async () => cards.count()).toBeLessThan(all);
    await page.getByLabel('Filter library').fill('tagged sci-fi');
    await expect(page.locator('.lib-chips')).toContainText('Tagged Sci-fi');
  });

  test('a tag on a game page opens the library filtered by it', async ({ page }) => {
    await open(page, '?reduced&tags');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('region', { name: 'What players call it' }).getByRole('button', { name: /^Racing\./ }).click();
    await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove tag filter Racing' })).toBeVisible();
  });

  test('while tags are still being looked up, the picker says so', async ({ page }) => {
    await open(page, '?reduced&tags=loading');
    await nav(page, /Library/);
    await page.getByRole('button', { name: /^Tags/ }).click();
    await expect(page.getByRole('dialog', { name: 'Filter by community tags' })).toContainText('looking up more');
  });
});

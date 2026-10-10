import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track C3: Discover 2.0 on the preview backend's FICTIONAL catalogue. `?discover` opens Discover with nothing typed;
// `?discoverStore` starts with Steam's store shelves on; `?discoverStoreFail` makes them fail; `?discoverNoKeys` acts as
// if IGDB isn't connected; `?wishlist` turns the Steam wishlist on. The preview never touches the network.

async function open(page: Page, query: string) {
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

const shelf = (page: Page, name: string | RegExp) => page.locator('section.dshelf').filter({ has: page.getByRole('heading', { name }) });

test.describe('Discover browse (nothing typed)', () => {
  test('featured picks, “Because you played” rows, genres, and an invitation to Steam’s shelves', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&discover');
    const because = page.locator('section.dshelf[data-shelf^="because:"]').first();
    await expect(because).toBeVisible({ timeout: 15_000 });
    await expect(because.getByRole('heading', { name: /^Because you played / })).toBeVisible();
    await expect(because.locator('.dshelf__reason')).toContainText('Similar games, according to IGDB');
    // Nothing you own is suggested.
    await expect(because.locator('.dcard[data-owned]')).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'Featured picks' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Browse by genre or tag' })).toBeVisible();

    // Steam's shelves are opt-in: an invitation, then the rows.
    const invite = page.locator('[data-invite="store"]');
    await expect(invite).toContainText('Bring Steam’s store shelves into Discover');
    await noSeriousViolations(page, '.discover');
    await invite.getByRole('button', { name: 'Show Steam shelves' }).click();
    await expect(shelf(page, 'Trending on Steam')).toBeVisible({ timeout: 15_000 });
    await expect(shelf(page, 'Coming soon')).toBeVisible();
    await expect(shelf(page, 'Free to play').locator('.dcard__price[data-free]').first()).toHaveText('Free');
    await expect(page.locator('[data-invite="store"]')).toHaveCount(0);
    await expect(page.getByText(/From Steam’s public store lists in your price country/)).toBeVisible();
    await noSeriousViolations(page, '.discover');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('the carousel moves with its controls, pauses, and opens a game page', async ({ page }) => {
    await open(page, '?reduced&discover&discoverStore&wishlist');
    const hero = page.getByRole('region', { name: 'Featured picks' });
    await expect(hero).toBeVisible({ timeout: 15_000 });
    const dots = hero.getByRole('group', { name: 'Choose a pick' }).getByRole('button');
    await expect.poll(async () => dots.count(), { timeout: 15_000 }).toBeGreaterThan(2);
    const first = await hero.locator('.dhero__slide[data-active] .dhero__title').textContent();
    await hero.getByRole('button', { name: 'Next pick' }).click();
    await expect(hero.locator('.dhero__slide[data-active] .dhero__title')).not.toHaveText(first ?? '');
    await expect(dots.nth(1)).toHaveAttribute('aria-current', 'true');
    // Arrow keys from the controls, too.
    await hero.getByRole('button', { name: 'Next pick' }).press('ArrowLeft');
    await expect(dots.nth(0)).toHaveAttribute('aria-current', 'true');
    // Reduced motion: no auto-advance, so no Pause button either.
    await expect(hero.getByRole('button', { name: /Pause the featured picks/ })).toHaveCount(0);

    const title = (await hero.locator('.dhero__slide[data-active] .dhero__title').textContent()) ?? '';
    await hero.locator('.dhero__slide[data-active]').getByRole('button', { name: 'See the game' }).click();
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
  });

  test('wishlist deals and Steam rows are keyboard-friendly and open VYSTRAL pages', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&discover&discoverStore&wishlist');
    const sale = shelf(page, 'From your wishlist, on sale');
    await expect(sale).toBeVisible({ timeout: 15_000 });
    await expect(sale.locator('.dcard').first()).toContainText('Starward Couriers'); // the biggest discount first
    await expect(sale.locator('.dcard__cut').first()).toHaveText('−75%');

    const trending = shelf(page, 'Trending on Steam');
    const cards = trending.locator('.dcard');
    await cards.first().focus();
    await page.keyboard.press('ArrowRight');
    await expect(cards.nth(1)).toBeFocused();
    await page.keyboard.press('End');
    await expect(cards.last()).toBeFocused();
    await page.keyboard.press('Home');
    await expect(cards.first()).toBeFocused();

    const name = (await cards.first().locator('.dcard__title').textContent()) ?? '';
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name, level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('browse a genre or tag, page through it, and come back', async ({ page }) => {
    await open(page, '?reduced&discover&discoverStore');
    const genres = page.getByRole('navigation', { name: 'Browse by genre or tag' });
    await genres.getByRole('button', { name: 'Racing' }).click();
    await expect(page.getByRole('heading', { name: 'Racing', level: 2 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Racing', level: 2 })).toBeFocused();
    await expect(genres.getByRole('button', { name: 'Racing' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('.dgrid .dcard').filter({ hasText: 'Riders of the Red Dune' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(/Steam, most popular first/)).toBeVisible();
    await noSeriousViolations(page, '.discover');

    await genres.getByRole('button', { name: '#Horror' }).click();
    await expect(page.locator('.dgrid .dcard').filter({ hasText: 'Echoes of the Deep' })).toBeVisible({ timeout: 15_000 });
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.getByRole('heading', { name: 'Racing', level: 2 })).toBeVisible();
    await page.getByRole('button', { name: 'All of Discover' }).click();
    await expect(page.getByRole('region', { name: 'Featured picks' })).toBeVisible({ timeout: 15_000 });
  });

  test('without IGDB or Steam’s shelves: honest invitations instead of empty rows', async ({ page }) => {
    await open(page, '?reduced&discover&discoverNoKeys');
    await expect(page.locator('[data-invite="because"]')).toContainText('See games like the ones you play', { timeout: 15_000 });
    await page.getByRole('navigation', { name: 'Browse by genre or tag' }).getByRole('button', { name: 'Puzzle' }).click();
    await expect(page.getByText('Browsing by genre needs Steam’s shelves or IGDB')).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'Show Steam shelves' }).click();
    await expect(page.locator('.dgrid .dcard').filter({ hasText: 'Paper Comets' })).toHaveCount(0); // not on Steam
    await expect(page.locator('.dgrid .dcard').filter({ hasText: 'Keeper of Small Things' })).toBeVisible({ timeout: 15_000 });
    await page.getByRole('button', { name: 'All of Discover' }).click();
    // Steam's tags now stand in for IGDB.
    await expect(page.locator('section.dshelf[data-shelf^="because:"] .dshelf__reason').first()).toContainText('Shares Steam tags', { timeout: 15_000 });
  });

  test('when Steam’s shelves can’t be fetched, it says so and offers to try again', async ({ page }) => {
    await open(page, '?reduced&discover&discoverStore&discoverStoreFail');
    await expect(page.getByRole('alert').filter({ hasText: 'Steam couldn’t be reached' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('alert').getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

test.describe('Discover results', () => {
  test('editions and add-ons fold under their game', async ({ page }) => {
    await open(page, '?reduced&discover=starfall');
    const group = page.locator('.dgroup').filter({ hasText: 'Starfall Tactics II' });
    await expect(group).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('section[aria-labelledby="disc-rest"]')).toHaveAttribute('aria-busy', 'false', { timeout: 15_000 });
    const toggle = group.locator('.dgroup__toggle');
    await expect(toggle).toHaveText(/Also 1 edition/);
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await group.getByRole('button', { name: /Starfall Tactics II Deluxe Edition/ }).click();
    await expect(page.getByRole('heading', { name: 'Starfall Tactics II Deluxe Edition', level: 1 })).toBeVisible();
  });
});

test.describe('Wishlist → game pages', () => {
  test('a wishlist game opens its VYSTRAL page; the Steam store stays a secondary action', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&wishlist');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Wishlist' }).click();
    const list = page.getByRole('list', { name: /wishlisted games/ });
    await expect(list).toBeVisible({ timeout: 15_000 });
    await expect(list.getByRole('button', { name: 'Open Aurora Vanguard on the Steam store' })).toBeVisible();
    await list.getByRole('button', { name: /^Aurora Vanguard\. Open its page/ }).click();
    await expect(page.getByRole('heading', { name: 'Aurora Vanguard', level: 1 })).toBeVisible();
    await expect(page.locator('.ddhero__route')).toContainText('Not in your library');
    await noSeriousViolations(page);
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    // A wishlist game you already own opens your own page.
    await list.getByRole('button', { name: /^Deep Field\. Open its page in your library/ }).click();
    await expect(page.getByRole('heading', { name: 'Deep Field', level: 1 })).toBeVisible();
    await expect(page.locator('.ddhero')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

// Not a test of behaviour: pictures for reviewing the design (only with SHOTS=<folder>).
test('screenshots for review', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'only on request');
  const dir = process.env.SHOTS!;
  await open(page, '?discover&discoverStore&wishlist');
  await expect(shelf(page, 'Trending on Steam')).toBeVisible({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${dir}/browse-top.png` });
  await page.locator('section.dshelf[data-shelf^="because:"]').first().scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${dir}/browse-2.png` });
  await shelf(page, 'Trending on Steam').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${dir}/browse-3.png` });
  await shelf(page, 'Free to play').scrollIntoViewIfNeeded();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${dir}/browse-4.png` });
  await page.getByRole('navigation', { name: 'Browse by genre or tag' }).getByRole('button', { name: 'RPG' }).click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${dir}/genre.png` });
  await page.goto('/?discover=starfall');
  await page.waitForTimeout(2500);
  await page.locator('.dgroup__toggle').first().click();
  await page.screenshot({ path: `${dir}/results.png` });
  await page.goto('/?discover&discoverNoKeys');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: `${dir}/invites.png`, fullPage: true });
  await page.goto('/?wishlist');
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Wishlist' }).click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${dir}/wishlist.png` });
});

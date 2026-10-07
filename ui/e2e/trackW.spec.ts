import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track W: Steam data extras on the preview backend (fictional data only).
// ?wishlist (=empty | =loading | =invalid), ?friendsHistory (=loading), ?news (=empty | =offline), ?achGuide.

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

test.describe('wishlist', () => {
  test('is off by default: no sidebar entry; the command bar opens an invitation that turns it on', async ({ page }) => {
    const { errors } = await open(page);
    const sidebar = page.getByRole('navigation', { name: 'Main' });
    await expect(sidebar.getByRole('button', { name: 'Wishlist' })).toHaveCount(0);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search' }).fill('wishlist');
    await page.getByRole('option', { name: /Wishlist/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Wishlist', level: 1 })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Bring your Steam wishlist into VYSTRAL' })).toBeVisible();
    await page.getByRole('button', { name: 'Show my wishlist' }).click();
    await expect(page.getByRole('list', { name: /wishlisted games/ })).toBeVisible();
    await expect(sidebar.getByRole('button', { name: 'Wishlist' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('lists prices, lowest-ever, release badges and price history; sorts and filters; axe-clean', async ({ page }) => {
    const { errors, external } = await open(page, '?wishlist&reduced');
    await nav(page, 'Wishlist');
    const list = page.getByRole('list', { name: /12 wishlisted games/ });
    await expect(list).toBeVisible();

    const lantern = list.getByRole('listitem').filter({ hasText: 'Lantern Shore' });
    await expect(lantern.getByText('Released!')).toBeVisible();          // launch day
    await expect(lantern.getByText('Out today')).toBeVisible();
    const halcyon = list.getByRole('listitem').filter({ hasText: 'Halcyon Depths' });
    await expect(halcyon.getByText('Out in 3 days')).toBeVisible();
    await expect(halcyon.getByText('Not for sale yet')).toBeVisible();   // coming soon, no price on Steam yet
    const starward = list.getByRole('listitem').filter({ hasText: 'Starward Couriers' });
    await expect(starward.getByText('−75%')).toBeVisible();
    await expect(starward.getByText('Lowest price ever')).toBeVisible();
    await expect(starward.getByRole('img', { name: /Steam price seen by VYSTRAL since/ })).toBeVisible();
    const clockwork = list.getByRole('listitem').filter({ hasText: 'Clockwork Pilgrim' });
    await expect(clockwork.getByText(/Lowest ever/)).toBeVisible();
    await expect(clockwork.getByText(/% higher now/)).toBeVisible();
    await expect(list.getByRole('listitem').filter({ hasText: 'Glacier Run' }).getByText('Free to play')).toBeVisible();
    await expect(list.getByRole('listitem').filter({ hasText: 'Deep Field' }).getByRole('button', { name: 'In your library' })).toBeVisible();
    await expect(page.getByText(/Lowest price ever from IsThereAnyDeal/)).toBeVisible();

    // Sort by price drop: the biggest discount first.
    await page.getByLabel('Sort wishlist').selectOption('drop');
    await expect(list.getByRole('listitem').first()).toContainText('Starward Couriers');
    // Release date: the soonest upcoming first.
    await page.getByLabel('Sort wishlist').selectOption('release');
    await expect(list.getByRole('listitem').first()).toContainText('Halcyon Depths');
    // Filters.
    await page.getByRole('radio', { name: 'Lowest ever' }).click();
    await expect(page.getByRole('list', { name: /3 wishlisted games/ })).toBeVisible();
    await page.getByRole('radio', { name: 'All' }).click();
    await page.getByLabel('Search your wishlist').fill('vesper');
    await expect(page.getByRole('list', { name: /1 wishlisted game$/ })).toBeVisible();
    await page.getByLabel('Search your wishlist').fill('');

    await list.getByRole('button', { name: 'Open Starward Couriers on the Steam store' }).click();
    await page.getByRole('button', { name: 'Refresh' }).click();
    await expect(page.getByText(/^Updated /)).toBeVisible();
    await noSeriousViolations(page, '.wish');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('empty, first refresh and rejected-key states explain themselves', async ({ page }) => {
    await open(page, '?wishlist=empty&reduced');
    await nav(page, 'Wishlist');
    await expect(page.getByRole('heading', { name: 'Your wishlist is empty' })).toBeVisible();
    await expect(page.getByText(/Game details are public/)).toBeVisible();

    await page.goto('/?wishlist=loading&reduced');
    await nav(page, 'Wishlist');
    await expect(page.getByText(/Reading your wishlist from Steam/)).toBeVisible();
    await expect(page.getByRole('list', { name: /wishlisted games/ })).toBeVisible({ timeout: 15_000 });

    await page.goto('/?wishlist=invalid&reduced');
    await nav(page, 'Wishlist');
    await expect(page.getByRole('heading', { name: 'Steam didn’t accept your key' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Check the key' })).toBeVisible();
  });
});

test.describe('friends who played a game', () => {
  test('is off by default: no chip on the game page', async ({ page }) => {
    await open(page);
    await openGame(page, 'Nebula Drift');
    await expect(page.locator('.fpchip')).toHaveCount(0);
  });

  test('shows an avatar stack with two-week playtime, opens the list, and is axe-clean', async ({ page }) => {
    const { errors, external } = await open(page, '?friendsHistory&reduced');
    await openGame(page, 'Nebula Drift');
    const chip = page.getByRole('button', { name: /3 friends played this recently/ });
    await expect(chip).toBeVisible();
    await expect(chip).toContainText('10 h 45 min in the last two weeks');
    await expect(chip).toHaveAttribute('aria-expanded', 'false');
    await chip.click();
    const list = page.getByRole('list', { name: 'Friends who played this in the last two weeks' });
    await expect(list.getByRole('listitem').first()).toContainText('Juniper');
    await expect(list.getByRole('listitem').first()).toContainText('6 h 52 min');
    await expect(list.getByRole('listitem').nth(2)).toContainText('Saffron'); // no avatar: an initial instead
    await expect(page.getByText(/From friends’ public Steam profiles/)).toBeVisible();
    await noSeriousViolations(page, '.dhero');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('the first round says it takes a while', async ({ page }) => {
    await open(page, '?friendsHistory=loading&reduced');
    await openGame(page, 'Nebula Drift');
    await expect(page.getByText(/Checking what your friends played/)).toBeVisible();
  });
});

test.describe('achievement guide', () => {
  test('lists locked achievements easiest first, reveals hidden ones on request, and pins a goal by Play', async ({ page }) => {
    const { errors } = await open(page, '?achGuide&reduced');
    await openGame(page, 'Nebula Drift');
    // The pinned goal shows next to Play, from the cache.
    const goalChip = page.getByRole('button', { name: /^Current goal: .+ Open achievements$/ });
    await expect(goalChip).toBeVisible();
    await goalChip.click();
    await expect(page.getByRole('tab', { name: 'Achievements', selected: true })).toBeVisible();
    const guide = page.getByRole('complementary', { name: 'Next to aim for' });
    await expect(guide).toBeVisible();
    await expect(guide.getByText('Current goal')).toBeVisible();
    const items = guide.getByRole('list', { name: 'Locked achievements, easiest first' }).getByRole('listitem');
    await expect(items.first()).toBeVisible();

    // Easiest first: percentages never increase down the list.
    const pcts = (await items.locator('.achguide__rarity .num').allTextContents()).map((t) => parseFloat(t.replace('<', '')));
    expect(pcts.length).toBeGreaterThan(2);
    for (let i = 1; i < pcts.length; i++) expect(pcts[i]).toBeLessThanOrEqual(pcts[i - 1]);

    // Pin another one: the chip follows.
    const second = items.nth(1);
    const name = (await second.locator('.achguide__name').first().innerText()).replace('Hidden', '').trim();
    await second.getByRole('button', { name: new RegExp(`^Pin .+ as your current goal$`) }).click();
    await expect(page.getByRole('button', { name: new RegExp(`^Current goal: ${name}`) })).toBeVisible();

    // A hidden one stays secret until asked.
    const reveal = guide.getByRole('button', { name: /Reveal what it asks/ }).first();
    if (await reveal.count()) {
      await reveal.click();
      await expect(guide.getByText(/Sample hidden achievement/).first()).toBeVisible();
    }
    await noSeriousViolations(page, '.achguide');
    expect(errors).toEqual([]);
  });
});

test.describe('news and patch notes', () => {
  test('highlights updates since you last played, renders sanitized posts, loads images, and is axe-clean', async ({ page }) => {
    const { errors, external } = await open(page, '?news&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'News' }).click();
    await expect(page.getByText(/^Updated since you last played: one patch/)).toBeVisible();
    const posts = page.getByRole('list', { name: /posts from Steam/ });
    const first = posts.locator('.news-item').first();
    await expect(first.getByText('Since you last played')).toBeVisible();
    await expect(first.getByText('Patch notes')).toBeVisible();
    // The newest post opens by itself, with its list, heading and quote rendered as text.
    await expect(first.getByRole('button', { name: /Patch 1\.4\.2/ })).toHaveAttribute('aria-expanded', 'true');
    await expect(first.getByRole('heading', { name: 'Fixes', exact: true })).toBeVisible();
    await expect(first.getByText('Fixed a rare crash when loading a save made during a cutscene.')).toBeVisible();
    await expect(first.locator('strong', { hasText: 'high refresh rate' })).toBeVisible();
    await expect(first.locator('img.news-body__img')).toHaveCount(1);       // loaded on open
    await expect(first.getByRole('button', { name: 'Open full post' })).toBeVisible();
    await first.getByRole('button', { name: 'Open full post' }).click();

    // Older posts are collapsed with an excerpt.
    const second = posts.locator('.news-item').nth(1);
    await expect(second.getByRole('button', { name: /Community spotlight/ })).toHaveAttribute('aria-expanded', 'false');
    await second.getByRole('button', { name: /Community spotlight/ }).click();
    await expect(second.getByText(/photo-mode tag/)).toBeVisible();
    await noSeriousViolations(page, '.news');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('offline shows saved posts; empty says so; non-Steam games have no News tab', async ({ page }) => {
    await open(page, '?news=offline&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'News' }).click();
    await expect(page.getByText(/Offline mode is on, so these are the posts saved/)).toBeVisible();

    await page.goto('/?news=empty&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'News' }).click();
    await expect(page.getByRole('heading', { name: 'No announcements yet' })).toBeVisible();

    await openGame(page, 'Hollow Lantern'); // GOG only
    await expect(page.getByRole('tab', { name: 'Achievements' })).toBeVisible();
    await expect(page.getByRole('tab', { name: 'News' })).toHaveCount(0);
  });
});

test.describe('settings', () => {
  test('Steam extras rows explain each switch and the notification category exists', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+,');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Library & stores' }).click();
    const group = page.getByRole('region', { name: 'Steam extras' });
    await expect(group).toBeVisible();
    await expect(group.getByRole('switch', { name: 'Wishlist' })).not.toBeChecked();
    await expect(group.getByRole('switch', { name: 'Friends who played a game' })).not.toBeChecked();
    await expect(group.getByRole('switch', { name: 'News and patch notes' })).toBeChecked();
    await group.getByRole('switch', { name: 'Wishlist' }).click();
    await expect(group.getByRole('button', { name: 'Open' })).toBeVisible();
    await noSeriousViolations(page, '[aria-labelledby="steamextras-title"]');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Windows integration' }).click();
    await expect(page.getByText('Wishlist news')).toBeVisible();
  });
});

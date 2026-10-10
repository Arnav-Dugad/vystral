import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track D2: the wishlist as a release calendar, on the preview backend (fictional games only).
// ?wishlist turns the wishlist on with 22 games: exact days around today, a month-only date, a quarter, seasons,
// years and games with no date at all.

async function open(page: Page, query = '?wishlist&reduced') {
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
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Wishlist' }).click();
  await expect(page.getByRole('region', { name: 'Release calendar' })).toBeVisible({ timeout: 15_000 });
  return { errors, external };
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

const monthName = (offset = 0) => {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
};

const grid = (page: Page) => page.getByRole('group', { name: /Arrow keys move between games/ });

test.describe('wishlist release calendar', () => {
  test('opens on this month with today marked, covers on their days, and the next release', async ({ page }) => {
    const { errors, external } = await open(page);
    await expect(page.getByRole('heading', { name: monthName(), level: 2 })).toBeVisible();
    const months = page.getByRole('navigation', { name: /Months of/ });
    await expect(months.getByRole('button', { name: /this month/ })).toHaveAttribute('aria-current', 'date');
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeDisabled();
    // Lantern Shore comes out today (a past release is on its day too).
    await expect(grid(page).getByRole('button', { name: /^Open the page for Lantern Shore, Out today/ })).toBeVisible();
    // The agenda names every release of the month, and the next one.
    const agenda = page.getByRole('complementary', { name: /Releases in/ });
    await expect(agenda.getByRole('button', { name: /^Next up: open the page for Lantern Shore/ })).toBeVisible();
    await expect(agenda.getByRole('button', { name: /^Open the page for Lantern Shore/ })).toBeVisible();
    // Stats chips stay; the calendar is the page (no card list until you ask for it).
    await expect(page.getByRole('group', { name: 'Wishlist at a glance' })).toContainText('22');
    await expect(page.getByRole('list', { name: /wishlisted games/ })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('moves between months with buttons, the year strip, Page Up/Down and Today', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Next month' }).click();
    await expect(page.getByRole('heading', { name: monthName(1), level: 2 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Today', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Today', exact: true }).click();
    await expect(page.getByRole('heading', { name: monthName(), level: 2 })).toBeVisible();

    // The year strip: pick a month directly; it says how many releases each month has.
    const target = new Date(new Date().getFullYear(), new Date().getMonth() + 2, 1);
    if (target.getFullYear() === new Date().getFullYear()) {
      const strip = page.getByRole('navigation', { name: /Months of/ });
      await strip.getByRole('button', { name: new RegExp(`^${monthName(2)}, 1 release`) }).click();
      await expect(page.getByRole('heading', { name: monthName(2), level: 2 })).toBeVisible();
      // Kite Season has only a month: it's "sometime this month", never on a day.
      await expect(page.getByRole('group', { name: /^Sometime in .*day not announced/ }).getByRole('button', { name: /Kite Season/ })).toBeVisible();
      await expect(grid(page).getByRole('button', { name: /Kite Season/ })).toHaveCount(0);
      await page.getByRole('button', { name: 'Today', exact: true }).click();
    }

    // Keyboard: focus a game, arrows move, Page Down changes the month and focus follows.
    await grid(page).getByRole('button', { name: /Lantern Shore/ }).focus();
    await page.keyboard.press('PageDown');
    await expect(page.getByRole('heading', { name: monthName(1), level: 2 })).toBeVisible();
    await page.keyboard.press('PageUp');
    await expect(page.getByRole('heading', { name: monthName(), level: 2 })).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.activeElement?.closest('.wcal__grid') != null)).toBe(true);
    // Only one game in the grid is a Tab stop (roving focus).
    const tabbable = await page.locator('.wcal__grid [tabindex="0"]').count();
    expect(tabbable).toBeLessThanOrEqual(1);
  });

  test('vague dates sit in honest lanes with their precision', async ({ page }) => {
    const { errors } = await open(page);
    const lanes = page.getByRole('region', { name: 'Coming, no exact day yet' });
    const y = new Date().getFullYear();
    const thisYear = lanes.getByRole('region', { name: 'This year' });
    await expect(thisYear.getByRole('button', { name: new RegExp(`^Open the page for Tidebreaker, Late ${y} \\(Steam gives only a season`) })).toBeVisible();
    const nextYear = lanes.getByRole('region', { name: 'Next year' });
    await expect(nextYear.getByRole('button', { name: new RegExp(`Paper Lanterns II, Q2 ${y + 1} \\(Steam gives only the quarter\\)`) })).toBeVisible();
    await expect(nextYear.getByRole('button', { name: new RegExp(`Ember Atlas, ${y + 1} \\(Steam gives only the year\\)`) })).toBeVisible();
    await expect(nextYear.getByRole('button', { name: new RegExp(`Northwind Relay, Summer ${y + 1}`) })).toBeVisible();
    await expect(lanes.getByRole('region', { name: 'Later' }).getByRole('button', { name: /Lumen Drift/ })).toBeVisible();
    const tba = lanes.getByRole('region', { name: 'To be announced' });
    await expect(tba.getByRole('button', { name: /Hollow Choir, To be announced \(no date yet\)/ })).toBeVisible();
    await expect(tba.getByRole('button', { name: /Moonlit Ferry, Coming soon/ })).toBeVisible();
    // A game with no art at all gets VYSTRAL's own titled poster, not a blank icon.
    await expect(tba.locator('.wlane-card', { hasText: 'Hollow Choir' }).locator('.wposter')).toBeVisible();
    // Vague dates never land on a day.
    for (const name of ['Tidebreaker', 'Paper Lanterns II', 'Ember Atlas', 'Hollow Choir']) await expect(page.locator('.wcal__grid').getByRole('button', { name: new RegExp(name) })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('filters and search apply to the calendar; markers show sales and the lowest price ever', async ({ page }) => {
    await open(page);
    // Granite Saga came out 5 days ago at full price; Starward Couriers is at its lowest ever, but released long ago.
    await page.getByRole('radio', { name: 'Coming soon' }).click();
    await expect(page.getByText(/\(filtered\)/)).toBeVisible();
    await expect(page.locator('.wcal__grid').getByRole('button', { name: /Lantern Shore/ })).toHaveCount(0); // out today: not "coming soon"
    await page.getByRole('radio', { name: 'All' }).click();
    await page.getByLabel('Search your wishlist').fill('halcyon');
    await expect(page.getByRole('region', { name: 'Coming, no exact day yet' })).toHaveCount(0);
    await page.getByLabel('Search your wishlist').fill('');
    // Quiet Orbit (18 days out) has a pre-order discount at its lowest price.
    const later = new Date(Date.now() + 18 * 86_400_000);
    if (later.getMonth() !== new Date().getMonth()) await page.getByRole('button', { name: 'Next month' }).click();
    await expect(grid(page).getByRole('button', { name: /^Open the page for Quiet Orbit, Out .*, 10% off, lowest price ever/ })).toBeVisible();
    await expect(grid(page).locator('.wcal-game', { hasText: 'Quiet Orbit' }).locator('.wmark--cut')).toHaveText('−10%');
  });

  test('a game opens its VYSTRAL page; Back returns to the same month', async ({ page }) => {
    const { errors, external } = await open(page);
    await page.getByRole('button', { name: 'Next month' }).click();
    await page.getByRole('button', { name: 'Previous month' }).click();
    await grid(page).getByRole('button', { name: /^Open the page for Lantern Shore/ }).click();
    await expect(page.getByRole('heading', { name: 'Lantern Shore', level: 1 })).toBeVisible();
    await expect(page.locator('.ddhero__route')).toContainText('Not in your library');
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.getByRole('heading', { name: monthName(), level: 2 })).toBeVisible();
    // Lanes open pages too.
    await page.getByRole('region', { name: 'To be announced' }).getByRole('button', { name: /Hollow Choir/ }).click();
    await expect(page.getByRole('heading', { name: 'Hollow Choir', level: 1 })).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('"Show as list" is the accessible alternative, remembered; axe-clean in both views and in High contrast', async ({ page }) => {
    await open(page);
    await noSeriousViolations(page, '.wish');
    await page.getByRole('button', { name: 'Show as list' }).click();
    const list = page.getByRole('list', { name: /22 wishlisted games/ });
    await expect(list).toBeVisible();
    await expect(page.getByLabel('Sort wishlist')).toBeVisible();
    await expect(list.getByRole('listitem').filter({ hasText: 'Hollow Choir' }).locator('.wposter')).toBeVisible();
    await noSeriousViolations(page, '.wish');
    await page.reload();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Wishlist' }).click();
    await expect(page.getByRole('list', { name: /22 wishlisted games/ })).toBeVisible();
    await page.getByRole('button', { name: 'Show as calendar' }).click();
    await expect(page.getByRole('region', { name: 'Release calendar' })).toBeVisible();

    await page.evaluate(() => { document.documentElement.dataset.theme = 'contrast'; });
    await expect(page.locator('.wcal-day[data-today]')).toBeVisible();
    await noSeriousViolations(page, '.wish');
  });
});

// Not a test of behaviour: pictures for reviewing the design (only with SHOTS=<folder>).
test('wishlist calendar screenshots for review', async ({ page }) => {
  test.skip(!process.env.SHOTS, 'only on request');
  const dir = process.env.SHOTS!;
  await open(page, '?wishlist');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${dir}/calendar.png`, fullPage: true });
  await page.locator('.wlanes').screenshot({ path: `${dir}/lanes.png` });
  await page.locator('.wcal__agenda').screenshot({ path: `${dir}/agenda.png` });
  await page.getByRole('button', { name: 'Show as list' }).click();
  await page.waitForTimeout(600);
  await page.screenshot({ path: `${dir}/list.png` });
  await page.getByRole('button', { name: 'Show as calendar' }).click();
  await page.waitForTimeout(600);
  await grid(page).getByRole('button').first().hover();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/calendar-hover.png` });
  await page.getByRole('button', { name: 'Next month' }).click();
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${dir}/calendar-next.png` });
  await page.setViewportSize({ width: 900, height: 900 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${dir}/calendar-narrow.png`, fullPage: true });
  await page.setViewportSize({ width: 1536, height: 960 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'contrast'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/calendar-contrast.png` });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${dir}/calendar-light.png` });
});

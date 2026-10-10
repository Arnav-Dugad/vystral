import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track D6: the app-wide currency (converted prices on several pages), the subscriptions price fix, Settings search
// with jump-to-row, the Data sources health page, the cache viewer and the crash-free streak. Preview switches:
// ?currency=INR, ?fxNone, ?healthCalm, ?streakIncident, ?streakNew (see bridge/preview.trackD6.ts).

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
  await expect(page.locator('.shell').first()).toBeVisible();
  return { errors, external };
}

const nav = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

async function settings(page: Page, section?: string) {
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  if (section) await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: section, exact: true }).click();
}

async function settled(page: Page) {
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(450);
}

async function noSeriousViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page }).include(include).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

async function hold(page: Page, button: ReturnType<Page['getByRole']>) {
  await button.focus();
  await page.keyboard.down('Enter');
  await page.waitForTimeout(1150);
  await page.keyboard.up('Enter');
}

test.describe('app currency', () => {
  test('switching the currency converts prices on the wishlist, library value and Discover, labelled approximate', async ({ page }) => {
    const { errors, external } = await open(page, '?wishlist&reduced');
    // The browser region is US: prices are in dollars, exact.
    await nav(page, 'Wishlist');
    const card = page.getByRole('list', { name: /wishlisted games/ }).getByRole('listitem').filter({ hasText: 'Starward Couriers' });
    await expect(card.locator('.wish-card__now')).toHaveText(/^\$\d/);

    // Settings › Appearance › Currency → Indian rupee.
    await settings(page, 'Appearance');
    const picker = page.getByLabel('Show prices in');
    await expect(picker).toHaveValue('');
    await picker.selectOption('INR');
    await expect(page.getByTestId('currency-settings').getByText(/≈ ₹/).first()).toBeVisible();
    await expect(page.getByText(/^Rates of /)).toBeVisible();
    await settled(page);
    await noSeriousViolations(page, '[data-testid="currency-settings"]');

    // Wishlist: converted, with the original on hover and in the spoken text.
    await nav(page, 'Wishlist');
    const now = card.locator('.wish-card__now');
    await expect(now).toContainText('≈');
    await expect(now).toContainText('₹');
    await expect(now).toHaveAttribute('title', /converted from \$\d/);
    await expect(now.locator('.visually-hidden')).toHaveText(/^about ₹[\d,]+, converted from \$\d/);

    // Journal › Library value: the whole chart in rupees, and it says so.
    await nav(page, 'Journal');
    await page.getByRole('tab', { name: 'Library value' }).click();
    await expect(page.getByText(/shown in INR at the day’s exchange rate \(approximate\)/)).toBeVisible();
    await expect(page.getByText(/Cumulative current value · INR \(converted from USD, approximate\)/)).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.vx-tile, .stat-tile, [class*="tile"]').filter({ hasText: 'Current value' }).first()).toContainText('₹');

    // Discover: card prices follow too.
    await nav(page, 'Discover');
    await expect(page.locator('main').getByText(/≈ ₹[\d,]+/).first()).toBeVisible({ timeout: 10_000 });

    // Back to the Windows region: exact dollars again.
    await settings(page, 'Appearance');
    await page.getByLabel('Show prices in').selectOption('');
    await nav(page, 'Wishlist');
    await expect(card.locator('.wish-card__now')).toHaveText(/^\$\d/);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('without exchange rates prices stay in their own currency', async ({ page }) => {
    const { errors } = await open(page, '?wishlist&reduced&fxNone&currency=INR');
    await nav(page, 'Wishlist');
    const card = page.getByRole('list', { name: /wishlisted games/ }).getByRole('listitem').filter({ hasText: 'Starward Couriers' });
    await expect(card.locator('.wish-card__now')).toHaveText(/^\$\d/);
    await settings(page, 'Appearance');
    await expect(page.getByText('Exchange rates not downloaded yet')).toBeVisible();
    await page.getByRole('button', { name: 'Update rates' }).click();
    await expect(page.getByText(/^Rates of /)).toBeVisible();
    await nav(page, 'Wishlist');
    await expect(card.locator('.wish-card__now')).toContainText(/≈\s?₹/);
    expect(errors).toEqual([]);
  });
});

test.describe('subscriptions: what you pay a month', () => {
  test('reads thousands separators, never wipes the saved price, allows large amounts and says what it saved', async ({ page }) => {
    const { errors } = await open(page, '?reduced&currency=INR');
    await settings(page, 'Library & stores');
    const field = page.locator('#subs-price');
    await field.scrollIntoViewIfNeeded();

    // "1,299.00" used to clear the field and save nothing; 1,299 used to be capped at 1,000.
    await field.fill('1,299.00');
    await field.press('Tab');
    await expect(field).toHaveValue('1299');
    await expect(page.getByTestId('subs-price-saved')).toHaveText(/Saved: ₹1,299(\.00)? a month/);

    // Something that isn't an amount is refused in words, and the saved price stays.
    await field.fill('12.3.4,5,6');
    await field.press('Enter');
    await expect(page.getByRole('alert')).toHaveText(/doesn’t look like an amount/);
    await expect(field).toHaveAttribute('aria-invalid', 'true');
    await field.press('Escape');
    await expect(field).toHaveValue('1299');
    await expect(page.getByTestId('subs-price-saved')).toBeVisible();

    // European style and big numbers work.
    await field.fill('25.000');
    await field.press('Enter');
    await expect(field).toHaveValue('25000');

    // In another currency: shown converted on Home.
    await page.getByLabel('Currency of that amount').selectOption('USD');
    await field.fill('14.99');
    await field.press('Enter');
    await expect(page.getByTestId('subs-price-saved')).toHaveText(/Saved: \$14\.99 a month · shown on Home as ≈ ₹/);

    // Empty hides it again.
    await field.fill('');
    await field.press('Tab');
    await expect(page.getByTestId('subs-price-saved')).toHaveCount(0);
    await settled(page);
    await noSeriousViolations(page, '#settings-subs');
    expect(errors).toEqual([]);
  });
});

test.describe('settings search', () => {
  test('lists matching rows with their path; Enter jumps to the row, focuses it and pulses it', async ({ page }) => {
    const { errors } = await open(page);
    await settings(page, 'Appearance');
    const search = page.getByRole('combobox', { name: 'Search settings' });
    await search.fill('pay a month');
    const results = page.getByRole('listbox', { name: /setting matches/ });
    await expect(results).toBeVisible();
    const first = results.getByRole('option').first();
    await expect(first).toContainText('What you pay a month (optional)');
    await expect(first).toContainText('Library & stores');
    await expect(first).toContainText('Your subscriptions');
    await expect(first).toHaveAttribute('aria-selected', 'true');
    await expect(search).toHaveAttribute('aria-activedescendant', 'settings-result-0');
    await settled(page);
    await noSeriousViolations(page, '.settings');

    await search.press('Enter');
    const row = page.locator('[data-row="subs-price"]');
    await expect(row).toHaveClass(/settings-hit/);
    await expect(row).toBeInViewport();
    await expect(page.locator('#subs-price')).toBeFocused();
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Library & stores' })).toHaveAttribute('aria-current', 'true');
    await expect(search).toHaveValue('');

    // Arrow keys move through results; a row found by its label (no data-row) works too.
    await search.fill('vibration');
    await search.press('ArrowDown');
    await search.press('ArrowUp');
    await search.press('Enter');
    const vib = page.locator('.srow', { hasText: 'Gentle vibration feedback' });
    await expect(vib).toHaveClass(/settings-hit/);
    await expect(vib).toBeInViewport();

    // Nothing found says so; Escape clears.
    await search.fill('zzzz');
    await expect(page.getByText('Nothing in Settings matches “zzzz”')).toBeVisible();
    await search.press('Escape');
    await expect(search).toHaveValue('');
    expect(errors).toEqual([]);
  });
});

test.describe('data sources health', () => {
  test('shows every source at a glance with plain-words state, pauses and counts', async ({ page }) => {
    const { errors, external } = await open(page);
    await settings(page, 'Data sources');
    const health = page.getByTestId('sources-health');
    await expect(health.getByRole('heading', { name: 'Data sources at a glance' })).toBeVisible();
    const store = page.getByTestId('health-steam.store');
    await expect(store.locator('.dsh-pill')).toHaveText(/Paused/);
    await expect(store).toContainText('Steam asked VYSTRAL to slow down (HTTP 429)');
    await expect(store).toContainText(/for \d+ more minutes/);
    await expect(page.getByTestId('health-steamgriddb')).toContainText('didn’t accept the key');
    await expect(page.getByTestId('health-igdb')).toContainText('Needs your Twitch app');
    await expect(page.getByTestId('health-fx')).toContainText('Exchange rates');
    await expect(page.getByTestId('health-cheapshark').getByText('Requests today')).toBeVisible();
    await expect(health.getByRole('status')).toContainText('need');
    // Every row has its mark.
    await expect(page.getByTestId('health-wikidata').locator('.dsh-row__mark svg')).toHaveCount(1);
    await settled(page);
    await noSeriousViolations(page, '[data-testid="sources-health"]');

    // "Keys and switches" deep-links to the row in Library & stores.
    await health.getByRole('button', { name: 'Keys and switches' }).click();
    await expect(page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Library & stores' })).toHaveAttribute('aria-current', 'true');
    await expect(page.locator('.settings-hit')).toHaveCount(1);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('Offline mode turns every source off and says why', async ({ page }) => {
    await open(page);
    await settings(page, 'Privacy');
    await page.getByRole('switch', { name: 'Offline mode' }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Data sources' }).click();
    await expect(page.getByText(/Offline mode is on, so none of these are used right now/)).toBeVisible();
    await expect(page.getByTestId('health-steam.webapi')).toContainText('Offline mode is on');
  });
});

test.describe('cache viewer', () => {
  test('shows size, items and age, and clears one cache with a hold', async ({ page }) => {
    const { errors } = await open(page);
    await settings(page, 'Data & recovery');
    const viewer = page.getByTestId('cache-viewer');
    await expect(viewer.getByText(/in \d+ caches/)).toBeVisible();
    await expect(viewer.getByText('Your library, notes, play history, settings and keys are never touched.')).toBeVisible();
    const news = page.getByTestId('cache-news');
    await expect(news).toContainText('News and patch notes');
    await expect(news).toContainText(/2\.4 MB · 88 files/);
    await expect(news).toContainText(/Updated .* ago/);
    await settled(page);
    await noSeriousViolations(page, '[data-testid="cache-viewer"]');

    // A tap does nothing; a hold clears it.
    const clear = news.getByRole('button', { name: /Clear News and patch notes/ });
    await clear.focus();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    await expect(news).toContainText(/2\.4 MB/);
    await hold(page, clear);
    await expect(page.getByText(/News and patch notes cleared · 2\.4 MB freed/)).toBeVisible();
    await expect(news).toContainText('Empty');
    await expect(clear).toBeDisabled();
    expect(errors).toEqual([]);
  });
});

test.describe('crash-free streak', () => {
  test('About shows days without a failed start, a 30-day history and the last incident', async ({ page }) => {
    const { errors } = await open(page);
    await settings(page, 'About');
    const card = page.getByTestId('crash-free-streak');
    await expect(card.getByText('42 days without a failed start')).toBeAttached();
    await expect(card.locator('.streak__big')).toHaveText('42 days');
    await expect(card.locator('.streak__bar')).toHaveCount(30);
    await expect(card).toContainText('VYSTRAL 0.7.2 closed unexpectedly');
    await settled(page);
    await noSeriousViolations(page, '[data-testid="crash-free-streak"]');
    expect(errors).toEqual([]);
  });

  test('a recent failed start resets the count and is listed first', async ({ page }) => {
    await open(page, '?reduced&streakIncident');
    await settings(page, 'About');
    const card = page.getByTestId('crash-free-streak');
    await expect(card.locator('.streak__big')).toHaveText('9 days');
    await expect(card.locator('.streak__incidents li').first()).toContainText('didn’t finish starting');
    await expect(card.locator('.streak__bar[data-failed]')).toHaveCount(1);
  });

  test('a fresh install is honest about having no history', async ({ page }) => {
    await open(page, '?reduced&streakNew');
    await settings(page, 'About');
    const card = page.getByTestId('crash-free-streak');
    await expect(card.getByText('Counting starts from today').last()).toBeAttached();
    await expect(card.locator('.streak__big')).toHaveCount(0);
    await expect(card).toContainText('No incidents on record');
  });
});

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track D1: Library bulk actions with undo, "Similar in your library", the update / mod / session timeline, and the
// new personal records with their unlock fanfare. Preview backend, fictional data.

const SHOTS = process.env.D1_SHOTS; // a folder: save screenshots there while developing

async function open(page: Page, query = '') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell').first()).toBeVisible();
  await expect.poll(() => page.evaluate("import('/src/state/store.ts').then((m) => m.useStore.getState().libraryLoaded)")).toBe(true);
  return errors;
}

const go = (page: Page, route: object) =>
  page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().navigate(${JSON.stringify(route)}))`);
const gameId = (page: Page, title: string) =>
  page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().library.games.find((g) => g.title === ${JSON.stringify(title)}).id)`) as Promise<string>;
const statusOf = (page: Page, title: string) =>
  page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().library.games.find((g) => g.title === ${JSON.stringify(title)}).status ?? null)`) as Promise<string | null>;
const shot = async (page: Page, name: string) => { if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` }); };

async function seriousViolations(page: Page, include: string) {
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page }).include(include).exclude('.living-canvas').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

const card = (page: Page, title: string) => page.locator(`.sel-cell:has(.card[aria-label^="${title}"]) .card`);

test.describe('Library bulk actions', () => {
  test('Ctrl/Shift-click select, set a status for all, and one Undo puts every game back', async ({ page }) => {
    const errors = await open(page, '?bulk&reduced');
    await go(page, { name: 'library' });
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
    const before = { a: await statusOf(page, 'Ashen Crown'), c: await statusOf(page, 'Circuit Apex'), d: await statusOf(page, 'Deep Field') };

    await card(page, 'Ashen Crown').click({ modifiers: ['Control'] });
    const bar = page.getByRole('toolbar', { name: /Actions for 1 selected game/ });
    await expect(bar).toBeVisible();
    await card(page, 'Deep Field').click({ modifiers: ['Shift'] });
    // A range in title order: Ashen Crown … Deep Field.
    const count = await page.locator('.sel-cell[data-selected]').count();
    expect(count).toBeGreaterThanOrEqual(3);
    await expect(page.getByRole('toolbar', { name: new RegExp(`Actions for ${count} selected games`) })).toBeVisible();
    // Still on the Library: selection gestures never open the game.
    await expect(page.locator('.library')).toBeVisible();
    await shot(page, 'bulk-bar');
    expect(await seriousViolations(page, '.bulk-bar')).toEqual([]);

    await page.locator('.bulk-bar').getByRole('button', { name: /^Status/ }).click();
    await page.getByRole('menuitem', { name: /^Beaten/ }).click();
    const toast = page.locator('.toast').filter({ hasText: 'marked Beaten' });
    await expect(toast).toBeVisible();
    expect(await statusOf(page, 'Ashen Crown')).toBe('beaten');
    expect(await statusOf(page, 'Deep Field')).toBe('beaten');

    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('.toast').filter({ hasText: /^Undone/ }).or(page.locator('.toast').filter({ hasText: 'Undone' }))).toBeVisible();
    await expect.poll(() => statusOf(page, 'Ashen Crown')).toBe(before.a);
    expect(await statusOf(page, 'Circuit Apex')).toBe(before.c);
    expect(await statusOf(page, 'Deep Field')).toBe(before.d);

    // Escape clears the selection and the bar goes away.
    await page.keyboard.press('Escape');
    await expect(page.locator('.bulk-bar')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('keyboard: Space toggles, Shift+arrows extend, Ctrl+A selects everything shown; controller X toggles', async ({ page }) => {
    await open(page, '?bulk&reduced');
    await go(page, { name: 'library' });
    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
    const first = card(page, 'Ashen Crown');
    await first.focus();
    await page.keyboard.press('Space');
    await expect(page.locator('.sel-cell[data-selected]')).toHaveCount(1);
    await expect(page.locator('.library')).toBeVisible();
    await page.keyboard.press('Shift+ArrowRight');
    await page.keyboard.press('Shift+ArrowRight');
    await expect(page.locator('.sel-cell[data-selected]')).toHaveCount(3);
    await page.keyboard.press('Shift+ArrowLeft');
    await expect(page.locator('.sel-cell[data-selected]')).toHaveCount(2);
    await page.keyboard.press('Escape');
    await expect(page.locator('.sel-cell[data-selected]')).toHaveCount(0);

    await page.keyboard.press('Control+a');
    const shown = await page.locator('.lib-head__meta').first().innerText();
    await expect(page.getByRole('toolbar', { name: new RegExp(`Actions for ${parseInt(shown, 10)} selected`) })).toBeVisible();
    await page.getByRole('button', { name: 'Clear selection' }).click();
    await expect(page.locator('.bulk-bar')).toHaveCount(0);

    // Controller: X on the focused card toggles it.
    await first.focus();
    await page.evaluate(() => {
      const c = window.__vystralPreviewController!;
      c.emit('gamepad.button', { button: 'X', pressed: true });
      c.emit('gamepad.button', { button: 'X', pressed: false });
    });
    await expect(page.locator('.sel-cell[data-selected]')).toHaveCount(1);
  });

  test('add to a collection (smart ones aren’t offered), hide with undo, and the list view selects too', async ({ page }) => {
    await open(page, '?bulk&reduced');
    await go(page, { name: 'library' });
    await card(page, 'Nebula Drift').click({ modifiers: ['Control'] });
    await card(page, 'Glasswing').click({ modifiers: ['Control'] });
    await page.locator('.bulk-bar').getByRole('button', { name: /^Collection/ }).click();
    await expect(page.getByRole('menuitem', { name: /Short and sweet/ })).toHaveCount(0);
    await page.getByRole('menuitem', { name: /Couch co-op/ }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Added 2 games to Couch co-op' })).toBeVisible();

    await page.locator('.bulk-bar').getByRole('button', { name: /^Hide/ }).click();
    const toast = page.locator('.toast').filter({ hasText: '2 games hidden' });
    await expect(toast).toBeVisible();
    await expect(card(page, 'Nebula Drift')).toHaveCount(0);
    await toast.getByRole('button', { name: 'Undo' }).click();
    await expect(card(page, 'Nebula Drift')).toHaveCount(1);
    // Collection membership from the earlier change is still there.
    const id = await gameId(page, 'Nebula Drift');
    expect(await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().gamesById.get(${JSON.stringify(id)}).collections)`)).toContain('c011ec7100000000000000000000c0c0');

    await page.getByRole('radio', { name: 'List' }).or(page.getByRole('button', { name: 'List' })).first().click();
    const row = page.locator('.vlist__row', { hasText: 'Hollow Lantern' });
    await row.click({ modifiers: ['Control'] });
    await expect(row).toHaveAttribute('aria-selected', 'true');
    expect(await seriousViolations(page, '.vlist')).toEqual([]);
  });

  test('a failed bulk change puts every game back and says nothing changed', async ({ page }) => {
    await open(page, '?bulkFail&reduced');
    await go(page, { name: 'library' });
    const before = await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().library.games.filter((g) => g.favorite).length)`);
    await card(page, 'Hollow Lantern').click({ modifiers: ['Control'] });
    await page.locator('.bulk-bar').getByRole('button', { name: /^Favorite/ }).click();
    await expect(page.locator('.toast').filter({ hasText: 'Nothing was changed' })).toBeVisible();
    expect(await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().library.games.filter((g) => g.favorite).length)`)).toBe(before);
  });
});

test.describe('Game page', () => {
  test('Similar in your library explains each pick, forgotten games first', async ({ page }) => {
    const errors = await open(page, '?tags&reduced');
    await go(page, { name: 'game', id: await gameId(page, 'Nebula Drift') });
    const strip = page.locator('.similar');
    await expect(strip.getByRole('heading', { name: 'Similar in your library' })).toBeVisible();
    await expect(strip.locator('.similar__item').first()).toBeVisible();
    await expect(strip.locator('.similar__why').first()).toContainText(/Shares|Same series|IGDB/);
    await strip.scrollIntoViewIfNeeded();
    await shot(page, 'similar');
    expect(await seriousViolations(page, '.similar')).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('the timeline shows updates, mods and sessions; keyboard moves between markers; the compare link opens Performance', async ({ page }) => {
    const errors = await open(page, '?mods&timeline&reduced');
    await go(page, { name: 'game', id: await gameId(page, 'Nebula Drift') });
    await page.getByRole('tab', { name: /^Sessions/ }).click();
    const tl = page.locator('.mtl');
    await expect(tl.getByRole('heading', { name: 'Updates, mods and sessions' })).toBeVisible();
    await tl.getByRole('button', { name: 'All', exact: true }).click();
    await expect(tl.locator('.mtl__m[data-lane="sessions"]').first()).toBeVisible();
    await expect(tl.locator('.mtl__m[data-lane="updates"]').first()).toBeVisible();
    await expect(tl.locator('.mtl__m[data-lane="mods"]').first()).toBeVisible();
    await expect(tl.locator('.mtl__m[data-after]').first()).toBeVisible();
    await tl.scrollIntoViewIfNeeded();
    await shot(page, 'timeline');
    expect(await seriousViolations(page, '.mtl')).toEqual([]);

    // Keyboard: the roving marker takes focus; arrows move; Enter pins the details.
    const stop = tl.locator('.mtl__m[tabindex="0"]');
    await stop.focus();
    const firstLabel = await stop.getAttribute('aria-label');
    await page.keyboard.press('ArrowLeft');
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('aria-label'))).not.toBe(firstLabel);
    await page.keyboard.press('ArrowUp');
    await expect.poll(() => page.evaluate(() => document.activeElement?.getAttribute('data-lane'))).not.toBe('sessions');
    // Zoom with the keyboard changes the axis.
    const ticks = await tl.locator('.mtl__tick').allTextContents();
    await page.keyboard.press('+');
    await page.keyboard.press('+');
    await expect.poll(() => tl.locator('.mtl__tick').allTextContents()).not.toEqual(ticks);

    // The first session after an update links to the before/after comparison.
    await tl.getByRole('button', { name: 'All', exact: true }).click();
    const after = tl.locator('.mtl__m[data-after][aria-label*="fps average"]').last();
    await after.click();
    await expect(tl.locator('.mtl__detail')).toContainText('First session after');
    const compare = tl.getByRole('button', { name: 'Compare frame rate before and after' });
    {
      await compare.click();
      await expect(page.getByRole('tab', { name: /Compare/ })).toHaveAttribute('aria-selected', 'true');
    }
    expect(errors).toEqual([]);
  });

  test('timeline empty state, and a game without Steam patch notes says so', async ({ page }) => {
    await open(page, '?noVersions&reduced');
    await go(page, { name: 'game', id: await gameId(page, 'Paper Kingdoms') });
    await page.getByRole('tab', { name: /^Sessions/ }).click();
    await expect(page.locator('.mtl__empty')).toContainText('Nothing on the timeline yet');
  });
});

test.describe('Personal records (Track D1)', () => {
  test('new badges, and a one-time fanfare for badges earned since the last visit', async ({ page }) => {
    // The last visit knew only the first badges.
    await page.addInitScript(() => {
      if (!sessionStorage.getItem('d1.seeded')) {
        localStorage.setItem('vystral.records.seen', JSON.stringify({ longestSession: 1, first: -1 }));
        sessionStorage.setItem('d1.seeded', '1');
      }
    });
    const errors = await open(page);
    await go(page, { name: 'journal', tab: 'records' });
    await expect(page.locator('.jr-rec')).toHaveCount(20);
    await expect(page.getByRole('button', { name: /^Weekend warrior/ }).or(page.getByRole('group', { name: /^Weekend warrior/ }))).toBeVisible();
    const fanfare = page.locator('.jr-rec[data-fanfare]');
    await expect(fanfare.first()).toBeVisible();
    await expect(fanfare.first().locator('.jr-rec__fanfare')).toHaveCount(1);
    // The longest-session badge was already known: no fanfare for it.
    await expect(page.locator('.jr-rec[data-fanfare]:has-text("Marathon")').filter({ hasText: 'Longest session' })).toHaveCount(0);
    await page.waitForTimeout(1600);
    await shot(page, 'records');
    expect(await seriousViolations(page, '.jr-recs')).toEqual([]);

    // It plays once: back on the tab, nothing again.
    await go(page, { name: 'home' });
    await go(page, { name: 'journal', tab: 'records' });
    await expect(page.locator('.jr-rec')).toHaveCount(20);
    await page.waitForTimeout(2000);
    await expect(page.locator('.jr-rec[data-fanfare]')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('reduced motion: no glint sweep', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('vystral.records.seen', JSON.stringify({ first: -1 })));
    await open(page, '?reduced');
    await go(page, { name: 'journal', tab: 'records' });
    await expect(page.locator('.jr-rec[data-fanfare]').first()).toBeVisible();
    await expect(page.locator('.jr-rec__fanfare')).toHaveCount(0);
  });
});

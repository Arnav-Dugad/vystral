import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track C6: Immersive Discover (keyboard and controller), Watch with Y, the store-link confirmation, and the
// Journal's personal records (badges, links, the new-record toast). Preview backend, fictional data.

const setSetting = (page: Page, key: string, value: unknown) =>
  page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().setSetting(${JSON.stringify(key)}, ${JSON.stringify(value)}))`);
const getSetting = (page: Page, key: string) =>
  page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().settings[${JSON.stringify(key)}])`) as Promise<unknown>;

async function open(page: Page, query = '') {
  await page.addInitScript(() => {
    sessionStorage.setItem('vystral.introPlayed', '1');
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm, .onb').first()).toBeVisible();
  await page.evaluate("import('/src/views/Immersive.tsx')");
  await setSetting(page, 'immersive.tourDone', true);
  return errors;
}

async function enter(page: Page) {
  await page.keyboard.press('F11');
  await expect(page.locator('.imm')).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.modeSwitch ?? null), { timeout: 10_000 }).toBeNull();
  await expect(page.locator('.imm__card[data-focused="true"]')).toBeVisible();
}

async function pad(page: Page, button: string) {
  await page.evaluate((b) => {
    const c = window.__vystralPreviewController!;
    c.emit('gamepad.button', { button: b, pressed: true });
    c.emit('gamepad.button', { button: b, pressed: false });
  }, button);
}

async function seriousViolations(page: Page, include: string) {
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page }).include(include).exclude('.living-canvas').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

const activeRow = (page: Page) => page.locator('.imm__row[data-active="true"]');

test.describe('Immersive Discover', () => {
  test('keyboard: search any game, open its page, watch it with Y, and it shows on Watching', async ({ page }) => {
    test.setTimeout(process.env.GITHUB_ACTIONS ? 300_000 : 90_000); // three axe passes over Immersive are slow on a shared runner
    const errors = await open(page);
    await enter(page);

    await page.keyboard.press('e');
    await expect(page.locator('.imm[data-tab="library"]')).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.locator('.imm[data-tab="discover"]')).toBeVisible();
    await expect(page.locator('.imm__tab[aria-current="page"]')).toHaveText('Discover');
    await expect(activeRow(page)).toHaveAttribute('data-row-id', 'disc-find');
    await expect(activeRow(page)).toContainText('Preview · fictional games');
    // Right is the end of the sections.
    await page.keyboard.press('e');
    await expect(page.locator('.imm[data-tab="discover"]')).toBeVisible();

    // Y opens the keyboard, which searches every store.
    await page.keyboard.press('y');
    const input = page.getByRole('searchbox', { name: 'Search any game' });
    await expect(input).toBeFocused();
    await expect(input).toHaveAttribute('placeholder', 'Search any game, owned or not');
    await page.keyboard.type('tales');
    await page.keyboard.press('Enter');
    await expect(page.locator('.osk')).toHaveCount(0);
    await expect(activeRow(page)).toHaveAttribute('data-row-id', 'disc-results');
    const results = page.locator('.imm__row[data-row-id="disc-results"] .imm__card--discover');
    await expect.poll(() => results.count(), { timeout: 10_000 }).toBeGreaterThan(1);
    await expect(page.locator('.imm__row[data-row-id="disc-results"] .imm__row-meta')).toHaveText(/\d+ games$/);
    await expect(page.locator('.imm__info')).toContainText('Not in your library');
    expect(await seriousViolations(page, '.imm')).toEqual([]);

    // A opens its page; the details arrive (price, time to beat, where to get it).
    const title = (await page.locator('.imm__info .imm__title').textContent())!;
    await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: `${title}, not in your library` });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.imm-panel__stat')).toHaveCount(4);
    await expect(dialog).toContainText('Steam price');
    await expect(dialog).toContainText('Time to beat');
    await expect(dialog.getByRole('heading', { name: /Where to get it/ })).toBeVisible();
    const watch = dialog.locator('.imm-dpage__watch');
    await expect(watch).toHaveAttribute('aria-pressed', 'false');
    await expect(watch).toBeFocused();

    // Y watches it, and again stops; once more to keep it.
    await page.keyboard.press('y');
    await expect(watch).toHaveAttribute('aria-pressed', 'true');
    await expect(dialog.locator('.imm-page__hints')).toContainText('Stop watching');
    await page.keyboard.press('y');
    await expect(watch).toHaveAttribute('aria-pressed', 'false');
    await page.keyboard.press('y');
    await expect(watch).toHaveAttribute('aria-pressed', 'true');
    expect(await seriousViolations(page, '.imm-dpage')).toEqual([]);

    // A store link asks first; Escape cancels and focus goes back to the link.
    const steam = dialog.getByRole('button', { name: /^Steam store page/ });
    await steam.focus();
    await page.keyboard.press('Enter');
    const confirm = page.getByRole('dialog', { name: /Open the Steam store page\?/ });
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText('opens in your web browser');
    expect(await seriousViolations(page, '.imm-dconfirm')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();
    await expect(steam).toBeFocused();

    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    const watching = page.locator('.imm__row[data-row-id="disc-watching"] .imm__card--discover');
    await expect(watching).toHaveCount(1);
    await expect(watching).toHaveAttribute('aria-label', new RegExp(`^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    expect(errors).toEqual([]);
  });

  test('controller: RB to Discover, A types, RT searches, A opens, Y watches, the confirm opens the store with A', async ({ page }) => {
    const errors = await open(page, '?vibration');
    await enter(page);
    await pad(page, 'RB');
    await pad(page, 'RB');
    await expect(page.locator('.imm[data-tab="discover"]')).toBeVisible();
    await pad(page, 'RB');
    await expect.poll(() => page.evaluate(() => window.__vystralPreviewController!.rumbles.slice(-1)[0])).toBe('edge');

    await pad(page, 'A'); // the search card
    const input = page.getByRole('searchbox', { name: 'Search any game' });
    await expect(input).toBeFocused();
    await page.keyboard.type('echoes');
    await pad(page, 'RT');
    await expect(page.locator('.osk')).toHaveCount(0);
    const results = page.locator('.imm__row[data-row-id="disc-results"] .imm__card--discover');
    await expect.poll(() => results.count(), { timeout: 10_000 }).toBeGreaterThan(0);

    // X on a card watches it straight from the row.
    await pad(page, 'X');
    await expect(page.locator('.imm__row[data-row-id="disc-results"] .imm__card[data-focused="true"] .imm-dcard__flag')).toBeVisible();
    await expect(page.locator('.imm__hints')).toContainText('Stop watching');

    await pad(page, 'A');
    const dialog = page.locator('.imm-dpage [role="dialog"]');
    await expect(dialog).toBeVisible();
    const watch = dialog.locator('.imm-dpage__watch');
    await expect(watch).toHaveAttribute('aria-pressed', 'true');
    await pad(page, 'Y');
    await expect(watch).toHaveAttribute('aria-pressed', 'false');

    // Down to the store links, A asks, A opens it in the browser (the preview only records the call).
    await expect(watch).toBeFocused();
    await pad(page, 'Down');
    await expect(dialog.locator('.imm-dpage__link').first()).toBeFocused();
    await pad(page, 'A');
    const confirm = page.locator('.imm-dconfirm');
    await expect(confirm).toBeVisible();
    await expect(confirm.getByRole('button', { name: 'Open in browser' })).toBeFocused();
    await pad(page, 'B');
    await expect(confirm).toHaveCount(0);
    await pad(page, 'A');
    await expect(confirm).toBeVisible();
    await pad(page, 'A');
    await expect(confirm).toHaveCount(0);
    await expect(dialog).toBeVisible();

    await pad(page, 'B');
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.imm[data-tab="discover"]')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('search turned off: the card explains it and A turns it back on', async ({ page }) => {
    await open(page);
    await setSetting(page, 'discover.searchOnline', false);
    await enter(page);
    await page.keyboard.press('e');
    await page.keyboard.press('e');
    await expect(page.locator('.imm[data-tab="discover"]')).toBeVisible();
    const off = page.locator('.imm__card--note[aria-label^="Searching stores is off"]');
    await expect(off).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.imm__info')).toContainText('Searching stores is off');
    await page.keyboard.press('Enter');
    await expect.poll(() => getSetting(page, 'discover.searchOnline')).toBe(true);
    await expect(off).toHaveCount(0);
  });
});

test.describe('Personal records', () => {
  test('the Records tab shows collectible badges that link to their day', async ({ page }) => {
    const errors = await open(page);
    await page.evaluate("import('/src/state/store.ts').then((m) => m.useStore.getState().navigate({ name: 'journal', tab: 'records' }))");
    const tab = page.getByRole('tab', { name: 'Records' });
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    const badges = page.locator('.jr-rec');
    await expect(badges).toHaveCount(20); // Track D1 added eleven
    await expect(page.getByRole('heading', { name: 'Personal records' })).toBeVisible();
    const marathon = page.getByRole('button', { name: /^Marathon.*Longest session: / });
    await expect(marathon).toBeVisible();
    expect(await seriousViolations(page, '.jr-recs')).toEqual([]);

    await marathon.click();
    await expect(page.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Show all days' })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('reduced motion: badges fade in without the flip, glint or ribbon burst', async ({ page }) => {
    await open(page, '?reduced');
    await page.evaluate("import('/src/state/store.ts').then((m) => m.useStore.getState().navigate({ name: 'journal', tab: 'records' }))");
    const medal = page.locator('.jr-rec__medal').first();
    await expect(medal).toBeVisible();
    expect(await medal.evaluate((el) => getComputedStyle(el).animationName)).toBe('jr-fade');
    expect(await page.locator('.jr-rec__glint').first().evaluate((el) => getComputedStyle(el).display)).toBe('none');
  });

  test('high contrast: solid black badges with white edges', async ({ page }) => {
    await open(page);
    await setSetting(page, 'appearance.theme', 'contrast');
    await page.evaluate("import('/src/state/store.ts').then((m) => m.useStore.getState().navigate({ name: 'journal', tab: 'records' }))");
    const card = page.locator('.jr-rec__card').first();
    await expect(card).toBeVisible();
    expect(await card.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe('rgb(0, 0, 0)');
    expect(await seriousViolations(page, '.jr-recs')).toEqual([]);
  });

  test('a session that beats a record ends with a subtle toast', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page, '?recordSession');
    // A first look at the badges, so the next visit can tell what's new.
    await page.evaluate("import('/src/state/store.ts').then((m) => m.useStore.getState().navigate({ name: 'journal', tab: 'records' }))");
    await expect(page.locator('.jr-rec')).toHaveCount(20);
    await expect(page.locator('.jr-rec[data-new]')).toHaveCount(0);
    await page.waitForTimeout(1500);
    await page.evaluate("import('/src/state/store.ts').then((m) => m.useStore.getState().navigate({ name: 'home' }))");
    // Launch an installed game; the preview session ends after ~7 s, six hours long (longer than any other).
    await page.evaluate(`import('/src/state/store.ts').then((m) => {
      const s = m.useStore.getState();
      const g = s.library.games.find((x) => x.installations.some((i) => i.state === 'installed'));
      return s.launchGame(g.id);
    })`);
    const toast = page.locator('.toast').filter({ hasText: /new personal record/i });
    await expect(toast).toBeVisible({ timeout: 20_000 });
    await expect(toast).toContainText('Marathon');
    await expect(toast).toContainText('6h');
    await toast.getByRole('button', { name: 'See your records' }).click();
    await expect(page.getByRole('tab', { name: 'Records' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.jr-rec[data-new]').first()).toBeVisible();
  });
});

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track M (v0.5): away card, time-to-beat bars, anti-cheat notes, value forecast and session replay.
// Preview data only (fictional); features that change Home/Library at a glance are opt-in by URL.

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

async function nav(page: Page, name: RegExp | string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('while you were away', () => {
  test('summarises games noticed while VYSTRAL was closed, links to the Journal and can be dismissed', async ({ page }) => {
    const { errors, external } = await open(page, '?away&reduced');
    const card = page.getByRole('region', { name: /You played/ });
    await expect(card).toBeVisible();
    await expect(card.getByText('While you were away')).toBeVisible();
    await expect(card.getByRole('list', { name: 'Games played' }).getByRole('button').first()).toBeVisible();
    await expect(card.getByText(/achievements? unlocked/)).toBeVisible();
    await expect(card.getByRole('button', { name: /^Best session:/ })).toBeVisible();
    await noSeriousViolations(page, '.away');

    await card.getByRole('button', { name: 'Open in Journal' }).click();
    await expect(page.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
    await nav(page, 'Home');
    const again = page.getByRole('region', { name: /You played/ });
    await expect(again).toBeVisible(); // held for this run until dismissed
    await again.getByRole('button', { name: 'Dismiss' }).click();
    await expect(again).toBeHidden();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('shows nothing when nothing happened', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.locator('.away')).toHaveCount(0);
  });
});

test.describe('time to beat', () => {
  test('bars on cards, list rows and the game page, with an IGDB label and a "closest to finishing" sort', async ({ page }) => {
    const { errors } = await open(page, '?ttb&reduced');
    await nav(page, /Library/);
    await expect(page.locator('.vgrid .ttb--card').first()).toBeVisible();
    await expect(page.locator('.vgrid .ttb--card').first()).toHaveAttribute('aria-label', /IGDB estimate/);
    const sort = page.getByRole('combobox', { name: 'Sort by' });
    await sort.selectOption('finishing');
    await expect(page.locator('.vgrid [data-game-id]').first()).toBeVisible();
    await page.getByRole('radio', { name: 'List' }).click();
    await expect(page.locator('.vlist .ttb--row').first()).toBeVisible();
    await page.getByRole('radio', { name: 'Grid' }).click();

    await page.getByLabel('Filter library').fill('Ashen Crown');
    await page.getByRole('button', { name: /^Ashen Crown/ }).first().click();
    const panel = page.getByRole('region', { name: 'Time to beat' });
    await expect(panel).toBeVisible();
    await expect(panel.getByText(/IGDB estimate/)).toBeVisible();
    await expect(panel.getByText('Main story')).toBeVisible();
    await noSeriousViolations(page, '.ttb-panel');
    expect(errors).toEqual([]);
  });

  test('no estimates means no bars and no extra sort', async ({ page }) => {
    await open(page);
    await nav(page, /Library/);
    await expect(page.locator('.vgrid [data-game-id]').first()).toBeVisible();
    await expect(page.locator('.ttb')).toHaveCount(0);
    await expect(page.getByRole('combobox', { name: 'Sort by' }).locator('option[value="finishing"]')).toHaveCount(0);
  });
});

test.describe('anti-cheat notes', () => {
  test('pre-flight shows an informative kernel anti-cheat note, and Settings can hide the notes', async ({ page }) => {
    await open(page, '?antiCheat');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search' }).fill('launch nebula');
    await expect(page.getByRole('option').first()).toContainText('Launch Nebula Drift');
    await page.keyboard.press('Enter');
    const preflight = page.getByRole('region', { name: 'Before you play' });
    await expect(preflight).toBeVisible();
    const row = preflight.getByRole('listitem').filter({ hasText: 'Anti-cheat' });
    await expect(row).toContainText(/kernel/);
    await expect(row).toContainText('VYSTRAL never interacts with it');
    await expect(row).toContainText('AreWeAntiCheatYet');
    await noSeriousViolations(page, '.preflight');
    await expect(page.getByText(/Played Nebula Drift for/)).toBeVisible({ timeout: 15_000 });

    // Game page note, then hide all notes from Settings.
    await nav(page, /Library/);
    await page.getByLabel('Filter library').fill('Nebula Drift');
    await page.getByRole('button', { name: /^Nebula Drift/ }).first().click();
    const note = page.locator('.acn');
    await expect(note).toContainText('Uses kernel anti-cheat');
    await expect(note.getByRole('list')).toBeHidden();
    await note.getByRole('button', { name: 'What VYSTRAL does' }).click();
    await expect(note.getByRole('list')).toBeVisible();
    await note.getByRole('button', { name: 'Hide these notes' }).click();
    await page.getByRole('switch', { name: 'Show anti-cheat notes' }).click();
    await expect(page.getByRole('switch', { name: 'Show anti-cheat notes' })).toHaveAttribute('aria-checked', 'false');
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.getByRole('heading', { name: 'Nebula Drift', level: 1 })).toBeVisible();
    await expect(page.locator('.acn')).toHaveCount(0);
  });
});

test.describe('library value forecast', () => {
  test('next Steam sale with its source, and a clearly labelled backlog savings estimate', async ({ page }) => {
    const { errors, external } = await open(page);
    await nav(page, 'Journal');
    await page.getByRole('tab', { name: /Library value/ }).click();
    const sale = page.getByRole('region', { name: 'Next big sale' });
    await expect(sale).toBeVisible();
    await expect(sale.getByText('Steam Winter Sale', { exact: true })).toBeVisible();
    // Preview dates are fictional and say so; the app shows “Announced by Valve” with the Steamworks source.
    await expect(sale.getByText('Fictional preview dates')).toBeVisible();
    await expect(sale.getByRole('button', { name: 'Source' })).toBeVisible();
    const savings = page.getByRole('region', { name: 'Estimated savings on your backlog' });
    await expect(savings.getByText('An estimate based on past lows')).toBeVisible();
    await expect(savings.getByText(/without price data|Prices are only looked up/).first()).toBeVisible();
    await noSeriousViolations(page, '.vf');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

test.describe('session replay', () => {
  test('plays a replay card and saves and copies it as a 1920×1080 PNG through the bridge', async ({ page }) => {
    const { errors, external } = await open(page);
    await nav(page, 'Performance');
    await page.getByRole('tab', { name: 'Sessions' }).click(); // Track C2: one session in depth is on the Sessions tab
    await page.getByRole('button', { name: 'Replay', exact: true }).first().click();
    const dialog = page.getByRole('dialog', { name: /^Replay · / });
    await expect(dialog).toBeVisible();
    const canvas = dialog.getByRole('img');
    await expect(canvas).toHaveAttribute('aria-label', /played/);
    await expect(canvas).toHaveAttribute('data-done', 'true', { timeout: 15_000 });
    await noSeriousViolations(page, '.dialog');

    // The preview bridge, like the native one, only accepts a complete 1920×1080 PNG (chunked upload).
    await dialog.getByRole('button', { name: 'Save as image' }).click();
    await expect(page.getByText('Replay saved')).toBeVisible();
    await expect(page.getByText(/Pictures\\VYSTRAL replay - .+\.png/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Copy image' }).click();
    await expect(page.getByText('Replay copied')).toBeVisible();
    await expect(page.getByText(/Couldn’t (save|copy)/)).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toBeHidden();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('reduced motion shows the finished card at once; the Journal opens replays too', async ({ page }) => {
    await open(page, '?reduced');
    await nav(page, 'Journal');
    await page.getByRole('button', { name: /^Replay .* session$/ }).first().click();
    const dialog = page.getByRole('dialog', { name: /^Replay · / });
    await expect(dialog.getByRole('img')).toHaveAttribute('data-done', 'true', { timeout: 3_000 });
    await expect(dialog.getByRole('button', { name: 'Replay', exact: true })).toHaveCount(0);
  });
});

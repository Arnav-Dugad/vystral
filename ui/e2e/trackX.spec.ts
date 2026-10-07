import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track X: library tools on the preview backend — the Home card for new health issues (?healthNew), "Compare with
// default" for Steam Input layouts (?compare), the uninstall advisor (?uninstall), the mod viewer (?mods) and the
// save-file locator (?saves). Fictional data only; nothing may leave the page.

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

async function noSeriousViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page }).exclude('.living-canvas').include(include).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

async function openGame(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
  await page.getByLabel('Filter library').fill(title);
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

test.describe('Track X: library tools', () => {
  test('Home shows something new once, with its one-tap fix and See all', async ({ page }) => {
    const { errors, external } = await open(page, '?healthNew&reduced');
    const card = page.getByRole('region', { name: 'Lumen Garden can’t start' });
    await expect(card).toBeVisible();
    await expect(card.getByText('A shortcut stopped working')).toBeVisible();
    await expect(card.getByRole('button', { name: 'Locate the program…' })).toBeVisible();
    await expect(card.getByRole('button', { name: 'See all 2' })).toBeVisible();
    await expect(card.getByText('1 more thing to look at')).toBeVisible();
    await noSeriousViolations(page, '.hnews');

    // Dismissing hides everything that was new; nothing comes back by itself.
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(page.locator('.hnews')).toHaveCount(0);

    // A drive unplugged later arrives through the event; a missing drive has no pointless fix, only See all.
    await page.evaluate(() => window.__vystralPreviewHealthNews!.unplug());
    const drive = page.getByRole('region', { name: 'Drive F: isn’t connected' });
    await expect(drive).toBeVisible();
    await expect(drive.getByText('A drive was disconnected')).toBeVisible();
    await expect(drive.getByRole('button', { name: 'Rescan' })).toHaveCount(0);
    await drive.getByRole('button', { name: 'See all' }).click();
    await expect(page.getByRole('img', { name: /Health score \d+ out of 100/ })).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('without anything new, Home has no card', async ({ page }) => {
    await open(page, '?health&reduced');
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.locator('.hnews')).toHaveCount(0);
  });

  test('Compare with default marks and lists what changed', async ({ page }) => {
    const { errors, external } = await open(page, '?compare&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Controls' }).click();
    const compare = page.getByRole('button', { name: 'Compare with default' });
    await expect(compare).toBeVisible();
    await compare.click();
    await expect(page.getByRole('button', { name: 'Hide comparison' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByText(/Your layout started from “Gamepad”/)).toBeVisible();
    await expect(page.getByText('5 differences: 2 changed, 2 added, 1 removed.')).toBeVisible();

    const table = page.getByRole('table', { name: /Differences in “On foot”/ });
    await expect(table.getByRole('row', { name: /^B Changed Dodge/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /Paddle P1 Added/ })).toBeVisible();
    await expect(table.getByRole('row', { name: /D-pad down Removed Emote wheel/ })).toBeVisible();
    await expect(page.locator('.ccmp__pane')).toHaveCount(2);
    // Controls on the drawing are marked on both diagrams (paddles and gyro aren't drawn; the table lists them).
    await expect(page.locator('.ccmp__pane[data-which="yours"] .pad__face--b[data-diff="changed"]')).toBeAttached();
    await expect(page.locator('.ccmp__pane[data-which="default"] [data-diff="removed"]').first()).toBeAttached();
    await noSeriousViolations(page, '.ccmp');

    // Overlay: one diagram, flipped between yours and the default.
    await page.getByRole('radio', { name: 'Overlay' }).click();
    await expect(page.locator('.ccmp__pane')).toHaveCount(1);
    await page.getByRole('radio', { name: 'Default' }).click();
    await expect(page.locator('.ccmp__pane[data-which="default"]')).toBeVisible();

    await page.getByRole('button', { name: 'Done' }).click();
    await expect(page.getByRole('table', { name: /Every control in/ })).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('a template used as it is has nothing to compare; no templates means no button', async ({ page }) => {
    await open(page, '?compare&reduced');
    await openGame(page, 'Starfall Tactics');
    await page.getByRole('tab', { name: 'Controls' }).click();
    await page.getByRole('button', { name: 'Compare with default' }).click();
    await expect(page.getByText('No differences — your layout matches it exactly.')).toBeVisible();

    await page.goto('/?controls&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Controls' }).click();
    await expect(page.getByRole('heading', { name: 'My layout' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Compare with default' })).toHaveCount(0);
  });

  test('the uninstall advisor explains, then opens the store’s own uninstall', async ({ page }) => {
    const { errors, external } = await open(page, '?uninstall&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('button', { name: 'More actions' }).click();
    await page.getByRole('menuitem', { name: 'Before you uninstall…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Before you uninstall Nebula Drift' });
    await expect(dialog).toBeVisible();
    for (const label of ['Your time', 'Saves', 'To get it back', 'Subscriptions']) await expect(dialog.getByText(label, { exact: true })).toBeVisible();
    await expect(dialog.getByText('Steam’s own figure for the install')).toBeVisible();
    await expect(dialog.getByText(/Advice only/)).toBeVisible();
    await noSeriousViolations(page, '[role="dialog"]');

    const hold = dialog.getByRole('button', { name: 'Open Steam’s uninstall' });
    await hold.focus();
    await page.keyboard.down('Enter');
    await page.waitForTimeout(1150);
    await page.keyboard.up('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Steam’s uninstall window is open')).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('Storage Studio asks the advisor first, for every store', async ({ page }) => {
    await open(page, '?uninstall&reduced');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Storage/ }).click();
    await expect(page.getByRole('heading', { name: 'Big and unplayed for 6+ months' })).toBeVisible();
    await expect(page.locator('.suggest__list, .suggest__empty').first()).toBeVisible();
    const button = page.getByRole('button', { name: /^Uninstall .+ in / }).first();
    test.skip((await button.count()) === 0, 'No big, unplayed games in this preview library');
    await button.click();
    await expect(page.getByRole('dialog', { name: /^Before you uninstall/ })).toBeVisible();
    await page.getByRole('button', { name: 'Keep it' }).click();
    await expect(page.getByRole('dialog')).toBeHidden();
  });

  test('the Files tab lists Workshop items and names them on request', async ({ page }) => {
    const { errors, external } = await open(page, '?mods&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Files' }).click();
    const mods = page.getByRole('region', { name: 'Mods' });
    const workshop = mods.getByRole('article', { name: 'Steam Workshop' });
    await expect(workshop).toBeVisible();
    await expect(workshop.getByText(/items? · /)).toBeVisible();
    await expect(workshop.getByText('Not downloaded yet')).toBeVisible();
    await expect(mods.getByRole('button', { name: 'Open folder' }).first()).toBeVisible();
    await mods.getByRole('button', { name: 'Show Workshop names' }).click();
    await expect(workshop.getByText('Better Night Sky')).toBeVisible();
    await expect(mods.getByText('Workshop titles from Steam.')).toBeVisible();
    await expect(mods.getByText(/Read-only/)).toBeVisible();
    await noSeriousViolations(page, '.files');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('save locations: opt in, then found, missing and unsupported places with credit', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Files' }).click();
    const saves = page.getByRole('region', { name: 'Save files' });
    await expect(saves.getByText('See where Nebula Drift saves')).toBeVisible();
    await expect(saves.getByText(/sends this game’s Steam app ID to\s+pcgamingwiki.com/)).toBeVisible();
    await saves.getByRole('button', { name: 'Look up save locations' }).click();
    await expect(saves.getByText(/^Found in \d of \d places/)).toBeVisible();
    await expect(saves.getByRole('button', { name: /^Open folder: / }).first()).toBeVisible();
    await expect(saves.getByText('Can’t be checked (a registry key or an unusual path)')).toBeVisible();
    await expect(saves.getByText(/CC BY-NC-SA 3.0/)).toBeVisible();
    await noSeriousViolations(page, '.files');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('?saves starts with lookups on', async ({ page }) => {
    await open(page, '?saves&reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Files' }).click();
    await expect(page.getByRole('region', { name: 'Save files' }).getByText(/^Found in /)).toBeVisible();
    await page.getByRole('region', { name: 'Save files' }).getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByRole('region', { name: 'Save files' }).getByText(/^Found in /)).toBeVisible();
  });
});

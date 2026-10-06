import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track P: friends playing now (opt-in, preview data only) and the update-space forecast.
// ?friends / ?friends=empty / ?friendsPrivate turn the card on; ?diskTight fills D: up.

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

async function openSettingsSection(page: Page, name: string) {
  await page.keyboard.press('Control+,');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name }).click();
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('friends playing now', () => {
  test('is off by default: no card on Home', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.locator('.friends')).toHaveCount(0);
  });

  test('groups friends by game, links library games without launching, and is axe-clean', async ({ page }) => {
    const { errors, external } = await open(page, '?friends&reduced');
    const card = page.getByRole('region', { name: /friends are playing \d+ games/ });
    await expect(card).toBeVisible();
    await expect(card.getByText('Friends playing now')).toBeVisible();
    const games = card.getByRole('list', { name: 'Games your friends are playing' });
    await expect(games.getByRole('listitem').first()).toContainText('Nebula Drift');
    await expect(games.getByRole('listitem').first()).toContainText('Juniper, Rook and Saffron');
    await expect(card.getByText('Not in your library')).toBeVisible();          // Skyward Relay
    await expect(card.getByRole('list', { name: 'Friends online, not in a game' })).toContainText('Quill');
    await expect(card.getByText(/public Steam profiles/)).toBeVisible();
    await expect(card.locator('.favatar[data-tone="playing"]').first()).toBeVisible();
    await expect(card.locator('.favatar[data-tone="away"]').first()).toBeVisible();
    await noSeriousViolations(page, '.friends');

    await card.getByRole('button', { name: /Nebula Drift is in your library/ }).click();
    await expect(page.locator('.dhero')).toBeVisible();
    await expect(page.locator('.launch-overlay, .launch')).toHaveCount(0); // never auto-launches
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('reorders smoothly when a friend joins a game', async ({ page }) => {
    await open(page, '?friends');
    const card = page.locator('.friends');
    const games = card.getByRole('list', { name: 'Games your friends are playing' });
    await expect(games.getByRole('listitem').nth(1)).toContainText('Ashen Crown');
    await expect(games.getByRole('listitem').nth(1)).not.toContainText('Quill');
    await page.evaluate(() => window.__vystralPreviewFriends!.next()); // Quill joins Ashen Crown
    await card.getByRole('button', { name: 'Refresh friends' }).click();
    await expect(games.getByRole('listitem').nth(1)).toContainText('Atlas and Quill');
    await expect(card.getByRole('list', { name: 'Friends online, not in a game' })).not.toContainText('Quill');
  });

  test('a private friends list explains what to change, with Try again', async ({ page }) => {
    await open(page, '?friendsPrivate&reduced');
    const card = page.getByRole('region', { name: 'Your friends list is private' });
    await expect(card).toBeVisible();
    await expect(card.getByText(/Friends List.*Public/)).toBeVisible();
    await expect(card.getByText(/Only your own setting matters/)).toBeVisible();
    await expect(card.getByRole('button', { name: 'Try again' })).toBeVisible();
    await noSeriousViolations(page, '.friends');
  });

  test('an empty evening is gentle and shows who was on recently', async ({ page }) => {
    await open(page, '?friends=empty&reduced');
    const card = page.getByRole('region', { name: 'None of your friends are online right now' });
    await expect(card).toBeVisible();
    await expect(card.getByText(/It’s quiet right now/)).toBeVisible();
    await expect(card.getByRole('list', { name: 'Recently online' })).toContainText('Juniper');
  });

  test('a rejected key points to Settings', async ({ page }) => {
    await open(page, '?friends=invalid&reduced');
    const card = page.getByRole('region', { name: 'Steam didn’t accept your key' });
    await card.getByRole('button', { name: 'Open settings' }).click();
    await expect(page.getByRole('heading', { name: /Steam Web API/ })).toBeVisible();
  });

  test('the Steam Web API settings have the opt-in switch, and turning it off hides the card', async ({ page }) => {
    await open(page, '?friends&reduced');
    await expect(page.locator('.friends')).toBeVisible();
    await openSettingsSection(page, 'Library & stores');
    const toggle = page.getByRole('switch', { name: 'Friends playing now on Home' });
    await expect(toggle).toBeChecked();
    await expect(page.getByText(/public profile status/)).toBeVisible();
    await toggle.click();
    await expect(toggle).not.toBeChecked();
    await nav(page, 'Home');
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.locator('.friends')).toHaveCount(0);
  });

  test('Offline mode shows a calm note instead of friends', async ({ page }) => {
    await open(page, '?friends&reduced');
    await openSettingsSection(page, 'Privacy');
    await page.getByRole('switch', { name: 'Offline mode' }).click();
    await nav(page, 'Home');
    await expect(page.getByRole('region', { name: 'Offline mode is on' })).toBeVisible();
  });
});

test.describe('update-space forecast', () => {
  test('nothing on Home when every pending update fits', async ({ page }) => {
    await open(page);
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.locator('.diskwarn')).toHaveCount(0);
  });

  test('Home warns when an update won’t fit, with safe actions only', async ({ page }) => {
    const { errors, external } = await open(page, '?diskTight&reduced');
    const card = page.getByRole('region', { name: /won’t fit on D:/ });
    await expect(card).toBeVisible();
    await expect(card.getByText(/Free up about/)).toBeVisible();
    await expect(card.getByRole('img', { name: /D: has 9\.1 GB free/ })).toBeVisible();
    await expect(card.getByText(/never deletes anything/)).toBeVisible();
    await expect(card.getByRole('button', { name: /Uninstall|Delete/ })).toHaveCount(0);
    await noSeriousViolations(page, '.diskwarn');
    await card.getByRole('button', { name: 'Open Storage Studio' }).click();

    const section = page.getByRole('region', { name: 'Pending Steam updates' });
    await expect(section).toBeVisible();
    await expect(section.getByText('Won’t fit', { exact: true })).toBeVisible();
    await expect(section.getByRole('list', { name: 'Pending updates on D:' }).getByRole('listitem')).toHaveCount(3);
    await expect(section.getByText('Size not known yet')).toBeVisible();
    await expect(section.getByText(/updates it when you launch it/)).toBeVisible();
    await expect(section.getByRole('list', { name: 'Pending updates on C:' })).toContainText('Northbound');
    await noSeriousViolations(page, '.pupd');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('the game page shows the chip and a dismissed Home warning stays away', async ({ page }) => {
    await open(page, '?diskTight&reduced');
    const card = page.locator('.diskwarn');
    await expect(card).toBeVisible();
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(card).toHaveCount(0);

    await nav(page, /Library/);
    await page.getByLabel('Filter library').fill('Nebula Drift');
    await page.getByRole('button', { name: /^Nebula Drift/ }).first().click();
    const chip = page.locator('.uschip');
    await expect(chip).toHaveText(/Won’t fit\s*Next update needs 23\.4 GB · 9\.1 GB free on D:/);
    await expect(chip).toHaveAttribute('data-fit', 'short');
    await noSeriousViolations(page, '.dhero__info');
    await nav(page, 'Home');
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.locator('.diskwarn')).toHaveCount(0);
    await nav(page, /Library/);
    await page.getByLabel('Filter library').fill('Nebula Drift');
    await page.getByRole('button', { name: /^Nebula Drift/ }).first().click();
    await page.locator('.uschip').click();
    await expect(page.getByRole('heading', { name: 'Storage Studio' })).toBeVisible();
  });

  test('Storage Studio lists a pending update that fits, calmly', async ({ page }) => {
    await open(page, '?reduced');
    await nav(page, /Storage/);
    const section = page.getByRole('region', { name: 'Pending Steam updates' });
    await expect(section).toBeVisible();
    await expect(section.getByText('Fits', { exact: true })).toBeVisible();
    await expect(section).toContainText('Deep Field');
  });

  test('the disk-space notification has its own switch', async ({ page }) => {
    await open(page);
    await openSettingsSection(page, 'Windows integration');
    await expect(page.getByRole('switch', { name: /Not enough space for an update/ })).toBeChecked();
  });
});

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track J: "What's new" after an update, "New" badges, the rollback notice and Network health,
// against the preview backend (see src/bridge/preview.updates.ts for the URL switches).

async function open(page: Page, query: string) {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  // Pinned so the assertions (0.4 tour, 0.4.x rollback text, badge lifetimes) don't drift with each release.
  await page.goto(`/${query}${query.includes('?') ? '&' : '?'}version=0.4.0`);
  await expect(page.locator('.shell')).toBeVisible();
  return errors;
}

async function openSettingsSection(page: Page, name: string) {
  await page.keyboard.press('Control+,');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name }).click();
}

test.describe("What's new", () => {
  test('shows once after a version bump, pages with keys, and is accessible', async ({ page }) => {
    const errors = await open(page, '?reduced&whatsnew=0.3.1');
    const sheet = page.getByTestId('whats-new');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    await expect(sheet.getByRole('heading', { name: 'What’s new in VYSTRAL 0.4' })).toBeVisible();
    await expect(sheet.getByRole('heading', { name: 'Tracked wherever you launch' })).toBeVisible();

    const axe = await new AxeBuilder({ page }).include('[data-testid="whats-new"]').analyze();
    expect(axe.violations).toEqual([]);

    // Keyboard paging: → and ←, and the dots say where we are.
    await page.keyboard.press('ArrowRight');
    await expect(sheet.getByRole('heading', { name: 'Art and details, your way' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: /^Card 2 of/ })).toHaveAttribute('aria-current', 'step');
    await page.keyboard.press('ArrowLeft');
    await expect(sheet.getByRole('heading', { name: 'Tracked wherever you launch' })).toBeVisible();
    await expect(sheet.getByRole('button', { name: 'Back' })).toBeDisabled();

    // Through to the end; the last card's button finishes the tour.
    const count = await sheet.getByRole('button', { name: /^Card \d of/ }).count();
    for (let i = 1; i < count; i++) await sheet.getByRole('button', { name: 'Next' }).click();
    await sheet.getByRole('button', { name: 'Done' }).click();
    await expect(sheet).toBeHidden();

    // Next start: already seen.
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    await page.waitForTimeout(2500);
    await expect(sheet).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('skippable with Escape, and a deep link opens the feature', async ({ page }) => {
    await open(page, '?reduced&whatsnew=0.3.1');
    const sheet = page.getByTestId('whats-new');
    await expect(sheet).toBeVisible({ timeout: 10_000 });
    // The last card links to Network health.
    const cards = await sheet.getByRole('button', { name: /^Card \d of/ }).count();
    for (let i = 1; i < cards; i++) await sheet.getByRole('button', { name: 'Next' }).click();
    await sheet.getByRole('button', { name: 'Open Network health' }).click();
    await expect(sheet).toBeHidden();
    await expect(page.getByRole('heading', { name: /Network health/ })).toBeVisible();

    // From About later on: "See what's new" opens it again; Escape skips.
    await openSettingsSection(page, 'About');
    await page.getByRole('button', { name: /See what’s new/ }).click();
    await expect(sheet).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
  });

  test('never appears on a fresh install or by default', async ({ page }) => {
    await open(page, '?reduced');
    await page.waitForTimeout(2500);
    await expect(page.getByTestId('whats-new')).toBeHidden();
    await expect(page.locator('[data-new-badge]')).toHaveCount(0);
  });

  test('explains a silent rollback once', async ({ page }) => {
    await open(page, '?reduced&rollback');
    await expect(page.getByText('VYSTRAL 0.4.1 didn’t start correctly, so you’re back on 0.4.0. It will try again with the next update.')).toBeVisible();
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    await page.waitForTimeout(1500);
    await expect(page.getByText('didn’t start correctly')).toHaveCount(0);
  });
});

test.describe('"New" badges', () => {
  test('disappear after visiting, and stay gone', async ({ page }) => {
    await open(page, '?reduced&badges');
    const nav = page.getByRole('navigation', { name: 'Main' });
    const journalDot = nav.locator('[data-new-badge="nav.journal"]');
    await expect(journalDot).toBeVisible();
    await nav.getByRole('button', { name: /Journal/ }).click();
    await expect(journalDot).toHaveCount(0);

    // Settings: the Privacy section is marked until its new row has been on screen.
    await page.keyboard.press('Control+,');
    const privacyDot = page.locator('[data-new-badge-group="settings.privacy."]');
    await expect(privacyDot).toBeVisible();
    await openSettingsSection(page, 'Privacy');
    const rowBadge = page.locator('[data-new-badge="settings.privacy.network-health"]');
    await expect(privacyDot).toBeVisible(); // not seen until it has actually been on screen
    await rowBadge.scrollIntoViewIfNeeded();
    await expect(privacyDot).toHaveCount(0, { timeout: 5000 });
    await expect(rowBadge).toBeVisible(); // stays for this visit, so it doesn't vanish under your eyes

    await page.waitForTimeout(300); // the preview backend saves after a short simulated delay
    await page.reload();
    await expect(page.locator('.shell')).toBeVisible();
    await expect(nav.locator('[data-new-badge="nav.journal"]')).toHaveCount(0);
    await openSettingsSection(page, 'Privacy');
    await expect(page.getByRole('heading', { name: /Network health/ })).toBeVisible();
    await expect(page.locator('[data-new-badge="settings.privacy.network-health"]')).toHaveCount(0);
  });
});

test.describe('Network health', () => {
  test('checks on demand and explains each result', async ({ page }) => {
    const errors = await open(page, '?reduced');
    await openSettingsSection(page, 'Privacy');
    await expect(page.getByText('Not checked yet this session')).toBeVisible();
    await page.getByRole('button', { name: 'Check now' }).click();

    const download = page.getByTestId('health-github.download');
    await expect(download).toContainText('(185.199.109.133) isn\'t reachable from this network; VYSTRAL uses the others');
    await expect(page.getByTestId('health-steam.video')).toContainText(/Slow: \d\.\d s/);
    await expect(page.getByTestId('health-github.api')).toContainText(/OK · \d+ ms/);
    await expect(page.getByText(/All reachable · 2 with a caveat/)).toBeVisible();

    await download.getByRole('button', { name: /addresses reachable/ }).click();
    await expect(download.getByText('No answer within 3 s')).toBeVisible();

    // A second check adds to this session's sparkline.
    await page.getByRole('button', { name: 'Check GitHub releases now' }).click();
    await expect(page.getByTestId('health-github.api').locator('.nh-spark polyline')).toHaveCount(1);

    const axe = await new AxeBuilder({ page }).include('.settings__content').analyze();
    expect(axe.violations).toEqual([]);
    expect(errors).toEqual([]);
  });

  test('Offline mode skips everything', async ({ page }) => {
    await open(page, '?reduced');
    await openSettingsSection(page, 'Privacy');
    await page.getByRole('switch', { name: 'Offline mode' }).click();
    await page.getByRole('button', { name: 'Check now' }).click();
    await expect(page.getByTestId('health-github.api')).toContainText('Skipped: Offline mode is on');
    await expect(page.getByText('Nothing was checked')).toBeVisible();
  });
});

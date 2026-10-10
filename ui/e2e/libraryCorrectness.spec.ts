import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track C1: library correctness on the preview backend — Steam games that are no longer owned (?refunded), an Xbox
// game with a measured size and a last-played date estimated from save data (?xbox), and Continue playing keeping
// the hero's game. Fictional data only; nothing may leave the page.

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

const nav = (page: Page, name: RegExp) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

test.describe('Track C1: library correctness', () => {
  test('refunded Steam games leave the library, quietly, once — and can be seen', async ({ page }) => {
    const { errors, external } = await open(page, '?refunded&reduced');

    // One quiet toast, with a way to see them.
    const toast = page.getByRole('status').filter({ hasText: '2 games are no longer in your Steam library' });
    await expect(toast).toHaveCount(1);
    await expect(toast).toContainText('Play history, notes and ratings are kept');
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Continue playing' }).getByRole('button', { name: /^Lantern Drift/ })).toHaveCount(0);

    await toast.getByRole('button', { name: 'Show them' }).click();
    const chip = page.getByRole('button', { name: /No longer owned/ });
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('note')).toContainText('Steam no longer lists these games on your account');
    await expect(page.getByRole('button', { name: /^Lantern Drift/ }).first()).toBeVisible();
    await expect(page.getByRole('button', { name: /^Saltwind Harbor/ }).first()).toBeVisible();
    // Copperline is also on Epic: it stays in the library, so it isn't listed here.
    await expect(page.getByRole('button', { name: /^Copperline/ })).toHaveCount(0);
    await noSeriousViolations(page, '.page');

    // The game page says why, keeps the notes and rating, and offers no install.
    await page.getByRole('button', { name: /^Lantern Drift/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Lantern Drift', level: 1 })).toBeVisible();
    await expect(page.getByText('No longer in your Steam library (refunded or removed)')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Lantern Drift is no longer in your Steam library' }).first()).toBeDisabled();
    await page.getByRole('tab', { name: /Versions/ }).click();
    await expect(page.getByText('No longer in your Steam library').first()).toBeVisible();
    await expect(page.getByText('Left your Steam library')).toBeVisible();

    // Not in the main library or "Hidden"; Copperline (Epic) is.
    await nav(page, /Library/);
    await expect(page.getByRole('button', { name: /No longer owned/ })).toHaveAttribute('aria-pressed', 'false');
    await page.getByLabel('Filter library').fill('Lantern');
    await expect(page.getByRole('button', { name: /^Lantern Drift/ })).toHaveCount(0);
    await page.getByLabel('Filter library').fill('Copperline');
    await expect(page.getByRole('button', { name: /^Copperline/ }).first()).toBeVisible();
    await page.getByRole('button', { name: /^Copperline/ }).first().click();
    await page.getByRole('tab', { name: /Versions/ }).click();
    await expect(page.getByText('No longer in your Steam library')).toHaveCount(1); // only the Steam copy's badge

    // Shown once: nothing more after it was read.
    await expect(page.getByRole('status').filter({ hasText: 'no longer in your Steam library' })).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('without refunds there is no toast and no extra filter', async ({ page }) => {
    await open(page, '?reduced');
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: 'no longer in your Steam library' })).toHaveCount(0);
    await nav(page, /Library/);
    await expect(page.getByRole('button', { name: /No longer owned/ })).toHaveCount(0);
  });

  test('an Xbox game shows its size, package details and an honestly labelled estimate', async ({ page }) => {
    const { errors, external } = await open(page, '?xbox&reduced');

    // Continue playing has it, labelled as an estimate…
    const shelf = page.getByRole('region', { name: 'Continue playing' });
    await expect(shelf.getByRole('button', { name: /^Coastline Rally 4, last played .+ \(estimated from save data\)$/ })).toBeVisible();
    // …and the hero's game is the row's first card (it used to be left out).
    const heroTitle = (await page.locator('.hero__title').first().textContent())!.trim();
    await expect(shelf.locator('.tile').first()).toHaveAttribute('aria-label', new RegExp(`^${heroTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));

    await shelf.getByRole('button', { name: /^Coastline Rally 4/ }).click();
    await expect(page.getByRole('heading', { name: 'Coastline Rally 4', level: 1 })).toBeVisible();
    await expect(page.getByText('estimated from save data').first()).toBeVisible();
    await expect(page.getByText(/Installed on C: · 79\.4 GB/)).toBeVisible();
    await page.getByRole('tab', { name: /Versions/ }).click();
    await expect(page.getByText('1.478.564.2', { exact: true })).toBeVisible();
    await expect(page.getByText('(estimated from save data)')).toBeVisible();
    await noSeriousViolations(page, '.page');

    // Storage Studio sees it on C:, with its size.
    await nav(page, /Storage/);
    await expect(page.getByRole('heading', { name: 'Storage Studio' })).toBeVisible();
    const tile = page.getByRole('button', { name: /^Coastline Rally 4, Xbox, 79\.4 GB, / });
    await expect(tile).toBeVisible();
    await tile.focus();
    await expect(page.getByRole('tooltip')).toContainText('(estimated from save data)');
    await noSeriousViolations(page, '.storage');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

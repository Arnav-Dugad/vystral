import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track AA: the cached first paint (?firstpaint reads the preview's saved snapshot, ?slowLibrary delays the live
// library), startup weight (no three.js on Home), and the Settings rows for the after-update check and compaction.

const SNAPSHOT_KEY = 'vystral.preview.firstPaint';

async function open(page: Page, query = '?reduced') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell').first()).toBeVisible();
  return { errors };
}

/** A normal start, then wait for the snapshot the interface saves a few seconds after the live library arrives. */
async function seedSnapshot(page: Page) {
  await expect(page.locator('main[aria-busy="false"]')).toBeVisible();
  await expect.poll(() => page.evaluate((k) => localStorage.getItem(k)?.length ?? 0, SNAPSHOT_KEY), { timeout: 15_000 }).toBeGreaterThan(1000);
}

async function noSeriousViolations(page: Page, include: string) {
  const results = await new AxeBuilder({ page }).include(include).analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('cached first paint', () => {
  test('Home paints from the snapshot before the live library, then reconciles without replacing cards', async ({ page }) => {
    const { errors } = await open(page, '?reduced');
    await seedSnapshot(page);
    const heroTitle = await page.locator('.hero').getAttribute('aria-label');

    // Next start: the live library takes 2.5 s to arrive.
    await page.goto('/?reduced&firstpaint&slowLibrary=2500');
    const cached = page.locator('.home[data-first-paint]');
    await expect(cached).toBeVisible({ timeout: 1500 });
    await expect(cached.locator('.hero')).toHaveAttribute('aria-label', heroTitle!);
    await expect(cached.getByRole('region', { name: 'Continue playing' })).toBeVisible();
    // The live library hasn't arrived yet.
    await expect(page.locator('main[aria-busy="true"]')).toBeVisible();
    // Rows below the fold follow a frame later, also from the snapshot.
    await expect(cached.getByRole('region', { name: 'Library radar' })).toBeVisible();

    // Tag every card; after reconciliation the same DOM nodes must still be there (identity kept, no flicker).
    const tagged = await page.evaluate(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('.home [data-game-id]')];
      cards.forEach((c, i) => ((c as unknown as { __fp: number }).__fp = i));
      return cards.length;
    });
    expect(tagged).toBeGreaterThan(5);

    await expect(page.locator('.home:not([data-first-paint])')).toBeVisible({ timeout: 8000 });
    await expect(page.locator('main[aria-busy="false"]')).toBeVisible();
    const kept = await page.evaluate(() => [...document.querySelectorAll('.home [data-game-id]')].filter((c) => (c as unknown as { __fp?: number }).__fp !== undefined).length);
    expect(kept).toBe(tagged);
    expect(errors).toEqual([]);
  });

  test('without a snapshot, or with a corrupt one, the live path takes over quietly', async ({ page }) => {
    await page.addInitScript((k) => localStorage.setItem(k, '{"v":1,"games":"broken'), SNAPSHOT_KEY);
    const { errors } = await open(page, '?reduced&firstpaint&slowLibrary=800');
    // The skeleton, never a half-drawn Home from bad data.
    await expect(page.locator('.home[aria-hidden]')).toBeVisible();
    await expect(page.locator('.home[data-first-paint]')).toHaveCount(0);
    await expect(page.locator('.home .hero')).toBeVisible({ timeout: 8000 });
    await expect(page.getByText('Couldn’t load your library')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the snapshot carries the theme, so the very first frame is already light', async ({ page }) => {
    await open(page, '?reduced');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Settings/ }).click();
    await page.getByRole('radio', { name: 'Light' }).click();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Home/ }).click();
    await expect.poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? '{}')?.appearance?.theme, SNAPSHOT_KEY), { timeout: 15_000 }).toBe('light');
    // Read the theme before any module script runs: boot.js already put it on <html>.
    await page.addInitScript(() => {
      document.addEventListener('readystatechange', () => {
        if (document.readyState === 'interactive') (window as unknown as { __earlyTheme?: string }).__earlyTheme = document.documentElement.dataset.theme;
      }, { once: true });
    });
    await page.goto('/?reduced&firstpaint&slowLibrary=1500');
    expect(await page.evaluate(() => (window as unknown as { __earlyTheme?: string }).__earlyTheme)).toBe('light');
    // (The preview forgets settings on reload, so its live settings then switch back to the default theme.)
  });

  test('startup doesn’t download three.js or other heavy views', async ({ page }) => {
    const scripts: string[] = [];
    page.on('request', (r) => {
      if (r.resourceType() === 'script') scripts.push(r.url());
    });
    await open(page, '?reduced');
    await expect(page.locator('main[aria-busy="false"]')).toBeVisible();
    await page.waitForTimeout(500);
    expect(scripts.filter((u) => /node_modules\/three|\/three[-.]|views\/Constellation|constellation\/scene/.test(u))).toEqual([]);
  });
});

test.describe('maintenance settings', () => {
  async function section(page: Page, name: string) {
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /^Settings/ }).click();
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name }).click();
  }

  test('Updates shows the after-update check, its details, and runs it again', async ({ page }) => {
    const { errors } = await open(page, '?reduced');
    await section(page, 'Updates');
    const group = page.getByTestId('selfcheck');
    // The automatic check ran after app.ready and its bridge round trip came back unchanged.
    await expect(group.getByText(/passed 6 of 6 checks/)).toBeVisible({ timeout: 8000 });
    await group.getByRole('button', { name: 'Show the checks' }).click();
    await expect(group.getByRole('listitem')).toHaveCount(6);
    await expect(group.getByRole('listitem').filter({ hasText: 'Interface and VYSTRAL talk to each other' }).getByRole('img', { name: 'Passed' })).toBeVisible();
    await group.getByRole('button', { name: 'Check again' }).click();
    await expect(page.getByText(/passed 6 of 6 checks/).last()).toBeVisible();
    await expect(group.getByText(/checked from Settings/)).toBeVisible();
    await noSeriousViolations(page, '[data-testid="selfcheck"]');
    expect(errors).toEqual([]);
  });

  test('a failed check is shown open, with what it means', async ({ page }) => {
    await open(page, '?reduced&selfCheckFail');
    await section(page, 'Updates');
    const group = page.getByTestId('selfcheck');
    await expect(group.getByText(/passed 5 of 6 checks/)).toBeVisible({ timeout: 8000 });
    await expect(group.getByRole('button', { name: 'Hide the checks' })).toBeVisible();
    await expect(group.getByRole('listitem').filter({ hasText: 'Artwork cache readable' }).getByRole('img', { name: 'Failed' })).toBeVisible();
    await expect(group.getByText(/goes back to the last version that worked/)).toBeVisible();
  });

  test('before any check, it says so and offers to run one', async ({ page }) => {
    await open(page, '?reduced&selfCheckNone');
    await section(page, 'Updates');
    const group = page.getByTestId('selfcheck');
    await expect(group.getByText('Not checked yet')).toBeVisible();
    await group.getByRole('button', { name: 'Check now' }).click();
    await expect(group.getByText(/passed 6 of 6 checks/)).toBeVisible();
  });

  test('Data & recovery shows the size, the last compaction, and compacts on request', async ({ page }) => {
    const { errors } = await open(page, '?reduced');
    await section(page, 'Data & recovery');
    const group = page.getByTestId('compaction');
    await expect(group.getByText(/52\.1 MB now · last compacted .*55\.4 MB → 49\.0 MB \(saved 6\.4 MB\)/)).toBeVisible();
    await expect(group.getByRole('switch', { name: 'Compact automatically' })).toHaveAttribute('aria-checked', 'true');
    await group.getByRole('button', { name: 'Compact now' }).click();
    await expect(page.getByText(/Database compacted · saved 3\.9 MB/)).toBeVisible({ timeout: 8000 });
    await expect(group.getByText(/48\.2 MB now · last compacted .*52\.1 MB → 48\.2 MB/)).toBeVisible();
    await group.getByRole('switch', { name: 'Compact automatically' }).click();
    await expect(group.getByRole('switch', { name: 'Compact automatically' })).toHaveAttribute('aria-checked', 'false');
    await noSeriousViolations(page, '[data-testid="compaction"]');
    expect(errors).toEqual([]);
  });

  test('a busy database is explained, not an error', async ({ page }) => {
    await open(page, '?reduced&compactBusy');
    await section(page, 'Data & recovery');
    await page.getByTestId('compaction').getByRole('button', { name: 'Compact now' }).click();
    await expect(page.getByText('The database was busy')).toBeVisible({ timeout: 8000 });
  });
});

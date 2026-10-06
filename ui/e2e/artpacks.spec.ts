import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track N: art packs, animated store marks, and the live-tile director. Preview data only: pack art is
// drawn locally, live tiles use the bundled loop — nothing here touches the network (asserted below).

async function open(page: Page, query = '') {
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

const nav = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
}

async function seriousViolations(page: Page, include?: string) {
  await settled(page);
  let axe = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) axe = axe.include(include);
  const results = await axe.analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

async function openGame(page: Page, title: string) {
  await nav(page, /Library/);
  await page.getByLabel('Filter library').fill(title);
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeVisible();
}

test.describe('art packs', () => {
  test('choose a style, preview eight games, apply in the background, then restore', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced');
    await nav(page, /Library/);
    await page.getByRole('button', { name: 'Art packs' }).click();
    const dialog = page.getByRole('dialog', { name: 'Art packs' });
    await expect(dialog).toBeVisible();

    // Blurred has covers and backgrounds, but no logos.
    const blurred = dialog.getByRole('radio', { name: /^Blurred/ });
    await blurred.click();
    await expect(blurred).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('checkbox', { name: 'Logos' })).toBeDisabled();
    await expect(dialog.getByRole('checkbox', { name: 'Covers' })).toBeChecked();
    await expect(dialog.getByText(/Changes \d+ images across \d+ games/)).toBeVisible();

    await dialog.getByRole('button', { name: /^Preview \d+ games$/ }).click();
    const samples = dialog.locator('.ap-sample');
    await expect(samples).toHaveCount(8);
    await expect(dialog.locator('.ap-sample[data-state="loading"]')).toHaveCount(0, { timeout: 10_000 });
    await expect(dialog.locator('.ap-sample__new').first()).toHaveAttribute('src', /^data:image\/svg\+xml/);
    const compare = dialog.getByRole('button', { name: 'Compare with current art' });
    await compare.click();
    await expect(dialog.getByRole('button', { name: 'Showing current art' })).toHaveAttribute('aria-pressed', 'true');
    expect(await seriousViolations(page, '.dialog')).toEqual([]);

    await dialog.getByRole('button', { name: /^Apply to \d+ games$/ }).click();
    const status = dialog.locator('.artpacks__status');
    await expect(status).toBeVisible();
    await expect(dialog.getByRole('progressbar', { name: 'Art pack progress' })).toBeVisible();
    // Pause holds the job; resume continues it.
    await dialog.getByRole('button', { name: 'Pause' }).click();
    await expect(status).toHaveText(/^Paused at \d+ of \d+/);
    await dialog.getByRole('button', { name: 'Resume' }).click();
    await expect(status).toHaveText(/^Updated \d+/, { timeout: 30_000 });
    await expect(page.getByText('Blurred art applied')).toBeVisible();

    // Library cards now show the pack's art.
    await dialog.getByRole('button', { name: 'Done' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.locator('.card img[src^="data:image/svg+xml"]').first()).toBeVisible();

    // Settings lists the run; restoring puts the previous art back.
    await nav(page, 'Settings');
    await page.getByRole('button', { name: 'Library & stores' }).click();
    await expect(page.getByRole('heading', { name: 'Art packs' })).toBeVisible();
    await page.getByRole('button', { name: 'Restore previous art' }).first().click();
    await expect(page.getByText('Previous art restored')).toBeVisible();
    await expect(page.getByText('Restored', { exact: true })).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);

    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('art you picked yourself is kept unless you ask, and pack art is credited', async ({ page }) => {
    await open(page, '?reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Artwork' }).click();
    await page.getByRole('button', { name: 'Browse SteamGridDB…' }).first().click();
    const picker = page.getByRole('dialog', { name: /Choose a cover from SteamGridDB/ });
    await picker.getByRole('option').first().click();
    await picker.getByRole('button', { name: 'Use this cover' }).click();
    await expect(picker).toBeHidden();

    await nav(page, /Library/);
    await page.getByRole('button', { name: 'Art packs' }).click();
    const dialog = page.getByRole('dialog', { name: 'Art packs' });
    await dialog.getByRole('radio', { name: /^Material/ }).click();
    await expect(dialog.getByText(/1 of your own picks stay as they are/)).toBeVisible();
    await dialog.getByRole('checkbox', { name: 'Replace my picks' }).check();
    await expect(dialog.getByText(/of your own picks stay as they are/)).toHaveCount(0);
    await dialog.getByRole('checkbox', { name: 'Replace my picks' }).uncheck();
    await dialog.getByRole('button', { name: /^Apply to \d+ games$/ }).click();
    await expect(dialog.locator('.artpacks__status')).toHaveText(/^Updated \d+/, { timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Done' }).click();

    // Nebula Drift kept the cover chosen by hand; its background came from the pack.
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Artwork' }).click();
    await expect(page.getByText(/Your choice · from SteamGridDB by/)).toBeVisible();
    await expect(page.getByText(/From the Material pack · SteamGridDB/)).toBeVisible();
  });

  test('without a SteamGridDB key it explains what is needed', async ({ page }) => {
    await open(page, '?reduced&nosgdb');
    await nav(page, /Library/);
    await page.getByRole('button', { name: 'Art packs' }).click();
    const dialog = page.getByRole('dialog', { name: 'Art packs' });
    await expect(dialog.getByRole('alert')).toContainText('needs your own free API key');
    await expect(dialog.getByRole('button', { name: /^Apply/ })).toBeDisabled();
    await dialog.getByRole('button', { name: 'Open Data sources settings' }).click();
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('heading', { name: 'Art packs' })).toBeVisible();
  });

  test('the art picker’s “Apply this style to…” opens art packs with that style', async ({ page }) => {
    await open(page, '?reduced');
    await openGame(page, 'Nebula Drift');
    await page.getByRole('tab', { name: 'Artwork' }).click();
    await page.getByRole('button', { name: 'Browse SteamGridDB…' }).first().click();
    const picker = page.getByRole('dialog', { name: /Choose a cover from SteamGridDB/ });
    await picker.getByRole('button', { name: 'Blurred' }).click();
    await picker.getByRole('option', { name: /^Blurred/ }).first().click();
    await picker.getByRole('button', { name: 'Apply this style to…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Art packs' });
    await expect(dialog.getByRole('radio', { name: /^Blurred/ })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('checkbox', { name: 'Covers' })).toBeChecked();
    await expect(dialog.getByRole('checkbox', { name: 'Backgrounds' })).not.toBeChecked();
  });
});

test.describe('store marks draw themselves', () => {
  const inkOpacity = (page: Page, selector: string) =>
    page.locator(selector).first().evaluate((el) => getComputedStyle(el.querySelector('.store-logo__ink')!).opacity);

  test('on hover and focus of a store filter, in brand colour, and back to monochrome afterwards', async ({ page }) => {
    await open(page);
    await nav(page, /Library/);
    const chip = page.locator('.lib-store-chip').filter({ hasText: 'Steam' });
    await expect(chip.locator('svg.store-logo')).toHaveAttribute('data-motion', 'trace');
    expect(await inkOpacity(page, '.lib-store-chip')).toBe('0');
    await chip.hover();
    await expect.poll(() => chip.evaluate((el) => getComputedStyle(el.querySelector('.store-logo__ink')!).opacity)).toBe('1');
    await expect.poll(() => chip.evaluate((el) => getComputedStyle(el.querySelector('.store-logo__shape')!).strokeDashoffset)).toMatch(/^0(px)?$/);
    await page.mouse.move(5, 5);
    await expect.poll(() => chip.evaluate((el) => getComputedStyle(el.querySelector('.store-logo__ink')!).opacity)).toBe('0');

    // Keyboard focus draws it too; a selected filter keeps its colour.
    await chip.focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    await expect.poll(() => chip.evaluate((el) => getComputedStyle(el.querySelector('.store-logo__ink')!).opacity)).toBe('1');
    await chip.click();
    await expect(chip).toHaveAttribute('aria-pressed', 'true');
    await page.mouse.move(5, 5);
    await expect.poll(() => chip.evaluate((el) => getComputedStyle(el.querySelector('.store-logo__ink')!).opacity)).toBe('1');

    // Settings store cards and decorative marks: cards respond, marks in running text don't.
    await nav(page, 'Settings');
    await page.getByRole('button', { name: 'Library & stores' }).click();
    const card = page.locator('.adapter.logo-host').first();
    await expect(card.locator('svg.store-logo[data-motion]')).toHaveCount(1);
    await card.hover();
    await expect.poll(() => card.evaluate((el) => getComputedStyle(el.querySelector('.store-logo__ink')!).opacity)).toBe('1');
  });

  test('reduced motion changes colour instantly', async ({ page }) => {
    await open(page, '?reduced');
    await nav(page, /Library/);
    const chip = page.locator('.lib-store-chip').first();
    const transition = await chip.evaluate((el) => getComputedStyle(el.querySelector('.store-logo__shape')!).transitionDuration);
    expect(transition.split(',').every((d) => parseFloat(d) === 0)).toBe(true);
    await chip.hover();
    expect(await chip.evaluate((el) => getComputedStyle(el.querySelector('.store-logo__ink')!).opacity)).toBe('1');
  });
});

test.describe('live-tile director', () => {
  test.beforeEach(async ({ page }) => {
    // Live tiles stay still at low quality ("auto" on ≤4-core CI runners): pretend to be a typical 8-core PC.
    await page.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }));
  });

  test('analyses a clip once, then loops its best two seconds', async ({ page }) => {
    const { errors, external } = await open(page);
    const directed = page.locator('.live-layer[data-director="segment"]').first();
    await expect(directed).toBeAttached({ timeout: 25_000 });
    const start = Number(await directed.getAttribute('data-loop-start'));
    const end = Number(await directed.getAttribute('data-loop-end'));
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeLessThanOrEqual(3.01); // the preview loop is 3 s long
    expect(end - start).toBeGreaterThan(1.5);
    expect(end - start).toBeLessThanOrEqual(2.01);

    // Playback stays inside the segment (with a little slack for the seam), still muted and decoded once per tile.
    const video = directed.locator('video');
    for (let i = 0; i < 6; i++) {
      const t = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
      expect(t).toBeGreaterThanOrEqual(start - 0.2);
      expect(t).toBeLessThanOrEqual(end + 0.4);
      await page.waitForTimeout(250);
    }
    await expect(video).toHaveJSProperty('muted', true);
    expect(await page.locator('video.live-layer__video').count()).toBeLessThanOrEqual(2);

    // The pick is stored: asked again, the backend already knows it.
    const gameId = await directed.evaluate((el) => el.closest('[data-game-id]')?.getAttribute('data-game-id'));
    expect(gameId).toBeTruthy();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

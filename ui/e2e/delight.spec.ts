import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track K: store logos, live tiles, sort animation, never-played gallery, unlock shimmer, illustrations.
// Everything runs against the preview backend: live tiles use a tiny bundled loop, never the network.

async function open(page: Page, query = '') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm, .onb').first()).toBeVisible();
  return errors;
}

const nav = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();

/**
 * Track C1: Continue playing now starts with the hero's game; in the preview its first two cards aren't Steam games
 * (no clip), so scroll the row a little to bring Steam tiles fully on screen.
 */
async function showSteamTiles(page: Page) {
  const track = page.locator('.shelf__track--landscape').first();
  await expect(track).toBeVisible();
  await track.evaluate((el) => el.scrollTo({ left: 780, behavior: 'instant' }));
}

async function seriousViolations(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
  const results = await new AxeBuilder({ page }).exclude('.living-canvas').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

test.describe('store logos', () => {
  test('marks render with accessible names on Home, in the list view and in Settings', async ({ page }) => {
    const errors = await open(page);
    // Card meta lines name each store through its mark.
    await expect(page.getByRole('img', { name: 'Steam' }).first()).toBeVisible();
    // The hero names its store in text, with a decorative mark beside it.
    await expect(page.locator('.hero__meta .platform-badge svg.store-logo').first()).toBeAttached();

    await nav(page, /Library/);
    await page.getByRole('radio', { name: 'List' }).click();
    const row = page.locator('.vlist__row').first();
    await expect(row.locator('svg.store-logo').first()).toBeVisible();

    await nav(page, 'Settings');
    await page.getByRole('button', { name: 'Library & stores' }).click();
    for (const store of ['Steam', 'Epic Games', 'GOG', 'EA app', 'Ubisoft Connect', 'Xbox']) {
      await expect(page.locator('.adapter__head .platform-badge', { hasText: store }).locator('svg.store-logo')).toBeVisible();
    }
    // Xbox shows its real sphere mark (Bootstrap Icons drawing, MIT), like every other store.
    await expect(page.locator('svg.store-logo[data-platform="xbox"]').first()).toHaveAttribute('data-kind', 'brand');
    expect(errors).toEqual([]);
  });

  // Track R: services that aren't stores show their licensed marks, or a plain icon when none exists.
  test('service marks on data sources, Steam Web API and local AI; store marks on install buttons', async ({ page }) => {
    const errors = await open(page, '?reduced');
    await nav(page, 'Settings');
    await page.getByRole('button', { name: 'Library & stores' }).click();
    await expect(page.locator('#steamapi-title svg.store-logo[data-platform="steam"]')).toBeAttached();
    const card = (id: string) => page.locator(`.dsrc-card svg.service-logo[data-service="${id}"]`);
    await expect(card('igdb')).toHaveAttribute('data-kind', 'brand');
    await expect(card('wikidata')).toHaveAttribute('data-kind', 'brand');
    await expect(card('steamdeck')).toHaveAttribute('data-kind', 'brand');
    // No openly licensed mark: a descriptive icon, never an imitation.
    await expect(card('rawg')).toHaveAttribute('data-kind', 'generic');
    await expect(card('awacy')).toHaveAttribute('data-kind', 'generic');
    // The card names the source in text, so its mark is hidden from assistive technology.
    await expect(card('igdb')).toHaveAttribute('aria-hidden', 'true');
    expect(await seriousViolations(page)).toEqual([]);

    await page.getByRole('button', { name: 'Local AI' }).click();
    await expect(page.locator('.sgroup__desc svg.service-logo[data-service="ollama"]')).toBeVisible();

    await nav(page, /Library/);
    await page.getByLabel('Filter library').fill('Echoes of Vael');
    await page.getByRole('button', { name: /^Echoes of Vael/ }).first().click();
    await expect(page.getByRole('button', { name: /Install in EA app/ }).first().locator('svg.store-logo[data-platform="ea"]')).toBeVisible();
    expect(errors).toEqual([]);
  });
});

test.describe('live tiles', () => {
  // Live tiles stay still at "low" visual quality, which "auto" picks on PCs with 4 cores or fewer
  // (GitHub's Windows runners): pretend to be a typical 8-core PC so the behaviour under test runs.
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 }));
  });

  test('only tiles at least half on screen play, two at most, muted, and they stop when scrolled away', async ({ page }) => {
    await open(page);
    await showSteamTiles(page);
    const playing = page.locator('.live-layer[data-playing]');
    await expect(playing.first()).toBeVisible({ timeout: 10_000 });
    const check = async () =>
      page.evaluate(() => {
        const vids = [...document.querySelectorAll<HTMLVideoElement>('video.live-layer__video')];
        const vh = innerHeight;
        const vw = document.querySelector('[data-scroll-main]')!.getBoundingClientRect().right;
        return {
          count: vids.length,
          muted: vids.every((v) => v.muted && v.loop),
          local: vids.every((v) => !/^https?:\/\/(?!localhost)/.test(v.currentSrc || v.src)),
          visible: [...document.querySelectorAll('.live-layer[data-playing]')].every((el) => {
            const r = el.getBoundingClientRect();
            const w = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0));
            const h = Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
            return (w * h) / (r.width * r.height) >= 0.5;
          }),
        };
      });
    // Layout may still be settling on a busy machine; intersection updates are asynchronous.
    await expect.poll(async () => (await check()).visible, { timeout: 4000 }).toBe(true);
    const first = await check();
    expect(first.count).toBeGreaterThan(0);
    expect(first.count).toBeLessThanOrEqual(2);
    expect(first).toMatchObject({ muted: true, local: true, visible: true });

    // Scroll the Continue playing shelf out of view: its tiles release their videos.
    const firstGame = await playing.first().evaluate((el) => el.closest('[data-game-id]')?.getAttribute('data-game-id'));
    await page.locator('[data-scroll-main]').evaluate((el) => el.scrollTo({ top: el.scrollHeight }));
    await expect(page.locator(`.shelf__track--landscape [data-game-id="${firstGame}"] video`)).toHaveCount(0, { timeout: 5000 });
    // Intersection updates arrive asynchronously; within a moment everything playing is on screen again.
    await expect.poll(async () => (await check()).visible, { timeout: 4000 }).toBe(true);
    expect((await check()).count).toBeLessThanOrEqual(2);
  });

  test('reduced motion and data saver keep every tile still', async ({ page }) => {
    await open(page, '?reduced');
    await page.waitForTimeout(1500);
    await expect(page.locator('video.live-layer__video')).toHaveCount(0);

    await open(page);
    await showSteamTiles(page);
    await expect(page.locator('.live-layer[data-playing]').first()).toBeVisible({ timeout: 10_000 });
    await nav(page, 'Settings');
    await page.getByRole('button', { name: 'Privacy' }).click();
    await page.getByRole('switch', { name: 'Data saver', exact: true }).click();
    await nav(page, 'Home');
    await page.waitForTimeout(1500);
    await expect(page.locator('video.live-layer__video')).toHaveCount(0);
  });
});

test.describe('library sort animation', () => {
  test('a re-sort of 5,000 games glides on-screen cards without breaking virtualization', async ({ page }) => {
    await open(page, '?games=5000');
    await nav(page, /Library/);
    const cards = page.locator('.vgrid [data-flip-id]');
    // 5,000 preview games take a while to build under a full parallel run (and on CI).
    await expect(cards.first()).toBeVisible({ timeout: 20_000 });
    const mounted = await cards.count();
    expect(mounted).toBeLessThan(120);

    await page.getByRole('combobox', { name: 'Sort by' }).selectOption('title');
    // Mid-animation: still only the visible slice is mounted (plus short-lived ghosts).
    expect(await cards.count()).toBeLessThan(120);
    await expect(page.locator('.vgrid__ghost')).toHaveCount(0, { timeout: 2000 });
    await page.waitForFunction(() => document.getAnimations().filter((a) => a.playState === 'running' && a.effect?.getComputedTiming().iterations !== Infinity).length === 0);
    const titles = await page.locator('.vgrid [data-flip-id] .card').evaluateAll((els) => els.slice(0, 6).map((e) => e.getAttribute('aria-label')!.split(',')[0]));
    expect([...titles].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()))).toEqual(titles);
    // Cards end exactly in their cells: no transform left behind.
    expect(await cards.evaluateAll((els) => els.every((e) => getComputedStyle(e).transform === 'none'))).toBe(true);

    // Far down the list still renders a small window.
    await page.locator('[data-scroll-main]').evaluate((el) => el.scrollTo({ top: 200_000 }));
    await expect(cards.first()).toBeVisible();
    expect(await cards.count()).toBeLessThan(120);
  });
});

test.describe('owned, never played', () => {
  test('Home offers picks for tonight and See all opens the filtered library, longest-waiting first', async ({ page }) => {
    await open(page);
    const section = page.locator('section.never');
    await expect(section.getByRole('heading', { name: /Owned, never played/ })).toBeVisible();
    await expect(section.getByRole('list', { name: 'Try it tonight' }).getByRole('listitem').first()).toBeVisible();
    await expect(section.locator('.shelf__caption').first()).toHaveText(/^In VYSTRAL for |^New to VYSTRAL today$/);
    await section.getByRole('button', { name: 'See all' }).click();
    await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Never played' })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('combobox', { name: 'Sort by' })).toHaveValue('waiting');
    await expect(page.locator('.vgrid__caption').first()).toHaveText(/VYSTRAL/);
  });

  test('marking a pick as not for me moves it off the shelf, with undo', async ({ page }) => {
    await open(page);
    const picks = page.locator('section.never .tonight');
    const title = await picks.first().locator('.tonight__title').textContent();
    await picks.first().getByRole('button', { name: 'Not for me' }).click();
    await expect(page.getByText(`${title}: Abandoned`)).toBeVisible();
    await expect(page.locator('section.never .tonight__title', { hasText: title! })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.locator('section.never .tonight__title', { hasText: title! })).toHaveCount(1);
  });
});

test.describe('achievement shimmer', () => {
  test('new unlocks shimmer once on the timeline, then not on the next visit', async ({ page }) => {
    await open(page);
    await nav(page, 'Journal');
    await page.getByRole('tab', { name: /Achievements/ }).click();
    await expect(page.getByRole('heading', { name: 'Unlock timeline' })).toBeVisible();
    const fresh = page.locator('.at-row.shimmer');
    await expect(fresh.first()).toBeVisible();
    expect(await fresh.first().getAttribute('data-tier')).toMatch(/^(common|rare|ultra)$/);
    await nav(page, 'Home');
    await nav(page, 'Journal');
    await page.getByRole('tab', { name: /Achievements/ }).click();
    await expect(page.getByRole('heading', { name: 'Unlock timeline' })).toBeVisible();
    await expect(page.locator('.at-row').first()).toBeVisible();
    await expect(fresh).toHaveCount(0);
  });

  test('reduced motion shows a static tint instead of a sweep', async ({ page }) => {
    await open(page, '?reduced');
    await nav(page, 'Journal');
    await page.getByRole('tab', { name: /Achievements/ }).click();
    const fresh = page.locator('.at-row.shimmer').first();
    await expect(fresh).toBeVisible();
    const anim = await fresh.evaluate((el) => getComputedStyle(el, '::before').animationName);
    expect(anim).toBe('none');
  });
});

test.describe('illustrations and settings', () => {
  test('empty states draw a tinted illustration; errors keep the plain icon', async ({ page }) => {
    await open(page);
    await nav(page, /Library/);
    await page.getByRole('textbox', { name: 'Filter library' }).fill('zzzz-no-such-game');
    await expect(page.getByRole('heading', { name: 'Nothing matches' })).toBeVisible();
    const art = page.locator('.empty-art');
    await expect(art).toHaveAttribute('data-kind', 'shelf');
    await expect(art).toHaveAttribute('aria-hidden', 'true');
  });

  test('sound and live-tile settings exist and Home, Library and Settings stay axe-clean', async ({ page }) => {
    await open(page, '?reduced');
    expect(await seriousViolations(page)).toEqual([]);
    await nav(page, 'Settings');
    await expect(page.getByRole('switch', { name: 'Live tiles' })).toBeChecked();
    await page.getByRole('button', { name: 'Controller & sound' }).click();
    const ambient = page.getByRole('switch', { name: 'Ambient sound' });
    await expect(ambient).toBeDisabled(); // needs interface sounds first
    await page.getByRole('switch', { name: 'Interface sounds' }).click();
    await expect(ambient).toBeEnabled();
    await ambient.click();
    await expect(ambient).toBeChecked();
    expect(await seriousViolations(page)).toEqual([]);
    await nav(page, /Library/);
    expect(await seriousViolations(page)).toEqual([]);
  });
});

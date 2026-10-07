import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track Z: Immersive row reordering (keyboard and controller), the screensaver's trailers and big
// clock, and the desktop game page's docking header (preview backend, fictional data).

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

/** A controller press (and release) through the preview backend; `holdMs` keeps it down. */
async function pad(page: Page, button: string, holdMs = 0) {
  await page.evaluate(
    async ([b, ms]) => {
      const c = window.__vystralPreviewController!;
      c.emit('gamepad.button', { button: b, pressed: true });
      if (ms) await new Promise((r) => setTimeout(r, ms));
      c.emit('gamepad.button', { button: b, pressed: false });
    },
    [button, holdMs] as const,
  );
}

/** The Home rows you can move, in screen order (live rows such as Downloads follow their own rules). */
const rowOrder = (page: Page) =>
  page.locator('.imm__row').evaluateAll((els) => els.map((e) => e.getAttribute('data-row-id')).filter((id) => id !== 'playing' && id !== 'downloads'));

async function seriousViolations(page: Page, include: string) {
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page }).include(include).exclude('.living-canvas').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

test.describe('Immersive: moving rows', () => {
  test('keyboard: Left reaches the header, holding Y lifts the row, arrows move it, Enter saves', async ({ page }) => {
    const errors = await open(page);
    await enter(page);
    const before = await rowOrder(page);
    const first = before[0]!;

    await page.keyboard.press('ArrowLeft');
    const header = page.locator(`.imm__row[data-row-id="${first}"] .imm__row-title[data-header-focus]`);
    await expect(header).toBeVisible();
    await expect(page.locator('.imm__hints[data-mode="header"]')).toContainText('Hold to move row');
    await expect(page.locator('.imm__ring')).toHaveCSS('opacity', '0');

    // A tap of Y on the header still searches.
    await page.keyboard.press('y');
    await expect(page.locator('.osk')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.osk')).toHaveCount(0);
    await expect(header).toBeVisible();

    // Holding Y picks the row up.
    await page.keyboard.down('y');
    await page.waitForTimeout(560);
    await page.keyboard.up('y');
    await expect(page.locator('.imm[data-moving]')).toBeVisible();
    await expect(page.locator(`.imm__row[data-row-id="${first}"][data-lifted]`)).toBeVisible();
    await expect(page.locator('.imm-move')).toHaveAccessibleName(/^Moving .+: row 1 of \d+$/);
    await expect(page.locator('.imm__hints[data-mode="moving"]')).toContainText('Drop it here');
    expect(await seriousViolations(page, '.imm')).toEqual([]);

    await page.keyboard.press('ArrowUp'); // already first: an edge, nothing moves
    expect((await rowOrder(page))[0]).toBe(first);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    await expect.poll(() => rowOrder(page)).toEqual([before[1], before[2], first, ...before.slice(3)]);
    await expect(page.locator('.imm-move')).toHaveAccessibleName(/: row 3 of \d+$/);
    // Focus followed the lifted row; it stays the active one.
    await expect(page.locator(`.imm__row[data-row-id="${first}"]`)).toHaveAttribute('data-active', 'true');

    await page.keyboard.press('Enter');
    await expect(page.locator('.imm[data-moving]')).toHaveCount(0);
    await expect.poll(() => getSetting(page, 'immersive.rowOrder')).toMatch(new RegExp(`^${before[1]}\\|${before[2]}\\|${first}\\b`));
    // Back on the header it was picked up from; Right returns to the cards.
    await expect(header).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.imm__row-title[data-header-focus]')).toHaveCount(0);
    await expect(page.locator('.imm__ring')).toHaveCSS('opacity', '1');

    // The order is remembered across a visit to the desktop.
    await page.keyboard.press('F11');
    await expect(page.locator('.shell')).toBeVisible();
    await enter(page);
    await expect.poll(() => rowOrder(page)).toEqual([before[1], before[2], first, ...before.slice(3)]);
    expect(errors).toEqual([]);
  });

  test('keyboard: Escape puts everything back; Y off a header is still search', async ({ page }) => {
    await open(page);
    await enter(page);
    const before = await rowOrder(page);
    await page.keyboard.press('y');
    await expect(page.locator('.osk')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.osk')).toHaveCount(0);

    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('Enter'); // A on a header picks it up too
    await expect(page.locator('.imm[data-moving]')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect.poll(async () => (await rowOrder(page))[1]).toBe(before[0]);
    await page.keyboard.press('Escape');
    await expect(page.locator('.imm[data-moving]')).toHaveCount(0);
    await expect.poll(() => rowOrder(page)).toEqual(before);
    expect(await getSetting(page, 'immersive.rowOrder')).toBe('');
  });

  test('controller: hold Y on the header, D-pad down, A drops; the quick menu can move a row; Display resets', async ({ page }) => {
    await open(page);
    await enter(page);
    const before = await rowOrder(page);
    await pad(page, 'Left');
    await expect(page.locator('.imm__row-title[data-header-focus]')).toBeVisible();
    await pad(page, 'Y', 600);
    await expect(page.locator('.imm[data-moving]')).toBeVisible();
    await expect(page.locator('.osk')).toHaveCount(0); // a hold is not a search
    await pad(page, 'Down');
    await pad(page, 'A');
    await expect(page.locator('.imm[data-moving]')).toHaveCount(0);
    await expect.poll(() => rowOrder(page)).toEqual([before[1], before[0], ...before.slice(2)]);
    await expect.poll(() => getSetting(page, 'immersive.rowOrder')).not.toBe('');

    // From a card: the quick menu's Move row (Y) picks up the focused row.
    await pad(page, 'Right'); // off the header, onto the cards
    await pad(page, 'View');
    const move = page.getByRole('button', { name: /^Move row: / });
    await expect(move).toBeVisible();
    await pad(page, 'Y');
    await expect(page.locator('.imm[data-moving]')).toBeVisible();
    await expect(page.locator('.imm-quick')).toHaveCount(0);
    await pad(page, 'B');
    await expect(page.locator('.imm[data-moving]')).toHaveCount(0);

    // Display & text size › Reset row order: back to the automatic order.
    await pad(page, 'Menu');
    await page.locator('.imm-guide').getByRole('menuitem', { name: /Display & text size/ }).click();
    const reset = page.getByRole('button', { name: /Home row order/ });
    await expect(reset).toHaveText('Reset row order');
    expect(await seriousViolations(page, '.imm-couch')).toEqual([]);
    await reset.click();
    await expect.poll(() => getSetting(page, 'immersive.rowOrder')).toBe('');
    await expect(reset).toHaveText('Automatic');
    await expect(reset).toHaveAttribute('aria-disabled', 'true');
    await page.keyboard.press('Escape');
    await expect.poll(() => rowOrder(page)).toEqual(before);
  });

  test('All games rows never move', async ({ page }) => {
    await open(page);
    await enter(page);
    await page.keyboard.press('e'); // All games
    await expect(page.locator('.imm[data-tab="library"]')).toBeVisible();
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowLeft');
    await expect(page.locator('.imm__row-title[data-header-focus]')).toHaveCount(0);
    await page.keyboard.press('m');
    await expect(page.getByRole('menu')).toBeVisible();
    await expect(page.getByRole('button', { name: /^Move row: / })).toHaveCount(0);
  });
});

test.describe('Immersive: the screensaver', () => {
  test('showcases a game you have not played in a while with its trailer; A opens its page', async ({ page }) => {
    await open(page, '?attractTest');
    await enter(page);
    const focused = await page.locator('.imm__card[data-focused="true"]').getAttribute('aria-label');
    const attract = page.locator('.attract');
    await expect(attract).toBeVisible({ timeout: 10_000 });
    await expect(attract).toHaveAttribute('data-trailers', 'play');
    // The first slide is a rediscovery: played over a month ago (or never started).
    const kicker = page.locator('.attract__kicker');
    await expect(kicker).toHaveText(/It’s been a while|Still waiting for you/);
    await expect(page.locator('.attract__sub').first()).toHaveText(/^(Last played .+ ago|In your library since .+)/);
    // A silent trailer loop crossfades in on a slide with one (some games have none).
    await expect(page.locator('.attract__loop[data-shown]').first()).toBeVisible({ timeout: 25_000 });
    expect(await page.locator('.attract__loop').first().evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);

    const id = await attract.getAttribute('data-slide-game');
    const title = (await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().gamesById.get(${JSON.stringify(id)}).title)`)) as string;
    await pad(page, 'A');
    await expect(attract).toBeHidden();
    await expect(page.locator('.imm-panel__card')).toBeVisible();
    await expect(page.locator('.imm-panel__card')).toContainText(title);
    // Closing the page lands exactly where you were.
    await page.keyboard.press('Escape');
    await expect(page.locator('.imm-panel__card')).toHaveCount(0);
    await expect(page.locator('.imm__card[data-focused="true"]')).toHaveAttribute('aria-label', focused!);
  });

  test('never plays trailers on Data saver or Low quality, and pauses them on battery saver', async ({ page }) => {
    await open(page, '?attractTest');
    await setSetting(page, 'dataSaver.enabled', true);
    await enter(page);
    await expect(page.locator('.attract')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.attract')).toHaveAttribute('data-trailers', 'off');
    await page.waitForTimeout(2500);
    await expect(page.locator('.attract__loop')).toHaveCount(0);
    await page.keyboard.press('Shift');
    await expect(page.locator('.attract')).toBeHidden();

    await setSetting(page, 'dataSaver.enabled', false);
    await setSetting(page, 'appearance.quality', 'low');
    await expect(page.locator('.attract')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.attract')).toHaveAttribute('data-trailers', 'off');
    await page.keyboard.press('Shift');
    await expect(page.locator('.attract')).toBeHidden();

    await setSetting(page, 'appearance.quality', 'high');
    await page.evaluate(() => {
      window.__vystralPreviewSystem!.set({ battery: { percent: 40, charging: false, saver: true } });
      window.__vystralPreviewController!.emit('gamepad.connection', { count: 1 });
    });
    await expect(page.locator('.attract')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.attract')).toHaveAttribute('data-trailers', 'pause');
    await page.waitForTimeout(2500);
    await expect(page.locator('.attract__loop[data-shown]')).toHaveCount(0);
  });

  test('big clock: follows the Windows 24-hour format, drifts, and wakes on any button', async ({ page }) => {
    await open(page, '?attractTest&clock24');
    await setSetting(page, 'immersive.attractClock', true);
    await enter(page);
    const clock = page.locator('.attract-clock');
    await expect(clock).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.attract__clock')).toHaveCount(0); // no small clock as well
    await expect(page.locator('.attract-clock__time')).toHaveText(/^\d{2}:\d{2}$/);
    await expect(page.locator('.attract-clock__period')).toHaveCount(0);
    await expect(page.locator('.attract-clock__date')).not.toBeEmpty();
    // Burn-in protection: the face sits at this minute's drift spot.
    const drift = await page.locator('.attract-clock__face').getAttribute('data-drift');
    const expected = await page.evaluate(`import('/src/views/immersive/screensaver.ts').then((m) => { const d = m.clockDrift(m.minuteOf(Date.now())); return d.x + ',' + d.y; })`);
    expect(drift).toBe(expected);
    const before = await page.locator('.imm__card[data-focused="true"]').getAttribute('aria-label');
    await pad(page, 'B');
    await expect(clock).toBeHidden();
    await expect(page.locator('.imm__card[data-focused="true"]')).toHaveAttribute('aria-label', before!);
  });

  test('big clock: a 12-hour Windows format shows the period', async ({ page }) => {
    await open(page, '?attractTest&clock12');
    await setSetting(page, 'immersive.attractClock', true);
    await enter(page);
    await expect(page.locator('.attract-clock')).toBeVisible({ timeout: 10_000 });
    await expect(page.locator('.attract-clock__time')).toHaveText(/^\d{1,2}:\d{2}(AM|PM)$/i);
    await expect(page.locator('.attract-clock__period')).toHaveText(/^(AM|PM)$/i);
  });
});

/* ------------------------------------------------------------------ desktop: the docking header */

async function openGamePage(page: Page, title = 'Hollow Lantern') {
  await page.evaluate(
    `import('/src/state/store.ts').then((m) => { const s = m.useStore.getState(); const g = s.library.games.find((x) => x.title === ${JSON.stringify(title)}); s.navigate({ name: 'game', id: g.id }); })`,
  );
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeAttached();
  await expect(page.locator('.detail[data-dock]')).toBeAttached();
  await page.waitForTimeout(700); // the hero's entrance settles
}

/** Scrolls the page instantly (the scroller is smooth-scrolling by default) and waits two frames. */
async function scrollTo(page: Page, top: number) {
  await page.evaluate((y) => {
    document.querySelector<HTMLElement>('[data-scroll-main]')!.scrollTo({ top: y, behavior: 'instant' });
  }, top);
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(80);
}

const box = async (page: Page, sel: string) => (await page.locator(sel).first().boundingBox())!;
const opacity = (page: Page, sel: string) => page.locator(sel).first().evaluate((el) => Number(getComputedStyle(el).opacity));
const dockEnd = (page: Page) => page.locator('.detail').evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--dk-end')));

for (const [name, query, mode] of [
  ['scroll-driven', '', 'timeline'],
  ['scripted fallback', '?dockFallback', 'js'],
] as const) {
  test(`game page header docks as you scroll (${name})`, async ({ page }) => {
    const errors = await open(page, query);
    await openGamePage(page);
    await expect(page.locator('.detail')).toHaveAttribute('data-dock', mode);
    const end = await dockEnd(page);
    expect(end).toBeGreaterThan(200);

    // At rest: the hero as it was; the bar is just Back.
    const hero = await box(page, '.dhero__cover');
    await expect(page.locator('.ddock')).not.toHaveAttribute('data-docked');
    expect(await opacity(page, '.ddock__cover')).toBe(0);
    expect(await opacity(page, '.ddock__glass')).toBe(0);
    await expect(page.locator('.ddock .dhero__back')).toBeVisible();
    await expect(page.locator('.ddock__play')).toHaveCount(0);

    // A little way in: the bar's cover sits exactly on the hero cover, riding with the page.
    await scrollTo(page, 40);
    const riding = await box(page, '.ddock__cover');
    expect(Math.abs(riding.x - hero.x)).toBeLessThan(3);
    expect(Math.abs(riding.y - (hero.y - 40))).toBeLessThan(4);
    expect(Math.abs(riding.height - hero.height * 1.0)).toBeLessThan(hero.height * 0.03);
    expect(await opacity(page, '.dhero__cover-slot')).toBe(0);

    // Halfway: between the hero and the bar, and smaller.
    await scrollTo(page, end * 0.6);
    const mid = await box(page, '.ddock__cover');
    expect(mid.height).toBeLessThan(hero.height * 0.95);
    expect(mid.height).toBeGreaterThan(50);
    const titleMid = await box(page, '.dhero__titlescale');

    // Docked: a compact bar with the cover in its slot, the title and Play at the right.
    await scrollTo(page, end + 200);
    await expect(page.locator('.ddock')).toHaveAttribute('data-docked', 'true');
    const docked = await box(page, '.ddock__cover');
    const slot = await box(page, '.ddock__slot');
    expect(Math.abs(docked.height - 48)).toBeLessThan(2.5);
    expect(Math.abs(docked.y - slot.y)).toBeLessThan(2);
    expect(Math.abs(docked.x - slot.x)).toBeLessThan(2);
    expect(await opacity(page, '.ddock__glass')).toBeCloseTo(1, 1);
    expect(await opacity(page, '.ddock__title')).toBeCloseTo(1, 1);
    const bar = await box(page, '.ddock__bar');
    expect(bar.height).toBe(72);
    const play = page.locator('.ddock__play .pbtn__main');
    await expect(play).toBeVisible();
    await expect(play).toHaveAccessibleName(/^Play /);
    const pb = (await play.boundingBox())!;
    expect(pb.y).toBeGreaterThan(bar.y);
    expect(pb.y + pb.height).toBeLessThan(bar.y + bar.height);
    expect(bar.x + bar.width - (pb.x + pb.width)).toBeLessThan(80); // docked at the right
    // The hero title travelled up and shrank on its way into the bar.
    const titleEnd = await box(page, '.dhero__titlescale');
    expect(titleEnd.height).toBeLessThan(titleMid.height);
    expect(await opacity(page, '.dhero__titlescale')).toBeLessThan(0.05);
    // The hero's facts and actions are gone (no invisible buttons left under the bar).
    expect(await page.locator('.dhero__meta').evaluate((el) => getComputedStyle(el).visibility)).toBe('hidden');
    expect(await seriousViolations(page, '.ddock')).toEqual([]);

    // Back to the top: undocked again, Play leaves the bar.
    await scrollTo(page, 0);
    await expect(page.locator('.ddock')).not.toHaveAttribute('data-docked');
    await expect(page.locator('.ddock__play')).toHaveCount(0);
    expect(await opacity(page, '.dhero__cover-slot')).toBe(1);
    expect(errors).toEqual([]);
  });
}

test('game page header: reduced motion jumps to the docked bar with a fade', async ({ page }) => {
  await open(page, '?reduced');
  await openGamePage(page);
  await expect(page.locator('.detail')).toHaveAttribute('data-dock', 'reduced');
  const end = await dockEnd(page);
  const hero = await box(page, '.dhero__cover');
  await scrollTo(page, end * 0.5);
  // No scroll-linked motion: the hero cover scrolls normally, nothing animates with it.
  expect(await page.locator('.ddock__cover').evaluate((el) => getComputedStyle(el).animationName)).toBe('none');
  expect(Math.abs((await box(page, '.dhero__cover')).y - (hero.y - end * 0.5))).toBeLessThan(2);
  expect(await opacity(page, '.ddock__glass')).toBe(0);
  await scrollTo(page, end + 100);
  await expect(page.locator('.ddock')).toHaveAttribute('data-docked', 'true');
  await expect.poll(() => opacity(page, '.ddock__glass')).toBe(1);
  await expect.poll(() => opacity(page, '.ddock__cover')).toBe(1);
  expect(Math.abs((await box(page, '.ddock__cover')).height - 48)).toBeLessThan(2.5);
  await expect(page.locator('.ddock__play .pbtn__main')).toBeVisible();
});

test('game page header: High contrast is an opaque bar with a solid edge', async ({ page }) => {
  await open(page);
  await setSetting(page, 'appearance.theme', 'contrast');
  await openGamePage(page);
  await scrollTo(page, (await dockEnd(page)) + 100);
  await expect(page.locator('.ddock')).toHaveAttribute('data-docked', 'true');
  const glass = page.locator('.ddock__glass');
  expect(await glass.evaluate((el) => getComputedStyle(el).backdropFilter)).toBe('none');
  expect(await glass.evaluate((el) => getComputedStyle(el).backgroundColor)).toMatch(/^(rgb\(0, 0, 0\)|oklch\(0 0 0\))$/);
  expect(await seriousViolations(page, '.ddock')).toEqual([]);
});

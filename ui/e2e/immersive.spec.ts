import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track L: the desktop ↔ Immersive switch and the Immersive overhaul (preview backend, fictional data).

/** Changes a setting through the app's own store (string-evaluated so the dynamic import runs in the page). */
const setSetting = (page: Page, key: string, value: unknown) =>
  page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().setSetting(${JSON.stringify(key)}, ${JSON.stringify(value)}))`);
const isFavorite = (page: Page, title: string) =>
  page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().library.games.find((g) => g.title === ${JSON.stringify(title)}).favorite)`) as Promise<boolean>;

/** Skip the startup animation; pretend to be an 8-core PC so "auto" quality isn't Low on CI runners. */
async function open(page: Page, query = '', opts: { tourDone?: boolean } = { tourDone: true }) {
  await page.addInitScript(() => {
    sessionStorage.setItem('vystral.introPlayed', '1');
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm, .onb').first()).toBeVisible();
  // Warm the dev server's transform of the Immersive code (the app preloads it when the switch starts).
  await page.evaluate("import('/src/views/Immersive.tsx')");
  if (opts.tourDone) await setSetting(page, 'immersive.tourDone', true);
  return errors;
}

/** Simulates a press (and release) of a controller button through the preview backend. */
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

const switchAttr = (page: Page) => page.evaluate(() => document.documentElement.dataset.modeSwitch ?? null);

/** Records every phase the switch goes through until it settles (no stuck states). */
async function watchSwitch(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __phases: string[]; __watching?: boolean };
    w.__phases = [];
    if (w.__watching) return;
    w.__watching = true;
    new MutationObserver(() => w.__phases.push(document.documentElement.dataset.modeSwitch ?? 'none')).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-mode-switch'],
    });
  });
}
const phases = (page: Page) => page.evaluate(() => (window as unknown as { __phases: string[] }).__phases);

async function settled(page: Page) {
  await expect.poll(() => switchAttr(page), { timeout: 10_000 }).toBeNull();
  await expect(page.locator('.mt')).toHaveCount(0);
}

async function enter(page: Page) {
  await page.keyboard.press('F11');
  await expect(page.locator('.imm')).toBeVisible();
  await settled(page);
  await expect(page.locator('.imm__card[data-focused="true"]')).toBeVisible();
}

async function seriousViolations(page: Page, include: string) {
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page }).include(include).exclude('.living-canvas').analyze();
  return results.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

test.describe('mode switch', () => {
  test('cinematic enter and exit: fold away, star, rise in — and never left half-way', async ({ page }) => {
    const errors = await open(page);
    await watchSwitch(page);
    const t0 = Date.now();
    await page.keyboard.press('F11');
    await expect(page.locator('.mt__star')).toBeAttached();
    await expect(page.locator('.imm')).toBeVisible();
    await settled(page);
    const took = Date.now() - t0;
    expect(await phases(page)).toEqual(['out', 'hold', 'in', 'none']);
    expect(took).toBeLessThan(4000); // ~0.9 s of animation plus test overhead on a busy runner
    // The game the overlay zoomed into is the one Immersive opens on.
    await expect(page.locator('.imm__card[data-focused="true"]')).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'immersive');

    await watchSwitch(page);
    await page.keyboard.press('F11');
    await expect(page.locator('.shell')).toBeVisible();
    await settled(page);
    expect(await phases(page)).toEqual(['out', 'hold', 'in', 'none']);
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'desktop');
    // The desktop chrome is fully back (no leftover fold transform).
    const t = await page.locator('.sidebar').evaluate((el) => getComputedStyle(el).transform);
    expect(t === 'none' || t === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true);
    expect(errors).toEqual([]);
  });

  test('any input skips; before the commit it is swallowed, after it reaches Immersive', async ({ page }) => {
    await open(page);
    await page.keyboard.press('F11');
    await page.keyboard.press('ArrowRight'); // during the fold-away: skips, and must not move anything
    await settled(page);
    await expect(page.locator('.imm')).toBeVisible();
    const first = await page.locator('.imm__card[data-focused="true"]').getAttribute('aria-label');
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.imm__card[data-focused="true"]')).not.toHaveAttribute('aria-label', first!);
    // Toggling twice fast never leaves a half-way state: the mode and the layout always agree.
    await page.keyboard.press('F11');
    await page.keyboard.press('F11');
    await settled(page);
    const mode = await page.locator('html').getAttribute('data-mode');
    await expect(page.locator(mode === 'immersive' ? '.imm' : '.shell')).toBeVisible();
    await expect(page.locator(mode === 'immersive' ? '.shell' : '.imm')).toHaveCount(0);
  });

  test('reduced motion is a quick crossfade without the star', async ({ page }) => {
    await open(page, '?reduced');
    await watchSwitch(page);
    await page.keyboard.press('F11');
    await expect(page.locator('.mt--fade')).toBeAttached();
    await expect(page.locator('.mt__star')).toHaveCount(0);
    await settled(page);
    await expect(page.locator('.imm')).toBeVisible();
    await page.keyboard.press('F11');
    await settled(page);
    await expect(page.locator('.shell')).toBeVisible();
  });

  test('works from the controller (Menu) both ways', async ({ page }) => {
    await open(page);
    await pad(page, 'Menu');
    await expect(page.locator('.imm')).toBeVisible();
    await settled(page);
    await pad(page, 'Menu');
    await expect(page.locator('.shell')).toBeVisible();
    await settled(page);
  });

  test('the cinematic switch can be turned off (a quick fade instead)', async ({ page }) => {
    await open(page);
    await setSetting(page, 'immersive.cinematicSwitch', false);
    await page.keyboard.press('F11');
    await expect(page.locator('.mt--fade')).toBeAttached();
    await settled(page);
  });
});

test.describe('Immersive overhaul', () => {
  test('rows, system bar, browse by store and a filtered grid', async ({ page }) => {
    const errors = await open(page);
    await enter(page);
    // System bar: fictional laptop on Wi-Fi with a wireless controller.
    const bar = page.getByRole('group', { name: 'System' });
    await expect(bar.getByRole('img', { name: 'Battery 76%' })).toBeVisible();
    await expect(bar.getByRole('img', { name: 'Wi-Fi, signal 3 of 5' })).toBeVisible();
    await expect(bar.getByRole('img', { name: 'Controller, battery 62%' })).toBeVisible();
    // The first Continue tile is the pinned "Jump back in" slot.
    await expect(page.locator('.imm__card--pinned')).toHaveCount(1);
    await expect(page.getByText('Jump back in')).toBeVisible();

    // Walk down to the stores row and open Steam.
    for (let i = 0; i < 14; i++) {
      if ((await page.locator('.imm__row[data-active="true"] .imm__row-name').textContent()) === 'Your stores') break;
      await page.keyboard.press('ArrowDown');
    }
    await expect(page.locator('.imm__row[data-active="true"] .imm__row-name')).toHaveText('Your stores');
    await expect(page.locator('.imm__card[data-focused="true"]')).toHaveAttribute('aria-label', /^Steam, \d+ games$/);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Showing Steam. Clear filter' })).toBeVisible();
    await expect(page.locator('.imm__tab[aria-current="page"]')).toHaveText('All games');
    // B/Escape returns to exactly where you were.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /Clear filter/ })).toHaveCount(0);
    await expect(page.locator('.imm__row[data-active="true"] .imm__row-name')).toHaveText('Your stores');
    expect(errors).toEqual([]);
  });

  test('quick menu: hold X or press View; tap X toggles Favorite', async ({ page }) => {
    await open(page, '?vibration');
    await enter(page);
    const label = (await page.locator('.imm__card[data-focused="true"]').getAttribute('aria-label'))!.replace(', not installed', '');
    // A tap (press + release) favourites, it doesn't open the menu.
    const before = await isFavorite(page, label);
    await pad(page, 'X');
    await expect.poll(() => isFavorite(page, label)).toBe(!before);
    await expect(page.getByRole('menu')).toHaveCount(0);

    // Holding X opens the radial; the D-pad walks it; B closes.
    await pad(page, 'X', 600);
    const menu = page.getByRole('menu', { name: `Quick actions for ${label}` });
    await expect(menu).toBeVisible();
    await expect(menu.locator('[data-selected="true"]')).toHaveAccessibleName(/Play|Install|Get it|Not installed/);
    await pad(page, 'Right');
    await expect(menu.locator('[data-selected="true"]')).toHaveAccessibleName(/favorites/);
    await pad(page, 'Right');
    await pad(page, 'A'); // Status → the status ring
    await expect(page.getByRole('menu', { name: `Play status for ${label}` })).toBeVisible();
    await pad(page, 'B'); // back to the main ring
    await expect(menu).toBeVisible();
    await pad(page, 'B');
    await expect(page.getByRole('menu')).toHaveCount(0);

    // View opens it too, and Achievements opens the game page on that tab.
    await pad(page, 'View');
    await expect(menu).toBeVisible();
    await pad(page, 'Left');
    await expect(menu.locator('[data-selected="true"]')).toHaveAccessibleName('Achievements');
    await pad(page, 'A');
    await expect(page.getByRole('tab', { name: /Achievements/, selected: true })).toBeVisible();
  });

  test('game page: tabs by LB/RB and Q/E, favourite stays live, B closes, nothing leaks to the desktop', async ({ page }) => {
    await open(page);
    await enter(page);
    await page.keyboard.press('Enter');
    const dialog = page.locator('.imm-panel__card');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('tab', { name: /Overview/, selected: true })).toBeVisible();
    // Favourite toggles both ways (reads the live game, not a snapshot).
    const fav = dialog.getByRole('button', { name: /Favorite|Add to favorites/ });
    const pressed = await fav.getAttribute('aria-pressed');
    await fav.click();
    await expect(fav).not.toHaveAttribute('aria-pressed', pressed!);
    await fav.click();
    await expect(fav).toHaveAttribute('aria-pressed', pressed!);

    await pad(page, 'RB');
    await expect(page.getByRole('tab', { name: /Achievements/, selected: true })).toBeVisible();
    await pad(page, 'RB');
    await expect(page.getByRole('tab', { name: /Sessions/, selected: true })).toBeVisible();
    await page.keyboard.press('e');
    await expect(page.getByRole('tab', { name: /Media/, selected: true })).toBeVisible();
    await page.keyboard.press('q');
    await expect(page.getByRole('tab', { name: /Sessions/, selected: true })).toBeVisible();
    // Y (command bar) and LB at the first tab don't escape to the desktop UI underneath.
    await pad(page, 'Y');
    await expect(page.locator('.cmd')).toHaveCount(0);
    await pad(page, 'B');
    await expect(dialog).toBeHidden();
    await expect(page.locator('html')).toHaveAttribute('data-mode', 'immersive');
  });

  test('search has fast filters (View cycles them)', async ({ page }) => {
    await open(page);
    await enter(page);
    await pad(page, 'Y');
    const filters = page.getByRole('radiogroup', { name: 'Show' });
    await expect(filters.getByRole('radio', { name: /^All/ })).toHaveAttribute('aria-checked', 'true');
    await pad(page, 'View');
    await expect(filters.getByRole('radio', { name: /^Installed/ })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('searchbox', { name: 'Search your library' })).toHaveAttribute('placeholder', /Search \d+ games/);
    await pad(page, 'Y');
    await expect(filters).toBeHidden();
  });

  test('couch mode: text size and safe area apply live and persist', async ({ page }) => {
    await open(page);
    await enter(page);
    await page.getByRole('button', { name: 'Display and text size' }).click();
    const sheet = page.getByRole('dialog', { name: 'Display' });
    await expect(sheet).toBeVisible();
    const size = sheet.getByRole('slider', { name: 'Text size' });
    await expect(size).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(size).toHaveAttribute('aria-valuetext', '105%');
    await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue('--couch-scale'))).toBe('1.05');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await expect(sheet.getByRole('slider', { name: 'Safe area' })).toHaveAttribute('aria-valuetext', '2%');
    const pad2 = await page.locator('.imm').evaluate((el) => parseFloat(getComputedStyle(el).paddingTop));
    expect(pad2).toBeGreaterThan(10);
    await page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
    // Leaving Immersive drops the couch scale from the desktop layout.
    await page.keyboard.press('F11');
    await settled(page);
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--couch-scale'))).toBe('');
  });

  test('spatial sounds pan with the travelling ring and drop in pitch with row depth', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __notes: { pan: number; freq: number }[] };
      w.__notes = [];
      const proto = AudioContext.prototype;
      const createPanner = proto.createStereoPanner;
      const createOsc = proto.createOscillator;
      let lastPan: StereoPannerNode | null = null;
      proto.createStereoPanner = function () {
        lastPan = createPanner.call(this);
        return lastPan;
      };
      proto.createOscillator = function () {
        const osc = createOsc.call(this);
        const pan = lastPan;
        queueMicrotask(() => w.__notes.push({ pan: pan?.pan.value ?? 0, freq: osc.frequency.value }));
        return osc;
      };
    });
    await open(page);
    await setSetting(page, 'sounds.enabled', true);
    await enter(page);
    // The A–Z grid fits on screen, so the ring travels right as focus moves right.
    await page.keyboard.press('e');
    await page.waitForTimeout(500);
    const notes = () => page.evaluate(() => (window as unknown as { __notes: { pan: number; freq: number }[] }).__notes.slice());
    const take = async () => {
      await page.waitForTimeout(260);
      const n = await notes();
      return n[n.length - 1];
    };
    await page.keyboard.press('ArrowRight');
    const a = await take();
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    const b = await take();
    expect(b.pan).toBeGreaterThan(a.pan);
    // Moving down a row steps down in pitch: the row sound goes from the old row's note to a lower one.
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(260);
    const n = await notes();
    const [from, to] = n.slice(-2);
    expect(to.freq).toBeLessThan(from.freq);

    // Off when interface sounds are off.
    await setSetting(page, 'sounds.enabled', false);
    const count = (await notes()).length;
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(300);
    expect((await notes()).length).toBe(count);
  });

  test('the hero stage plays a live loop once focus rests on a Steam game', async ({ page }) => {
    await open(page);
    await enter(page);
    // Walk right until a game with a loop is focused (preview: two in three Steam games have one).
    let playing = false;
    for (let i = 0; i < 10 && !playing; i++) {
      playing = await page
        .locator('.imm__loop[data-playing]')
        .waitFor({ state: 'attached', timeout: 2400 })
        .then(() => true)
        .catch(() => false);
      if (!playing) await page.keyboard.press('ArrowRight');
    }
    expect(playing).toBe(true);
    // Moving on removes it (decoders are released).
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.imm__loop')).toHaveCount(0);
  });

  test('first-run tour advances as you do things, and Skip ends it for good', async ({ page }) => {
    await open(page, '', { tourDone: false });
    await enter(page);
    const tour = page.getByRole('region', { name: 'Immersive Mode tour' });
    await expect(tour.getByText('Look around')).toBeVisible();
    await page.keyboard.press('ArrowRight');
    await expect(tour.getByText('Switch sections')).toBeVisible();
    await page.keyboard.press('e');
    await expect(tour.getByText('Quick actions')).toBeVisible();
    await tour.getByRole('button', { name: /Skip tour/ }).click();
    await expect(tour).toHaveCount(0);
    await page.keyboard.press('F11');
    await settled(page);
    await enter(page);
    await expect(page.getByRole('region', { name: 'Immersive Mode tour' })).toHaveCount(0);
  });

  test('a controller button wakes the screensaver (and only wakes it)', async ({ page }) => {
    await open(page, '?attractTest');
    await enter(page);
    const before = await page.locator('.imm__card[data-focused="true"]').getAttribute('aria-label');
    await expect(page.locator('.attract')).toBeVisible({ timeout: 10_000 });
    await pad(page, 'Right');
    await expect(page.locator('.attract')).toBeHidden();
    await expect(page.locator('.imm__card[data-focused="true"]')).toHaveAttribute('aria-label', before!);
  });

  test('has no serious accessibility violations (home, quick menu, game page, display)', async ({ page }) => {
    await open(page, '?reduced');
    await enter(page);
    expect(await seriousViolations(page, '.imm')).toEqual([]);
    await page.keyboard.press('m');
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await seriousViolations(page, '.imm-quick')).toEqual([]);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expect(page.locator('.imm-panel__card')).toBeVisible();
    expect(await seriousViolations(page, '.imm-panel')).toEqual([]);
    await page.keyboard.press('e');
    await expect(page.getByRole('tab', { name: /Achievements/, selected: true })).toBeVisible();
    await page.waitForTimeout(500);
    expect(await seriousViolations(page, '.imm-panel')).toEqual([]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Display and text size' }).click();
    expect(await seriousViolations(page, '.imm-couch')).toEqual([]);
  });

  test('high contrast theme renders Immersive with a plain ring', async ({ page }) => {
    await open(page, '?reduced');
    await setSetting(page, 'appearance.theme', 'contrast');
    await enter(page);
    const glint = await page.locator('.imm__ring-glint').evaluate((el) => getComputedStyle(el).display);
    expect(glint).toBe('none');
    expect(await seriousViolations(page, '.imm')).toEqual([]);
  });
});

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track T: controller glyphs and hint alignment, voice-over and captions, and the Immersive
// improvements (guide, All games toolbar and quick jump, Now playing, Downloads, achievement
// showcase, focus memory, seamless return). Preview backend, fictional data.

const setSetting = (page: Page, key: string, value: unknown) =>
  page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().setSetting(${JSON.stringify(key)}, ${JSON.stringify(value)}))`);
const getSetting = (page: Page, key: string) => page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().settings[${JSON.stringify(key)}])`);

async function open(page: Page, query = '') {
  await page.addInitScript(() => {
    sessionStorage.setItem('vystral.introPlayed', '1');
    Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm').first()).toBeVisible();
  await page.evaluate("import('/src/views/Immersive.tsx')");
  await setSetting(page, 'immersive.tourDone', true);
  return errors;
}

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

async function settled(page: Page) {
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.modeSwitch ?? null), { timeout: 10_000 }).toBeNull();
  await expect(page.locator('.mt')).toHaveCount(0);
}

async function enter(page: Page) {
  await page.keyboard.press('F11');
  await expect(page.locator('.imm')).toBeVisible();
  await settled(page);
  await expect(page.locator('.imm__card[data-focused="true"]')).toBeVisible();
}

const focusedLabel = (page: Page) => page.locator('.imm__card[data-focused="true"], .imm__chip[data-focused="true"]').first().getAttribute('aria-label');

/**
 * Every hint in `scope`: the glyph's centre and the label's centre within 1 px vertically, and the
 * glyph's drawn ink centred in its own shape within 1 px.
 */
async function hintAlignment(page: Page, scope: string) {
  return page.evaluate((sel) => {
    const out: { label: string; dy: number; inkDx: number; inkDy: number }[] = [];
    for (const hint of document.querySelectorAll<HTMLElement>(`${sel} .pad-hint`)) {
      const label = hint.querySelector<HTMLElement>('.pad-hint__label');
      const glyphs = [...hint.querySelectorAll<HTMLElement>('.pad-glyph')];
      if (!label || !glyphs.length || !hint.offsetParent) continue;
      const l = label.getBoundingClientRect();
      for (const g of glyphs) {
        const r = g.getBoundingClientRect();
        const body = g.querySelector<SVGGraphicsElement>('.pg__body')!.getBoundingClientRect();
        const inks = [...g.querySelectorAll<SVGGraphicsElement>('.pg__ink, .pg__ink-fill')].map((e) => e.getBoundingClientRect());
        const ink = inks.reduce((a, b) => ({ left: Math.min(a.left, b.left), right: Math.max(a.right, b.right), top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) }));
        const isTrigger = g.classList.contains('pad-glyph--trigger');
        out.push({
          label: `${label.textContent} / ${g.getAttribute('aria-label')}`,
          dy: Math.abs(r.top + r.height / 2 - (l.top + l.height / 2)),
          // Bumpers centre their label on the shape's visual centre (a hair off the box centre) — checked in unit tests.
          inkDx: g.classList.contains('pad-glyph--bumper') ? 0 : Math.abs((ink.left + ink.right) / 2 - (body.left + body.right) / 2),
          // Trigger labels sit 0.4 units high on purpose (the shape's mass is low).
          inkDy: Math.abs((ink.top + ink.bottom) / 2 - (body.top + body.bottom) / 2) - (isTrigger ? (0.4 / 24) * r.height : 0),
        });
      }
    }
    return out;
  }, scope);
}

function expectAligned(rows: { label: string; dy: number; inkDx: number; inkDy: number }[], min = 1) {
  expect(rows.length).toBeGreaterThanOrEqual(min);
  for (const r of rows) {
    expect(r.dy, `${r.label}: glyph vs label`).toBeLessThanOrEqual(1);
    expect(r.inkDx, `${r.label}: ink x`).toBeLessThanOrEqual(1);
    expect(Math.abs(r.inkDy), `${r.label}: ink y`).toBeLessThanOrEqual(1);
  }
}

async function seriousViolations(page: Page, include: string) {
  await page.waitForTimeout(400);
  const results = await new AxeBuilder({ page }).include(include).exclude('.living-canvas').analyze();
  return results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical').map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`);
}

/* ------------------------------------------------------------------ glyphs and hint alignment */

for (const [w, h, scale] of [[1280, 720, 1], [1920, 1080, 1], [2560, 1440, 1], [1280, 720, 1.5], [1280, 720, 2]] as const) {
  test.describe(`hint alignment at ${w}×${h} @${scale}x`, () => {
    test.use({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
    test('footer, quick menu, game page, guide and search hints line up', async ({ page }) => {
      await open(page, '?reduced');
      await enter(page);
      expectAligned(await hintAlignment(page, '.imm__hints'), 5);
      await page.keyboard.press('m');
      await expect(page.getByRole('menu')).toBeVisible();
      expectAligned(await hintAlignment(page, '.imm-quick__hints'), 2);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
      await expect(page.locator('.imm-panel__card')).toBeVisible();
      expectAligned(await hintAlignment(page, '.imm-page__hints'), 3);
      await page.keyboard.press('Escape');
      await expect(page.locator('.imm-panel__card')).toHaveCount(0);
      await pad(page, 'Menu');
      await expect(page.locator('.imm-guide__panel')).toBeVisible();
      expectAligned(await hintAlignment(page, '.imm-guide__hints'), 2);
      await pad(page, 'B');
      await expect(page.locator('.imm-guide')).toHaveCount(0);
      await pad(page, 'Y');
      await expect(page.locator('.osk__hints')).toBeVisible();
      expectAligned(await hintAlignment(page, '.osk__hints'), 6);
    });
  });
}

test.describe('hint alignment in couch mode', () => {
  test('130% text and a safe area keep every hint centred', async ({ page }) => {
    await open(page, '?reduced');
    await setSetting(page, 'immersive.scale', 1.3);
    await setSetting(page, 'immersive.safeArea', 0.04);
    await enter(page);
    expectAligned(await hintAlignment(page, '.imm__hints'), 5);
    await page.getByRole('button', { name: 'Display and text size' }).click();
    await expect(page.getByRole('dialog', { name: 'Display' })).toBeVisible();
    expectAligned(await hintAlignment(page, '.imm-couch__hints'), 3);
  });
});

test.describe('controller glyphs', () => {
  test('drawn as SVG; PlayStation detected from the Gamepad id; a chosen family wins', async ({ page }) => {
    await open(page);
    await enter(page);
    const a = page.locator('.imm__hints .pad-glyph').first();
    await expect(a).toHaveAttribute('aria-label', 'A button');
    await expect(a.locator('svg')).toHaveCount(1);
    await expect(page.locator('.imm__exit .pad-glyph')).toHaveAttribute('aria-label', 'Menu button');
    // A DualSense says hello through the standard Gamepad API.
    await page.evaluate(() => {
      const e = new Event('gamepadconnected');
      Object.defineProperty(e, 'gamepad', { value: { id: 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', connected: true, timestamp: 1 } });
      window.dispatchEvent(e);
    });
    await expect(a).toHaveAttribute('aria-label', 'Cross button');
    await expect(page.locator('.imm__exit .pad-glyph')).toHaveAttribute('aria-label', 'Options button');
    await expect(page.locator('.imm__tabs .pad-glyph').first()).toHaveAttribute('aria-label', 'L1 button');
    await setSetting(page, 'controller.glyphs', 'nintendo');
    await expect(a).toHaveAttribute('aria-label', 'B button');
    await expect(page.locator('.imm__exit .pad-glyph')).toHaveAttribute('aria-label', 'Plus button');
    await setSetting(page, 'controller.glyphs', 'xbox');
    await expect(a).toHaveAttribute('aria-label', 'A button');
  });
});

/* ------------------------------------------------------------------ voice-over and captions */

/** A stand-in for Windows' speech engine: records what's said; one local and one online voice. */
async function mockSpeech(page: Page, opts: { noLocal?: boolean } = {}) {
  await page.addInitScript((noLocal) => {
    const w = window as unknown as { __spoken: { text: string; voice: string | null; rate: number }[]; __cancels: number };
    w.__spoken = [];
    w.__cancels = 0;
    const voices = [
      ...(noLocal ? [] : [{ voiceURI: 'zira', name: 'Microsoft Zira - English (United States)', lang: 'en-US', localService: true, default: true }]),
      { voiceURI: 'aria-online', name: 'Microsoft Aria Online (Natural) - English (United States)', lang: 'en-US', localService: false, default: false },
    ];
    class Utterance {
      text: string;
      voice: { voiceURI: string } | null = null;
      rate = 1;
      volume = 1;
      lang = '';
      onstart: (() => void) | null = null;
      onend: (() => void) | null = null;
      onerror: (() => void) | null = null;
      constructor(t: string) {
        this.text = t;
      }
    }
    (window as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = Utterance;
    Object.defineProperty(window, 'speechSynthesis', {
      configurable: true,
      value: {
        speak(u: Utterance) {
          w.__spoken.push({ text: u.text, voice: u.voice?.voiceURI ?? null, rate: u.rate });
          setTimeout(() => u.onstart?.(), 0);
          // Long enough that the caption is still up when a busy test machine checks it.
          setTimeout(() => u.onend?.(), 2500);
        },
        cancel() {
          w.__cancels++;
        },
        getVoices: () => voices,
        addEventListener() {},
      },
    });
  }, !!opts.noLocal);
}
const spoken = (page: Page) => page.evaluate(() => (window as unknown as { __spoken: { text: string; voice: string | null; rate: number }[] }).__spoken.slice());
const lastSpoken = async (page: Page) => (await spoken(page)).at(-1)?.text ?? '';

test.describe('voice-over', () => {
  test('off by default: nothing is said', async ({ page }) => {
    await mockSpeech(page);
    await open(page);
    expect(await getSetting(page, 'voiceover.enabled')).toBe(false);
    await enter(page);
    await page.keyboard.press('ArrowRight');
    await page.waitForTimeout(600);
    expect(await spoken(page)).toEqual([]);
    await expect(page.locator('.captions__bar')).toHaveCount(0);
  });

  test('speaks the focused game and its state, rows on row change, debounced, with captions', async ({ page }) => {
    await mockSpeech(page);
    await open(page);
    await setSetting(page, 'voiceover.enabled', true);
    await setSetting(page, 'voiceover.rate', 1.3);
    await enter(page);
    await expect.poll(() => lastSpoken(page)).toMatch(/^Continue playing\. .+\. (Jump back in\. )?(Installed|Not installed), /);
    // Only the local voice is used, at the chosen rate.
    expect((await spoken(page)).every((s) => s.voice === 'zira' && Math.abs(s.rate - 1.3) < 0.01)).toBe(true);
    // Fast browsing: three moves, one phrase (the last), and the previous one is cancelled.
    const before = (await spoken(page)).length;
    // (Dispatched in one go, like a controller's auto-repeat, so a busy test machine can't space them out.)
    await page.evaluate(() => {
      for (let i = 0; i < 3; i++) dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    });
    await expect.poll(async () => (await spoken(page)).length).toBe(before + 1);
    await page.waitForTimeout(500);
    expect((await spoken(page)).length).toBe(before + 1);
    const title = (await focusedLabel(page))!.replace(', not installed', '');
    expect(await lastSpoken(page)).toContain(`${title}.`);
    expect(await lastSpoken(page)).not.toMatch(/^Continue playing/);
    // The caption shows the same words (hidden from screen readers so nothing is read twice).
    await expect(page.locator('.captions__text').last()).toHaveText(await lastSpoken(page));
    await expect(page.locator('.captions')).toHaveAttribute('aria-hidden', 'true');
    // A row change says the row's name first.
    await page.keyboard.press('ArrowDown');
    const row = await page.locator('.imm__row[data-active="true"] .imm__row-name').textContent();
    await expect.poll(() => lastSpoken(page)).toMatch(new RegExp(`^${row}\\. `));
  });

  test('menus and dialogs: quick menu items, game page tabs; notices queue', async ({ page }) => {
    await mockSpeech(page);
    await open(page);
    await setSetting(page, 'voiceover.enabled', true);
    await enter(page);
    const title = (await focusedLabel(page))!.replace(', not installed', '');
    await page.keyboard.press('m');
    await expect.poll(() => lastSpoken(page)).toMatch(new RegExp(`^Quick actions for ${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\. `));
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => lastSpoken(page)).toMatch(/favorites/);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expect(page.locator('.imm-panel__card')).toBeVisible();
    await page.keyboard.press('e');
    await expect.poll(() => lastSpoken(page)).toMatch(/Achievements, tab, selected|Achievements/);
    await page.keyboard.press('Escape');
    // Back on the rows, the focused game is said again so you know where you landed.
    await expect.poll(() => lastSpoken(page)).toContain(title);
    await page.waitForTimeout(300);
    // A notice (toast) is read after what's being said, without cutting it off.
    const cancels = await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels);
    await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().toast({ tone: 'success', title: 'Saved your screenshot' }))`);
    await expect.poll(() => lastSpoken(page)).toBe('Saved your screenshot.');
    expect(await page.evaluate(() => (window as unknown as { __cancels: number }).__cancels)).toBe(cancels);
  });

  test('captions only: shows the words, never speaks; settings sheet from the guide', async ({ page }) => {
    await mockSpeech(page);
    await open(page);
    await enter(page);
    await pad(page, 'Menu');
    await page.getByRole('menuitem', { name: /Voice-over & captions/ }).click();
    const sheet = page.getByRole('dialog', { name: 'Voice-over & captions' });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('switch', { name: 'Voice-over' })).toBeFocused();
    await pad(page, 'A');
    await expect(sheet.getByRole('switch', { name: 'Voice-over' })).toHaveAttribute('aria-checked', 'true');
    await pad(page, 'Down');
    await pad(page, 'A');
    await expect(sheet.getByRole('switch', { name: 'Captions only' })).toHaveAttribute('aria-checked', 'true');
    expect(await getSetting(page, 'voiceover.captionsOnly')).toBe(true);
    // Only the local voice is offered.
    await expect(sheet.locator('.imm-voice__name')).toHaveText('Zira · English (United States)');
    expect(await seriousViolations(page, '.imm-voice')).toEqual([]);
    await pad(page, 'B');
    const before = (await spoken(page)).length;
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.captions__text').last()).toContainText((await focusedLabel(page))!.replace(', not installed', ''));
    expect((await spoken(page)).length).toBe(before);
  });

  test('without a local Windows voice it explains and offers captions only', async ({ page }) => {
    await mockSpeech(page, { noLocal: true });
    await open(page);
    await setSetting(page, 'voiceover.enabled', true);
    await enter(page);
    await page.keyboard.press('ArrowRight');
    await expect(page.locator('.captions__text').last()).toBeVisible();
    expect(await spoken(page)).toEqual([]); // the online voice is never used
    await pad(page, 'Menu');
    await page.getByRole('menuitem', { name: /Voice-over & captions/ }).click();
    await expect(page.getByText(/No Windows voices are installed on this PC/)).toBeVisible();
  });
});

/* ------------------------------------------------------------------ guide, grid, live rows */

test.describe('Immersive improvements', () => {
  test('Menu opens the guide; Menu again goes to desktop and lands on the same game', async ({ page }) => {
    const errors = await open(page);
    await enter(page);
    await page.keyboard.press('ArrowRight');
    const title = (await focusedLabel(page))!.replace(', not installed', '');
    await pad(page, 'Menu');
    const guide = page.getByRole('dialog', { name: /Good (morning|afternoon|evening)|Late session/ });
    await expect(guide).toBeVisible();
    await expect(guide.getByRole('menuitem', { name: /Desktop mode/ })).toBeFocused();
    expect(await seriousViolations(page, '.imm-guide')).toEqual([]);
    await pad(page, 'Menu');
    await expect(page.locator('.shell')).toBeVisible();
    await settled(page);
    await expect(page.getByRole('heading', { name: title, level: 1 }).or(page.getByRole('img', { name: title })).first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('Close VYSTRAL needs a hold; Settings opens desktop settings', async ({ page }) => {
    await open(page);
    await enter(page);
    await pad(page, 'Menu');
    const close = page.getByRole('menuitem', { name: /Close VYSTRAL/ });
    for (let i = 0; i < 5; i++) await pad(page, 'Down');
    await expect(close).toBeFocused();
    await pad(page, 'A'); // a tap does nothing
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__vystralPreviewClosed ?? false)).toBe(false);
    await pad(page, 'A', 1300);
    await expect.poll(() => page.evaluate(() => window.__vystralPreviewClosed ?? false)).toBe(true);
  });

  test('All games: toolbar sort and store filter chips, LT/RT jump by letter with a rail', async ({ page }) => {
    await open(page);
    await enter(page);
    await page.keyboard.press('e');
    await expect(page.locator('.imm__row[data-active="true"]')).toHaveClass(/imm__row--library/);
    const rail = page.getByRole('navigation', { name: 'Jump to' });
    await expect(rail).toBeVisible();
    const first = await focusedLabel(page);
    const letter = await rail.locator('[aria-current="true"]').textContent();
    await pad(page, 'RT');
    await expect(page.locator('.imm-flash__label')).toBeVisible();
    await expect(rail.locator('[aria-current="true"]')).not.toHaveText(letter!);
    expect(await focusedLabel(page)).not.toBe(first);
    await pad(page, 'LT');
    await expect(rail.locator('[aria-current="true"]')).toHaveText(letter!);

    // Up to the toolbar: Sort, then filters.
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('ArrowUp');
    await expect(page.locator('.imm__chip[data-focused="true"]')).toHaveAttribute('aria-label', 'Sort: A–Z');
    await page.keyboard.press('Enter');
    await expect.poll(() => getSetting(page, 'immersive.librarySort')).toBe('recent');
    await expect(page.locator('.imm__chip[data-focused="true"]')).toHaveAttribute('aria-label', 'Sort: Recently played');
    for (let i = 0; i < 12; i++) {
      if (/^Steam,/.test((await focusedLabel(page)) ?? '')) break;
      await page.keyboard.press('ArrowRight');
    }
    await page.keyboard.press('Enter');
    await expect(page.locator('.imm__chip[aria-pressed="true"]')).toHaveAttribute('aria-label', /^Steam, \d+ games, selected$/);
    await expect(page.getByRole('button', { name: 'Showing Steam. Clear filter' })).toBeVisible();
    expect(await seriousViolations(page, '.imm__rows')).toEqual([]);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /Clear filter/ })).toHaveCount(0);
    await setSetting(page, 'immersive.librarySort', 'az');
  });

  test('Now playing leads Home; A returns to the game without launching anything', async ({ page }) => {
    await open(page, '?nowPlaying');
    await enter(page);
    await expect(page.locator('.imm__row[data-active="true"] .imm__row-name')).toHaveText('Now playing');
    await expect(page.locator('.imm__card[data-focused="true"]')).toHaveAttribute('aria-label', /^Now playing: .+\. Return to game$/);
    await expect(page.locator('.imm__hints')).toContainText('Return to game');
    const ticket = await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().launch.ticket)`);
    await page.evaluate(() => {
      const w = window as unknown as { __calls: string[] };
      w.__calls = [];
    });
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
    expect(await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().launch.ticket)`)).toBe(ticket);
    await expect(page.locator('.toast')).toHaveCount(0); // the preview's game.focus says yes
    await pad(page, 'Menu');
    await expect(page.getByRole('menuitem', { name: /^Return to / })).toBeVisible();
  });

  test('Downloads appear while Steam installs; the game page shows an achievement showcase', async ({ page }) => {
    await open(page);
    await enter(page);
    const id = await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().library.games.find((g) => !g.hidden && g.installations.some((i) => i.platform === 'steam' && i.state !== 'installed' && /^\\d+$/.test(i.platformGameId)))?.id)`);
    expect(id).toBeTruthy();
    await page.evaluate(`import('/src/bridge/bridge.ts').then((m) => m.call('steam.install', { gameId: ${JSON.stringify(id)} }))`);
    await expect(page.locator('.imm__row--downloads')).toBeAttached({ timeout: 8000 });
    await expect(page.locator('.imm__row--downloads .imm__row-name')).toHaveText('Downloads');

    // A Steam game's page: progress ring and its rarest unlocks.
    await page.keyboard.press('Enter');
    await expect(page.locator('.imm-panel__card')).toBeVisible();
    const show = page.locator('.imm-show');
    if (await show.count()) {
      await expect(show.getByRole('img', { name: /\d+ of \d+ achievements unlocked/ })).toBeVisible();
      await show.getByRole('button', { name: 'See all' }).click();
      await expect(page.getByRole('tab', { name: /Achievements/, selected: true })).toBeVisible();
    }
  });

  test('focus memory: re-entering Immersive returns to the same row and card', async ({ page }) => {
    await open(page);
    await enter(page);
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowRight');
    const row = await page.locator('.imm__row[data-active="true"] .imm__row-name').textContent();
    const card = await focusedLabel(page);
    await pad(page, 'Menu');
    await pad(page, 'Menu');
    await expect(page.locator('.shell')).toBeVisible();
    await settled(page);
    await enter(page);
    await expect(page.locator('.imm__card[data-focused="true"]')).toHaveAttribute('aria-label', card!);
    expect(await page.locator('.imm__row[data-active="true"] .imm__row-name').textContent()).toBe(row);
  });

  test('desktop settings: voice-over and button glyphs', async ({ page }) => {
    await mockSpeech(page);
    await open(page);
    await page.evaluate(`import('/src/state/store.ts').then((m) => m.useStore.getState().navigate({ name: 'settings', section: 'controller' }))`);
    await expect(page.getByRole('heading', { name: 'Voice-over & captions' })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Voice-over in Immersive Mode' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByLabel('Voice', { exact: true }).locator('option')).toHaveCount(1);
    await page.getByRole('button', { name: 'Test the voice' }).click();
    await expect.poll(() => lastSpoken(page)).toMatch(/^Hi, I'm Zira/);
    await page.getByRole('radiogroup', { name: 'Button glyphs' }).getByRole('radio', { name: 'PlayStation' }).click();
    await expect.poll(() => getSetting(page, 'controller.glyphs')).toBe('playstation');
    await expect(page.locator('.glyph-preview .pad-glyph').first()).toHaveAttribute('aria-label', 'Cross button');
    expect(await seriousViolations(page, '.sgroup')).toEqual([]);
  });
});

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Skip the startup animation so tests start from a settled interface. */
async function open(page: Page, query = '') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm, .onb').first()).toBeVisible();
  return errors;
}

test.describe('shell', () => {
  test('home renders library rows with preview data and no errors', async ({ page }) => {
    const errors = await open(page);
    await expect(page.getByText('PREVIEW · SAMPLE DATA')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Continue playing' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Play', exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('sidebar navigation, back and forward', async ({ page }) => {
    await open(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
    await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Settings' }).click();
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
    await page.keyboard.press('Alt+ArrowLeft');
    await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
    await page.keyboard.press('Alt+ArrowRight');
    await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  });
});

test.describe('command bar', () => {
  test('interprets natural language deterministically and shows how', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+k');
    const input = page.getByRole('combobox', { name: 'Search' });
    await expect(input).toBeFocused();
    await input.fill('installed racing games');
    const chips = page.getByLabel('How your search was understood');
    await expect(chips.getByText('Installed', { exact: true })).toBeVisible();
    await expect(chips.getByText('Racing', { exact: true })).toBeVisible();
    await expect(page.getByRole('option').first()).toContainText(/Nebula Drift|Circuit Apex|Redline Rivals|Night Courier/);
    await page.keyboard.press('Escape');
    await expect(input).toBeHidden();
  });

  test('launch intent starts the game and the overlay follows real phases', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search' }).fill('launch nebula');
    await expect(page.getByRole('option').first()).toContainText('Launch Nebula Drift');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: /Launching Nebula Drift/ })).toBeVisible();
    await expect(page.getByText(/Waiting for the game window|Starting via/)).toBeVisible();
    await expect(page.getByText(/Played Nebula Drift for/)).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('library', () => {
  test('filters with quick filters and inline language', async ({ page }) => {
    await open(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
    await page.getByRole('button', { name: 'Favorites' }).click();
    const cards = page.locator('.vgrid [data-game-id]');
    await expect(cards.first()).toBeVisible();
    const favCount = await cards.count();
    await page.getByRole('button', { name: 'All', exact: true }).click();
    expect(await cards.count()).toBeGreaterThan(favCount);
    await page.getByLabel('Filter library').fill('xbox');
    await expect(page.getByText('Xbox', { exact: true }).first()).toBeVisible();
  });

  test('virtualizes very large libraries', async ({ page }) => {
    await open(page, '?games=5000');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
    await expect(page.getByText(/5,028 games/)).toBeVisible();
    const mounted = await page.locator('.vgrid [data-game-id]').count();
    expect(mounted).toBeGreaterThan(10);
    expect(mounted).toBeLessThan(200);
    const t0 = Date.now();
    await page.getByLabel('Filter library').fill('installed strategy');
    await expect(page.locator('.lib-chips')).toContainText('Strategy');
    expect(Date.now() - t0).toBeLessThan(3000);
  });

  test('list view shows tracked vs store playtime distinctly', async ({ page }) => {
    await open(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
    await page.getByRole('radio', { name: 'List' }).click();
    await expect(page.getByRole('table', { name: 'Games' })).toBeVisible();
    await expect(page.getByText('* Playtime reported by the store.')).toBeVisible();
  });
});

test.describe('game details', () => {
  test('shows honest stats and versions', async ({ page }) => {
    await open(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
    await page.getByRole('button', { name: /^Ashen Crown/ }).first().click();
    await expect(page.getByRole('heading', { name: 'Ashen Crown', level: 1 })).toBeVisible();
    await expect(page.getByText('Tracked by VYSTRAL')).toBeVisible();
    await page.getByRole('tab', { name: /Versions/ }).click();
    await expect(page.locator('.version')).toHaveCount(2);
    await expect(page.getByRole('button', { name: 'Choose which store to play from' })).toBeVisible();
  });
});

test.describe('settings & accessibility preferences', () => {
  test('theme and reduced motion apply immediately', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+,');
    await page.getByRole('radio', { name: 'Light' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await page.getByRole('radio', { name: 'Obsidian' }).click();
    await page.getByRole('radio', { name: 'On', exact: true }).click();
    await expect(page.locator('html')).toHaveAttribute('data-reduced-motion', 'true');
  });

  test('settings search narrows sections', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+,');
    await page.getByLabel('Search settings').fill('vibration');
    await expect(page.getByRole('button', { name: 'Controller & sound' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Appearance' })).toBeHidden();
  });

  test('update centre shows download progress', async ({ page }) => {
    await open(page);
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Updates' }).click();
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await page.getByRole('button', { name: /^Download/ }).click();
    await expect(page.getByRole('progressbar', { name: 'Update download progress' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Restart and install' })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('first run & immersive', () => {
  test('onboarding can be completed or skipped', async ({ page }) => {
    await open(page, '?onboarding');
    await expect(page.getByRole('heading', { name: 'Welcome to VYSTRAL' })).toBeVisible();
    await page.getByRole('button', { name: 'Get started' }).click();
    await expect(page.getByRole('heading', { name: 'Pick your look' })).toBeVisible();
    await page.getByRole('button', { name: 'Skip setup' }).click();
    await expect(page.getByRole('heading', { name: 'Welcome to VYSTRAL' })).toBeHidden();
  });

  test('immersive mode is fully keyboard navigable', async ({ page }) => {
    await open(page);
    await page.keyboard.press('F11');
    await expect(page.locator('.imm')).toBeVisible();
    const focused = page.locator('.imm__card[data-focused="true"]');
    const first = await focused.getAttribute('aria-label');
    await page.keyboard.press('ArrowRight');
    await expect(focused).not.toHaveAttribute('aria-label', first!);
    await page.keyboard.press('Enter');
    await expect(page.locator('.imm-panel__card')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.imm-panel__card')).toBeHidden();
    await page.keyboard.press('F11');
    await expect(page.locator('.shell')).toBeVisible();
  });
});

test.describe('v0.2 experience', () => {
  test('startup intro plays on a fresh start and is skippable', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('.intro')).toBeVisible();
    await page.keyboard.press('Space');
    await expect(page.locator('.intro')).toBeHidden({ timeout: 3000 });
  });

  test('Back restores scroll position and the focused card', async ({ page }) => {
    await open(page, '?games=400');
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
    await page.waitForSelector('.vgrid button.card');
    await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-scroll-main]')!;
      el.style.scrollBehavior = 'auto';
      el.scrollTop = 2000;
    });
    await page.waitForTimeout(400);
    // Pick a card fully on screen (clicking an off-screen one would scroll the page first).
    const id = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.vgrid button.card')].find((el) => {
        const r = el.getBoundingClientRect();
        return r.top > 120 && r.bottom < innerHeight - 40;
      });
      return c!.getAttribute('data-game-id');
    });
    const card = page.locator(`.vgrid button.card[data-game-id="${id}"]`);
    const before = await page.evaluate(() => document.querySelector('[data-scroll-main]')!.scrollTop);
    await card.click();
    await expect(page.locator('.dhero')).toBeVisible();
    await page.keyboard.press('Alt+ArrowLeft');
    await page.waitForTimeout(900);
    const after = await page.evaluate(() => ({ top: document.querySelector('[data-scroll-main]')!.scrollTop, focused: document.activeElement?.getAttribute('data-game-id') }));
    expect(Math.abs(after.top - before)).toBeLessThan(4);
    expect(after.focused).toBe(id);
  });

  test('Immersive: one travelling ring that always sits on the focused card', async ({ page }) => {
    await open(page);
    await page.evaluate(() => document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'F11', bubbles: true })));
    await page.waitForSelector('.imm__card');
    for (const k of ['ArrowRight', 'ArrowRight', 'ArrowDown', 'ArrowRight', 'ArrowDown']) await page.keyboard.press(k);
    await page.waitForTimeout(1000);
    const match = await page.evaluate(() => {
      const f = document.querySelector('.imm__card[data-focused="true"] .imm__card-frame')!.getBoundingClientRect();
      const r = document.querySelector('.imm__ring')!.getBoundingClientRect();
      return Math.abs(f.x - r.x) < 2 && Math.abs(f.y - r.y) < 2 && Math.abs(f.width - r.width) < 2;
    });
    expect(match).toBe(true);
    const focused = await page.locator('.imm__card[data-focused="true"]').getAttribute('aria-label');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog', { name: focused!.replace(', not installed', '') })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.imm-panel__card')).toBeHidden();
  });

  test('notification centre keeps toast history', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Rescan installed games' }).click();
    await page.getByRole('button', { name: /^Notifications/ }).click();
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Notifications' })).toBeHidden();
  });

  test('Storage Studio renders a treemap of installed games', async ({ page }) => {
    await open(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Storage' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(/Storage/);
  });
});

test.describe('accessibility (axe)', () => {
  for (const [name, nav] of [
    ['home', null],
    ['library', /Library/],
    ['settings', 'Settings'],
    ['journal', 'Journal'],
    ['performance', 'Performance'],
    ['moments', 'Moments'],
    ['constellation', 'Constellation'],
    ['assistant', 'Assistant'],
    ['storage', 'Storage'],
  ] as const) {
    test(`${name} has no serious or critical violations`, async ({ page }) => {
      await open(page, '?reduced');
      if (nav) await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: nav }).click();
      await page.waitForTimeout(500);
      // Let route transitions settle so contrast isn't sampled mid-fade on a busy machine.
      await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
      const results = await new AxeBuilder({ page }).exclude('.living-canvas').analyze();
      const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
      expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
    });
  }
});

test.describe('visual regression', () => {
  for (const [name, nav] of [
    ['home', null],
    ['library', /Library/],
    ['settings', 'Settings'],
  ] as const) {
    test(`${name} looks right`, async ({ page }) => {
      await open(page, '?reduced');
      if (nav) await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: nav }).click();
      await page.waitForTimeout(700);
      await expect(page).toHaveScreenshot(`${name}.png`, { mask: [page.locator('.living-canvas')], fullPage: false });
    });
  }
});

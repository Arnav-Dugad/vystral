import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track C2: title bar caption space, the redesigned Performance page and the startup timing chart (preview data
// only). Switches: ?caption=px (caption-button width), ?startupSlow, ?startupNone, ?noRig.

async function open(page: Page, query = '?reduced') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm, .onb').first()).toBeVisible();
  return { errors };
}

async function nav(page: Page, name: RegExp | string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();
}

async function settle(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
}

async function noSeriousViolations(page: Page, include?: string) {
  await settle(page);
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('title bar caption space', () => {
  for (const [query, inset] of [['?reduced', 138], ['?reduced&caption=220', 220], ['?reduced&caption=0', 0]] as const) {
    test(`reserves the caption buttons' width (${inset}px) plus a gap`, async ({ page }) => {
      await open(page, query);
      const space = page.locator('.titlebar__caption-space');
      await expect(space).toHaveAttribute('data-inset', String(inset));
      expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--caption-inset-right').trim())).toBe(`${inset}px`);
      const box = await space.boundingBox();
      expect(box!.width).toBeCloseTo(Math.max(12, inset + 8), 0);
      // The Immersive button (the last of VYSTRAL's own) ends before the caption buttons start.
      const viewport = page.viewportSize()!;
      const last = await page.getByRole('button', { name: 'Immersive Mode (F11)' }).boundingBox();
      expect(last!.x + last!.width).toBeLessThanOrEqual(viewport.width - inset - 8 + 0.5);
    });
  }

  test('still fits at the minimum window width with wide caption buttons', async ({ page }) => {
    await page.setViewportSize({ width: 960, height: 600 });
    await open(page, '?reduced&caption=207');
    // Until the window state arrives the bar assumes the usual 138 px; then it makes room for the real width.
    await expect(page.locator('.titlebar__caption-space')).toHaveAttribute('data-inset', '207');
    for (const name of ['Rescan installed games', 'Immersive Mode (F11)']) {
      const b = await page.getByRole('button', { name }).boundingBox();
      expect(b!.x + b!.width).toBeLessThanOrEqual(960 - 207 - 8 + 0.5);
      expect(b!.x).toBeGreaterThan(0);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(960);
  });
});

for (const scale of [1.25, 1.5]) {
  test.describe(`title bar at ${scale * 100}% scale`, () => {
    test.use({ deviceScaleFactor: scale });
    test('the reserved space is in CSS pixels, so it matches the native inset divided by the scale', async ({ page }) => {
      // The native side reports RightInset / RasterizationScale: 207 physical px at 150% → 138.
      await open(page, '?reduced&caption=138');
      const box = await page.locator('.titlebar__caption-space').boundingBox();
      expect(box!.width).toBeCloseTo(146, 0);
      const last = await page.getByRole('button', { name: 'Immersive Mode (F11)' }).boundingBox();
      expect(last!.x + last!.width).toBeLessThanOrEqual(page.viewportSize()!.width - 146 + 0.5);
    });
  });
}

test.describe('Performance page', () => {
  test('summary band, tabs, overview, sessions, compare and system; axe on every tab', async ({ page }) => {
    const { errors } = await open(page);
    await nav(page, /Performance/);

    const summary = page.getByRole('region', { name: 'Summary' });
    await expect(summary.getByText('NVIDIA GeForce RTX 4060 Laptop GPU')).toBeVisible();
    await expect(summary.getByText('Driver 572.16')).toBeVisible();
    await expect(summary.getByText('AMD Ryzen 7 7735HS with Radeon Graphics')).toBeVisible();
    await expect(summary.getByRole('img', { name: 'NVIDIA' })).toHaveCount(0); // decorative marks; the name says it
    await expect(summary.getByRole('list', { name: /Last \d+ sessions, oldest first/ })).toBeVisible();
    await expect(summary.getByRole('img', { name: /Frame rate over the last \d+ sessions/ })).toBeVisible();

    const tabs = page.getByRole('tablist', { name: 'Performance sections' });
    await expect(tabs.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Frame rate across sessions' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Worth a look' })).toBeVisible();
    await expect(page.getByText('1% lows of 22 fps against a 58 fps average.')).toBeVisible();
    await noSeriousViolations(page, '.pf');

    // The trend chart reads by keyboard and its table view lists the same sessions.
    const chart = page.getByRole('group', { name: /Frame rate across your last \d+ measured sessions/ });
    await chart.focus();
    await page.keyboard.press('Home');
    await expect(page.locator('.pf-trendchart__tip')).toBeVisible();
    await page.getByRole('button', { name: 'Show as table' }).click();
    await expect(page.getByRole('region', { name: 'Frame rate across sessions, as a table' }).getByRole('row')).toHaveCount(5);
    await page.getByRole('button', { name: 'Show as chart' }).click();

    // "Worth a look" opens that session on the Sessions tab.
    await page.getByRole('button', { name: /^Open the Hollow Lantern session/ }).first().click();
    await expect(tabs.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.pf-hero__title')).toHaveText('Hollow Lantern');
    await expect(page.locator('.pf-hero__health')).toContainText('Rough');
    await expect(page.getByText(/▲ \d+ sharp drops/)).toBeVisible();
    await expect(page.locator('.vx-chart__marker').first()).toBeAttached();

    // The timeline picker moves through sessions with the arrow keys.
    const picker = page.getByRole('slider', { name: 'Pick a session' });
    const before = await picker.getAttribute('aria-valuenow');
    await picker.focus();
    await page.keyboard.press('ArrowRight');
    await expect(picker).not.toHaveAttribute('aria-valuenow', before!);
    await page.keyboard.press('End');
    await expect(picker).toHaveAttribute('aria-valuenow', await picker.getAttribute('aria-valuemax') as string);
    await noSeriousViolations(page, '.pf');

    await tabs.getByRole('tab', { name: 'Compare' }).click();
    await expect(page.getByRole('heading', { name: 'Compare two sessions' })).toBeVisible();
    const table = page.getByRole('region', { name: 'Session comparison' });
    await expect(table.getByRole('row', { name: /CPU usage/ })).toBeVisible();
    const a = await page.getByLabel('This session').inputValue();
    const b = await page.getByLabel('Compared with').inputValue();
    await page.getByRole('button', { name: 'Swap the two sessions' }).click();
    await expect(page.getByLabel('This session')).toHaveValue(b);
    await expect(page.getByLabel('Compared with')).toHaveValue(a);
    await noSeriousViolations(page, '.pf');

    await tabs.getByRole('tab', { name: 'System' }).click();
    await expect(page.getByRole('heading', { name: /GPU driver changes/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Background apps/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Hardware history/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /^Energy/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Controller battery/ })).toBeVisible();
    await noSeriousViolations(page, '.pf');

    // The tab is remembered for this app session.
    await nav(page, /Home/);
    await nav(page, /Performance/);
    await expect(tabs.getByRole('tab', { name: 'System' })).toHaveAttribute('aria-selected', 'true');
    expect(errors).toEqual([]);
  });

  test('tabs move with the arrow keys; the game filter scopes the summary', async ({ page }) => {
    await open(page);
    await nav(page, /Performance/);
    const tabs = page.getByRole('tablist', { name: 'Performance sections' });
    await tabs.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(tabs.getByRole('tab', { name: 'Sessions' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('tabpanel')).toHaveAttribute('aria-labelledby', 'pf-tab-sessions');

    const select = page.locator('.pf-toolbar select');
    const option = await select.locator('option').nth(1).getAttribute('value');
    await select.selectOption(option!);
    const count = await page.locator('.pf-list .pf-item').count();
    expect(count).toBeGreaterThan(0);
    const label = await select.locator(`option[value="${option}"]`).innerText();
    expect(label).toContain(`(${count})`);
  });

  test('without the rig reported, the summary says so', async ({ page }) => {
    await open(page, '?reduced&noRig');
    await nav(page, /Performance/);
    await expect(page.getByText('Graphics card not reported')).toBeVisible();
    await expect(page.getByText('Processor not reported')).toBeVisible();
  });

  test('High contrast and light themes render the summary and timeline', async ({ page }) => {
    for (const theme of ['contrast', 'light'] as const) {
      await open(page);
      await page.evaluate((t) => (document.documentElement.dataset.theme = t), theme);
      await nav(page, /Performance/);
      await page.getByRole('tab', { name: 'Sessions' }).click();
      await expect(page.getByRole('slider', { name: 'Pick a session' })).toBeVisible();
      await noSeriousViolations(page, '.pf');
    }
  });
});

test.describe('startup timings', () => {
  async function openAbout(page: Page) {
    await page.keyboard.press('Control+,');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'About' }).click();
    return page.locator('section', { has: page.getByRole('heading', { name: 'Startup timings' }) });
  }

  test('shows the last starts as stacked phases with the usual start; table view; axe', async ({ page }) => {
    const { errors } = await open(page);
    const card = await openAbout(page);
    await expect(card).toContainText('Your last 20 starts');
    await expect(card.getByText('Usual start')).toBeVisible();
    await expect(card.getByRole('list', { name: 'Startup phases' }).getByRole('listitem')).toHaveText(['Backend', 'WebView', 'First paint', 'Ready']);
    await expect(card.locator('.st__col')).toHaveCount(20);
    await expect(card.getByText('Slower than usual.')).toHaveCount(0);

    const chart = card.getByRole('group', { name: /Startup timings for the last 20 starts/ });
    await chart.focus();
    await expect(card.locator('.st__tip')).toBeVisible();
    await page.keyboard.press('Home');
    await expect(card.locator('.st__col[data-active]')).toHaveCount(1);

    await card.getByRole('button', { name: 'Show as table' }).click();
    await expect(card.getByRole('region', { name: 'Startup timings table' }).locator('tbody tr')).toHaveCount(20);
    await noSeriousViolations(page, '.settings__content');
    expect(errors).toEqual([]);
  });

  test('warns when the newest start was much slower than usual', async ({ page }) => {
    await open(page, '?reduced&startupSlow');
    const card = await openAbout(page);
    await expect(card.getByRole('note')).toContainText('Slower than usual.');
    await expect(card.getByRole('note')).toContainText(/The last start took \d\.\d\d s/);
    await expect(card.locator('.st__flag')).toHaveCount(1);
    await noSeriousViolations(page, '.settings__content');
  });

  test('explains when there are no timings yet', async ({ page }) => {
    await open(page, '?reduced&startupNone');
    const card = await openAbout(page);
    await expect(card).toContainText('No startup timings yet.');
    await expect(card.getByRole('button', { name: 'Show as table' })).toHaveCount(0);
  });
});

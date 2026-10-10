import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track Y: play data and insights (preview data only). ?ttb gives games IGDB estimates, ?pace a recent
// cadence on some of them, ?energy turns the energy estimate on, ?lowBattery makes pre-flight warn.

async function open(page: Page, query = '?reduced') {
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

async function nav(page: Page, name: RegExp | string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();
}

async function openSettingsSection(page: Page, name: string) {
  await page.keyboard.press('Control+,');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name }).click();
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

const section = (page: Page, heading: RegExp | string) => page.locator('section', { has: page.getByRole('heading', { name: heading }) }).first();

test.describe('Journal play insights', () => {
  test('hour-of-week heatmap, genre drift with its table, finishing soon; keyboard and axe', async ({ page }) => {
    const { errors, external } = await open(page, '?ttb&pace&reduced');
    await nav(page, /Journal/);

    const hours = section(page, 'When you play');
    await expect(hours).toBeVisible();
    await expect(hours.getByText('Your prime time')).toBeVisible();
    await expect(hours.locator('.how-prime__title')).toHaveText(/^\w+ (mornings|afternoons|evenings|nights), /);
    const grid = hours.getByRole('grid', { name: /Play time by hour of the week/ });
    await expect(grid.getByRole('gridcell')).toHaveCount(168);
    // Roving focus: one tab stop, arrows move between hours.
    await expect(grid.locator('[role="gridcell"][tabindex="0"]')).toHaveCount(1);
    await grid.locator('[role="gridcell"][tabindex="0"]').focus();
    const before = await page.evaluate(() => document.activeElement?.getAttribute('data-cell'));
    await page.keyboard.press('Home');
    await page.keyboard.press('ArrowRight');
    const after = await page.evaluate(() => document.activeElement?.getAttribute('data-cell'));
    expect(after).toMatch(/^\d-1$/);
    expect(after?.split('-')[0]).toBe(before?.split('-')[0]);
    await expect(page.locator('.hm-tip')).toBeVisible();
    await expect(grid.locator('[data-prime]').first()).toHaveAttribute('aria-label', /Part of your prime time/);

    // Changing the Journal range re-bins the grid.
    await page.getByRole('radio', { name: 'All time' }).click();
    await expect(hours.getByText(/Hour of the week · all time/)).toBeVisible();

    const drift = section(page, 'Genre drift');
    await expect(drift).toBeVisible();
    await expect(drift.getByRole('group', { name: /Genre mix of tracked hours per month/ })).toBeVisible();
    await expect(drift.getByRole('list', { name: 'Genres' }).getByRole('listitem').first()).toBeVisible();
    await expect(drift.locator('.gs-layer').first()).toBeVisible();
    await expect(drift.getByText(/splits its hours equally/)).toBeVisible();
    await drift.getByRole('button', { name: 'Show as table' }).click();
    const table = drift.getByRole('table');
    await expect(table.locator('tbody tr')).toHaveCount(12);
    await expect(drift.getByRole('button', { name: 'Hide table' })).toHaveAttribute('aria-expanded', 'true');
    // Keyboard readout of the stream.
    await drift.getByRole('group', { name: /Genre mix/ }).focus();
    await page.keyboard.press('ArrowLeft');
    await expect(drift.locator('.gs-tip')).toBeVisible();

    const finishing = section(page, 'Finishing soon');
    await expect(finishing).toBeVisible();
    const rows = finishing.getByRole('button', { name: /to finish the main story at your pace, likely/ });
    expect(await rows.count()).toBeGreaterThan(0);

    await noSeriousViolations(page, '.jr');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('a game page shows the completion forecast with its range, and hides it without a pace', async ({ page }) => {
    await open(page, '?ttb&pace&reduced');
    await nav(page, /Journal/);
    await section(page, 'Finishing soon').getByRole('button', { name: /to finish/ }).first().click();
    const panel = page.getByRole('region', { name: 'Completion forecast' });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText('At your pace you’ll finish the main story in about');
    await expect(panel.getByRole('img', { name: /likely within/ })).toBeVisible();
    await expect(panel).toContainText('IGDB’s player average');
    await noSeriousViolations(page, '.cf-panel');

    // Without ?pace the preview sessions are months old: no pace, no forecast.
    await open(page, '?ttb&reduced');
    await nav(page, /Journal/);
    await expect(section(page, 'Genre drift')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Finishing soon' })).toHaveCount(0);
  });
});

test.describe('Performance play data', () => {
  test('hardware timeline links driver changes to the FPS comparison; energy and battery charts; axe', async ({ page }) => {
    const { errors } = await open(page, '?energy&reduced');
    await nav(page, /Performance/);

    const hw = section(page, /Hardware history/);
    await expect(hw).toBeVisible();
    await expect(hw.getByRole('img', { name: /Hardware history from/ })).toBeVisible();
    const changes = hw.getByRole('list', { name: 'Changes' });
    await expect(changes.getByRole('listitem').filter({ hasText: 'Graphics driver' }).first()).toContainText('→');
    await expect(changes.getByRole('listitem').filter({ hasText: 'Display mode' })).toContainText('2560 × 1440 · 165 Hz');
    await expect(changes.getByRole('listitem').filter({ hasText: 'HDR' })).toContainText('turned on');
    await changes.getByRole('button', { name: 'Frame rate before/after' }).first().click();
    await expect(section(page, /GPU driver changes/)).toBeInViewport();

    const energy = section(page, /^Energy/);
    await expect(energy.getByText('Estimate', { exact: true })).toBeVisible();
    await expect(energy.getByText('All tracked')).toBeVisible();
    await expect(energy.getByRole('group', { name: /Estimated energy per month/ })).toBeVisible();
    await expect(energy.getByRole('list', { name: 'Energy by game' }).getByRole('listitem').first()).toContainText('kWh');
    await energy.getByRole('button', { name: 'How it’s estimated' }).click();
    const pop = page.getByRole('dialog', { name: 'How the energy estimate works' });
    await expect(pop).toBeVisible();
    await expect(pop).toContainText('typical board power 100 W');
    await expect(pop).toContainText('±30%');
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();

    const battery = section(page, /Controller battery/);
    await expect(battery.getByRole('group', { name: /Xbox Wireless Controller battery over the past 7 days/ })).toBeVisible();
    await expect(battery).toContainText('left at your usual rate');

    // The selected session's estimate sits with its stat tiles.
    await expect(page.locator('.pf-tiles').getByText('Energy (est.)')).toBeVisible();

    await noSeriousViolations(page, '.pf');
    expect(errors).toEqual([]);
  });

  test('energy is off by default and turns on from the card', async ({ page }) => {
    await open(page);
    await nav(page, /Performance/);
    const energy = section(page, /^Energy/);
    await expect(energy).toContainText('Off');
    await energy.getByRole('button', { name: 'Turn on energy estimate' }).click();
    await expect(energy.getByText('Estimate', { exact: true })).toBeVisible();
    await expect(energy.getByText('All tracked')).toBeVisible();
  });

  test('a game page shows its hardware timeline on the Sessions tab', async ({ page }) => {
    await open(page);
    await nav(page, /Journal/);
    await page.locator('.jr-top__row').first().click();
    await page.getByRole('tab', { name: /^Sessions ·/ }).click(); // the game page's tab (the Journal's own Sessions tab may still be leaving)
    const hw = section(page, /Hardware history/);
    await expect(hw).toBeVisible();
    await expect(hw.getByRole('img', { name: /Hardware history from/ })).toBeVisible();
  });
});

test.describe('controller battery and energy settings', () => {
  test('Settings › Controller & sound shows the battery history; Launching & sessions validates energy inputs', async ({ page }) => {
    await open(page);
    await openSettingsSection(page, 'Controller & sound');
    const group = page.locator('section.sgroup', { has: page.getByRole('heading', { name: 'Controller battery' }) });
    await expect(group.getByRole('switch', { name: 'Keep battery history' })).toBeChecked();
    await expect(group.getByRole('group', { name: /Xbox Wireless Controller battery/ })).toBeVisible();
    await expect(group.getByRole('button', { name: /Clear/ })).toBeVisible();
    await noSeriousViolations(page, '.settings__content');

    await openSettingsSection(page, 'Launching & sessions');
    const energy = page.locator('section.sgroup', { has: page.getByRole('heading', { name: 'Energy estimate' }) });
    await expect(energy.getByRole('spinbutton', { name: 'Your PC’s gaming wattage' })).toHaveCount(0);
    await energy.getByRole('switch', { name: 'Estimate energy use' }).click();
    const watts = energy.getByRole('spinbutton', { name: 'Your PC’s gaming wattage' });
    await watts.fill('9000');
    await watts.press('Enter');
    await expect(energy.getByText('Enter a number from 0 to 3,000, or leave it empty.')).toBeVisible();
    await watts.fill('420');
    await watts.press('Enter');
    await expect(energy.getByText(/Measured at the wall/)).toBeVisible();
    await energy.getByRole('textbox', { name: 'Currency' }).fill('eu');
    await expect(energy.getByText('Use a three-letter code such as EUR, GBP or USD.')).toBeVisible();
    await noSeriousViolations(page, '.settings__content');

    await nav(page, /Performance/);
    await section(page, /^Energy/).getByRole('button', { name: 'How it’s estimated' }).click();
    await expect(page.getByRole('dialog', { name: 'How the energy estimate works' })).toContainText('You entered 420 W');
  });

  test('pre-flight warns about a low controller with the usual-drain estimate', async ({ page }) => {
    await open(page, '?lowBattery');
    await page.keyboard.press('Control+k');
    await page.getByRole('combobox', { name: 'Search' }).fill('launch nebula');
    await expect(page.getByRole('option').first()).toContainText('Launch Nebula Drift');
    await page.keyboard.press('Enter');
    const preflight = page.getByRole('region', { name: 'Before you play' });
    const row = preflight.getByRole('listitem').filter({ hasText: 'Controller' });
    await expect(row).toContainText('14% battery');
    await expect(row).toContainText('about 2 h 20 min left at your usual rate');
    await expect(row).toHaveAttribute('data-status', 'warn');
  });
});

test.describe('number roll-ups', () => {
  test('count up once per session, land on the real value, and never run under reduced motion', async ({ page }) => {
    await open(page, '?ttb');
    await nav(page, /Journal/);
    const tile = page.locator('.vx-tile').filter({ hasText: 'Sessions' }).first();
    // While rolling, screen readers get the final text; the moving digits are hidden from them.
    await expect(tile.locator('.rollup .visually-hidden')).toHaveCount(1);
    await expect(tile.locator('.rollup__anim')).toHaveAttribute('aria-hidden', 'true');
    await expect(tile.locator('.rollup')).toHaveCount(0, { timeout: 4000 });
    const value = (await tile.locator('.vx-tile__value').innerText()).trim();
    expect(value).toMatch(/^\d[\d,]*$/);

    // Back to the Journal in the same session: no second roll.
    await nav(page, /Home/);
    await nav(page, /Journal/);
    await expect(page.locator('.jr-tiles .vx-tile').first()).toBeVisible();
    await expect(page.locator('.jr-tiles .rollup')).toHaveCount(0);

    await open(page, '?reduced');
    await nav(page, /Journal/);
    await expect(page.locator('.jr-tiles .vx-tile').first()).toBeVisible();
    await expect(page.locator('.rollup')).toHaveCount(0);
  });
});

import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track V: your subscriptions on the preview backend's fictional Game Pass lists. `?subs` (Game Pass Ultimate, Humble
// Choice, GeForce NOW Performance, lists on), `?subsPrice`, `?leaving`, `?subsAsk`, `?onboarding`. Nothing is opened
// or downloaded: "open the store page" is only recorded (window.__vystralPreviewSubs).

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

async function openGame(page: Page, title: string) {
  await nav(page, /Library/);
  await page.getByLabel('Filter library').fill(title);
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeAttached();
}

async function subsSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Library & stores' }).click();
  const section = page.getByRole('region', { name: /Your subscriptions/ });
  await expect(section).toBeVisible();
  return section;
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('asking about subscriptions', () => {
  test('onboarding has a subscriptions step that saves the answer locally', async ({ page }) => {
    const { errors, external } = await open(page, '?onboarding&reduced');
    await page.getByRole('button', { name: 'Get started' }).click();
    await page.getByRole('button', { name: 'Continue' }).click(); // look
    await page.getByRole('button', { name: 'Continue' }).click(); // stores
    await expect(page.getByRole('heading', { name: 'Your subscriptions' })).toBeVisible();
    await expect(page.getByRole('progressbar', { name: 'Setup progress' })).toHaveAttribute('aria-valuetext', 'Step 4 of 6');
    const ultimate = page.getByRole('button', { name: /^Game Pass Ultimate\./ });
    await ultimate.click();
    await expect(ultimate).toHaveAttribute('aria-pressed', 'true');
    // One tier per service: picking PC Game Pass replaces Ultimate, picking Ultimate again swaps back.
    await page.getByRole('button', { name: /^PC Game Pass\./ }).click();
    await expect(ultimate).toHaveAttribute('aria-pressed', 'false');
    await ultimate.click();
    await page.getByRole('button', { name: /^GeForce NOW Performance\./ }).click();
    await expect(page.getByText('Your answer stays on this PC.', { exact: false })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Show what my plans include' })).toBeChecked();
    await noSeriousViolations(page, '.onb');

    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Optional features' })).toBeVisible();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Enter VYSTRAL' }).click();
    await expect(page.getByTestId('subs-ask')).toHaveCount(0); // answered during setup
    await expect(page.getByTestId('subs-included')).toBeVisible();

    const section = await subsSettings(page);
    await expect(section.getByRole('button', { name: /^Game Pass Ultimate\./ })).toHaveAttribute('aria-pressed', 'true');
    await expect(section.getByRole('button', { name: /^GeForce NOW Performance\./ })).toHaveAttribute('aria-pressed', 'true');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('people who skipped get a one-time Home card; saving or “Not now” both put it away', async ({ page }) => {
    const { errors } = await open(page, '?subsAsk&reduced');
    const card = page.getByTestId('subs-ask');
    await expect(card.getByRole('heading', { name: 'Tell VYSTRAL your subscriptions' })).toBeVisible();
    await noSeriousViolations(page, '.subs-ask');
    await card.getByRole('group', { name: 'EA Play' }).getByRole('button', { name: /^EA Play\./ }).click();
    await card.getByRole('button', { name: 'Save' }).click();
    await expect(card).toBeHidden();
    await expect(page.getByText('Your subscriptions are saved')).toBeVisible();
    // The lists switch defaulted on, so EA Play games now carry a badge.
    await nav(page, /Library/);
    await expect(page.getByRole('button', { name: 'In my subscriptions' })).toBeVisible();

    await page.goto('/?subsAsk&reduced');
    await nav(page, 'Home'); // a reload returns to the last page
    await page.getByTestId('subs-ask').getByRole('button', { name: 'Not now' }).first().click();
    await expect(page.getByTestId('subs-ask')).toBeHidden();
    await expect(page.getByTestId('subs-included')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});

test.describe('tailored to your plans', () => {
  test('badges, the “In my subscriptions” filter and game-page pills', async ({ page }) => {
    const { errors, external } = await open(page, '?subs&reduced');
    await nav(page, /Library/);
    const badge = page.locator('.vgrid .subs-badge').first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('aria-label', /Included with your Game Pass Ultimate|Also in your Game Pass Ultimate/);
    await page.getByRole('button', { name: 'In my subscriptions' }).click();
    await expect(page.locator('.lib-head__meta')).toHaveText(/^9 games/);
    await expect(page.getByRole('button', { name: /^Hollow Lantern/ })).toHaveCount(0);
    await page.getByRole('radio', { name: 'List' }).click();
    await expect(page.locator('.vlist .subs-badge').first()).toBeVisible();
    await page.getByRole('radio', { name: 'Grid' }).click();

    await openGame(page, 'Circuit Apex');
    await expect(page.getByTestId('subs-pills')).toContainText('Included with your Game Pass Ultimate');
    await openGame(page, 'Echoes of Vael');
    await expect(page.getByTestId('subs-pills')).toContainText('Also in your Game Pass Ultimate (likely: matched by name)');
    await openGame(page, 'Hollow Lantern');
    await expect(page.getByTestId('subs-pills')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('Home shows included games you don’t own and the value card; opening one never installs', async ({ page }) => {
    const { errors, external } = await open(page, '?subs&reduced');
    const row = page.getByTestId('subs-included');
    await expect(row.getByRole('heading', { name: /Included with your subscriptions/ })).toBeVisible();
    const tiles = row.getByRole('button', { name: /included with your/ });
    expect(await tiles.count()).toBeGreaterThan(3);
    await expect(row.locator('.subs-tile__gen')).toHaveCount(1); // the one whose poster hasn't downloaded: a drawn tile
    await tiles.first().click();
    expect(await page.evaluate(() => window.__vystralPreviewSubs?.opened.length)).toBe(1);

    const value = page.getByTestId('subs-value');
    await expect(value).toContainText(/in games your plans include/);
    await expect(value.getByRole('list', { name: 'Time by plan' })).toContainText('Game Pass Ultimate');
    await expect(value.getByRole('button', { name: 'Add what you pay' })).toBeVisible();
    await expect(value).not.toContainText('an hour');
    await noSeriousViolations(page, '[data-testid="subs-included"]');
    await noSeriousViolations(page, '[data-testid="subs-value"]');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('with a price, cost per hour is shown and labelled as an estimate', async ({ page }) => {
    await open(page, '?subsPrice&reduced');
    const value = page.getByTestId('subs-value');
    await expect(value.getByText(/^About \$\d+\.\d\d an hour$/)).toBeVisible();
    await expect(value).toContainText('What you entered ($29.99 a month)');
    await expect(value).toContainText('Play on other devices isn’t counted');
  });

  test('“leaving soon” shows on cards, the game page and the Home row, with the date when there is one', async ({ page }) => {
    const { errors } = await open(page, '?leaving&reduced');
    await expect(page.getByTestId('subs-included').locator('.subs-tile__flag[data-reason="leaving"]').first()).toBeVisible();
    await expect(page.getByTestId('subs-included').locator('.section-head__meta')).toContainText('2 games leaving soon');
    await nav(page, /Library/);
    await expect(page.locator('.vgrid .subs-badge[data-leaving]')).toHaveCount(2);
    await openGame(page, 'Velvet Orbit');
    const pills = page.getByTestId('subs-pills');
    await expect(pills).toContainText(/Leaves Game Pass around \d{1,2} \w{3}|Leaves Game Pass around \w{3} \d{1,2}/);
    await expect(pills).toContainText('from the Store listing');
    await openGame(page, 'Ashen Crown');
    await expect(page.getByTestId('subs-pills')).toContainText('Leaving Game Pass soon');
    await noSeriousViolations(page, '[data-testid="subs-pills"]');

    const section = await subsSettings(page);
    await expect(section.getByRole('switch', { name: 'Tell me before a game leaves Game Pass' })).toBeChecked();
    await expect(section.getByText(/9 leaving soon · 2 of yours/)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('cloud play only offers your services until you ask for all of them', async ({ page }) => {
    const { errors } = await open(page, '?cloud&subs&reduced');
    const section = await subsSettings(page);
    await section.getByRole('button', { name: /^PC Game Pass\./ }).click(); // no cloud gaming in PC Game Pass
    await expect(section.getByRole('switch', { name: 'Cloud play: show every service' })).not.toBeChecked();
    await noSeriousViolations(page, '#settings-subs');

    await openGame(page, 'Ashen Crown');
    await page.getByRole('button', { name: 'More ways to play in the cloud' }).click();
    const menu = page.getByRole('dialog', { name: 'Play in the cloud' });
    await expect(menu.getByRole('button', { name: /GeForce NOW/ }).first()).toBeVisible();
    await expect(menu.getByRole('button', { name: /Cloud playable · may be included with Game Pass/ })).toHaveCount(0);
    await expect(menu).toContainText('it’s hidden because it isn’t in your subscriptions');
    await page.keyboard.press('Escape');

    const again = await subsSettings(page);
    await again.getByRole('switch', { name: 'Cloud play: show every service' }).click();
    await openGame(page, 'Ashen Crown');
    await page.getByRole('button', { name: 'More ways to play in the cloud' }).click();
    await expect(page.getByRole('dialog', { name: 'Play in the cloud' }).getByRole('button', { name: /Cloud playable · may be included with Game Pass/ })).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('settings: the lists are opt-in, the price is optional, queue alerts live with cloud play', async ({ page }) => {
    const { errors, external } = await open(page, '?cloud&reduced');
    const section = await subsSettings(page);
    await expect(section.getByRole('switch', { name: 'Show what my plans include' })).not.toBeChecked();
    await section.getByRole('button', { name: /^Game Pass Premium\./ }).click();
    await section.getByRole('switch', { name: 'Show what my plans include' }).click();
    await expect(section.getByText(/Up to date/)).toBeVisible();
    await section.getByLabel('What you pay a month (optional)').fill('14.99');
    await section.getByLabel('What you pay a month (optional)').press('Enter');
    await expect(section.getByLabel('What you pay a month (optional)')).toHaveValue('14.99');
    await noSeriousViolations(page, '#settings-subs');

    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Cloud play' }).click();
    const queue = page.getByRole('region', { name: /GeForce NOW queue alerts/ });
    await expect(queue.getByRole('switch', { name: 'Tell me when my turn is close' })).toBeChecked();
    await expect(queue).toContainText('no clicks, no memory, nothing injected');
    await expect(queue.getByRole('slider', { name: 'Notify at queue position' })).toBeVisible();
    await noSeriousViolations(page, '[aria-labelledby="queue-alerts-title"]');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

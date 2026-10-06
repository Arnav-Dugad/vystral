import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track O: cloud play (Xbox Cloud Gaming, GeForce NOW) on the preview backend's fictional catalogue. Off by default;
// `?cloud` turns it on, `?cloudMeter=near|reached|free|none` picks a meter state. Nothing is ever launched.

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

async function cloudSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Cloud play' }).click();
  const section = page.getByRole('region', { name: /Cloud play/ });
  await expect(section).toBeVisible();
  return section;
}

async function openGame(page: Page, title: string) {
  await nav(page, /Library/);
  await page.getByLabel('Filter library').fill(title);
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeAttached();
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('cloud play is opt-in', () => {
  test('off by default: an empty state in Settings, no badges, no filter, no button', async ({ page }) => {
    const { errors, external } = await open(page);
    await nav(page, /Library/);
    await expect(page.locator('.cloud-badge')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Playable in the cloud' })).toHaveCount(0);
    await openGame(page, 'Ashen Crown');
    await expect(page.locator('.cloud-split')).toHaveCount(0);

    const section = await cloudSettings(page);
    const empty = section.getByTestId('cloud-empty');
    await expect(empty.getByRole('heading', { name: 'Play in the cloud is off' })).toBeVisible();
    await expect(empty).toContainText('at most once a day');
    await noSeriousViolations(page, '.cloudset');

    await empty.getByRole('button', { name: 'Turn on cloud play' }).click();
    await expect(section.getByRole('switch', { name: 'GeForce NOW' })).toBeChecked();
    await expect(section.getByRole('switch', { name: 'Xbox Cloud Gaming' })).toBeChecked();
    await expect(section.getByText(/In your library/).first()).toBeVisible();
    await noSeriousViolations(page, '.cloudset');

    await nav(page, /Library/);
    await expect(page.getByRole('button', { name: 'Playable in the cloud' })).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

test.describe('cloud play', () => {
  test('cards get a cloud badge and the library filters to cloud-playable games', async ({ page }) => {
    const { errors } = await open(page, '?cloud&reduced');
    await nav(page, /Library/);
    const badge = page.locator('.vgrid .cloud-badge').first();
    await expect(badge).toBeVisible();
    await expect(badge).toHaveAttribute('aria-label', /Playable in the cloud: /);
    await page.getByRole('button', { name: 'Playable in the cloud' }).click();
    await expect(page.locator('.lib-head__meta')).toHaveText(/^8 games/);
    await expect(page.getByRole('button', { name: /^Hollow Lantern/ })).toHaveCount(0);
    await page.getByRole('radio', { name: 'List' }).click();
    await expect(page.locator('.vlist .cloud-badge').first()).toBeVisible();
    await page.getByRole('radio', { name: 'Grid' }).click();
    expect(errors).toEqual([]);
  });

  test('the game page offers each service with honest hints, launches, tracks and saves the session', async ({ page }) => {
    const { errors, external } = await open(page, '?cloud&reduced');
    await openGame(page, 'Ashen Crown');
    const split = page.locator('.cloud-split');
    await expect(split.getByRole('button', { name: 'Play in the cloud with GeForce NOW' })).toBeVisible();
    await split.getByRole('button', { name: 'More ways to play in the cloud' }).click();
    const menu = page.getByRole('dialog', { name: 'Play in the cloud' });
    await expect(menu).toBeVisible();
    const gfn = menu.getByRole('button', { name: /GeForce NOW · Ready to play/ });
    const xbox = menu.getByRole('button', { name: /Cloud playable · may be included with Game Pass/ });
    await expect(gfn).toContainText('Works with a free or paid membership and your Steam copy.');
    await expect(gfn).toContainText('Opens in GeForce NOW app');
    await expect(xbox).toContainText('Likely match');
    await expect(xbox).toContainText('Opens in a separate Microsoft Edge window');
    await expect(menu.getByRole('meter', { name: /GeForce NOW hours used/ })).toBeVisible();
    await expect(menu.getByText('Estimated from sessions VYSTRAL saw', { exact: false })).toBeVisible();
    await expect(menu.getByText(/GeForce NOW: All systems operational/)).toBeVisible();
    await noSeriousViolations(page, '.cloud-menu');

    await gfn.click();
    await expect(menu).toBeHidden();
    expect(await page.evaluate(() => window.__vystralPreviewCloud?.launches)).toEqual([expect.objectContaining({ service: 'gfn', surface: 'gfnApp' })]);
    const pill = page.getByRole('status', { name: 'Cloud session' });
    await expect(pill).toContainText('waiting for the stream');
    await expect(split).toContainText('Waiting for GeForce NOW');
    await expect(pill).toContainText(/Ashen Crown · \d+:\d\d/);
    await expect(pill).toContainText('left in this session');
    await noSeriousViolations(page, '.cloud-pillbar');

    await pill.getByRole('button', { name: 'I’m done' }).click();
    await expect(pill).toBeHidden();
    await expect(page.getByText('Cloud session saved')).toBeVisible();

    await nav(page, /Journal/);
    await expect(page.locator('.jr-session .origin-chip[data-source="cloud-gfn"]').first()).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('install-to-play and likely title matches are worded honestly', async ({ page }) => {
    await open(page, '?cloud&reduced');
    await openGame(page, 'Last Signal');
    await expect(page.locator('.cloud-split__sub')).toHaveText('GeForce NOW · Install-to-Play');
    await page.getByRole('button', { name: 'More ways to play in the cloud' }).click();
    const menu = page.getByRole('dialog', { name: 'Play in the cloud' });
    const itp = menu.getByRole('button', { name: /GeForce NOW · Install-to-Play \(Performance\/Ultimate\)/ });
    await expect(itp).toContainText('Install-to-Play (Performance/Ultimate)');
    await expect(menu.getByText('Needs a Performance or Ultimate membership and your Steam copy.')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await openGame(page, 'Moss & Marrow');
    await page.getByRole('button', { name: 'More ways to play in the cloud' }).click();
    await expect(page.getByRole('dialog', { name: 'Play in the cloud' }).getByText(/Likely match by title/)).toBeVisible();
  });

  for (const [state, title, tone] of [
    ['ok', /About \d+ h left/, 'ok'],
    ['near', 'About 14 h left', 'warn'],
    ['reached', 'About 100 h used', 'danger'],
    ['free', /played this month/, 'muted'],
    ['none', 'Pick your GeForce NOW membership', 'muted'],
  ] as const) {
    test(`hours meter: ${state}`, async ({ page }) => {
      await open(page, `?cloud&reduced${state === 'ok' ? '' : `&cloudMeter=${state}`}`);
      const section = await cloudSettings(page);
      const meter = section.locator('.cloud-meter');
      await expect(meter.locator('.cloud-meter__title')).toHaveText(title);
      await expect(meter).toHaveAttribute('data-tone', tone);
      await expect(meter).toContainText('Estimated from sessions VYSTRAL saw');
      if (state === 'near' || state === 'reached' || state === 'ok') await expect(meter.getByRole('meter')).toBeVisible();
      else await expect(meter.getByRole('meter')).toHaveCount(0);
      await expect(section.getByText(/Xbox Cloud Gaming: .* this cycle/)).toBeVisible();
      if (state === 'near') await noSeriousViolations(page, '.cloudset');
    });
  }

  test('changing the membership updates the meter', async ({ page }) => {
    await open(page, '?cloud&reduced');
    const section = await cloudSettings(page);
    await section.getByLabel('GeForce NOW membership').selectOption('free');
    await expect(section.locator('.cloud-meter__title')).toHaveText(/played this month/);
    await section.getByLabel('Hours reset on').selectOption('15');
    await expect(section.locator('.cloud-meter__foot')).toContainText('Resets');
  });
});

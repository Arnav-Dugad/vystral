import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track D4: every data source for every game, on the preview backend (fictional data; the preview never touches the
// network — asserted in every test). Circuit Apex is an Xbox game matched to a fictional Steam app; Velvet Orbit is
// only a suggestion; Kingsfall Remastered is disputed. ?youtube gives Velvet Orbit an IGDB trailer on YouTube.

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

async function openGame(page: Page, title: string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Library/ }).click();
  await page.getByLabel('Filter library').fill(title);
  await page.getByRole('button', { name: new RegExp(`^${title}`) }).first().click();
  await expect(page.getByRole('heading', { name: title, level: 1 })).toBeAttached();
}

async function settled(page: Page) {
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
}

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

test.describe('every data source for every game', () => {
  test('an Xbox game shows Steam reviews, tags and a RAWG trailer through its matched Steam app, labelled; axe-clean', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&reviews&tags&protondb');
    await openGame(page, 'Circuit Apex');

    const glance = page.getByRole('region', { name: 'At a glance' });
    await expect(glance).toBeVisible();
    // Labelled as Steam data for the matched app, with a way to fix it.
    const note = glance.getByTestId('matched-steam-note');
    await expect(note).toContainText('Steam data for “Circuit Apex” on Steam, matched automatically');
    await expect(note.getByRole('button', { name: 'Wrong game?' })).toBeVisible();

    await expect(glance.getByRole('region', { name: 'Steam reviews' })).toContainText('positive');
    await expect(glance.getByRole('region', { name: 'Runs on Linux' })).toContainText('ProtonDB');

    const tags = page.getByRole('region', { name: 'What players call it' });
    await expect(tags).toContainText('Community tags applied by Steam players');
    await expect(tags).toContainText('for “Circuit Apex”, matched automatically');

    // The hero trailer comes from RAWG (a local loop in the preview), offered with its source.
    const trailer = page.getByRole('group', { name: 'Trailer' });
    await expect(trailer).toContainText('from RAWG');
    await expect(trailer.getByRole('button', { name: 'Play trailer' })).toBeVisible();

    // Steam news is offered for the matched app too.
    await expect(page.getByRole('tab', { name: 'News' })).toBeVisible();

    await settled(page);
    await noSeriousViolations(page, '.gi');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('matched IDs say how they were found; a conflict waits for you, and your choice is final', async ({ page }) => {
    const { errors, external } = await open(page);
    await openGame(page, 'Kingsfall Remastered');
    // Disputed: no Steam data is shown on the overview.
    await expect(page.getByRole('region', { name: 'At a glance' })).toBeVisible();
    await expect(page.getByTestId('matched-steam-note')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: 'News' })).toHaveCount(0);

    await page.getByRole('tab', { name: /Versions/ }).click();
    const card = page.getByTestId('identity-card');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Sources disagree');
    await expect(card).toContainText('Disputed, not used');
    await card.getByRole('button', { name: 'Choose the Steam game' }).click();

    const dialog = page.getByRole('dialog', { name: 'Which Steam game is this?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('radio')).toHaveCount(3); // two candidates + "It isn't on Steam"
    await dialog.getByText('Kingsfall Remastered', { exact: false }).first().click();
    await settled(page);
    await noSeriousViolations(page, '[role="dialog"]');
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden();
    await expect(card).toContainText('Chosen by you');
    await expect(card).toContainText('You chose this');
    await expect(page.getByRole('tab', { name: 'News' })).toBeVisible();

    // Back to automatic matching, then "it isn't on Steam".
    await card.getByRole('button', { name: 'Use automatic matching' }).click();
    await expect(card).toContainText('Sources disagree');
    await card.getByRole('button', { name: 'Choose the Steam game' }).click();
    await dialog.getByText('It isn’t on Steam').click();
    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(card).toContainText('Not on Steam');

    await settled(page);
    await noSeriousViolations(page, '[data-testid="identity-card"]');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('a suggestion is shown but not used until you confirm it', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&reviews');
    await openGame(page, 'Velvet Orbit');
    await expect(page.getByRole('region', { name: 'At a glance' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Steam reviews' })).toHaveCount(0);
    await page.getByRole('tab', { name: /Versions/ }).click();
    const card = page.getByTestId('identity-card');
    await expect(card).toContainText('Needs a look');
    await expect(card).toContainText('Possible match');
    await card.getByRole('button', { name: 'It’s this one' }).click();
    await expect(card).toContainText('Chosen by you');
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(page.getByTestId('matched-steam-note')).toContainText('the version you chose');
    await expect(page.getByRole('region', { name: 'Steam reviews' })).toBeVisible();
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('YouTube trailers wait for the opt-in, and the preview never loads YouTube', async ({ page }) => {
    const { errors, external } = await open(page, '?youtube');
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Library & stores' }).click();
    const row = page.locator('#dsrc-youtube');
    const toggle = row.getByRole('switch', { name: 'Allow YouTube trailers' });
    await expect(toggle).toBeVisible();
    // ?youtube turns the setting on in the preview; turn it off and back on to check the explanation.
    await row.getByRole('button', { name: /What this means/ }).click();
    await expect(row).toContainText('youtube-nocookie.com');
    await expect(row).toContainText('can’t open pages, windows or downloads');

    await openGame(page, 'Velvet Orbit');
    const trailer = page.getByTestId('youtube-trailer-controls');
    await expect(trailer).toContainText('from IGDB · YouTube');
    await trailer.getByRole('button', { name: 'Play trailer (from YouTube)' }).click();
    await expect(page.getByTestId('youtube-preview-standin')).toBeAttached();
    await expect(page.locator('iframe')).toHaveCount(0);
    await trailer.getByRole('button', { name: 'Stop trailer' }).click();
    await expect(page.getByTestId('youtube-preview-standin')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('the new sources are listed in Settings › Data sources with what they send; axe-clean', async ({ page }) => {
    const { errors, external } = await open(page);
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Library & stores' }).click();
    const section = page.getByRole('region', { name: /Data sources/ });
    await expect(section).toBeVisible();
    await expect(section.getByRole('switch', { name: 'Match games across stores' })).toBeChecked();
    await expect(section.getByRole('switch', { name: 'Allow YouTube trailers' })).not.toBeChecked();

    for (const name of ['GamerPower', 'Epic free games', 'ProtonDB', 'GOG catalogue']) {
      const card = section.getByRole('article', { name });
      await expect(card).toBeVisible();
      await expect(card.getByRole('switch', { name: `Use ${name}` })).not.toBeChecked();
    }
    const gp = section.getByRole('article', { name: 'GamerPower' });
    await gp.getByRole('button', { name: /What’s sent and licence/ }).click();
    await expect(gp).toContainText('active link back to GamerPower.com');
    await expect(gp).toContainText('Nothing about you');
    await gp.getByRole('switch', { name: 'Use GamerPower' }).click();
    await expect(gp.getByRole('switch', { name: 'Use GamerPower' })).toBeChecked();

    await settled(page);
    await noSeriousViolations(page, '.dsrc');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });
});

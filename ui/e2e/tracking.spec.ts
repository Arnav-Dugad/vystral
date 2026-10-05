import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/** Track H: games started outside VYSTRAL — settings toggle, status line, background chip, detected chip. */
async function open(page: Page, query = '?reduced') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell').first()).toBeVisible();
  return errors;
}

async function openLaunchingSettings(page: Page) {
  await page.keyboard.press('Control+,');
  await page.getByRole('button', { name: 'Launching & sessions' }).click();
  await expect(page.getByRole('heading', { name: /Games started outside VYSTRAL/ })).toBeVisible();
}

test.describe('games started outside VYSTRAL', () => {
  test('is off by default and turning it on shows what the tracker is doing', async ({ page }) => {
    const errors = await open(page);
    await openLaunchingSettings(page);
    const toggle = page.getByRole('switch', { name: 'Track games even when VYSTRAL is closed' });
    const status = page.getByTestId('bg-tracking-status');

    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await expect(status).toHaveText('Off. Only games you start from VYSTRAL are recorded.');

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await expect(status).toContainText(/Background tracking is on — last game seen: .+, .+\./);
    await expect(page.getByText(/Starts with Windows · running/)).toBeVisible();

    // Explain everything on request.
    await page.getByText('What runs, what it costs, what’s stored').click();
    await expect(page.getByText(/--background-tracker/)).toBeVisible();
    await expect(page.getByText(/Nothing leaves this PC/)).toBeVisible();

    // Ignore the last game, then bring it back.
    await page.getByRole('button', { name: 'Don’t track this game' }).click();
    const again = page.getByRole('button', { name: 'Track again' });
    await expect(again).toBeVisible();
    await again.click();
    await expect(again).toBeHidden();

    await toggle.click();
    await expect(status).toHaveText('Off. Only games you start from VYSTRAL are recorded.');
    expect(errors).toEqual([]);
  });

  test('a development build explains that starting with Windows is unavailable', async ({ page }) => {
    await open(page, '?reduced&devbuild');
    await openLaunchingSettings(page);
    await page.getByRole('switch', { name: 'Track games even when VYSTRAL is closed' }).click();
    await expect(page.getByText(/isn’t available in development builds/)).toBeVisible();
  });

  test('sessions recorded in the background carry a quiet chip in the journal', async ({ page }) => {
    await open(page);
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: /Journal/ }).click();
    const chip = page.locator('.jr-session .origin-chip[data-source="background"]').first();
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/Background/);
    await expect(chip).toHaveAttribute('title', /while VYSTRAL was closed/);
    await expect(page.locator('.jr-session .origin-chip[data-source="detected"]').first()).toBeVisible();
  });

  test('a game started elsewhere shows in the title bar without the launch sequence, and can be stopped', async ({ page }) => {
    await open(page, '?reduced&detected');
    const chip = page.locator('.now-playing');
    await expect(chip).toBeVisible();
    await expect(chip.locator('.now-playing__label')).toHaveText('Detected');
    await expect(chip.getByRole('button', { name: /started outside VYSTRAL and tracked automatically/ })).toBeVisible();
    await expect(page.getByRole('dialog', { name: /Launching/ })).toHaveCount(0);

    await chip.getByRole('button', { name: /Stop tracking this session/ }).click();
    await expect(chip).toBeHidden();
  });

  test('the launching settings have no serious or critical violations', async ({ page }) => {
    await open(page);
    await openLaunchingSettings(page);
    await page.getByRole('switch', { name: 'Track games even when VYSTRAL is closed' }).click();
    await page.getByText('What runs, what it costs, what’s stored').click();
    const results = await new AxeBuilder({ page }).include('.settings').exclude('.living-canvas').analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
  });
});

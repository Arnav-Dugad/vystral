import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { deriveSystemAccent } from '../src/lib/systemAccent';
import { PREVIEW_SYSTEM_ACCENTS } from '../src/bridge/preview.shell';

// Track G: "Windows accent" and the Mica backdrop, against the preview backend's fictional accent.

async function openSettings(page: Page, query = '?reduced') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell')).toBeVisible();
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('radiogroup', { name: 'Accent colour' })).toBeVisible();
  return errors;
}

const oklch = (s: string) => {
  const m = /oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)/.exec(s);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const gameVar = (page: Page) => page.evaluate(() => document.documentElement.style.getPropertyValue('--game'));

async function expectAccent(page: Page, palette: (typeof PREVIEW_SYSTEM_ACCENTS)[number]) {
  const expected = oklch(deriveSystemAccent(palette.accent, palette.accentLight)!.accent)!;
  await expect.poll(async () => {
    const actual = oklch(await gameVar(page));
    return !!actual && actual.every((v, i) => Math.abs(v - expected[i]) < (i === 2 ? 1 : 0.01));
  }).toBe(true);
}

test.describe('Windows accent & Mica', () => {
  test('the Windows accent option applies the system accent, readably', async ({ page }) => {
    const errors = await openSettings(page);
    const option = page.getByRole('radio', { name: 'Windows accent' });
    await expect(option).toHaveAttribute('aria-checked', 'false');
    await option.click();
    await expect(option).toHaveAttribute('aria-checked', 'true');
    await expectAccent(page, PREVIEW_SYSTEM_ACCENTS[0]);

    // Switching back to a fixed accent hands colour back to the regular accent logic.
    await page.getByRole('radio', { name: 'rose' }).click();
    await expect.poll(async () => oklch(await gameVar(page))?.[2]).toBeCloseTo(5, 0);
    expect(errors).toEqual([]);
  });

  test('follows a Windows accent change live', async ({ page }) => {
    await openSettings(page, '?reduced&accentChange');
    await page.getByRole('radio', { name: 'Windows accent' }).click();
    await expectAccent(page, PREVIEW_SYSTEM_ACCENTS[1]);
  });

  test('Living Canvas off: no see-through window in a browser, and the reason is explained', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('switch', { name: 'Living Canvas' }).click();
    await expect(page.getByText('Mica appears in the VYSTRAL app')).toBeVisible();
    // The preview can't draw Mica, so the page must keep painting its own opaque background.
    await expect(page.locator('html')).toHaveAttribute('data-backdrop', 'none');
    const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(bg).not.toMatch(/rgba\(0, 0, 0, 0\)|transparent/);
  });

  test('settings with the Windows accent has no serious or critical axe violations', async ({ page }) => {
    await openSettings(page);
    await page.getByRole('radio', { name: 'Windows accent' }).click();
    await page.getByRole('switch', { name: 'Living Canvas' }).click();
    await page.waitForTimeout(500);
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
    const results = await new AxeBuilder({ page }).exclude('.living-canvas').analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
  });
});

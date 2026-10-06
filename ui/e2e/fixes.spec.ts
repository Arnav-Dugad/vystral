import { expect, test, type Page } from '@playwright/test';

/** Regression tests for the UI audit fixes (focus, navigation memory, overlays, WebGL lifecycle). */
async function open(page: Page, query = '') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell, .imm, .onb').first()).toBeVisible();
  return errors;
}

const nav = (page: Page, name: string | RegExp) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name });

test('typing a new collection name keeps every character', async ({ page }) => {
  await open(page);
  await nav(page, 'New collection').click();
  const input = page.getByRole('dialog').getByRole('textbox');
  await expect(input).toBeFocused();
  // Typed one key at a time, the way people type: each keystroke re-renders the dialog's parent.
  await input.pressSequentially('Weekend co-op picks', { delay: 25 });
  await expect(input).toHaveValue('Weekend co-op picks');
  await expect(input).toBeFocused();
});

test('library filter text, quick filter and sort come back on Back', async ({ page }) => {
  await open(page, '?reduced');
  await nav(page, /Library/).click();
  await page.getByLabel('Filter library').fill('a');
  await page.getByRole('button', { name: 'Installed', exact: true }).click();
  await page.getByLabel('Sort by').selectOption('title');
  await page.locator('.vgrid [data-game-id]').first().click();
  await expect(page.locator('.dhero')).toBeVisible();
  await page.keyboard.press('Alt+ArrowLeft');
  await expect(page.getByRole('heading', { name: 'Library', level: 1 })).toBeVisible();
  await expect(page.getByLabel('Filter library')).toHaveValue('a');
  await expect(page.getByRole('button', { name: 'Installed', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByLabel('Sort by')).toHaveValue('title');
  // A fresh visit from the sidebar starts clean.
  await nav(page, 'Settings').click();
  await nav(page, /Library/).click();
  await expect(page.getByLabel('Filter library')).toHaveValue('');
});

test('Escape while the launch overlay shows does not leave the game page', async ({ page }) => {
  await open(page);
  await nav(page, /Library/).click();
  await page.getByRole('button', { name: /^Hollow Lantern/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Hollow Lantern', level: 1 })).toBeVisible();
  await page.locator('.pbtn__main').click();
  await expect(page.getByRole('dialog', { name: /Launching Hollow Lantern/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: /Launching Hollow Lantern/ })).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Hollow Lantern', level: 1 })).toBeVisible();
});

test('keyboard focus on a switch shows a visible ring', async ({ page }) => {
  await open(page, '?reduced');
  await nav(page, 'Settings').click();
  const toggle = page.getByRole('switch').first();
  await toggle.focus();
  // Focus by keyboard so :focus-visible applies.
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(toggle).toBeFocused();
  const ring = await toggle.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { style: cs.outlineStyle, width: parseFloat(cs.outlineWidth), visible: el.matches(':focus-visible') };
  });
  expect(ring.visible).toBe(true);
  expect(ring.style).toBe('solid');
  expect(ring.width).toBeGreaterThanOrEqual(2);
});

test('Constellation re-groups without going blank', async ({ page }) => {
  const errors = await open(page);
  await nav(page, 'Constellation').click();
  const stage = page.locator('.cst-stage');
  test.skip(!(await stage.isVisible().catch(() => false)) && (await page.locator('.cst-list, [data-mode="list"]').count()) > 0, 'WebGL unavailable here');
  await expect(stage).toHaveAttribute('data-ready', 'true', { timeout: 15_000 });
  const shownLabels = () =>
    page.locator('.cst-label').evaluateAll((els) => els.filter((el) => Number(getComputedStyle(el).opacity) > 0 && (el as HTMLElement).style.transform !== '').length);
  await expect.poll(shownLabels, { timeout: 10_000 }).toBeGreaterThan(0);
  const genreNames = await page.locator('.cst-label__name').allTextContents();
  await page.getByRole('radio', { name: 'Platform' }).click();
  await expect.poll(async () => (await page.locator('.cst-label__name').allTextContents()).join('|'), { timeout: 5000 }).not.toBe(genreNames.join('|'));
  await expect(stage).toHaveAttribute('data-ready', 'true');
  // The new clusters are drawn: their labels get placed by the renderer.
  await expect.poll(shownLabels, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.getByRole('radio', { name: 'Genre' }).click();
  await expect.poll(shownLabels, { timeout: 10_000 }).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

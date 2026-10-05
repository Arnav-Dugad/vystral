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

async function immersive(page: Page) {
  await page.keyboard.press('F11');
  await expect(page.locator('.imm')).toBeVisible();
  await expect(page.locator('.imm__card[data-focused="true"]')).toBeVisible();
}

/** Simulates a press (and release) of a controller button through the preview backend. */
async function pad(page: Page, button: string) {
  await page.evaluate((b) => {
    const c = window.__vystralPreviewController!;
    c.emit('gamepad.button', { button: b, pressed: true });
    c.emit('gamepad.button', { button: b, pressed: false });
  }, button);
}

const rumbles = (page: Page) => page.evaluate(() => [...(window.__vystralPreviewController?.rumbles ?? [])]);

test.describe('on-screen keyboard', () => {
  test('opens with Y, predicts from the library as you type, and Enter opens the top match', async ({ page }) => {
    const errors = await open(page);
    await immersive(page);
    await page.keyboard.press('y');
    const dialog = page.getByRole('dialog', { name: 'Search your library' });
    await expect(dialog).toBeVisible();
    const field = page.getByRole('searchbox', { name: 'Search your library' });
    await expect(field).toBeFocused();
    // Nothing typed yet: recently played games fill the predictions row.
    await expect(dialog.getByRole('heading', { name: 'Recently played' })).toBeVisible();

    await page.keyboard.type('kin');
    await expect(dialog.getByRole('heading', { name: 'Top matches' })).toBeVisible();
    const games = dialog.getByRole('group', { name: 'Top matches' });
    await expect(games.getByRole('button').first()).toHaveAccessibleName('Kingsfall');
    await expect(dialog.getByRole('button', { name: 'Complete as Kingsfall' })).toBeVisible();
    await expect(dialog.getByText(/matching games?$/)).toBeAttached();

    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByRole('dialog', { name: 'Kingsfall' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('.imm-panel__card')).toBeHidden();
    expect(errors).toEqual([]);
  });

  test('is fully driven by a controller: type, delete, predictions, edge haptics, close', async ({ page }) => {
    await open(page, '?vibration');
    await immersive(page);
    await pad(page, 'Y');
    const field = page.getByRole('searchbox', { name: 'Search your library' });
    await expect(field).toBeVisible();

    // Focus starts on "q": A types it, Right moves to "w", X adds a space (collapsed at the start).
    await pad(page, 'A');
    await pad(page, 'Right');
    await pad(page, 'A');
    await expect(field).toHaveValue('qw');
    await pad(page, 'B');
    await expect(field).toHaveValue('q');
    await pad(page, 'B');
    await expect(field).toHaveValue('');

    // Type "as" then accept the word prediction from the row above the keys.
    await pad(page, 'Left'); // back to q
    await pad(page, 'Down'); // a
    await pad(page, 'A');
    await pad(page, 'Right');
    await pad(page, 'A');
    await expect(field).toHaveValue('as');
    const word = page.getByRole('button', { name: /^Complete as / }).first();
    await expect(word).toBeVisible();
    for (const b of ['Up', 'Up', 'Up']) await pad(page, b); // s → w → 2 → words
    await expect(word).toHaveAttribute('data-focused', 'true');
    await pad(page, 'A');
    await expect(field).toHaveValue(/^As\S+ $/i);

    // Bottom edge of the keyboard bumps instead of moving.
    for (let i = 0; i < 6; i++) await pad(page, 'Down');
    await expect.poll(() => rumbles(page)).toContain('edge');

    // Y closes, and Immersive gets its input back.
    await pad(page, 'Y');
    await expect(field).toBeHidden();
    const before = await page.locator('.imm__card[data-focused="true"]').getAttribute('aria-label');
    await pad(page, 'Right');
    await expect(page.locator('.imm__card[data-focused="true"]')).not.toHaveAttribute('aria-label', before!);
  });

  test('B on an empty query closes and the ring sits on the focused key', async ({ page }) => {
    await open(page);
    await immersive(page);
    await pad(page, 'Y');
    const dialog = page.getByRole('dialog', { name: 'Search your library' });
    await expect(dialog).toBeVisible();
    await pad(page, 'Right');
    await pad(page, 'Right');
    await page.waitForTimeout(700);
    const match = await page.evaluate(() => {
      const k = document.querySelector('.osk__key[data-focused="true"]')!.getBoundingClientRect();
      const r = document.querySelector('.osk__ring')!.getBoundingClientRect();
      return { label: document.querySelector('.osk__key[data-focused="true"]')!.textContent, dx: Math.abs(k.x - 3 - r.x), dy: Math.abs(k.y - 3 - r.y) };
    });
    expect(match.label).toBe('e');
    expect(match.dx).toBeLessThan(4);
    expect(match.dy).toBeLessThan(4);
    await pad(page, 'B');
    await expect(dialog).toBeHidden();
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await open(page, '?reduced');
    await immersive(page);
    await page.keyboard.press('y');
    await page.keyboard.type('a');
    await expect(page.getByRole('heading', { name: 'Top matches' })).toBeVisible();
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).include('.osk__panel').analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
  });
});

test.describe('controller haptics', () => {
  test('Immersive bumps at row edges and ticks on section switch, only for controller input', async ({ page }) => {
    await open(page, '?vibration');
    await immersive(page);
    // Keyboard input never vibrates.
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowUp');
    await page.waitForTimeout(200);
    expect(await rumbles(page)).toEqual([]);

    await pad(page, 'Left'); // already in the first column
    await expect.poll(() => rumbles(page)).toEqual(['edge']);
    await pad(page, 'RB');
    await expect.poll(() => rumbles(page)).toEqual(['edge', 'tick']);
  });

  test('vibration stays off unless enabled in settings', async ({ page }) => {
    await open(page);
    await immersive(page);
    await pad(page, 'Left');
    await pad(page, 'RB');
    await page.waitForTimeout(300);
    expect(await rumbles(page)).toEqual([]);
  });
});

test.describe('hold to confirm', () => {
  async function openReset(page: Page) {
    await page.keyboard.press('Control+,');
    await page.getByRole('button', { name: 'Data & recovery' }).click();
    await page.getByRole('button', { name: 'Reset…' }).click();
    const dialog = page.getByRole('dialog', { name: 'Reset all settings?' });
    await expect(dialog).toBeVisible();
    return dialog;
  }

  // Like every other Settings test, these run with reduced motion: on GitHub's GPU-less Windows
  // runner the full-motion Settings page stalled the renderer for minutes (not reproducible locally,
  // even with the CPU throttled 6×). The hold logic and timing are identical either way.
  test('a tap does nothing; holding Enter fills the ring and confirms', async ({ page }) => {
    await open(page, '?reduced');
    const dialog = await openReset(page);
    const hold = dialog.getByRole('button', { name: 'Reset settings' });
    await expect(hold).toHaveAccessibleDescription('Press and hold to confirm.');
    await hold.focus();

    await page.keyboard.press('Enter'); // a tap
    await expect(hold.locator('[data-shown="true"]')).toHaveText('Hold to confirm');
    await page.waitForTimeout(400);
    await expect(dialog).toBeVisible();

    await page.keyboard.down('Enter');
    await expect(hold).toHaveAttribute('data-hold', 'holding');
    await page.waitForTimeout(1150);
    await page.keyboard.up('Enter');
    await expect(dialog).toBeHidden();
    await expect(page.getByText('Settings restored to defaults')).toBeVisible();
  });

  test('releasing the mouse early springs back without confirming', async ({ page }) => {
    await open(page, '?reduced');
    const dialog = await openReset(page);
    const hold = dialog.getByRole('button', { name: 'Reset settings' });
    await page.waitForTimeout(400); // let the dialog settle before aiming
    const box = (await hold.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.waitForTimeout(350);
    await page.mouse.up();
    await expect(hold).toHaveAttribute('data-hold', 'idle');
    await page.waitForTimeout(500);
    await expect(dialog).toBeVisible();

    await page.mouse.down();
    await page.waitForTimeout(1150);
    await page.mouse.up();
    await expect(dialog).toBeHidden();
  });

  test('controller A must be held; a controller-only hold still clicks normally with the mouse', async ({ page }) => {
    await open(page, '?vibration');
    const dialog = await openReset(page);
    const hold = dialog.getByRole('button', { name: 'Reset settings' });
    await hold.focus();
    await page.evaluate(() => window.__vystralPreviewController!.emit('gamepad.button', { button: 'A', pressed: true }));
    await expect(hold).toHaveAttribute('data-hold', 'holding');
    await expect.poll(() => rumbles(page)).toContain('hold');
    await page.waitForTimeout(1150);
    await page.evaluate(() => window.__vystralPreviewController!.emit('gamepad.button', { button: 'A', pressed: false }));
    await expect(dialog).toBeHidden();
    await expect.poll(() => rumbles(page)).toContain('confirm');

    // "Clear all" in the notification centre needs a hold only on a controller.
    await page.getByRole('button', { name: /^Notifications/ }).click();
    const drawer = page.getByRole('dialog', { name: 'Notifications' });
    await drawer.getByRole('button', { name: 'Clear all' }).click();
    await expect(drawer.getByText('You’re all caught up.')).toBeVisible();
  });
});

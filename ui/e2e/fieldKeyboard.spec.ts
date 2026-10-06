import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

/**
 * Track S: the docked on-screen keyboard in desktop mode. Controller input is simulated through
 * the preview backend exactly like controller.spec.ts. Settings pages run with reduced motion (see
 * the note in controller.spec.ts about GPU-less CI runners).
 */
async function open(page: Page, query = '?reduced') {
  await page.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`/${query}`);
  await expect(page.locator('.shell').first()).toBeVisible();
  // The preview backend (and its controller hooks) loads lazily.
  await page.waitForFunction(() => !!window.__vystralPreviewController);
  return errors;
}

async function pad(page: Page, button: string) {
  await page.evaluate((b) => {
    const c = window.__vystralPreviewController!;
    c.emit('gamepad.button', { button: b, pressed: true });
    c.emit('gamepad.button', { button: b, pressed: false });
  }, button);
}

async function settings(page: Page, section?: string) {
  await page.keyboard.press('Control+,');
  await expect(page.getByRole('heading', { name: 'Settings', level: 1 })).toBeVisible();
  if (section) await page.getByRole('button', { name: section }).click();
}

const keyboard = (page: Page) => page.getByRole('region', { name: 'On-screen keyboard' });

test.describe('desktop on-screen keyboard', () => {
  test('opens with A on a settings field; types, deletes, spaces and submits through the real field', async ({ page }) => {
    const errors = await open(page);
    await settings(page);
    const field = page.getByLabel('Search settings');
    await field.focus();
    await pad(page, 'A');
    const kb = keyboard(page);
    await expect(kb).toBeVisible();
    await expect(kb.locator('.fkb__label')).toHaveText('Search settings');
    await expect(field).toBeFocused(); // focus never leaves the field
    await expect(field).toHaveAttribute('data-osk-target', '');

    // Focus starts on "q": A types it, Right moves on to "w".
    await pad(page, 'A');
    await pad(page, 'Right');
    await pad(page, 'A');
    await expect(field).toHaveValue('qw');
    await expect(kb.locator('.fkb__value')).toHaveText('qw');
    await pad(page, 'X'); // backspace
    await expect(field).toHaveValue('q');
    await pad(page, 'Y'); // space
    await expect(field).toHaveValue('q ');
    await pad(page, 'X');
    await pad(page, 'X');
    // Type "vib" from the keys: v is on the bottom letter row, i and b by moving along.
    await pad(page, 'Down'); // a
    await pad(page, 'Down'); // shift row (z…)
    for (let i = 0; i < 3; i++) await pad(page, 'Right'); // z → x c v
    await pad(page, 'A');
    await expect(field).toHaveValue('v');

    // Shift (LT) capitalises the next letter only.
    await pad(page, 'LT');
    await pad(page, 'Right'); // b
    await pad(page, 'A');
    await pad(page, 'A');
    await expect(field).toHaveValue('vBb');
    // The React-controlled search really saw it (native input events): nothing matches.
    await expect(page.getByText('No settings match “vBb”.')).toBeVisible();

    // RT is Done: the keyboard slides away and the text stays.
    await pad(page, 'RT');
    await expect(kb).toBeHidden();
    await expect(field).toHaveValue('vBb');
    await expect(field).toBeFocused();
    expect(errors).toEqual([]);
  });

  test('B closes and keeps the text; Escape does too without closing the dialog under it; Done presses Enter', async ({ page }) => {
    await open(page);
    // Opened with the mouse: no keyboard for mouse users.
    await page.getByRole('button', { name: 'New collection' }).first().click();
    const dialog = page.getByRole('dialog', { name: 'New collection' });
    await expect(dialog).toBeVisible();
    const name = dialog.getByLabel('Collection name');
    await expect(name).toBeFocused();
    await page.waitForTimeout(300);
    await expect(keyboard(page)).toHaveCount(0);

    // A with the controller opens it on the focused field.
    await pad(page, 'A');
    const kb = keyboard(page);
    await expect(kb).toBeVisible();
    await expect(kb.locator('.fkb__label')).toHaveText('Collection name');
    await expect(kb.locator('.fkb__count')).toHaveText('0/60');
    await pad(page, 'A');
    await expect(name).toHaveValue('q');
    await pad(page, 'B');
    await expect(kb).toBeHidden();
    await expect(dialog).toBeVisible();
    await expect(name).toHaveValue('q');

    await pad(page, 'A');
    await expect(kb).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(kb).toBeHidden();
    await expect(dialog).toBeVisible();

    // Done fires Enter in the field: the dialog creates the collection.
    await pad(page, 'A');
    await expect(kb).toBeVisible();
    await pad(page, 'Right');
    await pad(page, 'A');
    await expect(name).toHaveValue('qw');
    await pad(page, 'RT');
    await expect(kb).toBeHidden();
    await expect(dialog).toBeHidden();
    await expect(page.getByText('qw', { exact: true }).first()).toBeVisible();
  });

  test('a dialog opened with the controller opens the keyboard on its text field straight away', async ({ page }) => {
    await open(page);
    const button = page.getByRole('button', { name: 'New collection' }).first();
    await button.focus();
    await pad(page, 'A');
    await expect(page.getByRole('dialog', { name: 'New collection' })).toBeVisible();
    await expect(keyboard(page)).toBeVisible();
    await expect(keyboard(page).locator('.fkb__label')).toHaveText('Collection name');
  });

  test('number fields get a number pad; typing on a real keyboard hands back to it', async ({ page }) => {
    await open(page);
    await settings(page, 'Controller & sound');
    // Any number field gets the pad (VYSTRAL's own settings use sliders, so add one).
    await page.evaluate(() => {
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '0';
      input.setAttribute('aria-label', 'Test minutes');
      input.id = 'num-test';
      document.querySelector('.settings__content')!.prepend(input);
      input.focus();
    });
    await pad(page, 'A');
    const kb = keyboard(page);
    await expect(kb).toBeVisible();
    await expect(kb.getByRole('group', { name: 'Number pad' })).toBeVisible();
    await expect(kb.getByRole('button', { name: 'q' })).toHaveCount(0);
    await expect(kb.getByRole('button', { name: 'Period' })).toHaveCount(0); // whole numbers only
    // Focus starts on 1: type 1, 2, then 5 (down a row).
    await pad(page, 'A');
    await pad(page, 'Right');
    await pad(page, 'A');
    await pad(page, 'Down');
    await pad(page, 'A');
    await expect(page.locator('#num-test')).toHaveValue('125');
    await pad(page, 'X');
    await expect(page.locator('#num-test')).toHaveValue('12');

    // Picking up the keyboard: the on-screen one steps aside, keeping the value.
    await page.keyboard.press('3');
    await expect(kb).toBeHidden();
    await expect(page.locator('#num-test')).toHaveValue('123');
  });

  test('password fields are masked, have no suggestions, and the toggle in Settings turns it off', async ({ page }) => {
    await open(page);
    await settings(page, 'Library & stores');
    const rawg = page.getByRole('article', { name: 'RAWG' });
    const key = rawg.getByLabel('RAWG API key');
    await key.focus();
    await pad(page, 'A');
    const kb = keyboard(page);
    await expect(kb).toBeVisible();
    await expect(kb.getByText('Hidden · not remembered')).toBeVisible();
    await pad(page, 'Up'); // the digit row
    await pad(page, 'A');
    await pad(page, 'Right');
    await pad(page, 'A');
    await expect(key).toHaveValue('12');
    await expect(kb.locator('.fkb__value')).toHaveText('••');
    await expect(kb.getByText('12', { exact: true })).toHaveCount(0);
    await expect(kb.getByRole('group', { name: 'Suggestions' }).getByRole('button')).toHaveCount(0);
    await pad(page, 'B');
    await expect(kb).toBeHidden();
    const stored = await page.evaluate(() => localStorage.getItem('vystral.osk.words.v1'));
    expect(stored).toBeNull();

    // Settings › Controller & sound › On-screen keyboard off: A clicks as before.
    await settings(page, 'Controller & sound');
    const toggle = page.getByRole('switch', { name: 'On-screen keyboard when using a controller' });
    await expect(toggle).toHaveAttribute('aria-checked', 'true');
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-checked', 'false');
    await page.getByLabel('Search settings').focus();
    await pad(page, 'A');
    await page.waitForTimeout(300);
    await expect(keyboard(page)).toHaveCount(0);
  });

  test('remembers typed words for suggestions in ordinary fields', async ({ page }) => {
    await open(page);
    await page.evaluate(() => localStorage.setItem('vystral.osk.words.v1', JSON.stringify({ v: 1, words: { weekend: { w: 'weekend', n: 2, t: 1 } } })));
    await page.getByRole('button', { name: 'New collection' }).first().click();
    const name = page.getByRole('dialog', { name: 'New collection' }).getByLabel('Collection name');
    await expect(name).toBeFocused();
    await pad(page, 'A');
    const kb = keyboard(page);
    await pad(page, 'Right'); // w
    await pad(page, 'A');
    const chip = kb.getByRole('group', { name: 'Suggestions' }).getByRole('button', { name: 'weekend' });
    await expect(chip).toBeVisible();
    for (const b of ['Up', 'Up']) await pad(page, b); // w → 2 → suggestions
    await expect(chip).toHaveAttribute('data-focused', 'true');
    await pad(page, 'A');
    await expect(name).toHaveValue('weekend ');
  });

  test('has no serious accessibility violations', async ({ page }) => {
    await open(page);
    await settings(page);
    await page.getByLabel('Search settings').focus();
    await pad(page, 'A');
    await expect(keyboard(page)).toBeVisible();
    await pad(page, 'A');
    await page.waitForTimeout(400);
    const results = await new AxeBuilder({ page }).include('.fkb').analyze();
    const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
    expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
  });

  test('High contrast and full motion render without errors', async ({ page }) => {
    const errors = await open(page, '');
    await page.evaluate(() => (document.documentElement.dataset.theme = 'contrast'));
    await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name: 'Library' }).click();
    const filter = page.getByLabel('Filter library');
    await filter.focus();
    await pad(page, 'A');
    const kb = keyboard(page);
    await expect(kb).toBeVisible();
    // Game search fields predict titles from the library.
    for (const b of ['Down', 'A']) await pad(page, b); // a
    await expect(kb.getByRole('group', { name: 'Suggestions' }).getByRole('button').first()).toBeVisible();
    await pad(page, 'B');
    await expect(kb).toBeHidden();
    expect(errors).toEqual([]);
  });
});

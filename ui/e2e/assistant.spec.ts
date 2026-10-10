import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track D3: the one Assistant, against the preview backend's FAKE provider (no AI is contacted; fictional data only).
// ?aiCloud = Claude connected, opted in and chosen; ?assistantSlow = slow streaming; ?assistantFail = the provider fails.

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

const nav = (page: Page, name: RegExp | string) => page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();
const panel = (page: Page) => page.getByRole('dialog', { name: 'Assistant' });
const launcher = (page: Page) => page.getByRole('button', { name: 'Open the Assistant' });

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

async function ask(page: Page, text: string) {
  const input = panel(page).getByLabel('Message the Assistant');
  await input.fill(text);
  await input.press('Enter');
}

test.describe('the Assistant on every page', () => {
  test('off by default: the launcher and Ctrl+J open a panel that explains how to set up an AI; Escape closes it', async ({ page }) => {
    const { errors, external } = await open(page);
    await expect(launcher(page)).toBeVisible();
    await page.keyboard.press('Control+j');
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).getByRole('heading', { name: 'Choose an AI for the Assistant' })).toBeVisible();
    await expect(panel(page).getByLabel('Message the Assistant')).toBeDisabled();
    await expect(panel(page).getByRole('button', { name: 'Set up AI' })).toBeVisible();
    await noSeriousViolations(page, '.asx-panel');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toHaveCount(0);
    await launcher(page).click();
    await expect(panel(page)).toBeVisible();
    await panel(page).getByRole('button', { name: 'Close the Assistant' }).click();
    await expect(panel(page)).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('knows the page it is on: suggestions follow Library, Journal and a game page; the conversation follows you', async ({ page }) => {
    await open(page, '?aiCloud&reduced');
    await nav(page, /Library/);
    await launcher(page).click();
    await expect(panel(page).getByRole('button', { name: /Co-op games my friends play/ })).toBeVisible();
    await expect(panel(page).getByRole('button', { name: /: change AI/ })).toContainText('Claude Sonnet 5.5');
    await nav(page, 'Journal');
    await expect(panel(page).getByRole('button', { name: 'What did I play most this month?' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Close the Assistant' }).click();
    await openGame(page, 'Starfall Tactics');
    await page.getByRole('button', { name: 'Ask the Assistant about Starfall Tactics' }).click();
    await expect(panel(page).getByRole('button', { name: 'Is Starfall Tactics good with a controller?' })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Is Starfall Tactics good with a controller?' }).click();
    await expect(panel(page).getByRole('group', { name: /Share what I found with Anthropic/ })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Share', exact: true }).click();
    await expect(panel(page).locator('.as-rich')).toContainText('plays well with a controller');
    await expect(panel(page).getByRole('region', { name: /Sources for Starfall Tactics/ })).toContainText('Valve’s Steam Deck review');
    await expect(panel(page).getByRole('list', { name: 'Look-ups used' })).toContainText('Game facts');
    // The same conversation continues on another page.
    await nav(page, 'Home');
    await expect(panel(page).locator('.asx-msg--user')).toHaveCount(1);
  });

  test('tonight: look-up chips, a card, the OK before sharing, a streamed answer that says who wrote it and what was sent', async ({ page }) => {
    const { errors, external } = await open(page, '?aiCloud&reduced');
    await launcher(page).click();
    await panel(page).getByRole('button', { name: 'What should I play tonight? I have 1 hour' }).click();
    const approval = panel(page).getByRole('group', { name: /Share what I found with Anthropic/ });
    await expect(approval).toContainText('Tonight’s picks');
    await approval.getByRole('button', { name: 'Exactly what’s included' }).click();
    await expect(approval).toContainText('Up to 8 candidate games');
    await noSeriousViolations(page, '.asx-panel');
    await approval.getByRole('button', { name: 'Share', exact: true }).click();
    await expect(panel(page).getByText(/I’d reach for/)).toBeVisible();
    await expect(panel(page).getByRole('region', { name: /VYSTRAL’s shortlist/ }).locator('.asx-pick')).toHaveCount(3);
    await expect(panel(page).getByText('Shared with Anthropic', { exact: false })).toBeVisible();
    await expect(panel(page).locator('.asx-byline')).toContainText('Claude · Claude Sonnet 5.5');
    await panel(page).getByRole('button', { name: 'What was sent' }).click();
    await expect(panel(page).getByText(/Sent to Anthropic \(Claude · Claude Sonnet 5\.5\)/)).toBeVisible();
    // Open goes to the game's page; nothing is launched.
    const first = panel(page).locator('.asx-pick').first();
    const title = (await first.locator('.asx-pick__title').textContent())!;
    await first.getByRole('button', { name: `Open ${title}` }).click();
    await expect(page.getByRole('heading', { name: title, level: 1 })).toBeAttached();
    await expect(page.locator('.launch-overlay, [data-launch-phase]')).toHaveCount(0);
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('declining shares nothing', async ({ page }) => {
    await open(page, '?aiCloud&reduced');
    await launcher(page).click();
    await ask(page, 'Which RPGs haven’t I started?');
    await panel(page).getByRole('button', { name: 'Don’t share' }).click();
    await expect(panel(page).getByText(/I didn’t share anything/)).toBeVisible();
    await expect(panel(page).getByRole('list', { name: 'Look-ups used' })).toContainText('Library search');
    await expect(panel(page).locator('.asx-chip[data-status="declined"]')).toHaveCount(1);
  });

  test('an action waits for confirmation: nothing changes until the button is pressed', async ({ page }) => {
    await open(page, '?aiCloud&reduced');
    await openGame(page, 'Starfall Tactics');
    const heart = page.getByRole('button', { name: 'Add to favorites' }).first();
    await expect(heart).toBeVisible();
    await page.keyboard.press('Control+j');
    await ask(page, 'Add this to my favorites');
    const card = panel(page).getByRole('region', { name: 'Suggested: Add Starfall Tactics to favorites' });
    await expect(card).toBeVisible();
    await expect(page.getByRole('button', { name: 'Remove from favorites' })).toHaveCount(0); // still not a favorite
    await noSeriousViolations(page, '.asx-panel');
    await card.getByRole('button', { name: 'Add to favorites' }).click();
    await expect(card.getByRole('status')).toHaveText(/Done/);
    await expect(page.getByRole('button', { name: 'Remove from favorites' }).first()).toBeVisible();
  });

  test('stop ends an answer; a failing provider says so and offers to try again', async ({ page }) => {
    await open(page, '?aiCloud&assistantSlow&reduced');
    await launcher(page).click();
    await ask(page, 'hello there');
    await panel(page).getByRole('button', { name: 'Stop' }).click();
    await expect(panel(page).getByText('Stopped', { exact: true })).toBeVisible();

    await page.goto('/?aiCloud&assistantFail&reduced');
    await launcher(page).click();
    await ask(page, 'hello');
    await expect(panel(page).getByRole('alert')).toContainText('having trouble right now');
    await expect(panel(page).getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  test('can be hidden from Settings, and isn’t shown in Immersive Mode', async ({ page }) => {
    await open(page);
    await nav(page, 'Settings');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'AI', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Assistant/ })).toBeVisible();
    await page.getByRole('switch', { name: 'Assistant button on every page' }).click();
    await expect(launcher(page)).toHaveCount(0);
    await page.getByRole('switch', { name: 'Assistant button on every page' }).click();
    await expect(launcher(page)).toBeVisible();
    await page.keyboard.press('F11');
    await expect(page.locator('.imm').first()).toBeVisible();
    await expect(launcher(page)).toHaveCount(0);
    await page.keyboard.press('Control+j');
    await expect(panel(page)).toHaveCount(0);
  });
});

test.describe('the Assistant page', () => {
  test('the full Assistant continues the panel’s conversation, keeps a conversation list and passes axe', async ({ page }) => {
    const { errors } = await open(page, '?aiCloud&reduced');
    await launcher(page).click();
    await ask(page, 'Give me my weekly recap');
    await panel(page).getByRole('button', { name: 'Share', exact: true }).click();
    await expect(panel(page).getByText(/Here’s your week/)).toBeVisible();
    await expect(panel(page).locator('.asx-card--chart')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Open full Assistant' }).click();
    await expect(page.getByRole('heading', { name: 'Assistant', level: 1 })).toBeVisible();
    await expect(panel(page)).toHaveCount(0);
    await expect(page.locator('.asx-page .asx-msg--user')).toContainText('Give me my weekly recap');
    const rail = page.getByRole('navigation', { name: 'Conversations' });
    await expect(rail.getByRole('button', { name: /^Give me my weekly recap/ })).toBeVisible();
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().iterations === Infinity));
    await noSeriousViolations(page);
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(page.getByRole('heading', { name: 'How can I help?' })).toBeVisible();
    await rail.getByRole('button', { name: /^Give me my weekly recap/ }).click();
    await expect(page.locator('.asx-page .asx-msg--user')).toContainText('Give me my weekly recap');
    // No Tonight tab any more: the one Assistant answers it.
    await expect(page.getByRole('tab', { name: 'Tonight' })).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the provider switcher shows real marks and sends you to Settings to set up a provider', async ({ page }) => {
    await open(page, '?aiCloud&reduced');
    await nav(page, 'Assistant');
    await page.getByRole('button', { name: /: change AI/ }).click();
    const menu = page.getByRole('menu', { name: 'Choose the AI' });
    await expect(menu.getByRole('menuitem', { name: /^Claude In use/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /Claude Opus 5.5/ })).toBeVisible();
    await expect(menu.locator('[data-service="claude"]')).toHaveCount(1);
    await expect(menu.locator('[data-service="gemini"]')).toHaveCount(1);
    await menu.getByRole('menuitem', { name: /Gemini/ }).click();
    await expect(page.getByRole('heading', { name: /AI providers/ })).toBeVisible();
  });
});

test.describe('one assistant', () => {
  test('the Journal has no AI of its own any more', async ({ page }) => {
    await open(page, '?aiCloud&reduced');
    await nav(page, 'Journal');
    await expect(page.getByRole('heading', { name: 'Play calendar' })).toBeVisible();
    await expect(page.getByRole('region', { name: 'Ask the Journal' })).toHaveCount(0);
    await expect(page.getByLabel('Your question')).toHaveCount(0);
  });
});

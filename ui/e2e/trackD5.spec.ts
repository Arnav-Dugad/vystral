import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

// Track D5 on the preview backend (fictional data): recommend.v2 picks with reasons and "Not interested", "Free this
// week" (?freebies; ?freebiesFail), better cloud play (?cloud&cloudMore lists two games that aren't installed;
// ?readiness=great|fair|poor), and the cover flying between cards and pages. The preview never touches the network.

async function open(page: Page, query: string) {
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

async function noSeriousViolations(page: Page, include?: string) {
  let builder = new AxeBuilder({ page }).exclude('.living-canvas');
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  const serious = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).slice(0, 3).join(' | ')}`)).toEqual([]);
}

async function nav(page: Page, name: RegExp | string) {
  await page.getByRole('navigation', { name: 'Main' }).getByRole('button', { name }).click();
}

const homeShelf = (page: Page, name: string) => page.locator('section.shelf').filter({ has: page.getByRole('heading', { name }) });
const dshelf = (page: Page, name: string | RegExp) => page.locator('section.dshelf').filter({ has: page.getByRole('heading', { name }) });

test.describe('recommend.v2 on Home', () => {
  test('“Picked for you” explains every pick, and “Not interested” removes one, with undo', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced');
    const picked = homeShelf(page, 'Picked for you');
    await expect(picked).toBeVisible({ timeout: 15_000 });
    await expect(picked.getByText('From what you play, on this PC: no AI, nothing sent')).toBeVisible();
    const reasons = picked.locator('.pick-cap__why');
    await expect.poll(() => reasons.count()).toBeGreaterThan(3);
    for (const text of await reasons.allTextContents()) expect(text.trim().length).toBeGreaterThan(8);

    const firstCard = picked.locator('.shelf__item').first();
    const button = firstCard.getByRole('button', { name: /^Not interested in / });
    const name = (await button.getAttribute('aria-label'))!.replace('Not interested in ', '');
    await button.click();
    await expect(page.getByText(`You won’t see ${name} in suggestions`)).toBeVisible();
    await expect(picked.getByRole('button', { name: `Not interested in ${name}` })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(picked.getByRole('button', { name: `Not interested in ${name}` })).toHaveCount(1);
    await noSeriousViolations(page, '.home__rows');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('“Play in the cloud” lists streamable games you haven’t installed, with one-press Stream', async ({ page }) => {
    const { errors } = await open(page, '?reduced&cloud&cloudMore');
    const row = homeShelf(page, 'Play in the cloud');
    await expect(row).toBeVisible({ timeout: 15_000 });
    await expect(row.getByText('Not installed, ready to stream')).toBeVisible();
    const stream = row.getByRole('button', { name: 'Stream Starfall Tactics with GeForce NOW' });
    await expect(stream).toBeVisible();
    await stream.click();
    await expect.poll(() => page.evaluate(() => window.__vystralPreviewCloud?.launches.map((l) => l.service))).toEqual(['gfn']);
    await expect(page.getByRole('status', { name: 'Cloud session' })).toBeVisible();
    // Installed games never appear in it.
    await expect(row.getByRole('button', { name: /^Stream (Ashen Crown|Nebula Drift)/ })).toHaveCount(0);
    await noSeriousViolations(page, '.home__rows');
    expect(errors).toEqual([]);
  });

  test('without cloud play the row is absent', async ({ page }) => {
    await open(page, '?reduced&cloudMore');
    await expect(homeShelf(page, 'Picked for you')).toBeVisible({ timeout: 15_000 });
    await expect(homeShelf(page, 'Play in the cloud')).toHaveCount(0);
  });
});

test.describe('Free this week', () => {
  test('is an invitation until turned on, then a shelf that marks what you own and opens only the store page', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&discover');
    const invite = page.locator('[data-invite="free"]');
    await expect(invite).toBeVisible({ timeout: 15_000 });
    await expect(invite).toContainText('See what’s free this week');
    await noSeriousViolations(page, '[data-invite="free"]');
    await invite.getByRole('button', { name: 'Show free games' }).click();

    const free = dshelf(page, 'Free this week');
    await expect(free).toBeVisible({ timeout: 15_000 });
    await expect(free.getByText('Preview')).toBeVisible();
    const cards = free.locator('[data-free-id]');
    await expect.poll(() => cards.count()).toBeGreaterThan(4);
    // You own Moss & Marrow on Epic: marked, and moved to the end.
    const owned = free.locator('[data-free-id="9100002"]');
    await expect(owned).toContainText('In your library');
    await expect(cards.last()).toHaveAttribute('data-free-id', '9100002');
    // Ending within two days comes first.
    await expect(cards.first()).toHaveAttribute('data-free-id', '9100003');
    await expect(cards.first()).toContainText('Ends tomorrow');

    await cards.first().getByRole('button').click();
    await expect(page.getByText('Opening Ironwake Rally in your browser')).toBeVisible();
    await expect.poll(() => page.evaluate(() => window.__vystralPreviewFreebies?.opened)).toEqual(['9100003']);
    await expect(page.getByText(/From GamerPower’s public giveaway list/)).toBeVisible();
    await noSeriousViolations(page, '.disc-browse');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('also shows on Home when its row is on, and says so honestly when the source fails', async ({ page }) => {
    await open(page, '?reduced&freebies');
    await expect(dshelf(page, 'Free this week')).toBeVisible({ timeout: 15_000 });
    await noSeriousViolations(page, '.home__rows');

    const p2 = await page.context().newPage();
    await p2.addInitScript(() => sessionStorage.setItem('vystral.introPlayed', '1'));
    await p2.goto('/?reduced&discover&freebies&freebiesFail');
    await expect(p2.locator('[data-free-state="failed"]')).toContainText('Free games couldn’t be checked', { timeout: 15_000 });
    await expect(p2.locator('section.dshelf[data-shelf="free-week"]')).toHaveCount(0);
  });
});

test.describe('recommend.v2 on Discover', () => {
  test('“Recommended for you” ranks every source with reasons; cards show cloud availability', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&discover&discoverStore&cloud');
    const rec = dshelf(page, 'Recommended for you');
    await expect(rec).toBeVisible({ timeout: 15_000 });
    await expect(rec.locator('.dshelf__reason')).toContainText('Picked on this PC');
    const cells = rec.locator('[data-rec-key]');
    await expect.poll(() => cells.count()).toBeGreaterThanOrEqual(3);
    await expect(cells.first().locator('.pick-cap__why')).not.toBeEmpty();
    // Never a game you own.
    await expect(rec.locator('.dcard[data-owned]')).toHaveCount(0);
    // Starfall Tactics II is on GeForce NOW in the fictional catalogue (cloud play is on): its card says so.
    const starfall = page.locator('.dcard[data-discover-key="steam-9000001"]').first();
    await expect(starfall.locator('.dcard__cloud')).toBeVisible();
    await expect(starfall).toHaveAttribute('aria-label', /playable in the cloud with GeForce NOW/);

    // "Not interested" removes it here and from the "Because you played" rows.
    const key = await cells.first().getAttribute('data-rec-key');
    await cells.first().getByRole('button', { name: /^Not interested in / }).click();
    await expect(rec.locator(`[data-rec-key="${key}"]`)).toHaveCount(0);
    await expect(page.locator(`section.dshelf[data-shelf^="because:"] .dcard[data-discover-key="${key}"]`)).toHaveCount(0);
    await noSeriousViolations(page, '.disc-browse');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('without cloud play, no card claims cloud availability', async ({ page }) => {
    await open(page, '?reduced&discover&discoverStore');
    await expect(dshelf(page, 'Recommended for you')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('.dcard__cloud')).toHaveCount(0);
  });
});

test.describe('better cloud play', () => {
  test('a game page says the best way to play, and the readiness check is honest about what it measures', async ({ page }) => {
    const { errors, external } = await open(page, '?reduced&cloud&cloudMore&readiness=fair');
    await nav(page, /Library/);
    await page.getByRole('button', { name: /^Starfall Tactics/ }).first().click();
    const best = page.locator('section.bestway');
    await expect(best).toBeVisible();
    await expect(best).toContainText('Best way to play');
    await expect(best).toContainText('Stream it now');
    await expect(best).toContainText('Or install it for full quality');
    await best.getByRole('button', { name: 'Check my connection' }).click();
    await expect(best).toContainText('Your connection measured fair', { timeout: 10_000 });
    await expect(best.getByRole('button', { name: 'Check my connection' })).toHaveCount(0);
    await noSeriousViolations(page, 'section.bestway');

    // Installed games: installed wins.
    await page.getByRole('button', { name: 'Back' }).first().click();
    await page.getByRole('button', { name: /^Ashen Crown/ }).first().click();
    await expect(page.locator('section.bestway')).toContainText('Play it installed');
    expect(errors).toEqual([]);
    expect(external).toEqual([]);
  });

  test('Settings → Cloud play: readiness check, session insights and the hours forecast', async ({ page }) => {
    const { errors } = await open(page, '?reduced&cloud&readiness=poor');
    await page.keyboard.press('Control+,');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Cloud play' }).click();
    const section = page.locator('#settings-cloud-readiness');
    await expect(section).toBeVisible();
    await expect(section).toContainText('Is your connection ready for cloud play?');
    await section.getByRole('button', { name: 'Check my connection' }).click();
    await expect(section).toContainText('Connection: Poor', { timeout: 10_000 });
    await expect(section.getByRole('list', { name: 'Measurements' }).getByRole('listitem')).toHaveCount(2);
    await expect(section).toContainText('round trip');
    await section.getByRole('button', { name: 'What this measures' }).click();
    await expect(section).toContainText('not your internet speed');
    // Insights from the fictional cloud sessions.
    await expect(section.getByLabel('Cloud sessions')).toContainText('streamed in');
    await expect(section).toContainText('time on other devices isn’t counted');
    // The forecast under the hours meter (an estimate).
    await expect(page.locator('.cforecast').first()).toContainText(/At your pace/);
    await noSeriousViolations(page, '#settings-cloud-readiness');
    expect(errors).toEqual([]);
  });

  test('Settings → Suggestions lists “Not interested” and brings games back', async ({ page }) => {
    await open(page, '?reduced');
    const picked = homeShelf(page, 'Picked for you');
    await expect(picked).toBeVisible({ timeout: 15_000 });
    const button = picked.getByRole('button', { name: /^Not interested in / }).first();
    const name = (await button.getAttribute('aria-label'))!.replace('Not interested in ', '');
    await button.click();
    await page.keyboard.press('Control+,');
    await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'Library & stores' }).click();
    const list = page.getByRole('list', { name: 'Not interested' });
    await expect(list).toContainText(name);
    await noSeriousViolations(page, '#settings-suggestions');
    await list.getByRole('button', { name: `Bring back ${name}` }).click();
    await expect(page.getByRole('list', { name: 'Not interested' })).toHaveCount(0);
    // The free shelf toggles live here too.
    await page.locator('#freebies-enabled').click();
    await expect(page.locator('#freebies-home')).toBeEnabled();
  });
});

interface FlightStart {
  /** Where the element was drawn when its flight began: its place then, moved by the first transform the flight wrote. */
  start: { x: number; y: number; w: number } | null;
  /** Its own box once settled. */
  final: { x: number; y: number; w: number } | null;
  /** Its computed opacity, frame by frame (the reduced-motion crossfade). */
  opacities: number[];
  /** Any transform written at all. */
  moved: boolean;
}

/**
 * Watches elements matching `selector` for `ms`: the first transform a flight writes (a MutationObserver sees every
 * style write, however busy the machine and however few frames it draws), the element's own place at that moment,
 * and where it finally settles. The start is that place plus the first translate (transform origin: top-left).
 */
async function watchFlight(page: Page, selector: string, ms = 1100): Promise<FlightStart> {
  return page.evaluate(([sel, dur]) => new Promise<FlightStart>((resolve) => {
    let first: string | null = null;
    let moved: Element | null = null;
    let base: DOMRect | null = null;
    const opacities: number[] = [];
    const mo = new MutationObserver((records) => {
      for (const r of records) {
        const el = r.target as HTMLElement;
        if (first || !el.matches?.(sel as string) || !/translate|scale/.test(el.style.transform)) continue;
        first = el.style.transform;
        moved = el;
        // Its own place at that moment (without the flight's transform): start = place + first translate.
        el.style.transform = 'none';
        base = el.getBoundingClientRect();
        el.style.transform = first;
      }
    });
    mo.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['style'] });
    const t0 = performance.now();
    const sample = () => {
      const el = document.querySelector(sel as string);
      if (el) opacities.push(Number(getComputedStyle(el).opacity));
      if (performance.now() - t0 < (dur as number)) requestAnimationFrame(sample);
    };
    sample();
    setTimeout(() => {
      mo.disconnect();
      const box = (moved ?? document.querySelector(sel as string))?.getBoundingClientRect();
      const final = box ? { x: box.left, y: box.top, w: box.width } : null;
      let start: FlightStart['start'] = null;
      const b = base as DOMRect | null;
      if (first && b) {
        const num = (re: RegExp) => { const m = re.exec(first!); return m ? Number(m[1]) : 0; };
        const sx = /scaleX\(([\d.]+)\)/.exec(first)?.[1];
        start = { x: b.left + num(/translateX\((-?[\d.]+)px\)/), y: b.top + num(/translateY\((-?[\d.]+)px\)/), w: b.width * (sx ? Number(sx) : 1) };
      }
      resolve({ start, final, opacities, moved: !!first });
    }, dur as number);
  }), [selector, ms] as const);
}

/** Allowed difference in px (sub-pixel layout, a frame of the page's own ease-in). */
const NEAR = 16;

test.describe('cover flight between cards and pages', () => {
  // Timing-sensitive: these three don't compete with each other for the CPU.
  test.describe.configure({ mode: 'serial' });
  test('a Discover card’s cover flies into the page hero and back into the card', async ({ page }) => {
    await open(page, '?discover&discoverStore');
    const card = page.locator('section.dshelf[data-shelf^="because:"] .dcard').first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    const key = (await card.getAttribute('data-discover-key'))!;
    const from = (await card.locator('.dcard__cover').boundingBox())!;
    const forward = watchFlight(page, `.dhero__cover[data-discover-key="${key}"]`);
    await card.click();
    const f = await forward;
    // It starts exactly where the card's cover was, at its size, and settles in the hero.
    expect(f.start).not.toBeNull();
    expect(Math.abs(f.start!.x - from.x)).toBeLessThan(NEAR);
    expect(Math.abs(f.start!.y - from.y)).toBeLessThan(NEAR);
    expect(Math.abs(f.start!.w - from.width)).toBeLessThan(NEAR);
    expect(Math.hypot(f.final!.x - from.x, f.final!.y - from.y)).toBeGreaterThan(40);

    // Back: the page's cover flies back into the card.
    // Once the page has its details (the hero settles around them), measure where the cover is.
    await expect(page.getByRole('button', { name: 'Where to get it' })).toBeVisible();
    await page.waitForTimeout(400);
    const hero = (await page.locator(`.dhero__cover[data-discover-key="${key}"]`).boundingBox())!;
    // (The same game may be in "Recommended for you" too: whichever copy is on screen catches it.)
    const back = watchFlight(page, `.dcard[data-discover-key="${key}"] .dcard__cover`);
    await page.getByRole('button', { name: 'Back' }).first().click();
    const b = await back;
    expect(b.start).not.toBeNull();
    expect(Math.abs(b.start!.x - hero.x)).toBeLessThan(NEAR);
    expect(Math.abs(b.start!.y - hero.y)).toBeLessThan(NEAR);
    expect(Math.hypot(b.final!.x - hero.x, b.final!.y - hero.y)).toBeGreaterThan(40);
  });

  test('a Library card’s cover flies into the game page', async ({ page }) => {
    await open(page, '?');
    await nav(page, /Library/);
    const card = page.locator('.vgrid [data-game-id] .card__frame').first();
    await expect(card).toBeVisible();
    const from = (await card.boundingBox())!;
    const id = await page.locator('.vgrid [data-game-id]').first().getAttribute('data-game-id');
    const forward = watchFlight(page, `.dhero__cover[data-game-id="${id}"]`);
    await card.click();
    const f = await forward;
    expect(f.start).not.toBeNull();
    expect(Math.abs(f.start!.x - from.x)).toBeLessThan(NEAR);
    expect(Math.abs(f.start!.y - from.y)).toBeLessThan(NEAR);
  });

  test('with reduced motion the cover crossfades in place instead of flying', async ({ page }) => {
    await open(page, '?reduced&discover&discoverStore');
    const card = page.locator('section.dshelf[data-shelf^="because:"] .dcard').first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    const key = (await card.getAttribute('data-discover-key'))!;
    const forward = watchFlight(page, `.dhero__cover[data-discover-key="${key}"]`, 800);
    await card.click();
    const f = await forward;
    expect(f.moved).toBe(false); // no travel
    expect(f.opacities.some((o) => o > 0 && o < 1)).toBe(true); // a crossfade
    await expect(page.locator(`.dhero__cover[data-discover-key="${key}"]`)).toHaveCSS('opacity', '1');
  });
});


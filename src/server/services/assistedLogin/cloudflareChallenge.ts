/**
 * Clears the Cloudflare interstitial that stands in front of some OAuth pages.
 *
 * `connect.linux.do` answers its consent URL with "Just a moment..." instead of
 * the authorize form whenever it feels like checking the visitor. A session that
 * does not wait that out harvests nothing at all: the challenge page has no
 * controls to click, no site storage to read, and the caller reports a timeout
 * even though the provider session behind it is perfectly valid.
 *
 * Answering it takes more than a selector. Cloudflare renders its Turnstile
 * widget inside a shadow root, so `iframe[src*="challenges.cloudflare.com"]`
 * matches nothing and a `frameLocator` on it can never click the checkbox — the
 * frame is only reachable through the page's own frame list. And even located,
 * the widget ignores synthetic input on the variants that matter here, so the
 * click is replayed as a real X11 pointer event through xdotool.
 *
 * Both halves were confirmed against connect.linux.do: the selector path found
 * zero widgets while the frame path located the widget at 300x65 and a real
 * pointer click cleared the challenge on the first try.
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Page } from 'playwright-core';

export const CLOUDFLARE_FRAME_SELECTOR = 'iframe[src*="challenges.cloudflare.com"]';
export const DEFAULT_CHALLENGE_TIMEOUT_MS = 45_000;

/** Titles every Cloudflare interstitial uses, in the languages sites see. */
const CHALLENGE_TITLE = /just a moment|attention required|checking your browser|正在验证|请稍候/i;
const TURNSTILE_HOST = 'challenges.cloudflare.com';
/** Widgets draw the checkbox near their left edge, vertically centred. */
const CHECKBOX_OFFSET_X = 25;

export type ChallengeBox = { x: number; y: number; width: number; height: number };

function isChallengeTitle(title: string): boolean {
  return CHALLENGE_TITLE.test(title || '');
}

/**
 * Waits for the challenge to clear, answering it if it asks for a click.
 *
 * Returns true when the page is past the challenge, false when the budget ran
 * out. Callers keep their own verdict either way: a page that never cleared is
 * simply not the page they expected.
 */
export async function passCloudflareChallenge(
  page: Page,
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_CHALLENGE_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  let answered = false;

  while (Date.now() < deadline) {
    if (!isChallengeTitle(await page.title().catch(() => ''))) return true;

    if (!answered) answered = await answerChallenge(page);
    await page.waitForTimeout(1_000).catch(() => undefined);
  }

  return !isChallengeTitle(await page.title().catch(() => ''));
}

/** Clicks the widget once, through Playwright when it can and xdotool when not. */
async function answerChallenge(page: Page): Promise<boolean> {
  // A widget inside a plain iframe still answers a normal click, and that needs
  // no X server. Try it before reaching for the pointer.
  const checkbox = page
    .frameLocator(CLOUDFLARE_FRAME_SELECTOR)
    .locator('input[type="checkbox"]')
    .first();
  try {
    await checkbox.click({ timeout: 8_000 });
    return true;
  } catch {
    // Not locatable (shadow root) or not the shape that accepts a click.
  }

  const box = await locateChallengeWidget(page);
  if (!box) return false;
  return clickWithRealPointer(page, box).then(() => true).catch(() => false);
}

/**
 * Finds the Turnstile widget's box on the page.
 *
 * The selector is tried first because it is exact, but the widgets that need
 * this helper are the ones it cannot see; the frame list is the path that
 * actually resolves them, and `frameElement()` turns the frame back into the
 * element whose position can be clicked.
 */
export async function locateChallengeWidget(page: Page): Promise<ChallengeBox | null> {
  const bySelector = page.locator(CLOUDFLARE_FRAME_SELECTOR).first();
  const direct = await bySelector.boundingBox().catch(() => null);
  if (direct) return direct;

  const frame = page.frames().find((candidate) => candidate.url().includes(TURNSTILE_HOST));
  if (!frame) return null;
  const element = await frame.frameElement().catch(() => null);
  return element ? element.boundingBox().catch(() => null) : null;
}

/**
 * Replays a click through xdotool so the widget sees a real pointer event.
 *
 * The box is in viewport coordinates while xdotool works in screen ones, so the
 * window's own offset and its browser chrome have to be added back.
 */
export async function clickWithRealPointer(page: Page, box: ChallengeBox): Promise<void> {
  const geometry = await page.evaluate(() => ({
    screenX: window.screenX,
    screenY: window.screenY,
    chromeWidth: Math.max(0, window.outerWidth - window.innerWidth),
    chromeHeight: Math.max(0, window.outerHeight - window.innerHeight),
  }));
  const x = Math.round(geometry.screenX + geometry.chromeWidth / 2 + box.x + CHECKBOX_OFFSET_X);
  const y = Math.round(geometry.screenY + geometry.chromeHeight + box.y + box.height / 2);
  await promisify(execFile)('xdotool', ['mousemove', String(x), String(y)]).catch(() => undefined);
  await page.waitForTimeout(400).catch(() => undefined);
  await promisify(execFile)('xdotool', ['click', '1']);
}

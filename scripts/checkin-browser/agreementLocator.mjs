// Finds the sign-in page's "I have read and agree" checkbox.
//
// Some New API builds put the password form behind a consent checkbox: the
// credentials are right, Turnstile is green, and the Sign in button still does
// nothing, because the form refuses to submit until the box is ticked. The run
// then reports a failed sign-in for a password that was fine.
//
// The control is a Radix-style span (`<span role="checkbox" aria-checked>`)
// with the real input hidden beside it, and the check-in script drives the
// browser through xdotool, so it needs the *screen* coordinates of the visible
// control. The DevTools endpoint is where those come from: the page reports its
// own viewport, the window reports its chrome, and the two add up to the point
// xdotool has to click. `challengeLocator.mjs` does the same for the Cloudflare
// widget, which is the one case that needs it because that widget lives in a
// closed shadow root; this is the plain-DOM version of the same idea.
//
// Read-only: it reads one rect and one attribute and never clicks anything.
//
// Usage: node agreementLocator.mjs <profileDir>
// Prints
//   checked  - the box is already ticked, so there is nothing to click
//   none     - no consent checkbox on the page (or no DevTools endpoint)
//   x=.. y=.. w=.. h=..  - where the control sits on screen
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , profileDir] = process.argv;
if (!profileDir) {
  console.error('usage: agreementLocator.mjs <profileDir>');
  process.exit(2);
}

/** Anything smaller than this is the hidden input, not the painted control. */
const MIN_SIZE = 8;
const CDP_TIMEOUT_MS = 8000;

function readDebugPort() {
  const file = join(profileDir, 'DevToolsActivePort');
  if (!existsSync(file)) return null;
  const port = Number.parseInt(readFileSync(file, 'utf8').split('\n')[0].trim(), 10);
  return Number.isFinite(port) && port > 0 ? port : null;
}

/** Minimal CDP client: one socket, request/response, no event handling. */
function connect(target) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(target.webSocketDebuggerUrl);
    const pending = new Map();
    let nextId = 0;
    const openTimer = setTimeout(() => {
      socket.close();
      reject(new Error('cdp open timeout'));
    }, CDP_TIMEOUT_MS);

    socket.addEventListener('open', () => {
      clearTimeout(openTimer);
      resolve({
        send(method, params = {}) {
          const id = (nextId += 1);
          socket.send(JSON.stringify({ id, method, params }));
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              pending.delete(id);
              rej(new Error(`${method} timeout`));
            }, CDP_TIMEOUT_MS);
            pending.set(id, {
              res: (value) => { clearTimeout(timer); res(value); },
              rej: (error) => { clearTimeout(timer); rej(error); },
            });
          });
        },
        close() { socket.close(); },
      });
    });
    socket.addEventListener('message', (event) => {
      let message;
      try {
        message = JSON.parse(typeof event.data === 'string' ? event.data : String(event.data));
      } catch {
        return;
      }
      const slot = pending.get(message.id);
      if (!slot) return;
      pending.delete(message.id);
      if (message.error) slot.rej(new Error(String(message.error.message || 'cdp error')));
      else slot.res(message.result);
    });
    socket.addEventListener('error', () => {
      clearTimeout(openTimer);
      reject(new Error('cdp socket error'));
    });
  });
}

/**
 * Picks the consent control out of the page.
 *
 * The visible span is what xdotool can hit, the hidden input is not, so only
 * elements with a real box are candidates. A page with several checkboxes
 * (settings pages do) is told apart by name, and one that matches nothing falls
 * back to the last box on the form, which is where sign-in pages put it.
 */
const EXPRESSION = `(() => {
  const nodes = Array.from(document.querySelectorAll('[role="checkbox"], input[type="checkbox"]'));
  const visible = nodes
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ rect }) => rect.width >= ${MIN_SIZE} && rect.height >= ${MIN_SIZE});
  if (visible.length === 0) return JSON.stringify({ state: 'none' });
  const named = visible.find(({ element }) => /consent|agree|terms|privacy|legal/i.test(
    [element.id, element.name, element.getAttribute('aria-label') || ''].join(' '),
  ));
  const { element, rect } = named || visible[visible.length - 1];
  const checked = element.getAttribute('aria-checked') === 'true' || element.checked === true;
  return JSON.stringify({
    state: checked ? 'checked' : 'found',
    x: rect.left,
    y: rect.top,
    w: rect.width,
    h: rect.height,
    screenX,
    screenY,
    chromeX: Math.max(0, outerWidth - innerWidth),
    chromeY: Math.max(0, outerHeight - innerHeight),
  });
})()`;

try {
  const port = readDebugPort();
  if (!port) {
    console.log('none');
    process.exit(0);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) })).json();
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) {
    console.log('none');
    process.exit(0);
  }

  const client = await connect(page);
  const evaluated = await client.send('Runtime.evaluate', { expression: EXPRESSION, returnByValue: true });
  client.close();

  const info = JSON.parse(String((evaluated.result && evaluated.result.value) || '{}'));
  if (info.state === 'none') {
    console.log('none');
    process.exit(0);
  }
  if (info.state === 'checked') {
    console.log('checked');
    process.exit(0);
  }

  const x = Math.round(info.screenX + info.chromeX / 2 + info.x + info.w / 2);
  const y = Math.round(info.screenY + info.chromeY + info.y + info.h / 2);
  console.log(`x=${x} y=${y} w=${Math.round(info.w)} h=${Math.round(info.h)}`);
  process.exit(0);
} catch (error) {
  console.error(`agreementLocator: ${error?.message || error}`);
  console.log('none');
  process.exit(0);
}

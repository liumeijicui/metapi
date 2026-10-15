// Reports the daily check-in card on the page the browser is showing.
//
// Most of the builds here paint their check-in control at a fixed spot, which
// is why the layout presets carry measured coordinates for it. A few newer
// React dashboards lay the card out inside a responsive grid instead, so the
// control moves with the window and with the card's own content, and a measured
// point goes stale the moment either changes. For those, the page is the only
// source of truth: this reads the card's real state and the button's real
// position, and the shell only has to click where it is told.
//
// It also answers "is this page signed in", which the preset-based flow
// normally reads out of the signed-in header. The answer comes from the URL
// rather than from the page language: every build redirects an unauthenticated
// visitor to a route with `sign-in` or `login` in it, and that is true no matter
// which language the dashboard is rendered in.
//
// Read-only: it reads rects and text and never clicks anything.
//
// Usage: node checkinLocator.mjs <profileDir>
// Prints one line, e.g.
//   state=actionable signedIn=1 x=1173 y=454 w=99 h=28
//   state=checked signedIn=1
//   state=nocard signedIn=1
//   state=signedout signedIn=0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , profileDir] = process.argv;
if (!profileDir) {
  console.error('usage: checkinLocator.mjs <profileDir>');
  process.exit(2);
}

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
 * Classifies the card.
 *
 * The button labels are matched whole rather than by substring: the card is
 * titled "Daily Check-in", and a substring test for `check in` would report the
 * title as the control, handing the shell a click target that does nothing.
 */
const EXPRESSION = `(() => {
  const actionableLabel = /^(check\\s*in(\\s*now)?|立即签到|签到|领取)$/i;
  const checkedLabel = /^(checked\\s*in|已签到|已领取)$/i;
  const control = (patterns) => Array.from(document.querySelectorAll('button, a, [role="button"]'))
    .filter((element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 8 && rect.height > 8 && rect.top > -rect.height && rect.top < innerHeight;
    })
    .find((element) => patterns.test((element.innerText || '').replace(/\\s+/g, ' ').trim()));

  const signedIn = !/\\/(sign-in|login|signin)(\\/|$|\\?)/i.test(location.pathname);
  const actionable = control(actionableLabel);
  const checked = control(checkedLabel);

  const base = {
    signedIn: signedIn ? 1 : 0,
    screenX,
    screenY,
    chromeX: Math.max(0, outerWidth - innerWidth),
    chromeY: Math.max(0, outerHeight - innerHeight),
  };
  if (actionable) {
    const rect = actionable.getBoundingClientRect();
    return JSON.stringify({
      ...base,
      state: 'actionable',
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      w: rect.width,
      h: rect.height,
    });
  }
  if (checked) return JSON.stringify({ ...base, state: 'checked' });
  return JSON.stringify({ ...base, state: 'nocard' });
})()`;

try {
  const port = readDebugPort();
  if (!port) {
    console.log('state=unknown signedIn=0');
    process.exit(0);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) })).json();
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) {
    console.log('state=unknown signedIn=0');
    process.exit(0);
  }

  const client = await connect(page);
  const evaluated = await client.send('Runtime.evaluate', { expression: EXPRESSION, returnByValue: true });
  client.close();

  const info = JSON.parse(String((evaluated.result && evaluated.result.value) || '{}'));
  if (!info.state) {
    console.log('state=unknown signedIn=0');
    process.exit(0);
  }
  if (!info.signedIn) {
    console.log('state=signedout signedIn=0');
    process.exit(0);
  }
  if (info.state === 'actionable') {
    const x = Math.round(info.screenX + info.chromeX / 2 + info.x);
    const y = Math.round(info.screenY + info.chromeY + info.y);
    console.log(`state=actionable signedIn=1 x=${x} y=${y} w=${Math.round(info.w)} h=${Math.round(info.h)}`);
    process.exit(0);
  }
  console.log(`state=${info.state} signedIn=1`);
  process.exit(0);
} catch (error) {
  console.error(`checkinLocator: ${error?.message || error}`);
  console.log('state=unknown signedIn=0');
  process.exit(0);
}

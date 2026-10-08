// Finds the Cloudflare Turnstile checkbox on the page the browser is showing.
//
// The check-in flow clicks through xdotool because the widget ignores synthetic
// input, so it needs the checkbox in *screen* coordinates. Those used to be a
// per-layout constant, and that is exactly what breaks on a site whose card
// renders a little differently: the click lands on empty page, the widget never
// turns green, and the run reports a failed sign-in for a password that was
// fine.
//
// The widget cannot be found from the page's own DOM: Cloudflare renders it in
// a *closed* shadow root, so `document.querySelectorAll('*')` never reaches it
// and neither does a walk over `element.shadowRoot`. The DevTools DOM domain is
// the way in — `DOM.getDocument({pierce: true})` descends into closed roots and
// `DOM.getBoxModel` then reports the widget's real position.
//
// Read-only by design: it asks for the DOM and a box, and never navigates,
// clicks or mutates anything. The click itself still comes from xdotool.
//
// Usage: node challengeLocator.mjs <profileDir>
// Prints "x=<screen x> y=<screen y> w=<width> h=<height>" when a widget is on
// the page, and "none" when there is nothing to click (already solved, or no
// challenge at all). The caller falls back to its measured coordinates on
// "none", so a browser without a DevTools endpoint is not a failure.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , profileDir] = process.argv;
if (!profileDir) {
  console.error('usage: challengeLocator.mjs <profileDir>');
  process.exit(2);
}

const CHALLENGE_HOST = 'challenges.cloudflare.com';
/** Widgets draw the checkbox near their left edge, vertically centred. */
const CHECKBOX_OFFSET_X = 25;
/** Below this the element is a spacer, not the widget. */
const MIN_WIDGET_SIZE = 20;
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

/** Walks the pierced tree for the challenge iframe and reports its box. */
function findChallengeBox(root) {
  let found = null;
  const queue = [root];
  while (queue.length > 0 && !found) {
    const node = queue.shift();
    if (!node) continue;
    if (node.nodeName === 'IFRAME') {
      const attributes = node.attributes || [];
      const matches = attributes.some((value) => String(value).includes(CHALLENGE_HOST));
      if (matches) { found = node; break; }
    }
    for (const child of node.children || []) queue.push(child);
    // Closed shadow roots only show up through `pierce`; plain shadowRoots
    // covers the open ones for good measure.
    for (const shadow of node.shadowRoots || []) queue.push(shadow);
    if (node.contentDocument) queue.push(node.contentDocument);
  }
  return found;
}

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
  await client.send('DOM.enable');
  const document = await client.send('DOM.getDocument', { depth: -1, pierce: true });
  const iframe = findChallengeBox(document.root);
  if (!iframe) {
    client.close();
    console.log('none');
    process.exit(0);
  }

  const model = await client.send('DOM.getBoxModel', { backendNodeId: iframe.backendNodeId });
  // A solved widget still reports its box, so the position alone cannot tell
  // the caller whether there is anything left to click. Clicking one that is
  // already green can restart the challenge, which is how a check-in that was
  // about to complete gets thrown back to the start. Read the token instead: a
  // non-empty response means the challenge is done and no click is needed.
  const token = await client.send('Runtime.evaluate', {
    expression: '(() => { try { const t = window.turnstile; return t && t.getResponse ? String(t.getResponse() || "") : ""; } catch (error) { return ""; } })()',
    returnByValue: true,
  });
  if (String((token.result && token.result.value) || '').length > 0) {
    client.close();
    console.log('solved');
    process.exit(0);
  }

  const geometry = JSON.parse(
    (await client.send('Runtime.evaluate', {
      expression: 'JSON.stringify({ x: screenX, y: screenY, chromeX: Math.max(0, outerWidth - innerWidth), chromeY: Math.max(0, outerHeight - innerHeight) })',
      returnByValue: true,
    })).result.value,
  );
  client.close();

  // `content` is a quad: x1,y1 .. x4,y4. A widget can be scaled, so the box is
  // rebuilt from the extremes rather than assumed axis-aligned.
  const quad = model.model.content;
  const xs = [quad[0], quad[2], quad[4], quad[6]];
  const ys = [quad[1], quad[3], quad[5], quad[7]];
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width < MIN_WIDGET_SIZE || height < MIN_WIDGET_SIZE) {
    console.log('none');
    process.exit(0);
  }

  const x = Math.round(geometry.x + geometry.chromeX / 2 + Math.min(...xs) + CHECKBOX_OFFSET_X);
  const y = Math.round(geometry.y + geometry.chromeY + Math.min(...ys) + height / 2);
  console.log(`x=${x} y=${y} w=${Math.round(width)} h=${Math.round(height)}`);
  process.exit(0);
} catch (error) {
  console.error(`challengeLocator: ${error?.message || error}`);
  console.log('none');
  process.exit(0);
}

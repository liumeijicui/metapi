// Reads where the sign-in form currently is.
//
// The presets in the shell are measurements, and a measured point goes stale
// the moment the site ships a new build: chinahk's sign-in card moved 16px up
// when the fork was rebranded, which put every preset click a few pixels *below*
// its control. Nothing about that failure is visible from the outside - the
// click lands on the card, no error is raised, and the run reports a failed
// sign-in for a password that was never typed.
//
// The form itself is the only trustworthy source for this: the fields are plain
// `<input name="username">` / `<input name="password">` and the submit is the
// button that says "Sign in", all of them laid out by the page's own CSS. This
// reports them in screen coordinates so xdotool can click exactly where they
// are, and reports "no form" rather than guessing when the page has none.
//
// Read-only: it reads rects and never clicks or types.
//
// Usage: node loginFormLocator.mjs <profileDir>
// Prints one line:
//   form=1 ux=640 uy=426 px=640 py=496 sx=640 sy=552
//   form=0
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [, , profileDir] = process.argv;
if (!profileDir) {
  console.error('usage: loginFormLocator.mjs <profileDir>');
  process.exit(2);
}

const CDP_TIMEOUT_MS = 8000;
/** Below this a box is a hidden spacer, not a field somebody could click. */
const MIN_SIZE = 8;

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
 * Finds the three controls of the sign-in form.
 *
 * Each one is matched on the contract the fork itself uses rather than on
 * position: the field names come from the form's own `name` attributes and the
 * button from its label, so a relayout moves the coordinates without breaking
 * the lookup. `visible` keeps a hidden duplicate (a mobile/desktop pair, a
 * collapsed panel) from winning the match.
 */
const EXPRESSION = `(() => {
  const centre = (element) => {
    const rect = element.getBoundingClientRect();
    return {
      x: Math.round(screenX + Math.max(0, outerWidth - innerWidth) / 2 + rect.left + rect.width / 2),
      y: Math.round(screenY + Math.max(0, outerHeight - innerHeight) + rect.top + rect.height / 2),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
    };
  };
  const visible = (element) => {
    const rect = element.getBoundingClientRect();
    return rect.width >= ${MIN_SIZE} && rect.height >= ${MIN_SIZE};
  };
  const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
  const button = Array.from(document.querySelectorAll('button, [role="button"], input[type="submit"]'))
    .filter(visible)
    .find((element) => /^(sign\\s*in|log\\s*in|登录|登陆)$/i.test((element.innerText || element.value || '').replace(/\\s+/g, ' ').trim()));

  const username = inputs.find((element) => element.name === 'username')
    || inputs.find((element) => element.type === 'email')
    || inputs.find((element) => /user|e-?mail|账号|邮箱/i.test(element.name + ' ' + element.placeholder));
  const password = inputs.find((element) => element.type === 'password')
    || inputs.find((element) => /pass/i.test(element.name || ''));

  if (!username || !password || !button) return 'form=0';
  const u = centre(username);
  const p = centre(password);
  const s = centre(button);
  return 'form=1 ux=' + u.x + ' uy=' + u.y + ' px=' + p.x + ' py=' + p.y + ' sx=' + s.x + ' sy=' + s.y;
})()`;

try {
  const port = readDebugPort();
  if (!port) {
    console.log('form=0');
    process.exit(0);
  }
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(CDP_TIMEOUT_MS) })).json();
  const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
  if (!page) {
    console.log('form=0');
    process.exit(0);
  }

  const client = await connect(page);
  const evaluated = await client.send('Runtime.evaluate', { expression: EXPRESSION, returnByValue: true });
  client.close();

  const value = String((evaluated.result && evaluated.result.value) || 'form=0');
  console.log(value.startsWith('form=1') ? value : 'form=0');
  process.exit(0);
} catch (error) {
  console.error(`loginFormLocator: ${error?.message || error}`);
  console.log('form=0');
  process.exit(0);
}

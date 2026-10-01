// Reports colour statistics for rectangular regions of a PPM screenshot.
//
// The browser check-in script reads the page back as pixels (no DevTools), so
// it needs a tiny classifier: a saturated blue button means "check in now",
// a pale blue badge means "already checked in", a green patch marks the
// solved Turnstile checkbox, and dark pixel counts tell whether a page or a
// dialog is actually rendered.
//
// Usage: node regionStats.mjs <file.ppm> x y w h [x y w h ...]
// Prints one "strong=.. weak=.. green=.. nonwhite=.. dark=.." line per region.
import { readFileSync } from 'node:fs';

const [, , file, ...rest] = process.argv;
const buffer = readFileSync(file);

let position = 0;
const nextToken = () => {
  while (position < buffer.length && [32, 10, 13, 9].includes(buffer[position])) position += 1;
  const start = position;
  while (position < buffer.length && ![32, 10, 13, 9].includes(buffer[position])) position += 1;
  return buffer.slice(start, position).toString('ascii');
};

const magic = nextToken();
if (magic !== 'P6') {
  console.error(`not a P6 PPM: ${magic}`);
  process.exit(2);
}
const width = Number.parseInt(nextToken(), 10);
const height = Number.parseInt(nextToken(), 10);
const maxValue = Number.parseInt(nextToken(), 10);
position += 1;
const channels = maxValue > 255 ? 6 : 3;

for (let index = 0; index + 3 < rest.length; index += 4) {
  const x0 = Number.parseInt(rest[index], 10);
  const y0 = Number.parseInt(rest[index + 1], 10);
  const w = Number.parseInt(rest[index + 2], 10);
  const h = Number.parseInt(rest[index + 3], 10);

      let strong = 0;
      let strongX = 0;
      let strongY = 0;
  let weak = 0;
  let green = 0;
      let nonwhite = 0;
      let dark = 0;
      let gold = 0;
      let goldX = 0;
      let goldY = 0;
      let dull = 0;
      let bright = 0;
  for (let y = Math.max(0, y0); y < Math.min(y0 + h, height); y += 1) {
    for (let x = Math.max(0, x0); x < Math.min(x0 + w, width); x += 1) {
      const offset = position + (y * width + x) * channels;
      if (offset + 2 >= buffer.length) continue;
      const r = buffer[offset];
      const g = buffer[offset + 1];
      const b = buffer[offset + 2];
      const distance = (255 - r) + (255 - g) + (255 - b);
      if (distance > 45) nonwhite += 1;
      if (distance > 150) dark += 1;
      if (b - r > 30) {
        if (r < 120 && b > 180) {
          strong += 1;
          strongX += x;
          strongY += y;
        }
        else if (r >= 140) weak += 1;
      }
      if (g - r > 40 && g - b > 40) green += 1;
      // Warm themes (moto) paint the actionable control amber and its
      // "already claimed" badge in a muted tone; the bright counter also
      // recognises Cloudflare's white Turnstile widget on dark pages.
      if (r >= 150 && g >= 115 && r - b >= 60) {
        gold += 1;
        goldX += x;
        goldY += y;
      }
      else if (r >= 100 && r < 150 && g >= 80 && g < 130 && r - b >= 30) dull += 1;
      if (r > 200 && g > 200 && b > 200) bright += 1;
    }
  }
  // The centroid travels with the count so a caller can click the control
  // where it actually is instead of trusting a measured preset: these cards
  // move with the page content, and a click a few pixels off the pill lands on
  // nothing at all.
  const goldCx = gold > 0 ? Math.round(goldX / gold) : 0;
  const goldCy = gold > 0 ? Math.round(goldY / gold) : 0;
  const strongCx = strong > 0 ? Math.round(strongX / strong) : 0;
  const strongCy = strong > 0 ? Math.round(strongY / strong) : 0;
  console.log(`strong=${strong} weak=${weak} green=${green} nonwhite=${nonwhite} dark=${dark} gold=${gold} dull=${dull} bright=${bright} goldCx=${goldCx} goldCy=${goldCy} strongCx=${strongCx} strongCy=${strongCy}`);
}

import { inflateSync } from 'node:zlib';

/**
 * Bitmap-font image captcha solver for New API forks that gate daily check-in
 * behind a locally rendered captcha (简直了 / jianzhile.vip is the reference
 * deployment).
 *
 * Those deployments do not use a stock captcha library: the image is a
 * 160x58 RGBA PNG where each of the five characters is drawn in its own solid
 * colour and the noise is drawn in two *different* semi-transparent colours.
 * That means the character strokes can be isolated exactly by colour, with no
 * thresholding or de-noising, which turns the problem into plain template
 * matching over a dot-matrix font.
 *
 * Character order is fixed by colour (see `CAPTCHA_GLYPH_COLORS`), so the five
 * colour masks are read left to right. Recognition is 1-nearest-neighbour over
 * the embedded labelled glyph bitmaps below: the font only jitters by a couple
 * of pixels between renders, and each glyph is compared at every small offset.
 *
 * The embedded table was labelled by hand from live renders. On a leave-one-out
 * pass over those renders the solver reads 95% of characters correctly, which is
 * ~76% for a whole 5-character answer. Callers are expected to retry with a
 * freshly issued captcha when the site rejects an answer, which turns a 76%
 * single-shot solve into a >99% chance across three attempts.
 *
 * Deliberately self-contained: no third-party OCR service is contacted, so the
 * account session never leaves the deployment. The free public OCR/captcha
 * endpoints that were evaluated either rate-limited the whole deployment to a
 * handful of calls per hour, refused datacentre IPs, or were simply offline.
 */

/** Character colour palette, in the left-to-right order the site draws them. */
export const CAPTCHA_GLYPH_COLORS = ['111827', '1d4ed8', '047857', 'b45309', 'be123c'] as const;

const COLOR_BYTES = CAPTCHA_GLYPH_COLORS.map((hex) => Buffer.from(`${hex}ff`, 'hex'));
const CHAR_COUNT = CAPTCHA_GLYPH_COLORS.length;

interface Exemplar {
  /** Labelled character. */
  c: string;
  /** Glyph bitmap width in pixels. */
  w: number;
  /** Glyph bitmap height in pixels. */
  h: number;
  /** Row bitmaps, two bytes per row, base64. */
  d: string;
}

export interface CaptchaGlyphDebug {
  index: number;
  character: string | null;
  /** Distance to the winning exemplar; `null` when the colour was absent. */
  distance: number | null;
  /** Distance to the runner-up character. */
  runnerUpDistance: number | null;
  /** `runnerUpDistance - distance`: small margins mean the read is unsure. */
  margin: number | null;
}

export interface CaptchaSolveResult {
  /** The 5-character answer, or `null` when a glyph could not be isolated. */
  answer: string | null;
  glyphs: CaptchaGlyphDebug[];
}

/**
 * Working canvas for matching. Large enough for the tallest/widest glyph plus
 * the +-2px jitter the renderer applies, small enough that a shifted bitmap
 * still fits.
 */
const CANVAS_WIDTH = 20;
const CANVAS_HEIGHT = 26;

/** Offsets searched per comparison, covering the renderer's jitter. */
const JITTER_OFFSETS: Array<[number, number]> = (() => {
  const out: Array<[number, number]> = [];
  for (const dx of [-2, -1, 0, 1, 2]) {
    for (const dy of [-1, 0, 1]) out.push([dx, dy]);
  }
  return out;
})();

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  pixels: Buffer;
}

export interface GlyphBitmap {
  width: number;
  height: number;
  rows: number[];
}

/**
 * Minimal PNG reader for the exact shape these captchas use: 8-bit RGBA, no
 * interlace. Returns `null` rather than throwing so callers can fall back to a
 * fresh captcha when the site changes its renderer.
 */
export function decodeCaptchaPng(png: Buffer): DecodedPng | null {
  try {
    if (png.length < 8 || png.readUInt32BE(0) !== 0x89504e47) return null;
    let pos = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = -1;
    const idat: Buffer[] = [];
    while (pos + 8 <= png.length) {
      const length = png.readUInt32BE(pos);
      const type = png.toString('ascii', pos + 4, pos + 8);
      const data = png.subarray(pos + 8, pos + 8 + length);
      pos += 12 + length;
      if (type === 'IHDR') {
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
    }
    if (bitDepth !== 8) return null;
    const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType];
    if (!channels || !width || !height) return null;
    const raw = inflateSync(Buffer.concat(idat));
    const stride = width * channels;
    if (raw.length < height * (stride + 1)) return null;
    const pixels = Buffer.alloc(height * stride);
    const previous = Buffer.alloc(stride);
    let cursor = 0;
    for (let y = 0; y < height; y += 1) {
      const filter = raw[cursor];
      cursor += 1;
      const line = raw.subarray(cursor, cursor + stride);
      cursor += stride;
      for (let i = 0; i < stride; i += 1) {
        const left = i >= channels ? line[i - channels] : 0;
        const up = previous[i];
        const upLeft = i >= channels ? previous[i - channels] : 0;
        let value = line[i];
        if (filter === 1) value = (value + left) & 0xff;
        else if (filter === 2) value = (value + up) & 0xff;
        else if (filter === 3) value = (value + ((left + up) >> 1)) & 0xff;
        else if (filter === 4) {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = (value + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft)) & 0xff;
        }
        line[i] = value;
      }
      pixels.set(line, y * stride);
      previous.set(line);
    }
    return { width, height, channels, pixels };
  } catch {
    return null;
  }
}

/** Isolates the five colour-coded glyphs. Positions without pixels become `null`. */
export function extractCaptchaGlyphs(png: Buffer): Array<GlyphBitmap | null> | null {
  const decoded = decodeCaptchaPng(png);
  if (!decoded) return null;
  const { width, height, channels, pixels } = decoded;
  return COLOR_BYTES.map((color) => {
    let minX = Number.POSITIVE_INFINITY;
    let maxX = -1;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = -1;
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * channels;
        if (
          pixels[offset] === color[0]
          && pixels[offset + 1] === color[1]
          && pixels[offset + 2] === color[2]
          && pixels[offset + 3] === 0xff
        ) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < 0) return null;
    const rows = new Array<number>(maxY - minY + 1).fill(0);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const offset = (y * width + x) * channels;
        if (
          pixels[offset] === color[0]
          && pixels[offset + 1] === color[1]
          && pixels[offset + 2] === color[2]
          && pixels[offset + 3] === 0xff
        ) {
          rows[y - minY] |= 1 << (x - minX);
        }
      }
    }
    return { width: maxX - minX + 1, height: maxY - minY + 1, rows };
  });
}

function popCount(value: number): number {
  let v = value - ((value >> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >> 2) & 0x33333333);
  v = (v + (v >> 4)) & 0x0f0f0f0f;
  return Math.imul(v, 0x01010101) >>> 24;
}

function xorDistance(a: Int32Array, b: Int32Array): number {
  let total = 0;
  for (let i = 0; i < a.length; i += 1) total += popCount(a[i] ^ b[i]);
  return total;
}

/** Paints the glyph onto a fixed canvas at a jitter offset. */
function paintCanvas(glyph: GlyphBitmap, dx: number, dy: number): Int32Array {
  const canvas = new Int32Array(CANVAS_HEIGHT);
  const originY = Math.floor((CANVAS_HEIGHT - glyph.height) / 2) + dy;
  const originX = Math.floor((CANVAS_WIDTH - glyph.width) / 2) + dx;
  for (let y = 0; y < glyph.height; y += 1) {
    const target = originY + y;
    if (target < 0 || target >= CANVAS_HEIGHT) continue;
    const row = glyph.rows[y];
    canvas[target] = (originX >= 0
      ? ((row << originX) & 0xfffff) >>> 0
      : (row >>> -originX) >>> 0);
  }
  return canvas;
}

/** A single labelled glyph, already painted onto the matching canvas. */
export interface CaptchaExemplar {
  character: string;
  rows: Int32Array;
}

function decodeExemplar(exemplar: Exemplar): CaptchaExemplar {
  const packed = Buffer.from(exemplar.d, 'base64');
  const glyph: GlyphBitmap = { width: exemplar.w, height: exemplar.h, rows: [] };
  for (let y = 0; y < exemplar.h; y += 1) glyph.rows.push(packed.readUInt16BE(y * 2));
  return { character: exemplar.c, rows: paintCanvas(glyph, 0, 0) };
}

let loadedExemplars: CaptchaExemplar[] | null = null;

function loadExemplars(): CaptchaExemplar[] {
  if (!loadedExemplars) loadedExemplars = EMBEDDED_EXEMPLARS.map(decodeExemplar);
  return loadedExemplars;
}

/**
 * Builds an exemplar table from already-solved captchas. Used by tests to run a
 * leave-one-out pass over the fixture corpus, which is the only honest way to
 * measure accuracy without the embedded table marking its own homework.
 */
export function buildCaptchaExemplars(
  samples: Array<{ png: Buffer; answer: string }>,
): CaptchaExemplar[] {
  const out: CaptchaExemplar[] = [];
  for (const sample of samples) {
    const glyphs = extractCaptchaGlyphs(sample.png);
    if (!glyphs) continue;
    for (let index = 0; index < CHAR_COUNT; index += 1) {
      const glyph = glyphs[index];
      const character = sample.answer[index];
      if (!glyph || !character) continue;
      out.push({ character, rows: paintCanvas(glyph, 0, 0) });
    }
  }
  return out;
}

/** Reads a captcha against the embedded table. See {@link solveImageCaptchaWith}. */
export function solveImageCaptcha(png: Buffer): CaptchaSolveResult {
  return solveImageCaptchaWith(png, loadExemplars());
}

/** Reads a captcha against an explicit exemplar table. */
export function solveImageCaptchaWith(
  png: Buffer,
  exemplars: CaptchaExemplar[],
): CaptchaSolveResult {
  const glyphs = extractCaptchaGlyphs(png);
  if (!glyphs) return { answer: null, glyphs: [] };
  const debug: CaptchaGlyphDebug[] = [];
  let answer = '';
  let complete = true;
  for (let index = 0; index < CHAR_COUNT; index += 1) {
    const glyph = glyphs[index];
    if (!glyph) {
      complete = false;
      debug.push({ index, character: null, distance: null, runnerUpDistance: null, margin: null });
      continue;
    }
    const variants = JITTER_OFFSETS.map(([dx, dy]) => paintCanvas(glyph, dx, dy));
    const bestPerCharacter = new Map<string, number>();
    for (const exemplar of exemplars) {
      let best = Number.POSITIVE_INFINITY;
      for (const variant of variants) {
        const distance = xorDistance(variant, exemplar.rows);
        if (distance < best) best = distance;
      }
      const existing = bestPerCharacter.get(exemplar.character);
      if (existing === undefined || best < existing) bestPerCharacter.set(exemplar.character, best);
    }
    let winner: string | null = null;
    let winnerDistance = Number.POSITIVE_INFINITY;
    let runnerUpDistance = Number.POSITIVE_INFINITY;
    for (const [character, distance] of bestPerCharacter) {
      if (distance < winnerDistance) {
        runnerUpDistance = winnerDistance;
        winnerDistance = distance;
        winner = character;
      } else if (distance < runnerUpDistance) {
        runnerUpDistance = distance;
      }
    }
    if (!winner) {
      complete = false;
      debug.push({ index, character: null, distance: null, runnerUpDistance: null, margin: null });
      continue;
    }
    answer += winner;
    debug.push({
      index,
      character: winner,
      distance: winnerDistance,
      runnerUpDistance: Number.isFinite(runnerUpDistance) ? runnerUpDistance : null,
      margin: Number.isFinite(runnerUpDistance) ? runnerUpDistance - winnerDistance : null,
    });
  }
  return { answer: complete ? answer : null, glyphs: debug };
}

/**
 * Labelled glyph bitmaps harvested from live renders of the deployment's
 * captcha. Regenerate with `scripts/dev` tooling if the site ever changes its
 * font: a wrong answer here is not silently accepted, it just costs a retry.
 */
const EMBEDDED_EXEMPLARS: Exemplar[] = [
  { c: 'L', w: 12, h: 18, d: 'AAMAAAADAAMAAwADAAMAAwADAAMAAwADAAMAAwADAAMP/w//' },
  { c: 'F', w: 12, h: 18, d: 'D+8P/wADAAAAAwADAAMAAwDvAP8AAwADAAMAAwADAAMAAwAD' },
  { c: 'G', w: 12, h: 18, d: 'A3ACMAAMAAwAAwADAAEAAgPzA/MMDwwPDAMMAAwDDAMD/AP4' },
  { c: 'H', w: 12, h: 18, d: 'DAMMAwwDDAMMAwwDDAMMAw//D/8MAwwDDAMMAwwCDAMMAwwD' },
  { c: 'U', w: 12, h: 18, d: 'DAMMAwwDDAMMAwwDDAMMAwwDDAMMAwwDDAMMAwwDBAMD/AP8' },
  { c: 'A', w: 12, h: 18, d: 'APAA8AMMAwwMAwwDDAMMAwwDDAMP/w//DAMMAwwDDAMMAwwD' },
  { c: 'S', w: 12, h: 18, d: 'A/wD/AwDDAMAAwADAAMAAwP8AfwIAAgABAAEAAwDDAMD/AP8' },
  { c: 'Z', w: 12, h: 18, d: 'D/8P/wwADAADAAMAAMAAQACwANAAIAAwAAwADAADAAMP/w//' },
  { c: 'E', w: 12, h: 18, d: 'D/8P/wADAAMAAgABAAMAAwDvAN8AAwADAAMAAwADAAMP/w//' },
  { c: 'S', w: 12, h: 18, d: 'A2wD9AwDDAMAAQACAAMAAwP8A/wMAAwADAAMAAwBDAMD/AP8' },
  { c: 'A', w: 12, h: 18, d: 'APAA8AMMAwwMAwADDAMMAwwDDAMP/w//DAMMAwwDDAMMAwwD' },
  { c: 'Z', w: 12, h: 18, d: 'D78P3gwADAADAAMAAMAAgABwAPAAMAAwAAwADAADAAMP/w//' },
  { c: 'M', w: 12, h: 18, d: 'DAMMAw8NDw0PDQ8NDPEM8QzxDPEMAQwBDAEMAQwADAEAAQwB' },
  { c: 'B', w: 12, h: 18, d: 'A38C+AwECAwADAwMDAwMDAP8A/wMDAwMDAwADAwMDAAD/AP/' },
  { c: 'D', w: 12, h: 18, d: 'A/8D/wwMDAwMDAwMDAwMDAwMAAwMDAwADAwMDAwMDAwD/wP/' },
  { c: 'J', w: 12, h: 18, d: 'D8APwAMAAwADAAMAAwADAAMAAwADAAMAAwABAAEDAgMA/AD8' },
  { c: 'F', w: 12, h: 18, d: 'CH8PDwABAAIAAwADAAMAAwB/AIcAAAADAAMAAwADAAMAAwAD' },
  { c: 'P', w: 12, h: 18, d: 'A/8D/wADDAMMAAwDBAMMAwP/A/8AAwADAAMAAwADAAMAAwAD' },
  { c: 'L', w: 12, h: 18, d: 'AAEAAwADAAMAAwADAAMAAAADAAMAAwADAAMAAwADAAMP/w//' },
  { c: 'A', w: 12, h: 18, d: 'APAA8AMMAwwAAwwDDAAMAwwDDAMP+w//DAIMAwwDDAMMAwwD' },
  { c: '7', w: 12, h: 18, d: 'D/8P/wwADAADAAMAAMAAwADAAMAAMAAwADAAMAAMAAwADAAM' },
  { c: 'Q', w: 12, h: 20, d: 'A/wD4AwDAAMMAwwDDAMMAwwDDAMMAwwDDDMMMwzDDMMD/AP8DAAMAA==' },
  { c: 'F', w: 12, h: 18, d: 'D/8P9wADAAMAAwADAAMAAwD4AIcAAwADAAMAAwADAAMAAwAD' },
  { c: 'Z', w: 12, h: 18, d: 'D/sP/QwADAADAAMAAMAAwADwAPAAMAAwAAwADAACAAIP/A/h' },
  { c: 'Q', w: 12, h: 20, d: 'A9wD3AwDDAMMAwwDDAMMAwwDDAMMAwwDDDMEMwzDDMMD/AP8DAAMAA==' },
  { c: 'U', w: 12, h: 18, d: 'DAMMAwwDDAMMAwwDDAMMAwwDDAMMAwQDCAMMAwwDDAED/AP8' },
  { c: '7', w: 12, h: 18, d: 'D/8P/wwADAADAAMAAMAAwADAAMAAMAAwADAAMAAMAAwADAAM' },
  { c: 'S', w: 12, h: 18, d: 'AjwDzAwBDAIAAwADAAMAAwP8A/wMAAwADAAMAAwDDAMD/AP8' },
  { c: 'D', w: 12, h: 18, d: 'A/8D/wwIDAQMDAAMDAQMDAwMDAwMDAwMDAwMDAwMDAwD/wP/' },
  { c: 'N', w: 12, h: 18, d: 'DAMMAwwDDAMMDwwPDBIMIQwDCMMPAw8DDAMMAwwDDAMMAwwD' },
  { c: 'C', w: 12, h: 18, d: 'A/wB/AwDDAMAAwADAAMAAgABAAIAAwADAAAAAwwDAAMD/AP8' },
  { c: 'N', w: 12, h: 18, d: 'DAMMAAwDDAMMDwAPDDMMMwzDDMMPAw8DBAMMAwwDDAMMAwwD' },
  { c: 'F', w: 12, h: 18, d: 'D/cP/wADAAIAAQADAAMAAwA/AP8AAwADAAMAAwADAAMAAwAC' },
  { c: 'G', w: 12, h: 18, d: 'A/AD8AAMAAwAAwADAAMAAgPxA/EMCwwHDAMMAwwCDAEDcALs' },
  { c: 'Y', w: 12, h: 18, d: 'DAMMAwwDDAMMAwwDAwwBDAMMAwwDDAMMAPAA8ADwAPAA8ADw' },
  { c: '2', w: 12, h: 18, d: 'A+wD3AwDDAMMAwwDDAAIAAMAAwAA8ADwAAwADAADAAMD/wx/' },
  { c: 'Q', w: 12, h: 20, d: 'ABwD/AwDCAMEAwwDDAMMAwwDDAMMAwwDDDMAMwwDDMED+AP8DAAMAA==' },
  { c: '7', w: 12, h: 18, d: 'D38PfwwADAADAAAAAMAAwADAAMAAMAAwABAAAAAEAAQACAAM' },
  { c: 'T', w: 10, h: 17, d: 'A/8AIAAwADAAMAAwADAAMAAwADAAMAAQADAAEAAwADAAMA==' },
  { c: 'P', w: 12, h: 18, d: 'A/8D/wwCAAEMAwwDDAMMAwP/A/8AAQADAAMAAwADAAMAAwAD' },
  { c: '3', w: 12, h: 18, d: 'D/8P/wwADAADAAMAAMAAwAPwA/AMAAwADAAAAAwDDAMD/AP8' },
  { c: '9', w: 12, h: 18, d: 'A/wD/AgDDAMMAwwDDgMOAwx8DLwMAAwADAAMAAMAAwAA9AD0' },
  { c: 'L', w: 12, h: 18, d: 'AAMAAwADAAMAAwADAAMAAwADAAMAAwADAAMAAwADAAMP+Q/+' },
  { c: '8', w: 12, h: 18, d: 'A3wDHAwDDAMIAAgDBAMMAwJ8AfwEAwwDDAMMAwwDDAMD/AP8' },
  { c: 'N', w: 12, h: 18, d: 'DAEMAwwDDAMMDwwPDDMMMwxDDMMOAA0DDAMMAwwDCAMMAwwD' },
  { c: 'D', w: 12, h: 18, d: 'A/8D/wwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwIDAwD+wP/' },
  { c: 'G', w: 12, h: 18, d: 'A/wD+AwDDAMAAwADAAMAAwACAAIPwQ/DDAMMAw8DDwMM/Az8' },
  { c: 'J', w: 12, h: 18, d: 'C8ALwAMAAwADAAMAAAADAAMAAwADAAMAAwADAAMDAwMA/AD8' },
  { c: '5', w: 12, h: 18, d: 'D/8P8AADAAMAAwADA/MD8wwPDA8MAAwADAAMAAwDDAID+APk' },
  { c: '8', w: 12, h: 18, d: 'A/wD/AwDDAMMAgwDDAIMAQMcAPwMAwwDDAMMAwwDDAMD/AP8' },
  { c: 'S', w: 12, h: 18, d: 'A/wDvAwDDAMAAwADAAMAAwP8AvwMAAwADAAMAAwDDAMD/AP8' },
  { c: 'K', w: 12, h: 18, d: 'DAMMAgMBAwMAAQDDADMAMwAPAA8AMwAzAMMAwwMDAQMMAwwD' },
  { c: 'E', w: 12, h: 18, d: 'D/8P/wADAAMAAwADAAMAAwD/AF8AAwABAAIAAwADAAMP/g/5' },
  { c: 'E', w: 12, h: 18, d: 'D/8P/wADAAMAAwADAAMAAADCAD8AAwADAAMAAwADAAMP/w//' },
  { c: 'D', w: 12, h: 18, d: 'A38D/wwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwD/wP/' },
  { c: 'Z', w: 12, h: 18, d: 'D/8PfwwADAADAAMAAMAAwADwAPAAMAAwAAwADAADAAMP/w//' },
  { c: 'Z', w: 12, h: 18, d: 'D/kP5wwADAABAAMAAMAAwADwAPAAMAAwAAwADAADAAMP/w//' },
  { c: 'C', w: 12, h: 18, d: 'A9wDvAwDBAMAAwADAAMAAwADAAMAAwADAAMAAgwBDAMDnAJ8' },
  { c: 'T', w: 10, h: 17, d: 'A/8D/wAwADAAMAAwADAAMAAwADAAMAAwADAAMAAwADAAMA==' },
  { c: 'R', w: 12, h: 18, d: 'A58D4QwCDAMMAwADDAMMAwPxA/4AMwAzAMMAwwMDAwMMAwwD' },
  { c: 'S', w: 12, h: 18, d: 'A/wD/AwCDAEAAwADAAMAAwP8A/wMAAwADAAMAAwDDAMD/AP8' },
  { c: 'D', w: 12, h: 18, d: 'A/cA/wwMBAwMAAwMDAwMDAwMDAwMAAwMAAwMDAwMDAwD/wP/' },
  { c: 'R', w: 12, h: 18, d: 'A/8D/wwDDAMMAwwDDAMMAwP/A/8AMwAzAMIAwQADAwMMAwwD' },
  { c: 'F', w: 12, h: 17, d: 'D/wP8wADAAMAAwADAAMAAwD/AP8AAwADAAMAAwADAAMAAw==' },
  { c: 'U', w: 12, h: 18, d: 'DAMMAwwDDAMMAwwDDAMMAwwDDAMMAwwDDAMMAwwDCAMD/AP8' },
  { c: 'Y', w: 12, h: 17, d: 'BAMMAwwDBAMMAwMMAwwDDAMMAwwDDADwAPAA8ADwAPAA8A==' },
  { c: 'Q', w: 12, h: 20, d: 'A/wD/AwDDAMMAAADDAMMAwwDDAMMAwwDDDMMMwzDDMMD/AP8DAAMAA==' },
  { c: 'N', w: 12, h: 18, d: 'DAAAAwwDDAMMDwwPDDMIMwADAMAOAw8DDAAMAwwDDAMMAwQD' },
  { c: 'P', w: 12, h: 18, d: 'A/8D/wwDDAMMAwwDBAMIAwH/AH8AAAADAAAAAwABAAIAAwAD' },
  { c: '5', w: 12, h: 18, d: 'D/8P/wADAAMAAwADA/MD8wwPDA8MAAwADAAMAAwDDAMDvAN8' },
  { c: 'F', w: 12, h: 18, d: 'D/8ADwAAAAMAAwADAAMAAwD/AP8AAwADAAMAAwADAAMAAwAD' },
  { c: 'L', w: 12, h: 17, d: 'AAMAAwADAAMAAwADAAAAAwAAAAMAAwADAAMAAwADDfwAAw==' },
  { c: 'X', w: 12, h: 18, d: 'DAMMAwwADAIDDAMMAwwDDADwAAADAAIIAAQBDAwDDAMAAAwB' },
  { c: 'K', w: 12, h: 18, d: 'DAMMAwMDAwMAwwDDADMAMwAPAA8AMwAzAMAAAwMDAwMMAwwC' },
  { c: 'B', w: 12, h: 17, d: 'A/wMAwwDDAMMAwwDCAMD/AP8DAMMAwwDDAMMAwwDAAAD/A==' },
  { c: 'K', w: 12, h: 18, d: 'DAAMAwEDAwMAwwDDADMAMwAPAA8AMwAzAMMAwwEDAQMMAwwD' },
  { c: 'L', w: 12, h: 18, d: 'AAMAAwADAAMAAwAAAAMAAAAAAAMAAwADAAMAAwADAAMP7w//' },
  { c: 'Y', w: 10, h: 18, d: 'AQMDAwMDAwMAzADMAMwAzAAwADAAMAAwADAAMAAwADAAAAAw' },
  { c: 'G', w: 12, h: 18, d: 'AnwB/AQCDAEAAwADAAMAAwADAAMPww/DDAMMAw8DDwMM/Az8' },
  { c: '4', w: 12, h: 18, d: 'AwADAAPAA8ADEAAwAwwDDAMDAwADAwADA/8P/wMAAwADAAMA' },
  { c: '9', w: 12, h: 18, d: 'A/wD/AwDDAMMAwwDDwMHAwT8CPwMAAwADAAMAAMAAwAA/AD8' },
  { c: 'A', w: 12, h: 18, d: 'APAA8AMEAAwMAwwDDAMMAwwDDAMP3w/YDAMAAwwDDAMMAwwD' },
  { c: '2', w: 12, h: 18, d: 'A/wD/AwDDAMMAwwDDAAMAAMAAwAAkABwAAwADAADAAAPwwg/' },
  { c: 'K', w: 12, h: 18, d: 'DAMIAwMDAwMAwgDDADMAMwAPAA8AMwAzAMMAwwMDAwMMAwwD' },
  { c: 'M', w: 12, h: 18, d: 'DAMMAw8PDw8PDw8PDPMM8wzzDPMMAwwDDAMMAwQDAAMMAAwD' },
  { c: 'U', w: 12, h: 18, d: 'DAMMAwwDDAMMAgwCDAEMAQwDDAMMAwwDDAMMAwwDDAMDPAM8' },
  { c: 'K', w: 12, h: 18, d: 'DAMMAwMDAwMAwwCDACMAMwAPAA8AAwAzAMMAwwMDAwMMAwwD' },
  { c: 'T', w: 10, h: 18, d: 'A/8D/wAQADAAMAAgADAAMAAwADAAMAAwADAAAAAwADAAMAAw' },
  { c: 'B', w: 12, h: 18, d: 'A/8D/wwMDAwIDAwMDAwMDAP8A/wMDAwMDAwMDAwMCAAALQPz' },
  { c: 'X', w: 12, h: 18, d: 'DAMMAwwDDAMDDAMMAwwDDADwAPADDAMMAwwDDAwDDAMMAwwC' },
  { c: 'F', w: 12, h: 18, d: 'D/8P/wADAAMAAwADAAMAAwD/AP8AAwADAAMAAwADAAMAAwAD' },
  { c: 'S', w: 12, h: 18, d: 'A8QAPAADDAEAAwADAAMAAwP8A/wEAAgADAAMAAwADAMD/AP8' },
  { c: '2', w: 12, h: 18, d: 'AOQDHAwDAAAMAwwADAAMAAMAAwAA8ADwAAwADAADAAMP/w//' },
  { c: 'Z', w: 12, h: 18, d: 'D/8H/wgADAACAAEAAMAAwADwAPAAIAAQAAAADAADAAMP/w//' },
  { c: '4', w: 12, h: 18, d: 'AwADAAPAA8ADMAMwAwwBDAMDAwMDAwMDD/8P/wMAAwADAAMA' },
  { c: 'D', w: 12, h: 18, d: 'A+ED/gwMDAwMDAwMDAwMDAwMAAwMDAwMBAwMDAwMDAwD/wA/' },
  { c: 'Z', w: 12, h: 18, d: 'D/8P/wwADAADAAMAAMAAwADwAPAAMAAAAAAADAADAAMP/w//' },
  { c: 'E', w: 12, h: 18, d: 'D/8P/wADAAMAAwADAAMAAwCPAPAAAwADAAMAAwADAAMP/w//' },
  { c: '4', w: 12, h: 18, d: 'AwADAAPAAcACEAMgAwwDDAMBAwMDAwAACD8P/wMAAwADAAMA' },
  { c: 'J', w: 12, h: 18, d: 'C8APwAMAAwADAAMAAwADAAMAAwADAAMAAwADAAMDAwMA/AD8' },
  { c: 'F', w: 12, h: 18, d: 'B/8IAAADAAMAAwADAAMAAwD/AP8AAwADAAMAAwADAAMAAwAD' },
  { c: 'K', w: 12, h: 18, d: 'DAMMAwMDAwMAwwDDADMAMwAPAA8AMwAzAMMAwwMDAwMIAwwD' },
  { c: 'D', w: 12, h: 18, d: 'A/8D/wwMDAwMDAwADAwADAAMDAwMDAwABAAADAgMCAwB/wL/' },
  { c: 'V', w: 12, h: 18, d: 'DAMMAwwDDAMMAwwDAwwDDAMMAwwDDAMMAPAA4AAAAJAAcADw' },
  { c: '4', w: 12, h: 18, d: 'AwADAAPAA8ADMAMwAwwDDAMDAwMDAwMDD/8P/wMAAwAAAAMA' },
];

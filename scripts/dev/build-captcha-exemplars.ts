import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { extractCaptchaGlyphs } from '../../src/server/services/platforms/imageCaptcha.js';

/**
 * Regenerates the labelled glyph table embedded in `imageCaptcha.ts`.
 *
 * The table is a snapshot of the deployment's dot-matrix captcha font. It only
 * has to change when the site changes that font — at which point recognition
 * degrades and every check-in burns its retries, so the fix is to re-run this
 * against a fresh fixture corpus rather than to tune the matcher.
 *
 * Usage: `npx tsx scripts/dev/build-captcha-exemplars.ts [--write]`
 *
 * Fixtures live in `src/server/services/platforms/__fixtures__/captcha-jianzhile`.
 * Every image needs an entry in `answers.json`; samples the site itself accepted
 * count as verified labels, because a rejected answer is answered differently.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const FIXTURE_DIR = join(
  REPO_ROOT,
  'src/server/services/platforms/__fixtures__/captcha-jianzhile',
);
const MODULE_PATH = join(REPO_ROOT, 'src/server/services/platforms/imageCaptcha.ts');
const PLACEHOLDER_START = 'const EMBEDDED_EXEMPLARS: Exemplar[] = [';
const PLACEHOLDER_END = '\n];\n';

export function renderExemplarTable(): { table: string; count: number } {
  const answers = JSON.parse(readFileSync(join(FIXTURE_DIR, 'answers.json'), 'utf8')) as Record<string, string>;
  const names = readdirSync(FIXTURE_DIR).filter((name) => name.endsWith('.png')).sort();
  const rows: string[] = [];
  let count = 0;
  for (const name of names) {
    const answer = answers[name];
    if (!answer) throw new Error(`no answer recorded for ${name}`);
    const glyphs = extractCaptchaGlyphs(readFileSync(join(FIXTURE_DIR, name)));
    if (!glyphs) throw new Error(`could not decode ${name}`);
    for (let index = 0; index < glyphs.length; index += 1) {
      const glyph = glyphs[index];
      const character = answer[index];
      if (!glyph || !character) throw new Error(`${name}: missing glyph ${index + 1}`);
      const packed = Buffer.alloc(glyph.rows.length * 2);
      glyph.rows.forEach((row, y) => packed.writeUInt16BE(row & 0xffff, y * 2));
      rows.push(`  { c: '${character}', w: ${glyph.width}, h: ${glyph.height}, d: '${packed.toString('base64')}' },`);
      count += 1;
    }
  }
  return { table: `${PLACEHOLDER_START}\n${rows.join('\n')}${PLACEHOLDER_END}`, count };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  const { table, count } = renderExemplarTable();
  const source = readFileSync(MODULE_PATH, 'utf8');
  const start = source.indexOf(PLACEHOLDER_START);
  if (start < 0) throw new Error('could not find the embedded exemplar table');
  const end = source.indexOf(PLACEHOLDER_END, start);
  const next = `${source.slice(0, start)}${table}${source.slice(end + PLACEHOLDER_END.length)}`;
  if (process.argv.includes('--write')) {
    writeFileSync(MODULE_PATH, next);
    console.log(`wrote ${count} exemplars to ${MODULE_PATH}`);
  } else {
    console.log(next === source ? `table already up to date (${count} exemplars)` : `table is stale (${count} exemplars); re-run with --write`);
    process.exitCode = next === source ? 0 : 1;
  }
}

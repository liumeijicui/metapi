import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CAPTCHA_GLYPH_COLORS,
  buildCaptchaExemplars,
  extractCaptchaGlyphs,
  solveImageCaptcha,
  solveImageCaptchaWith,
} from './imageCaptcha.js';

const FIXTURE_DIR = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'captcha-jianzhile');

function loadFixtures(): Array<{ name: string; png: Buffer; answer: string }> {
  const answers = JSON.parse(readFileSync(join(FIXTURE_DIR, 'answers.json'), 'utf8')) as Record<string, string>;
  return readdirSync(FIXTURE_DIR)
    .filter((name) => name.endsWith('.png'))
    .sort()
    .map((name) => ({ name, png: readFileSync(join(FIXTURE_DIR, name)), answer: answers[name] }));
}

describe('imageCaptcha', () => {
  const fixtures = loadFixtures();

  it('ships a fixture corpus with a known answer for every image', () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(21);
    for (const fixture of fixtures) {
      expect(fixture.answer).toMatch(/^[0-9A-Z]{5}$/);
    }
  });

  it('isolates exactly five colour layers from every live render', () => {
    for (const fixture of fixtures) {
      const glyphs = extractCaptchaGlyphs(fixture.png);
      expect(glyphs, fixture.name).not.toBeNull();
      expect(glyphs!.length).toBe(CAPTCHA_GLYPH_COLORS.length);
      for (const glyph of glyphs!) {
        expect(glyph, fixture.name).not.toBeNull();
        expect(glyph!.width).toBeGreaterThan(4);
        expect(glyph!.height).toBeGreaterThan(8);
      }
    }
  });

  it('reads characters well past the point where a retry loop is worth it', () => {
    // Leave-one-out: the sample under test never contributes to its own table,
    // so this number is honest rather than the embedded table grading itself.
    let charactersSeen = 0;
    let charactersCorrect = 0;
    let answersCorrect = 0;
    for (let index = 0; index < fixtures.length; index += 1) {
      const others = fixtures.filter((_, position) => position !== index);
      const exemplars = buildCaptchaExemplars(others.map((f) => ({ png: f.png, answer: f.answer })));
      const solved = solveImageCaptchaWith(fixtures[index].png, exemplars);
      expect(solved.answer, fixtures[index].name).not.toBeNull();
      if (solved.answer === fixtures[index].answer) answersCorrect += 1;
      for (let position = 0; position < fixtures[index].answer.length; position += 1) {
        charactersSeen += 1;
        if (solved.answer![position] === fixtures[index].answer[position]) charactersCorrect += 1;
      }
    }
    const characterAccuracy = charactersCorrect / charactersSeen;
    const answerAccuracy = answersCorrect / fixtures.length;
    expect(characterAccuracy).toBeGreaterThanOrEqual(0.9);
    expect(answerAccuracy).toBeGreaterThanOrEqual(0.7);
  });

  it('reads the whole corpus with the embedded table', () => {
    let correct = 0;
    for (const fixture of fixtures) {
      const solved = solveImageCaptcha(fixture.png);
      if (solved.answer === fixture.answer) correct += 1;
    }
    expect(correct / fixtures.length).toBeGreaterThanOrEqual(0.95);
  });

  it('reports a null answer instead of guessing when the image is not a captcha', () => {
    const solved = solveImageCaptcha(Buffer.from('not a png at all'));
    expect(solved.answer).toBeNull();
    expect(solved.glyphs).toEqual([]);
  });

  it('reports per-character distances so callers can spot an unsure read', () => {
    const solved = solveImageCaptcha(fixtures[0].png);
    expect(solved.glyphs).toHaveLength(5);
    for (const glyph of solved.glyphs) {
      expect(glyph.distance).toBeTypeOf('number');
      expect(glyph.margin).toBeTypeOf('number');
    }
  });
});

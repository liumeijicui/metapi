import { describe, expect, it } from 'vitest';
import {
  browserCheckinUnavailableReason,
  mapCheckinVerdict,
  parseCheckinResultLine,
} from './browserCheckinRunner.js';

describe('parseCheckinResultLine', () => {
  it('reads the verdict from the script output', () => {
    const stdout = [
      '[2026-09-30 10:00:00] signing in',
      'noise',
      'METAPI_CHECKIN_RESULT={"ok":true,"already":false,"detail":"checked_in"}',
      '',
    ].join('\n');

    expect(parseCheckinResultLine(stdout)).toEqual({
      ok: true,
      already: false,
      detail: 'checked_in',
    });
  });

  it('keeps the last verdict when the script prints more than one', () => {
    const stdout = [
      'METAPI_CHECKIN_RESULT={"ok":false,"already":false,"detail":"login_failed"}',
      'METAPI_CHECKIN_RESULT={"ok":true,"already":true,"detail":"already_checked_in"}',
    ].join('\n');

    expect(parseCheckinResultLine(stdout)?.already).toBe(true);
  });

  it('returns null when no verdict was printed', () => {
    expect(parseCheckinResultLine('just logs')).toBeNull();
    expect(parseCheckinResultLine('METAPI_CHECKIN_RESULT=not-json')).toBeNull();
  });
});

describe('mapCheckinVerdict', () => {
  it('reports an already-checked day with the wording the caller classifies', () => {
    const result = mapCheckinVerdict({ ok: true, already: true, detail: 'already_checked_in' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('already checked in');
  });

  it('reports a completed check-in as success', () => {
    expect(mapCheckinVerdict({ ok: true, already: false, detail: 'checked_in' })).toEqual({
      success: true,
      message: '浏览器签到成功（已通过站点人机校验）',
    });
  });

  it('carries the failure token into the message', () => {
    const result = mapCheckinVerdict({ ok: false, already: false, detail: 'checkin_failed' });

    expect(result.success).toBe(false);
    expect(result.message).toContain('checkin_failed');
  });
});

describe('browserCheckinUnavailableReason', () => {
  it('explains that the flow needs a Linux host', () => {
    expect(browserCheckinUnavailableReason('win32', {})).toContain('Linux');
  });

  it('names the missing binary when the toolchain is incomplete', () => {
    expect(browserCheckinUnavailableReason('linux', { PATH: '/nonexistent' })).toContain('bash');
  });
});

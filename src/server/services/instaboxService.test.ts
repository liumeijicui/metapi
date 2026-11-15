import { describe, expect, it } from 'vitest';
import { Readable } from 'node:stream';
import {
  buildInstaboxUploadCommand,
  createInstaboxLimitedUploadStream,
  decryptInstaboxSecret,
  encryptInstaboxSecret,
  maskInstaboxApiKey,
  normalizeInstaboxUploadPath,
  resolveInstaboxStartAction,
  upstreamErrorMessage,
} from './instaboxService.js';

describe('instabox machine start action', () => {
  it('resumes a suspended machine instead of calling wake', () => {
    expect(resolveInstaboxStartAction({ state: 'suspended', desiredState: 'suspended' })).toBe('resume');
    expect(resolveInstaboxStartAction({ state: 'suspended', desiredState: 'running' })).toBe('pending');
  });

  it('wakes a running machine and never overrides a user stop', () => {
    expect(resolveInstaboxStartAction({ state: 'running', desiredState: 'running' })).toBe('wake');
    expect(resolveInstaboxStartAction({ state: 'running', desiredState: 'suspended' })).toBe('pending');
    expect(resolveInstaboxStartAction({ state: 'stopped', desiredState: 'stopped' })).toBe('skip');
  });

  it('cold-starts a machine that OS-rebooted itself (stopped but desired running)', () => {
    expect(resolveInstaboxStartAction({ state: 'stopped', desiredState: 'running' })).toBe('start');
  });
});

describe('instabox credential handling', () => {
  it('builds a single-line upload command that CMD and PowerShell both accept', () => {
    const result = buildInstaboxUploadCommand({
      machineId: 'm_test123',
      apiKey: 'ibk_test-key-for-unit-tests-only',
      localPath: String.raw`D:\jar\my app's.jar`,
    });
    expect(result.path).toBe('/data/home/jar/my app\'s.jar');
    expect(result.command).not.toContain('\n');
    expect(result.command.startsWith('curl.exe -X PUT ')).toBe(true);
    // 双引号是 CMD 与 PowerShell 都认的分组方式；单引号粘进 CMD 会让
    // `&parents=true` 被当作命令分隔符。
    expect(result.command).toContain('--data-binary "@D:\\jar\\my app\'s.jar"');
    expect(result.command).toContain('path=%2Fdata%2Fhome%2Fjar%2Fmy%20app%27s.jar');
    expect(result.command).toContain('"Authorization: Bearer ibk_test-key-for-unit-tests-only"');
  });

  it('drops quotes pasted around the remote path instead of encoding them as %22', () => {
    const result = buildInstaboxUploadCommand({
      machineId: 'm_test123',
      apiKey: 'ibk_test-key-for-unit-tests-only',
      localPath: 'D:\\project\\daas-mock-server\\target\\daas-mock-server.jar',
      path: '"/data/home/jar/daas-mock-server.jar"',
    });
    expect(result.path).toBe('/data/home/jar/daas-mock-server.jar');
    expect(result.command).not.toContain('%22');
    expect(result.command).toContain('path=%2Fdata%2Fhome%2Fjar%2Fdaas-mock-server.jar&parents=true');
  });

  it('drops a single trailing quote left over from a copied command', () => {
    const result = buildInstaboxUploadCommand({
      machineId: 'm_test123',
      apiKey: 'ibk_test-key-for-unit-tests-only',
      localPath: 'D:\\project\\daas-mock-server\\target\\daas-mock-server.jar',
      path: '/data/home/jar/daas-mock-server.jar"',
    });
    expect(result.path).toBe('/data/home/jar/daas-mock-server.jar');
    expect(result.command).not.toContain('%22');
  });

  it('accepts an explicit remote file path and rejects a directory local path', () => {
    const result = buildInstaboxUploadCommand({
      machineId: 'm_test123',
      apiKey: 'ibk_test-key-for-unit-tests-only',
      localPath: '@D:\\jar\\daas-dpms.jar',
      path: '/data/workspace/target.jar',
    });
    expect(result.localPath).toBe('D:\\jar\\daas-dpms.jar');
    expect(result.path).toBe('/data/workspace/target.jar');
    expect(() => buildInstaboxUploadCommand({
      machineId: 'm_test123',
      apiKey: 'ibk_test-key-for-unit-tests-only',
      localPath: 'D:\\jar\\',
    })).toThrow(/具体文件/);
  });

  it('round-trips an API key through AES-256-GCM', () => {
    const apiKey = 'ibk_test-key-for-unit-tests-only';
    const cipher = encryptInstaboxSecret(apiKey);
    expect(cipher).not.toContain(apiKey);
    expect(cipher.startsWith('v1:')).toBe(true);
    expect(decryptInstaboxSecret(cipher)).toBe(apiKey);
  });

  it('rejects tampered ciphertext instead of returning garbage', () => {
    const cipher = encryptInstaboxSecret('ibk_test-key-for-unit-tests-only');
    const parts = cipher.split(':');
    const data = parts[3]!;
    parts[3] = `${data.slice(0, -1)}${data.endsWith('A') ? 'B' : 'A'}`;
    expect(decryptInstaboxSecret(parts.join(':'))).toBeNull();
  });

  it('masks keys so the full value is never exposed', () => {
    const apiKey = 'ibk_abcdefghijklmnopqrstuvwxyz0123456789';
    const masked = maskInstaboxApiKey(apiKey);
    expect(masked).toBe('ibk_abcd…456789');
    expect(masked).not.toBe(apiKey);
  });

  it('only accepts complete file paths on the persistent data disk', () => {
    expect(normalizeInstaboxUploadPath('/data/workspace/app.jar')).toBe('/data/workspace/app.jar');
    expect(normalizeInstaboxUploadPath('/data/中文 文件.zip')).toBe('/data/中文 文件.zip');
    expect(() => normalizeInstaboxUploadPath('/etc/passwd')).toThrow(/\/data\//);
    expect(() => normalizeInstaboxUploadPath('/data/../etc/passwd')).toThrow(/\.\./);
    expect(() => normalizeInstaboxUploadPath('/data/workspace/')).toThrow(/完整文件路径/);
    expect(() => normalizeInstaboxUploadPath('/data/\u0000bad')).toThrow(/控制字符/);
  });

  it('reads the nested error code so a cooldown is not reported as a bare 409', () => {
    // InstaBox 把 code/message 放在 `error` 里；只读顶层会把所有 409 都
    // 显示成“请求失败（HTTP 409）”，看不出是冷却还是真的出错。
    const message = upstreamErrorMessage(409, {
      error: {
        code: 'machine_cooldown',
        message: 'machine is cooling down until 2026-11-04T08:54:21Z',
        retryable: true,
        retryAfterSeconds: 3434,
      },
    });
    expect(message).toContain('冷却期');
    expect(message).toContain('后可再启动');
    expect(message).not.toContain('HTTP 409');
  });

  it('still explains unknown statuses with their upstream message', () => {
    expect(upstreamErrorMessage(409, { error: { code: 'weird', message: 'nope' } }))
      .toBe('InstaBox 请求失败（HTTP 409）：nope');
  });

  it('streams uploads while enforcing the size limit without buffering', async () => {
    const valid = createInstaboxLimitedUploadStream(Readable.from([Buffer.from('1234')]), 4);
    const chunks: Buffer[] = [];
    for await (const chunk of valid.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe('1234');
    expect(valid.bytesWritten()).toBe(4);

    const oversized = createInstaboxLimitedUploadStream(Readable.from([Buffer.from('12345')]), 4);
    await expect(async () => {
      for await (const _chunk of oversized.stream) {
        // Consume the stream to trigger the limiter.
      }
    }).rejects.toMatchObject({ status: 413, code: 'upload_too_large' });
  });

  it('rejects an empty streaming upload', async () => {
    const empty = createInstaboxLimitedUploadStream(Readable.from([]));
    await expect(async () => {
      for await (const _chunk of empty.stream) {
        // Consume the stream to trigger the final check.
      }
    }).rejects.toMatchObject({ status: 400, code: 'empty_upload' });
  });
});

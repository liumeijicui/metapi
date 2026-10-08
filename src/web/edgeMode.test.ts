import { describe, expect, it } from 'vitest';
import { buildServerAddress, formatEdgeSyncTime, splitServerAddress } from './edgeMode.js';

describe('边缘版：服务器地址填写与回填', () => {
  it('只填 IP 或 IP:端口 时按 http 处理，带协议的地址按原协议', () => {
    expect(splitServerAddress('43.142.48.105')).toEqual({ scheme: 'http', host: '43.142.48.105', port: '' });
    expect(splitServerAddress(' 43.142.48.105:4000 ')).toEqual({ scheme: 'http', host: '43.142.48.105', port: '4000' });
    expect(splitServerAddress('http://43.142.48.105:4000/')).toEqual({ scheme: 'http', host: '43.142.48.105', port: '4000' });
    expect(splitServerAddress('https://metapi.cita777.me')).toEqual({ scheme: 'https', host: 'metapi.cita777.me', port: '' });
    expect(splitServerAddress('')).toEqual({ scheme: 'http', host: '', port: '' });
  });

  it('组装地址时协议默认端口不写进 URL', () => {
    expect(buildServerAddress({ scheme: 'http', host: '43.142.48.105', port: '4000' }))
      .toBe('http://43.142.48.105:4000');
    expect(buildServerAddress({ scheme: 'http', host: '43.142.48.105', port: '80' }))
      .toBe('http://43.142.48.105');
    expect(buildServerAddress({ scheme: 'https', host: 'metapi.cita777.me', port: '443' }))
      .toBe('https://metapi.cita777.me');
    // 地址为空时不要拼出 http://:4000 这种半截地址。
    expect(buildServerAddress({ scheme: 'http', host: '', port: '4000' })).toBe('');
  });

  it('已保存的地址能原样拆回两个输入框', () => {
    for (const url of ['http://43.142.48.105:4000', 'https://metapi.cita777.me']) {
      expect(buildServerAddress(splitServerAddress(url))).toBe(url);
    }
  });

  it('上次同步时间对空值 / 非法值安全', () => {
    expect(formatEdgeSyncTime(null)).toBe('');
    expect(formatEdgeSyncTime('')).toBe('');
    expect(formatEdgeSyncTime('not-a-date')).toBe('');
    expect(formatEdgeSyncTime('2026-10-08T02:00:00.000Z')).not.toBe('');
  });
});

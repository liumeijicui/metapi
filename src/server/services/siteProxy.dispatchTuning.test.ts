import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Headers } from 'undici';

type SiteProxyModule = typeof import('./siteProxy.js');

/**
 * AI 回答「复杂问题就断流」的根因曾在这一层：undici 默认 bodyTimeout 是 300s
 * （响应体数据之间的最大间隔），上游只要 5 分钟没吐新字节就直接掐断，而业务层
 * 的超时预算比这宽 —— 那条预算永远轮不到生效。AI 生成这条路必须显式放开，
 * 控制面请求则要**保留** undici 兜底（它们没有自己的超时）。这里把这条界线锁住。
 */
describe('siteProxy dispatcher 调优', () => {
  let siteProxy: SiteProxyModule;

  beforeAll(async () => {
    process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'metapi-site-proxy-tuning-'));
    await import('../db/migrate.js');
    siteProxy = await import('./siteProxy.js');
  });

  it('UNLIMITED_BODY_TIMEOUT 关掉 undici 那条第 5 分钟断流的 bodyTimeout', () => {
    expect(siteProxy.UNLIMITED_BODY_TIMEOUT.bodyTimeout).toBe(0);
  });

  it('不传调优 = 保留 undici 兜底（没有代理时不挂 dispatcher）', () => {
    const plain = siteProxy.withSiteRecordProxyRequestInit(null, { method: 'POST' });
    expect((plain as { dispatcher?: unknown }).dispatcher).toBeUndefined();
  });

  it('传了调优就挂上自己的 dispatcher；同样的调优复用同一实例', () => {
    const first = siteProxy.withSiteRecordProxyRequestInit(null, {}, null, siteProxy.UNLIMITED_BODY_TIMEOUT);
    const second = siteProxy.withSiteRecordProxyRequestInit(null, {}, null, siteProxy.UNLIMITED_BODY_TIMEOUT);
    expect((first as { dispatcher?: unknown }).dispatcher).toBeTruthy();
    expect((first as { dispatcher?: unknown }).dispatcher)
      .toBe((second as { dispatcher?: unknown }).dispatcher);
  });

  it('配了代理时：放开与不放开各自留一份连接池', () => {
    const proxyUrl = 'http://127.0.0.1:7890';
    const tuned = siteProxy.withExplicitProxyRequestInit(proxyUrl, {}, false, siteProxy.UNLIMITED_BODY_TIMEOUT);
    const plain = siteProxy.withExplicitProxyRequestInit(proxyUrl, {}, false);
    expect((tuned as { dispatcher?: unknown }).dispatcher).toBeTruthy();
    expect((plain as { dispatcher?: unknown }).dispatcher).toBeTruthy();
    expect((tuned as { dispatcher?: unknown }).dispatcher)
      .not.toBe((plain as { dispatcher?: unknown }).dispatcher);
  });

  it('放开超时的同时仍然合并站点自定义请求头', () => {
    const init = siteProxy.withSiteRecordProxyRequestInit(
      { customHeaders: { 'X-Site': '1' } } as never,
      { method: 'POST', headers: { 'X-Call': '2' } },
      null,
      siteProxy.UNLIMITED_BODY_TIMEOUT,
    );
    // 合并结果是个 Headers 实例，键会被规范化成小写。
    const headers = new Headers(init.headers as HeadersInit);
    expect(headers.get('x-site')).toBe('1');
    expect(headers.get('x-call')).toBe('2');
  });
});

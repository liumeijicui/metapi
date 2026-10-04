import { describe, expect, it } from 'vitest';
import { Headers } from 'undici';
import { mergeHeadersWithSiteCustomHeaders } from './siteCustomHeaders.js';

describe('mergeHeadersWithSiteCustomHeaders', () => {
  it('keeps explicit request headers authoritative by default', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'User-Agent': 'site-agent', 'X-Site-Scope': 'internal' }),
      { 'user-agent': 'request-agent' },
    ));

    expect(merged.get('user-agent')).toBe('request-agent');
    expect(merged.get('x-site-scope')).toBe('internal');
  });

  it('lets site custom headers override request headers when site priority is enabled', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'User-Agent': 'site-agent', 'X-Site-Scope': 'internal' }),
      { 'user-agent': 'request-agent', 'X-Trace-Id': 'trace-1' },
      { priority: 'site' },
    ));

    expect(merged.get('user-agent')).toBe('site-agent');
    expect(merged.get('x-site-scope')).toBe('internal');
    expect(merged.get('x-trace-id')).toBe('trace-1');
  });

  it('returns the original request headers when no site custom headers are configured', () => {
    const requestHeaders = { 'X-Trace-Id': 'trace-1' };

    expect(mergeHeadersWithSiteCustomHeaders(null, requestHeaders)).toBe(requestHeaders);
  });
});

describe('cookie header merging', () => {
  it('keeps the shield cookie and the credential cookie together', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ Cookie: 'cf_clearance=shield-pass', 'User-Agent': 'site-agent' }),
      { Cookie: 'new_api_refresh=credential', 'X-Trace-Id': 'trace-1' },
      { priority: 'site' },
    ));

    expect(merged.get('cookie')).toBe('new_api_refresh=credential; cf_clearance=shield-pass');
    expect(merged.get('user-agent')).toBe('site-agent');
  });

  it('lets the higher-priority side win on a duplicate cookie name', () => {
    const merged = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ Cookie: 'cf_clearance=new-pass; theme=dark' }),
      { Cookie: 'cf_clearance=old-pass; session=abc' },
      { priority: 'site' },
    ));

    expect(merged.get('cookie')).toBe('session=abc; cf_clearance=new-pass; theme=dark');
  });

  it('still replaces the cookie header wholesale when only one side has one', () => {
    const requestOnly = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'X-Site-Scope': 'internal' }),
      { Cookie: 'session=abc' },
      { priority: 'site' },
    ));
    expect(requestOnly.get('cookie')).toBe('session=abc');

    const siteOnly = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ Cookie: 'cf_clearance=shield-pass' }),
      { 'X-Trace-Id': 'trace-1' },
      { priority: 'site' },
    ));
    expect(siteOnly.get('cookie')).toBe('cf_clearance=shield-pass');

    const noCookies = new Headers(mergeHeadersWithSiteCustomHeaders(
      JSON.stringify({ 'X-Site-Scope': 'internal' }),
      { 'X-Trace-Id': 'trace-1' },
      { priority: 'site' },
    ));
    expect(noCookies.get('cookie')).toBeNull();
  });
});

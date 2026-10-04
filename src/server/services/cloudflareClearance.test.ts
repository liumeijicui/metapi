import { describe, expect, it } from 'vitest';
import { isCloudflareChallengeResponse } from './cloudflareClearance.js';

describe('isCloudflareChallengeResponse', () => {
  it('recognizes the Cloudflare interstitial', () => {
    expect(isCloudflareChallengeResponse({
      contentType: 'text/html; charset=UTF-8',
      body: '<!DOCTYPE html><html><head><title>Just a moment...</title></head></html>',
    })).toBe(true);
  });

  it('recognizes the challenge by its marker header alone', () => {
    expect(isCloudflareChallengeResponse({ mitigated: 'challenge' })).toBe(true);
    expect(isCloudflareChallengeResponse({
      contentType: 'application/json',
      body: '{"success":true}',
      mitigated: 'challenge',
    })).toBe(true);
  });

  it('leaves a normal JSON answer alone', () => {
    expect(isCloudflareChallengeResponse({
      contentType: 'application/json',
      body: '{"success":false,"message":"Invalid token"}',
    })).toBe(false);
    expect(isCloudflareChallengeResponse({ contentType: 'text/html', body: '<html>hi</html>' })).toBe(false);
    expect(isCloudflareChallengeResponse({})).toBe(false);
  });

  it('does not read a JSON body as a challenge just because it mentions the word', () => {
    expect(isCloudflareChallengeResponse({
      contentType: 'application/json',
      body: '{"message":"challenges.cloudflare.com"}',
    })).toBe(false);
  });
});

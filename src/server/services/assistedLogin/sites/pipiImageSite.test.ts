import { describe, expect, it } from 'vitest';
import { isPipiImageLoginSite, pipiImageHintsFor, pipiImageStorageHints } from './pipiImageSite.js';

describe('pipiImageSite', () => {
  it('claims only the image host', () => {
    expect(isPipiImageLoginSite('https://img.pipiwangcom.com/')).toBe(true);
    expect(isPipiImageLoginSite('img.pipiwangcom.com')).toBe(true);
    expect(isPipiImageLoginSite('https://img.pipiwangcom.com.evil.com/')).toBe(false);
    // 兄弟域名是 new-api 站，走通用 new-api 采集。
    expect(isPipiImageLoginSite('https://ai.pipiwangcom.com')).toBe(false);
  });

  it('declares the three storage keys the site writes and nothing else', () => {
    expect(pipiImageStorageHints()).toEqual({
      tokenKeys: ['pipi_pc_token'],
      userKeys: ['pipi_pc_user'],
      uidKeys: ['pipi_pc_uid'],
    });
  });

  it('only hands the hints to the sites that need them', () => {
    expect(pipiImageHintsFor('https://img.pipiwangcom.com/')).toEqual(pipiImageStorageHints());
    expect(pipiImageHintsFor('https://ai.pipiwangcom.com')).toBeNull();
  });
});

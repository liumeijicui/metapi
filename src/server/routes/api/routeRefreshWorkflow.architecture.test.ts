import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

function expectNoDirectModelServiceRouteRefresh(source: string): void {
  expect(source).not.toMatch(/import\s*\{[^}]*\brefreshModelsAndRebuildRoutes\b[^}]*\}\s*from\s*['"][^'"]*modelService\.js['"]/m);
  expect(source).not.toMatch(/import\s*\{[^}]*\brebuildTokenRoutesFromAvailability\b[^}]*\}\s*from\s*['"][^'"]*modelService\.js['"]/m);
}

function expectImportsRouteRefreshWorkflow(source: string): void {
  expect(source).toMatch(
    /import\s+\*\s+as\s+routeRefreshWorkflow\s+from\s+['"][^'"]*routeRefreshWorkflow\.js['"]/m,
  );
}

function expectCallsSelectProxyChannelForAttempt(source: string): void {
  expect(source).toMatch(/\bselectProxyChannelForAttempt\s*\(/);
}

function expectCallsRebuildRoutesOnly(source: string): void {
  expect(source).toMatch(/\brouteRefreshWorkflow\.rebuildRoutesOnly\s*\(/);
}

describe('route refresh workflow architecture boundaries', () => {
  it('keeps api controllers on the shared route refresh workflow instead of modelService', () => {
    const tokensSource = readSource('./tokens.ts');
    const settingsSource = readSource('./settings.ts');
    const statsSource = readSource('./stats.ts');

    for (const source of [tokensSource, settingsSource, statsSource]) {
      expectImportsRouteRefreshWorkflow(source);
      expectNoDirectModelServiceRouteRefresh(source);
    }

    expectCallsRebuildRoutesOnly(tokensSource);
    expectCallsRebuildRoutesOnly(statsSource);
  });

  it('keeps exact-route pattern sync detection behind the pattern sync service', () => {
    const tokensSource = readSource('./tokens.ts');

    // 老路由（按 model_pattern 生成的路由）已整体退出派发，路由 API 不再做任何
    // pattern 路由/通道同步，只剩读取与重建。
    expect(tokensSource).not.toContain('patternRouteChannelSyncService');
    expect(tokensSource).not.toContain('syncPatternRouteChannelsAfterAffectedRouteChanges');
    expect(tokensSource).not.toContain('rebuildPatternRouteChannelsAfterExactSourceRouteChange');
    expect(tokensSource).not.toContain('rebuildAllPatternRouteChannels');
  });

  it('keeps proxy fallback refreshes and scheduler hooks on the route refresh workflow', () => {
    const completionsSource = readSource('../proxy/completions.ts');
    const embeddingsSource = readSource('../proxy/embeddings.ts');
    const imagesSource = readSource('../proxy/images.ts');
    const modelsRouteSource = readSource('../proxy/models.ts');
    const searchSource = readSource('../proxy/search.ts');
    const videosSource = readSource('../proxy/videos.ts');
    const schedulerSource = readSource('../../services/checkinScheduler.ts');
    const oauthServiceSource = readSource('../../services/oauth/service.ts');
    const sharedSurfaceSource = readSource('../../proxy-core/surfaces/sharedSurface.ts');
    const geminiSurfaceSource = readSource('../../proxy-core/surfaces/geminiSurface.ts');
    const channelSelectionSource = readSource('../../proxy-core/channelSelection.ts');

    for (const source of [schedulerSource, oauthServiceSource]) {
      expectImportsRouteRefreshWorkflow(source);
      expectNoDirectModelServiceRouteRefresh(source);
    }

    // 选路落在老路由上时曾经会「刷新模型并重建路由再试一次」，老路由退出派发后这段
    // 兜底只会拖慢失败请求，已经删掉；channelSelection 不能再依赖 routeRefreshWorkflow。
    expect(channelSelectionSource).not.toContain('routeRefreshWorkflow');
    expectNoDirectModelServiceRouteRefresh(channelSelectionSource);

    for (const source of [
      completionsSource,
      embeddingsSource,
      imagesSource,
      modelsRouteSource,
      searchSource,
      videosSource,
      sharedSurfaceSource,
      geminiSurfaceSource,
    ]) {
      expectNoDirectModelServiceRouteRefresh(source);
    }

    for (const source of [
      completionsSource,
      embeddingsSource,
      imagesSource,
      searchSource,
      videosSource,
      sharedSurfaceSource,
    ]) {
      expectCallsSelectProxyChannelForAttempt(source);
    }

    expect(geminiSurfaceSource).toMatch(/\bselectGeminiChannel\s*\(/);
    expect(geminiSurfaceSource).toMatch(/\bselectNextGeminiProbeChannel\s*\(/);
  });
});

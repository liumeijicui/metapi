import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type DbModule = typeof import('../db/index.js');
type ServiceModule = typeof import('./modelProbeResultService.js');

describe('modelProbeResultService', () => {
  let dataDir = '';
  let db: DbModule['db'];
  let schema: DbModule['schema'];
  let closeDbConnections: DbModule['closeDbConnections'];
  let service: ServiceModule;
  let siteId = 0;

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'metapi-model-probe-'));
    process.env.DATA_DIR = dataDir;

    await import('../db/migrate.js');
    const dbModule = await import('../db/index.js');
    service = await import('./modelProbeResultService.js');
    db = dbModule.db;
    schema = dbModule.schema;
    closeDbConnections = dbModule.closeDbConnections;
  });

  beforeEach(async () => {
    await db.delete(schema.modelProbeResults).run();
    await db.delete(schema.sites).run();
    const site = await db.insert(schema.sites).values({
      name: 'Probe',
      url: 'https://probe.example.com',
      platform: 'new-api',
      status: 'active',
    }).returning().get();
    siteId = site.id;
  });

  afterAll(async () => {
    if (typeof closeDbConnections === 'function') await closeDbConnections();
    delete process.env.DATA_DIR;
    if (dataDir) {
      try {
        rmSync(dataDir, { recursive: true, force: true });
      } catch {}
    }
  });

  it('每个站点+模型只保留最新一条', async () => {
    await service.saveModelProbeResult({
      siteId,
      modelName: 'gpt-6-astra',
      source: 'chat',
      status: 'failed',
      durationMs: 900,
      apiMode: 'responses',
      errorMessage: '上游 500',
      now: new Date('2026-10-27T10:00:00.000Z'),
    });
    await service.saveModelProbeResult({
      siteId,
      modelName: 'gpt-6-astra',
      source: 'batch',
      status: 'success',
      firstByteMs: 1200,
      durationMs: 4300,
      apiMode: 'responses',
      reasoningEffort: 'high',
      answer: '正常',
      now: new Date('2026-10-27T10:05:00.000Z'),
    });

    const rows = await db.select().from(schema.modelProbeResults).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('success');
    expect(rows[0].source).toBe('batch');
    expect(rows[0].firstByteMs).toBe(1200);
    expect(rows[0].answer).toBe('正常');
    expect(rows[0].errorMessage).toBeNull();
    expect(rows[0].createdAt).toBe('2026-10-27T10:05:00.000Z');

    const loaded = await service.getModelProbeResult(siteId, 'gpt-6-astra');
    expect(loaded?.status).toBe('success');
    expect(loaded?.durationMs).toBe(4300);
  });

  it('回答过长时截断，避免把整张表撑大', async () => {
    const longAnswer = 'x'.repeat(service.MODEL_PROBE_ANSWER_MAX_CHARS + 500);
    await service.saveModelProbeResult({
      siteId,
      modelName: 'long-model',
      source: 'test',
      status: 'success',
      answer: longAnswer,
    });
    const loaded = await service.getModelProbeResult(siteId, 'long-model');
    expect(loaded?.answer?.length).toBeLessThan(longAnswer.length);
    expect(loaded?.answer?.endsWith('（已截断）')).toBe(true);
  });

  it('按站点批量读取结果，键是 站点ID:模型名', async () => {
    await service.saveModelProbeResult({
      siteId,
      modelName: 'a',
      source: 'chat',
      status: 'success',
      answer: 'ok',
    });
    await service.saveModelProbeResult({
      siteId,
      modelName: 'b',
      source: 'batch',
      status: 'failed',
      errorMessage: 'bad',
    });

    const map = await service.loadModelProbeResultMap([siteId]);
    expect(map.get(`${siteId}:a`)?.status).toBe('success');
    expect(map.get(`${siteId}:b`)?.errorMessage).toBe('bad');
    expect((await service.loadModelProbeResultMap([])).size).toBe(0);
  });

  it('拒绝非法的来源与状态', async () => {
    await expect(service.saveModelProbeResult({
      siteId,
      modelName: 'x',
      source: 'unknown',
      status: 'success',
    })).rejects.toThrow('来源');
    await expect(service.saveModelProbeResult({
      siteId,
      modelName: 'x',
      source: 'chat',
      status: 'weird',
    })).rejects.toThrow('状态');
  });
});

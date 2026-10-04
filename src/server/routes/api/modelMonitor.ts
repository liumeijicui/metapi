import { FastifyInstance } from 'fastify';
import { startBackgroundTask } from '../../services/backgroundTaskService.js';
import {
  isModelMonitorRunning,
  loadModelMonitorOverview,
  runModelMonitorFetch,
} from '../../services/modelMonitorService.js';

function parseOptionalNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseModelMonitorSort(value: unknown): string {
  const normalized = String(value || '').trim();
  return ['success', 'latency', 'tps', 'site'].includes(normalized) ? normalized : 'success';
}

export async function modelMonitorRoutes(app: FastifyInstance) {
  app.get<{
    Querystring: {
      siteId?: string;
      model?: string;
      minSuccessRate?: string;
      sort?: string;
    };
  }>('/api/model-monitor/overview', async (request) => {
    const siteId = parseOptionalNumber(request.query.siteId);
    return loadModelMonitorOverview({
      siteId: siteId !== null && siteId > 0 ? Math.trunc(siteId) : null,
      model: String(request.query.model || '').trim() || null,
      minSuccessRate: parseOptionalNumber(request.query.minSuccessRate),
      sort: parseModelMonitorSort(request.query.sort),
    });
  });

  app.post('/api/model-monitor/refresh', async () => {
    if (isModelMonitorRunning()) {
      return { success: true, queued: false, running: true };
    }
    const { task, reused } = startBackgroundTask(
      {
        type: 'model-monitor-refresh',
        title: '采集模型监控',
        dedupeKey: 'model-monitor:all',
        notifyOnSuccess: false,
        notifyOnFailure: false,
      },
      () => runModelMonitorFetch(),
    );
    return { success: true, queued: !reused, reused, running: true, taskId: task.id };
  });
}

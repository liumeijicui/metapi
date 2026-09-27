import { FastifyInstance } from 'fastify';
import { assistedLoginRoutes } from './assistedLogin.js';

/**
 * Back-compat entry point. The Linux.do routes were the original implementation
 * of assisted login and are now registered by the generic provider router, which
 * also serves `/api/linuxdo/*` as aliases.
 */
export async function linuxdoRoutes(app: FastifyInstance) {
  await assistedLoginRoutes(app);
}

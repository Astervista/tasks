import { join, resolve } from 'node:path';

/**
 * The server does no authentication: the login service in front of it decides who gets in (see
 * DEPLOY.md), so nothing but the reverse proxy may be able to reach it.
 */
export interface AppConfig {
  dataDir: string;
  /** Built Angular app; not served when missing (e.g. in tests) */
  webDir: string | null;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    dataDir: env['DATA_DIR'] ?? '/data',
    // Absolute: the SPA fallback (sendFile) refuses relative paths
    webDir: resolve(env['WEB_DIR'] ?? join(__dirname, '..', 'web', 'browser')),
  };
}

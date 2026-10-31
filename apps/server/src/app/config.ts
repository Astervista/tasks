import { join, resolve } from 'node:path';

/**
 * token: every request needs the token.
 * proxy: a login service in front of the server guards it, so requests without a token are trusted;
 *        requests that do carry one (CLI, daemon, tray apps) must carry the right one.
 */
export type AuthMode = 'token' | 'proxy';

export interface AppConfig {
  dataDir: string;
  token: string;
  auth: AuthMode;
  /** Built Angular app; not served when missing (e.g. in tests) */
  webDir: string | null;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const token = env['TASKS_TOKEN'] ?? '';
  if (token.length < 16) {
    throw new Error('TASKS_TOKEN must be set to a secret of at least 16 characters (e.g. `openssl rand -hex 32`)');
  }
  const auth = env['AUTH_MODE'] ?? 'token';
  if (auth !== 'token' && auth !== 'proxy') {
    throw new Error('AUTH_MODE must be "token" or "proxy"');
  }
  return {
    dataDir: env['DATA_DIR'] ?? '/data',
    token,
    auth,
    // Absolute: the SPA fallback (sendFile) refuses relative paths
    webDir: resolve(env['WEB_DIR'] ?? join(__dirname, '..', 'web', 'browser')),
  };
}

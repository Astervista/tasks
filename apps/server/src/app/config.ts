import { join, resolve } from 'node:path';

/**
 * The login service in front of the server (see DEPLOY.md) decides who gets in. Who the user is, the
 * server asks that service itself, over the internal network (`authUrl`), with the session cookie the
 * request came with, and whether that user has the `authPermission`: nothing a request says about its
 * user is trusted.
 */
export interface AppConfig {
  dataDir: string;
  /** Built Angular app; not served when missing (e.g. in tests) */
  webDir: string | null;
  /** The login service's permission check, e.g. http://astervista-auth-backend:1000/permission */
  authUrl: string | null;
  /** The permission a user needs on the login service to use tasks (and to have projects here) */
  authPermission: string;
  /**
   * Local testing without the login service: every request is this user. Never set it on a server
   * anyone else can reach
   */
  devUser: string | null;
}

export const APP_CONFIG = Symbol('APP_CONFIG');

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const authUrl = env['AUTH_URL']?.trim() || null;
  const devUser = env['TASKS_DEV_USER']?.trim() || null;
  if (authUrl == null && devUser == null) {
    throw new Error('Set AUTH_URL to the login service\'s permission check (see DEPLOY.md)');
  }
  return {
    dataDir: env['DATA_DIR'] ?? '/data',
    // Absolute: the SPA fallback (sendFile) refuses relative paths
    webDir: resolve(env['WEB_DIR'] ?? join(__dirname, '..', 'web', 'browser')),
    authUrl,
    authPermission: env['AUTH_PERMISSION']?.trim() || 'tasks',
    devUser: authUrl == null ? devUser : null,
  };
}

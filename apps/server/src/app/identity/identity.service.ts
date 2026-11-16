import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from '../config';
import { WorkspaceRepository } from '../storage/workspace.repository';

/** The header the login service names the user in, when a check that needed a login passes */
const USER_ID_HEADER = 'x-auth-user-id';
/** A session's user doesn't change: asking again every few seconds would only slow every request down */
const CACHE_MS = 60_000;
const CACHE_SIZE = 1000;
const TIMEOUT_MS = 5000;

export type Identity =
  | { userId: string; setCookie: string[] }
  | { userId: null; status: 401 | 503; message: string };

/**
 * Who sent a request, as the login service says: it gets the request's session cookie and the permission
 * tasks needs, over the internal network, and names the user if the session has that permission. A
 * request can't claim to be anyone.
 */
@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);
  private readonly cache = new Map<string, { userId: string; expires: number }>();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async identify(request: Request): Promise<Identity> {
    const authUrl = this.config.authUrl;
    if (authUrl == null) {
      return { userId: this.config.devUser!, setCookie: [] };
    }
    const cookie = request.headers.cookie;
    if (cookie == null || cookie === '') {
      return notLoggedIn();
    }
    const domain = (request.headers.host ?? '').replace(/:\d+$/, '');
    // The answer depends on the session and the permission, never on the path: one per session is enough
    const key = `${domain}\n${cookie}`;
    const now = Date.now();
    const cached = this.cache.get(key);
    if (cached != null && cached.expires > now) {
      return { userId: cached.userId, setCookie: [] };
    }
    let response: Response;
    try {
      response = await fetch(authUrl, {
        headers: {
          Cookie: cookie,
          'X-Domain': domain,
          'X-Path': request.originalUrl,
          'X-Scheme': String(request.headers['x-forwarded-proto'] ?? 'https').split(',')[0].trim(),
          'X-Original-Method': request.method,
          'X-Permission': this.config.authPermission,
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.error(`Cannot reach the login service at ${authUrl}: ${(error as Error).message}`);
      return { userId: null, status: 503, message: 'The login service cannot be reached' };
    }
    const userId = response.headers.get(USER_ID_HEADER);
    if (response.status !== 200) {
      this.cache.delete(key);
      return notLoggedIn();
    }
    if (userId == null || !WorkspaceRepository.isOwner(userId)) {
      // An older login service, which ignores X-Permission and names nobody
      this.logger.error(`The login service let a request in without naming a user (${userId ?? 'no X-Auth-User-Id'}): it must be a version that answers X-Permission`);
      return notLoggedIn();
    }
    this.cache.delete(key);
    if (this.cache.size >= CACHE_SIZE) {
      this.cache.delete(this.cache.keys().next().value!);
    }
    this.cache.set(key, { userId, expires: now + CACHE_MS });
    // A renewal the login service decided on now: it's this response's job to hand it to the browser
    return { userId, setCookie: response.headers.getSetCookie() };
  }
}

function notLoggedIn(): Identity {
  return { userId: null, status: 401, message: 'Not logged in, or this account may not use tasks' };
}

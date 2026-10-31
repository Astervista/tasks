import { CanActivate, ExecutionContext, Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { APP_CONFIG, AppConfig } from './config';

/**
 * The shared token goes in `Authorization: Bearer <token>`, or `?token=` for EventSource streams,
 * which cannot send headers. In "proxy" mode a login service in front of the server already decided
 * who gets in, so requests without a token pass; a token that is sent must still be right.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  private readonly expected: Buffer;
  private readonly mode: AppConfig['auth'];

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    this.expected = digest(config.token);
    this.mode = config.auth;
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = request.headers.authorization ?? '';
    const query = request.query['token'];
    const token = header.startsWith('Bearer ') ? header.slice(7) : typeof query === 'string' ? query : '';
    if (token === '' && this.mode === 'proxy') {
      return true;
    }
    if (token === '' || !timingSafeEqual(digest(token), this.expected)) {
      throw new UnauthorizedException('Missing or wrong token');
    }
    return true;
  }
}

function digest(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

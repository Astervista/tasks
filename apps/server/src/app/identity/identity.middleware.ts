import { createParamDecorator, ExecutionContext, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { IdentityService } from './identity.service';

interface IdentifiedRequest extends Request {
  userId?: string;
}

/** Every API request belongs to a user, as the login service says; anything else is refused here */
@Injectable()
export class IdentityMiddleware implements NestMiddleware {
  constructor(private readonly identity: IdentityService) {}

  use(request: IdentifiedRequest, response: Response, next: NextFunction): void {
    this.identity.identify(request).then(
      identity => {
        if (identity.userId == null) {
          response.status(identity.status).json({ statusCode: identity.status, message: identity.message, code: identity.status === 401 ? 'not-logged-in' : 'auth-unavailable' });
          return;
        }
        if (identity.setCookie.length > 0) {
          response.append('Set-Cookie', identity.setCookie);
        }
        request.userId = identity.userId;
        next();
      },
      next,
    );
  }
}

/** The user the request belongs to (set by IdentityMiddleware) */
export const User = createParamDecorator((_data: unknown, context: ExecutionContext): string => {
  const userId = context.switchToHttp().getRequest<IdentifiedRequest>().userId;
  if (userId == null) {
    throw new Error('IdentityMiddleware did not run for this route');
  }
  return userId;
});

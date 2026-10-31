import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { ApiError, CoreError } from '@tasks/core';
import type { Response } from 'express';

const STATUS: Record<CoreError['code'], number> = {
  'not-found': 404,
  invalid: 400,
  'open-descendants': 409,
  conflict: 409,
  'too-deep': 422,
  cycle: 422,
};

/** Turns the domain errors of @tasks/core into HTTP answers, keeping the code for clients */
@Catch(CoreError)
export class CoreErrorFilter implements ExceptionFilter {
  catch(error: CoreError, host: ArgumentsHost): void {
    const statusCode = STATUS[error.code];
    const body: ApiError = { statusCode, message: error.message, code: error.code };
    host.switchToHttp().getResponse<Response>().status(statusCode).json(body);
  }
}

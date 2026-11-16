import { Controller, Get } from '@nestjs/common';

/** For Docker's health check: answers without a login, and says nothing about anyone */
@Controller('health')
export class HealthController {
  @Get()
  health() {
    return { ok: true };
  }
}

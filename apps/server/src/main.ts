import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { configFromEnv } from './app/config';
import { createApp } from './app/create-app';

async function bootstrap() {
  const config = configFromEnv();
  const app = await createApp(config);
  const port = Number(process.env['PORT'] ?? 8080);
  await app.listen(port);
  Logger.log(`Tasks server listening on port ${port}, data in ${config.dataDir}`);
}

bootstrap().catch(error => {
  Logger.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

import { DynamicModule, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ServeStaticModule } from '@nestjs/serve-static';
import { existsSync } from 'node:fs';
import { AuthGuard } from './auth.guard';
import { APP_CONFIG, AppConfig } from './config';
import { CoreErrorFilter } from './core-error.filter';
import { EventsController } from './events/events.controller';
import { EventsService } from './events/events.service';
import { WorkspaceRepository } from './storage/workspace.repository';
import { WorkspacesController } from './workspaces/workspaces.controller';
import { WorkspacesService } from './workspaces/workspaces.service';

@Module({})
export class AppModule {
  static forConfig(config: AppConfig): DynamicModule {
    const web = config.webDir != null && existsSync(config.webDir)
      ? [ServeStaticModule.forRoot({ rootPath: config.webDir, exclude: ['/api/{*path}'] })]
      : [];
    return {
      module: AppModule,
      imports: web,
      controllers: [WorkspacesController, EventsController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_FILTER, useClass: CoreErrorFilter },
        WorkspaceRepository,
        WorkspacesService,
        EventsService,
      ],
    };
  }
}

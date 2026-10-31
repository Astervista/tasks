import { Controller, Get, MessageEvent, Param, Sse } from '@nestjs/common';
import { filter, interval, map, merge, Observable } from 'rxjs';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { EventsService } from './events.service';

/** Keeps proxies from closing idle streams */
const HEARTBEAT = 25_000;

@Controller()
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** Global stream: current task, workspace list and revision changes (tray apps, workspace picker) */
  @Sse('events')
  all(): Observable<MessageEvent> {
    return this.withHeartbeat(this.events.events);
  }

  /** One workspace: revision changes (web app, sync daemon) */
  @Sse('workspaces/:uid/events')
  workspace(@Param('uid') uid: string): Observable<MessageEvent> {
    return this.withHeartbeat(this.events.events.pipe(filter(event => event.type === 'revision' && event.uid === uid)));
  }

  @Get('current')
  current() {
    return this.workspaces.current();
  }

  @Get('todos')
  openTodos() {
    return this.workspaces.openTodos();
  }

  private withHeartbeat(source: Observable<object>): Observable<MessageEvent> {
    return merge(
      source.pipe(map(data => ({ data }) as MessageEvent)),
      interval(HEARTBEAT).pipe(map(() => ({ type: 'ping', data: '' }) as MessageEvent)),
    );
  }
}

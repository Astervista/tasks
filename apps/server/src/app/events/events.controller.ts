import { Controller, Get, Header, MessageEvent, Param, Sse } from '@nestjs/common';
import { filter, interval, map, merge, Observable } from 'rxjs';
import { WorkspacesService } from '../workspaces/workspaces.service';
import { User } from '../identity/identity.middleware';
import { EventsService } from './events.service';

/** Keeps proxies from closing idle streams */
const HEARTBEAT = 25_000;
/** Tells nginx (and proxies that honour it) to pass events on at once instead of buffering them */
const NO_BUFFERING = ['X-Accel-Buffering', 'no'] as const;

@Controller()
export class EventsController {
  constructor(
    private readonly events: EventsService,
    private readonly workspaces: WorkspacesService,
  ) {}

  /** The user's stream: current task, workspace list and revision changes (tray apps, workspace picker) */
  @Sse('events')
  @Header(...NO_BUFFERING)
  all(@User() user: string): Observable<MessageEvent> {
    return this.withHeartbeat(this.events.eventsOf(user));
  }

  /** One workspace: revision changes (web app, sync daemon) */
  @Sse('workspaces/:uid/events')
  @Header(...NO_BUFFERING)
  workspace(@User() user: string, @Param('uid') uid: string): Observable<MessageEvent> {
    return this.withHeartbeat(this.events.eventsOf(user).pipe(filter(event => event.type === 'revision' && event.uid === uid)));
  }

  @Get('current')
  current(@User() user: string) {
    return this.workspaces.current(user);
  }

  @Get('todos')
  openTodos(@User() user: string) {
    return this.workspaces.openTodos(user);
  }

  private withHeartbeat(source: Observable<object>): Observable<MessageEvent> {
    return merge(
      source.pipe(map(data => ({ data }) as MessageEvent)),
      interval(HEARTBEAT).pipe(map(() => ({ type: 'ping', data: '' }) as MessageEvent)),
    );
  }
}

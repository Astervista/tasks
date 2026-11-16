import { Injectable } from '@nestjs/common';
import { ServerEvent } from '@tasks/core';
import { filter, map, Observable, Subject } from 'rxjs';

/** Server events, each for one user: nobody hears about someone else's projects */
@Injectable()
export class EventsService {
  private readonly subject = new Subject<{ owner: string; event: ServerEvent }>();

  eventsOf(owner: string): Observable<ServerEvent> {
    return this.subject.pipe(
      filter(item => item.owner === owner),
      map(item => item.event),
    );
  }

  emit(owner: string, event: ServerEvent): void {
    this.subject.next({ owner, event });
  }
}

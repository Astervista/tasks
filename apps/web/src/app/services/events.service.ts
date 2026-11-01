import { DestroyRef, inject, Injectable, signal } from '@angular/core';
import { API_PREFIX, ServerEvent } from '@tasks/core';
import { Observable, Subject } from 'rxjs';

/** The server's global event stream; EventSource reconnects by itself */
@Injectable({ providedIn: 'root' })
export class EventsService {
  private readonly subject = new Subject<ServerEvent>();
  private readonly source = new EventSource(`/${API_PREFIX}/events`);
  readonly connected = signal(false);

  constructor() {
    this.source.onopen = () => this.connected.set(true);
    this.source.onerror = () => this.connected.set(false);
    this.source.onmessage = message => {
      try {
        this.subject.next(JSON.parse(message.data) as ServerEvent);
      } catch {
        // heartbeat or malformed
      }
    };
    inject(DestroyRef).onDestroy(() => this.source.close());
  }

  get events(): Observable<ServerEvent> {
    return this.subject.asObservable();
  }
}

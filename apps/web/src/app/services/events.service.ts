import { DestroyRef, effect, inject, Injectable, signal } from '@angular/core';
import { API_PREFIX, ServerEvent } from '@tasks/core';
import { Observable, Subject } from 'rxjs';
import { AuthService } from './api.service';

/** The server's global event stream; EventSource reconnects by itself */
@Injectable({ providedIn: 'root' })
export class EventsService {
  private readonly auth = inject(AuthService);
  private readonly subject = new Subject<ServerEvent>();
  private source: EventSource | null = null;
  readonly connected = signal(false);

  constructor() {
    effect(() => {
      const token = this.auth.token();
      const needed = this.auth.needed();
      this.source?.close();
      this.source = null;
      if (!needed) {
        this.open(token);
      }
    });
    inject(DestroyRef).onDestroy(() => this.source?.close());
  }

  get events(): Observable<ServerEvent> {
    return this.subject.asObservable();
  }

  private open(token: string | null): void {
    const query = token == null ? '' : `?token=${encodeURIComponent(token)}`;
    const source = new EventSource(`/${API_PREFIX}/events${query}`);
    source.onopen = () => this.connected.set(true);
    source.onerror = () => this.connected.set(false);
    source.onmessage = message => {
      try {
        this.subject.next(JSON.parse(message.data) as ServerEvent);
      } catch {
        // heartbeat or malformed
      }
    };
    this.source = source;
  }
}

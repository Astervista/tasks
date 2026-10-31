import { Injectable } from '@nestjs/common';
import { ServerEvent } from '@tasks/core';
import { Observable, Subject } from 'rxjs';

@Injectable()
export class EventsService {
  private readonly subject = new Subject<ServerEvent>();

  get events(): Observable<ServerEvent> {
    return this.subject.asObservable();
  }

  emit(event: ServerEvent): void {
    this.subject.next(event);
  }
}

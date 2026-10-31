import { Injectable, signal } from '@angular/core';
import { Todo, TodoFields, TodoId } from '@tasks/core';
import { ConfirmData } from '../dialogs/confirm-dialog';
import { TodoDialogData } from '../dialogs/todo-dialog';

export interface TodoDialogRequest {
  data: TodoDialogData;
  save: (fields: TodoFields, parentId: TodoId | null) => Promise<boolean>;
}

/** Which dialogs are open; the app root renders them */
@Injectable({ providedIn: 'root' })
export class DialogService {
  readonly todo = signal<TodoDialogRequest | null>(null);
  readonly confirm = signal<ConfirmData | null>(null);
  readonly stats = signal(false);
  readonly checkIn = signal<{ todo: Todo; initial: number | null } | null>(null);
  /** Create (no uid) or edit the open project */
  readonly project = signal<{ name: string; description: string; editing: boolean } | null>(null);

  ask(data: ConfirmData): void {
    this.confirm.set(data);
  }
}

import { inject, Injectable } from '@angular/core';
import { childrenOf, getTodo, latestCheckIn, openDescendants, parentReadyAfterCompleting, statusOf, Todo, TodoId } from '@tasks/core';
import { ConfettiService } from './confetti.service';
import { DialogService } from './dialog.service';
import { WorkspaceStore } from './workspace.store';

/** The user flows behind the row buttons: confirmations, follow-up offers and celebrations */
@Injectable({ providedIn: 'root' })
export class TodoActions {
  private readonly store = inject(WorkspaceStore);
  private readonly dialogs = inject(DialogService);
  private readonly confetti = inject(ConfettiService);

  /** Start / Resume / Reopen; asks first when another todo (here or elsewhere) is running */
  run(todo: Todo, verb: 'Start' | 'Resume' | 'Reopen'): void {
    const workspace = this.store.workspace();
    const current = this.store.current();
    const runningHere = workspace?.todos.find(other => other.id !== todo.id && statusOf(other) === 'running');
    const runningElsewhere = current?.running && current.uid !== workspace?.uid ? current : null;
    const start = () => this.store.setStatus(todo.id, 'running');
    if (runningHere == null && runningElsewhere == null) {
      void start();
      return;
    }
    const other = runningHere != null ? `"${runningHere.name}"` : `"${runningElsewhere!.todo.name}" in ${runningElsewhere!.workspace}`;
    const verbIng = { Start: 'Starting', Resume: 'Resuming', Reopen: 'Reopening' }[verb];
    this.dialogs.ask({
      title: 'Another ToDo is running',
      text: `Another ToDo is already running (${other}). ${verbIng} this one will pause the other. Do you want to proceed?`,
      choices: [{ label: verb, color: 'forestgreen', action: start }],
    });
  }

  pause(todo: Todo): void {
    void this.store.setStatus(todo.id, 'paused');
  }

  checkIn(todo: Todo): void {
    this.dialogs.checkIn.set({ todo, initial: latestCheckIn(todo)?.progress ?? null });
  }

  resetTimer(todo: Todo): void {
    void this.store.resetTimer(todo.id);
  }

  async done(todo: Todo): Promise<void> {
    const workspace = this.store.workspace();
    if (workspace == null) return;
    const open = openDescendants(workspace, todo.id);
    if (open.length > 0) {
      this.dialogs.ask({
        title: 'Complete the subtasks too?',
        text: `"${todo.name}" still has ${open.length} open subtask${open.length === 1 ? '' : 's'}. A macrotask is done when all of its subtasks are.`,
        choices: [{ label: 'Complete all', color: 'darkgreen', action: () => this.complete(todo.id, true) }],
      });
      return;
    }
    await this.complete(todo.id, false);
  }

  private async complete(id: TodoId, withDescendants: boolean): Promise<void> {
    const before = this.store.workspace();
    const readyParent = before == null ? null : parentReadyAfterCompleting(before, id);
    if ((await this.store.setStatus(id, 'done', withDescendants)) !== 'ok') return;
    const after = this.store.workspace();
    if (after == null) return;
    if (after.todos.every(todo => todo.completed != null)) {
      this.confetti.burst();
    } else if (readyParent != null) {
      this.dialogs.ask({
        title: 'All subtasks done!',
        text: `Every subtask of "${readyParent.name}" is done. Complete "${readyParent.name}" too?`,
        choices: [{ label: 'Complete', color: 'darkgreen', action: () => this.complete(readyParent.id, false) }],
        cancelLabel: 'Not yet',
      });
    } else if (childrenOf(after, id).length > 0) {
      // A whole macrotask done deserves a party too
      this.confetti.burst();
    }
  }

  delete(todo: Todo): void {
    const workspace = this.store.workspace();
    if (workspace == null) return;
    const children = childrenOf(workspace, todo.id).length;
    this.dialogs.ask(children === 0
      ? {
          title: 'Delete ToDo?',
          text: 'Are you sure to delete the ToDo? This action cannot be undone!',
          choices: [{ label: 'Delete', color: 'crimson', action: () => this.store.delete(todo.id, 'subtree') }],
        }
      : {
          title: 'Delete macrotask?',
          text: `"${todo.name}" has ${children} subtask${children === 1 ? '' : 's'}. Delete them too, or keep them in its place? This action cannot be undone!`,
          choices: [
            { label: 'Delete all', color: 'crimson', action: () => this.store.delete(todo.id, 'subtree') },
            { label: 'Keep subtasks', color: '#FF3300', action: () => this.store.delete(todo.id, 'promote') },
          ],
        });
  }

  add(parentId: TodoId | null = null): void {
    this.dialogs.todo.set({
      data: { id: null, name: '', weight: 1, desc: '', estimate: null, parentId },
      save: (fields, parent) => this.store.add(fields, parent),
    });
  }

  edit(todo: Todo): void {
    this.dialogs.todo.set({
      data: { id: todo.id, name: todo.name, weight: todo.weight, desc: todo.desc, estimate: todo.estimate, parentId: todo.parentId },
      save: (fields, parentId) => this.store.edit(todo.id, parentId === todo.parentId ? fields : { ...fields, parentId }),
    });
  }

  /** Moves a todo; returns false when the move is not allowed (cycle or too deep) */
  async move(id: TodoId, parentId: TodoId | null, index: number): Promise<boolean> {
    const workspace = this.store.workspace();
    if (workspace == null) return false;
    getTodo(workspace, id);
    return this.store.move(id, parentId, index);
  }
}

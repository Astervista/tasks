import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { descendantsOf, formatMinutes, formatMoment, ownMinutes, Status, statusOf, Todo } from '@tasks/core';
import { ClockService } from '../services/clock.service';
import { WorkspaceStore } from '../services/workspace.store';
import { Modal } from '../ui/modal';

interface ArchivedItem {
  todo: Todo;
  subtasks: number;
  minutes: number;
  /** "Done 12 Nov" or the status it was archived in */
  state: string;
  /** The task list's status icon */
  icon: { name: string; color: string };
}

const ICONS: Record<Status, { name: string; color: string }> = {
  done: { name: 'done', color: 'green-text' },
  running: { name: 'play_arrow', color: 'lime-text' },
  paused: { name: 'pause', color: 'amber-text' },
  new: { name: 'stop', color: 'red-text' },
};

/** What TODO.archive.md holds: archived ToDos with their subtasks, newest first, each one restorable */
@Component({
  selector: 't-archive-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal],
  template: `
    <t-modal #modal (closed)="done()()">
      <div class="modal-content">
        <h4 class="no-select">Archive</h4>
        <p class="archive-note">
          Done ToDos move here {{ afterText() }}, and anything that isn't running can be archived from its row.
          Restoring brings a ToDo back with its subtasks, open again.
        </p>
        @for (item of items(); track item.todo.id) {
          <div class="archive-line">
            <span class="material-icons" [class]="item.icon.color">{{ item.icon.name }}</span>
            <span class="archive-name">
              <span class="archive-title">{{ item.todo.name }}</span>
              <span class="archive-meta">
                {{ item.state }} · {{ minutes(item.minutes) }}@if (item.subtasks > 0) { · {{ item.subtasks }} subtask{{ item.subtasks === 1 ? '' : 's' }}}
              </span>
            </span>
            <span class="button button-restore white-text" [class.disabled]="busy()" (click)="restore(item.todo)">Restore</span>
          </div>
        } @empty {
          <p class="archive-empty">The archive is empty.</p>
        }
      </div>
      <div class="modal-footer">
        <a class="modal-close button white-text" (click)="modal.close()">Close</a>
      </div>
    </t-modal>
  `,
})
export class ArchiveDialog {
  readonly done = input.required<() => void>();
  private readonly store = inject(WorkspaceStore);
  private readonly clock = inject(ClockService);
  protected readonly busy = signal(false);

  protected readonly afterText = computed(() => {
    const days = this.store.workspace()?.archiveAfterDays ?? 7;
    return days === 0 ? 'as soon as they are done' : `${days} day${days === 1 ? '' : 's'} after completion`;
  });

  protected readonly items = computed<ArchivedItem[]>(() => {
    const document = this.store.document();
    if (document == null) return [];
    const { archive, workspace } = document;
    const now = this.clock.now();
    const items = archive.todos
      .filter(todo => todo.parentId == null)
      .map(todo => {
        const subtree = [todo, ...descendantsOf(archive, todo.id)];
        const status = statusOf(todo);
        return {
          todo,
          subtasks: subtree.length - 1,
          minutes: subtree.reduce((sum, item) => sum + ownMinutes(item, now), 0),
          state: status === 'done' ? `Done ${formatMoment(todo.completed!, workspace.timezone, now)}` : status === 'new' ? 'Not started' : 'Paused',
          icon: ICONS[status],
        };
      });
    // Most recent first: completion, else last change
    const at = (item: ArchivedItem) => item.todo.completed ?? item.todo.updated ?? item.todo.created;
    return items.sort((a, b) => at(b) - at(a));
  });

  protected minutes(value: number): string {
    return value > 0 ? formatMinutes(value) : 'no time';
  }

  protected async restore(todo: Todo): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    await this.store.restore(todo.id);
    this.busy.set(false);
  }
}

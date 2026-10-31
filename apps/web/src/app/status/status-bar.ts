import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { ancestorsOf, formatMinutes, openSession, ownMinutes, Status, statusOf } from '@tasks/core';
import { ClockService } from '../services/clock.service';
import { DialogService } from '../services/dialog.service';
import { TodoActions } from '../services/todo-actions.service';
import { WorkspaceStore } from '../services/workspace.store';

/** The original status bar: totals, the add button, and the running ToDo with live timers */
@Component({
  selector: 't-status-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div id="status-bar">
      <span id="status-left-ext">
        <span class="material-icons status-stats" title="Statistics" (click)="dialogs.stats.set(true)">bar_chart</span>
        <span style="margin-left: 5px">{{ total() }}</span>
        <span style="margin-left: 5px; color: #AAA">total todos</span>
      </span>
      <span id="status-left-int">
        @for (chip of chips(); track chip.icon) {
          <span style="display: flex; align-items: center" [title]="chip.title">
            <span class="material-icons" [class]="chip.color" style="margin-left: 20px">{{ chip.icon }}</span>
            <span class="status-bar-number-span" style="margin-left: 6px">{{ chip.count }}</span>
          </span>
        }
      </span>
      <span id="status-add" style="background-color: #8b65fd" class="button" (click)="actions.add()">Add TODO</span>
      @if (running(); as current) {
        <span id="status-right-int">
          <span class="material-icons lime-text" title="Running now">play_arrow</span>
          <!-- The path shrinks (ellipsis) before the name does; the full path is in the tooltip -->
          <span class="status-current" [class.status-elsewhere]="current.elsewhere"
                [title]="(current.elsewhere ? 'Open ' + current.workspace + ': ' : '') + current.label"
                (click)="current.elsewhere && openWorkspace.emit(current.uid)">
            @if (current.path) {<span class="status-path">{{ current.path }} ›&nbsp;</span>}
            <span class="status-name">{{ current.name }}</span>
          </span>
        </span>
        <span id="status-right-ext">
          <span class="material-icons" style="color: #AAA" title="This session · all the time on this todo">timer</span>
          <span style="margin-left: 5px" class="status-bar-timer-a" title="This session">{{ current.session }}</span>
          <span style="margin-left: 5px; color: #AAA" class="status-bar-timer-b" title="All the time on this todo">· {{ current.total }}</span>
        </span>
      } @else {
        <span id="status-right-int">
          <span style="margin-left: 5px; color: #AAA">No todo is currently running</span>
        </span>
        <span id="status-right-ext">
          <span style="margin-left: 5px; color: #AAA">Total running time:</span>
          <span style="margin-left: 5px" class="status-bar-timer-c">{{ totalTime() }}</span>
        </span>
      }
    </div>
  `,
})
export class StatusBar {
  private readonly store = inject(WorkspaceStore);
  private readonly clock = inject(ClockService);
  protected readonly dialogs = inject(DialogService);
  protected readonly actions = inject(TodoActions);
  readonly openWorkspace = output<string>();

  protected readonly total = computed(() => this.store.workspace()?.todos.length ?? 0);

  protected readonly chips = computed(() => {
    const counts: Record<Status, number> = { new: 0, paused: 0, running: 0, done: 0 };
    for (const todo of this.store.workspace()?.todos ?? []) {
      counts[statusOf(todo)]++;
    }
    return [
      { icon: 'done', color: 'green-text', count: counts.done, title: 'Done' },
      { icon: 'play_arrow', color: 'lime-text', count: counts.running, title: 'Running' },
      { icon: 'pause', color: 'amber-text', count: counts.paused, title: 'Paused' },
      { icon: 'stop', color: 'red-text', count: counts.new, title: 'Not started' },
    ];
  });

  /** The running ToDo, wherever it is: one runs at a time across all workspaces */
  protected readonly running = computed(() => {
    const now = this.clock.now();
    const workspace = this.store.workspace();
    const current = this.store.current();
    // Prefer the open workspace's own data: it is the freshest after an action
    const local = workspace?.todos.find(todo => openSession(todo) != null);
    const todo = local ?? (current?.running ? current.todo : null);
    if (todo == null) return null;
    const session = openSession(todo);
    if (session == null) return null;
    const elsewhere = local == null && current != null && current.uid !== workspace?.uid;
    const path = local == null ? (current?.path ?? []) : ancestorsOf(workspace!, local.id).reverse().map(item => item.name);
    return {
      uid: current?.uid ?? '',
      workspace: current?.workspace ?? '',
      elsewhere,
      label: [...(elsewhere ? [current!.workspace] : []), ...path, todo.name].join(' › '),
      path: [...(elsewhere ? [current!.workspace] : []), ...path].join(' › '),
      name: todo.name,
      session: clock(Math.max(0, now - session.start) / 60000),
      total: clock(ownMinutes(todo, now)),
    };
  });

  protected readonly totalTime = computed(() => {
    const now = this.clock.now();
    const minutes = (this.store.workspace()?.todos ?? []).reduce((sum, todo) => sum + ownMinutes(todo, now), 0);
    return formatMinutes(minutes);
  });
}

/** "0:04:09", "12:30:00": fixed-width digits, so the bar does not jump every second */
function clock(minutes: number): string {
  const seconds = Math.floor(minutes * 60);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${Math.floor(seconds / 3600)}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
}

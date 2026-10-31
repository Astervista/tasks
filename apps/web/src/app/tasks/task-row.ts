import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, input, output } from '@angular/core';
import { descendantsOf, formatMinutes, formatMoment, MAX_DEPTH, openSession, Status, statusOf, TodoEta, TreeEta } from '@tasks/core';
import { ClockService } from '../services/clock.service';
import { TodoActions } from '../services/todo-actions.service';
import { WorkspaceStore } from '../services/workspace.store';
import type { RowModel } from './task-list';
import { TimelineAxis, TimelineLane } from './timeline-lane';
import { LaidFlag, LaidItem } from './timeline-scale';

/** The sub-level palette of the address bar chips, reused for nesting depth */
export const LEVEL_COLORS = ['#ff2222', 'orangered', 'orange', 'teal', 'royalblue', '#c4f', 'deeppink'];

@Component({
  selector: 't-task-row',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [NgTemplateOutlet, TimelineLane],
  host: { class: 'task-group', '[class.dragging]': 'dragging()', '[class.selected]': 'expanded()' },
  template: `
    @let todo = row().todo;
    @if (guide(); as bar) {
      <span class="tree-guide" [style.left.px]="barLeft(bar.depth)" [style.background]="bar.color"></span>
    }
    <!-- A macrotask and its implicit leaf form one block, under one bar -->
    <div class="task-block" [class.macro]="row().hasChildren">
      @if (row().hasChildren && !row().collapsed) {
        <span class="block-bar" [style.left.px]="barLeft(row().depth)" [style.background]="color()"></span>
      }
      <div class="task-line" draggable="true"
           [class.drop-before]="dropZone() === 'before'" [class.drop-inside]="dropZone() === 'inside'" [class.drop-after]="dropZone() === 'after'"
           (click)="toggleDetails.emit()"
           (dragstart)="startDrag($event)" (dragend)="dragEnd.emit()"
           (dragover)="dragOver.emit($event)" (drop)="dropped.emit($event)">
        <span class="task-line-name">
          <span class="tree-indent" [style.width.px]="(row().depth - 1) * 22"></span>
          <span class="tree-bar" [style.background]="row().hasChildren && !row().collapsed ? 'transparent' : color()"></span>
          @if (row().hasChildren) {
            <span class="material-icons tree-toggle" [class.collapsed]="row().collapsed"
                  [title]="row().collapsed ? 'Show subtasks' : 'Hide subtasks'"
                  (click)="$event.stopPropagation(); toggleCollapse.emit()">expand_more</span>
          } @else {
            <span class="tree-spacer"></span>
          }
          <span class="task-title">{{ todo.name }}</span>
        </span>
        @if (axis(); as shared) {
          <t-timeline-lane [items]="lane() ?? []" [flags]="flags()" [axis]="shared" [open]="todo.completed == null" />
        } @else {
          <ng-container *ngTemplateOutlet="cells; context: { $implicit: header() }" />
        }
      </div>
      @if (row().hasChildren && !row().collapsed) {
        <!-- The implicit leaf: the work on the macrotask itself, with the macrotask's own data -->
        <div class="task-line implicit-leaf" title="The macrotask itself: its own weight, time and estimate">
          <span class="task-line-name">
            <span class="tree-indent" [style.width.px]="(row().depth - 1) * 22"></span>
            <span class="tree-bar" style="background: transparent"></span>
            <span class="tree-spacer"></span>
            <span class="material-icons implicit-sign">more_horiz</span>
          </span>
          @if (axis(); as shared) {
            <t-timeline-lane [items]="ownLane() ?? []" [flags]="ownFlags()" [axis]="shared" [open]="todo.completed == null" />
          } @else {
            <ng-container *ngTemplateOutlet="cells; context: { $implicit: implicit() }" />
          }
        </div>
      }
    </div>
    @if (expanded()) {
      <div class="task-line-details" [style.padding-left.px]="barLeft(row().depth) + 20">
        <div class="task-dates">
          @for (item of dates(); track item.label) {
            <span><span class="task-dates-label">{{ item.label }}</span> {{ item.value }}</span>
          }
        </div>
        @if (etaText(); as text) {<div class="task-eta">{{ text }}</div>}
        @if (todo.desc) {<div class="task-desc">{{ todo.desc }}</div>}
      </div>
      <!-- Order: timer, progress, completion, structure, editing, destructive -->
      <div class="task-line-buttons" [style.padding-left.px]="barLeft(row().depth) + 10">
        @if (todo.completed == null) {
          @if (session() == null) {
            <span class="task-line-button button button-play" (click)="actions.run(todo, todo.time.length === 0 ? 'Start' : 'Resume')">
              {{ todo.time.length === 0 ? 'Start' : 'Resume' }}
            </span>
          } @else {
            <span class="task-line-button button button-pause" (click)="actions.pause(todo)">Pause</span>
          }
          <span class="task-line-button button button-checkin" (click)="actions.checkIn(todo)">Check in</span>
          <span class="task-line-button button button-done" (click)="actions.done(todo)">Done</span>
        } @else {
          <span class="task-line-button button button-restart" (click)="actions.run(todo, 'Reopen')">Reopen</span>
        }
        @if (row().depth < maxDepth) {
          <span class="task-line-button button button-subtask" (click)="actions.add(todo.id)">Add subtask</span>
        }
        <span class="task-line-button button button-edit" (click)="actions.edit(todo)">Edit</span>
        @if (session() != null) {
          <span class="task-line-button button button-reset" (click)="actions.resetTimer(todo)">Reset timer</span>
        }
        <span class="task-line-button button button-delete" (click)="actions.delete(todo)">Delete</span>
      </div>
    }
    <ng-template #cells let-cell>
      <span class="task-line-weight" [title]="cell.weightTitle">
        <span class="task-line-weight-back">{{ cell.weightText }}</span>
        <span class="task-line-weight-progress" [style.width]="cell.weightWidth" [style.background]="cell.weightBackground">{{ cell.weightText }}</span>
      </span>
      <span class="task-line-counter" [title]="cell.progressTitle">
        @if (cell.minutes > 0) {
          <span>{{ minutes(cell.minutes) }}</span>
        } @else {
          <span class="material-icons red-text">close</span>
        }
        @if (cell.progress != null) {
          <span class="task-progress"><span class="task-progress-fill" [style.width.%]="cell.progress * 100" [style.background]="cell.progressColor"></span></span>
        }
      </span>
      @switch (cell.status) {
        @case ('done') { <span class="task-line-status material-icons green-text" title="Done">done</span> }
        @case ('running') { <span class="task-line-status material-icons lime-text text-lighten-1" title="Running">play_arrow</span> }
        @case ('paused') { <span class="task-line-status material-icons amber-text" title="Paused">pause</span> }
        @default { <span class="task-line-status material-icons red-text" title="Not started">stop</span> }
      }
    </ng-template>
  `,
})
export class TaskRow {
  protected readonly actions = inject(TodoActions);
  private readonly store = inject(WorkspaceStore);
  private readonly clock = inject(ClockService);

  readonly row = input.required<RowModel>();
  /** ETA of this todo (`own` is the implicit leaf's for macrotasks) */
  readonly eta = input<(TreeEta & { own: TodoEta }) | undefined>(undefined);
  readonly maxWeight = input.required<number>();
  readonly expanded = input(false);
  readonly dragging = input(false);
  readonly dropZone = input<'before' | 'inside' | 'after' | null>(null);
  /** Timeline mode: the shared axis (null = the table's columns) and this row's laid-out lanes */
  readonly axis = input<TimelineAxis | null>(null);
  readonly lane = input<LaidItem[] | null>(null);
  /** A macrotask's implicit leaf */
  readonly ownLane = input<LaidItem[] | null>(null);
  readonly flags = input<LaidFlag[]>([]);
  readonly ownFlags = input<LaidFlag[]>([]);
  readonly toggleDetails = output<void>();
  readonly toggleCollapse = output<void>();
  readonly dragStart = output<void>();
  readonly dragEnd = output<void>();
  readonly dragOver = output<DragEvent>();
  readonly dropped = output<DragEvent>();

  protected readonly maxDepth = MAX_DEPTH;
  protected readonly session = computed(() => openSession(this.row().todo));
  protected readonly color = computed(() => LEVEL_COLORS[(this.row().depth - 1) % LEVEL_COLORS.length]);

  /** The selected ancestor's bar, or this row's own while it is selected */
  protected readonly guide = computed(() =>
    this.row().guide ?? (this.expanded() ? { depth: this.row().depth, color: this.color() } : null));

  protected barLeft(depth: number): number {
    return 15 + (depth - 1) * 22;
  }

  /**
   * The row's columns. A macrotask's are cumulative over its subtree (its own data included), with
   * the weight bar split between the macrotask itself and its subtasks; a leaf's are its own.
   */
  protected readonly header = computed<Cells>(() => {
    const { todo, rollup, hasChildren, status } = this.row();
    const eta = this.eta();
    if (!hasChildren) return this.ownCells();
    const ownShare = rollup.weight === 0 ? 0 : (todo.weight / rollup.weight) * 100;
    return {
      status,
      weightText: format(rollup.weight),
      weightWidth: percent(rollup.weight / this.maxWeight()),
      weightBackground: `linear-gradient(to right, ${OWN_COLOR} 0 ${ownShare}%, ${SUBTASKS_COLOR} ${ownShare}% 100%)`,
      weightTitle: `Weight ${format(rollup.weight)}: ${format(todo.weight)} itself + ${format(rollup.weight - todo.weight)} in subtasks`,
      minutes: rollup.totalMinutes,
      ...progressOf(todo.completed != null ? 1 : eta?.progress ?? null, false, eta == null ? '' : `${formatMinutes(eta.remaining)} left${eta.unknown > 0 ? `, ${eta.unknown} unguessed` : ''}`),
    };
  });

  /** The implicit leaf of a macrotask: its own data only */
  protected readonly implicit = computed(() => this.ownCells());

  private ownCells(): Cells {
    const { todo, rollup, hasChildren } = this.row();
    const own = this.eta()?.own;
    const progress = todo.completed != null ? 1 : own?.total == null ? null : own.total === 0 ? (own.spent > 0 ? 1 : 0) : Math.min(1, own.spent / own.total);
    return {
      status: statusOf(todo),
      weightText: format(todo.weight),
      weightWidth: percent(todo.weight / this.maxWeight()),
      weightBackground: hasChildren ? OWN_COLOR : null,
      weightTitle: 'Weight',
      minutes: rollup.ownMinutes,
      ...progressOf(progress, own?.over ?? false, own?.total == null ? 'No guess yet' : `${formatMinutes(own.spent)} of ${formatMinutes(own.total)}`),
    };
  }

  /** Created / running since / completed, for the details panel */
  protected readonly dates = computed(() => {
    const { todo, hasChildren } = this.row();
    const workspace = this.store.workspace();
    const subtree = hasChildren && workspace != null ? [todo, ...descendantsOf(workspace, todo.id)] : [todo];
    const running = subtree.map(item => openSession(item)?.start).find(start => start != null);
    const items = [{ label: 'Created', value: this.date(todo.created) }];
    if (running != null) items.push({ label: 'Running since', value: this.date(running) });
    if (todo.completed != null) items.push({ label: 'Completed', value: this.date(todo.completed) });
    return items;
  });

  /** "≈ 1 h left · 1 h 20 min of 2 h 20 min (weight 3)" */
  protected readonly etaText = computed(() => {
    const eta = this.eta();
    const { todo, hasChildren } = this.row();
    if (eta == null || todo.completed != null) return '';
    const own = this.ownEtaText(eta.own);
    if (!hasChildren) return own;
    const unknown = eta.unknown > 0 ? ` (+ ${eta.unknown} unguessed)` : '';
    return `≈ ${formatMinutes(eta.remaining)} left${unknown} · own: ${own}`;
  });

  private ownEtaText(own: TodoEta): string {
    if (own.total == null) return 'no guess yet (add an estimate)';
    const source = own.source === 'check-in' ? `check-in ${Math.round((own.progress ?? 0) * 100)}%`
      : own.source === 'weight' ? `weight ${format(this.row().todo.weight)}` : 'estimate';
    const left = own.over ? `over by ${formatMinutes(own.spent - own.total)}` : `≈ ${formatMinutes(own.remaining ?? 0)} left`;
    return `${left} of ${formatMinutes(own.total)} (${source})`;
  }

  protected date(moment: number): string {
    return formatMoment(moment, this.store.workspace()?.timezone ?? 'UTC', this.clock.now());
  }

  protected minutes(value: number): string {
    return formatMinutes(value);
  }

  protected startDrag(event: DragEvent): void {
    event.dataTransfer?.setData('text/plain', String(this.row().todo.id));
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
    this.dragStart.emit();
  }
}

/** Weight bar colors: the macrotask itself vs its subtasks */
export const OWN_COLOR = '#f2b134';
const SUBTASKS_COLOR = 'indianred';

interface Cells {
  status: Status;
  weightText: string;
  weightWidth: string;
  weightBackground: string | null;
  weightTitle: string;
  minutes: number;
  /** Share of the forecast already spent, 0 … 1; null when there is no forecast */
  progress: number | null;
  progressColor: string;
  progressTitle: string;
}

function progressOf(progress: number | null, over: boolean, detail: string): Pick<Cells, 'progress' | 'progressColor' | 'progressTitle'> {
  return {
    progress,
    progressColor: over ? 'crimson' : progress === 1 ? '#4caf50' : 'gold',
    progressTitle: progress == null ? detail : `${over ? 'Over the forecast' : `${Math.round(progress * 100)}% of the forecast`} · ${detail}`,
  };
}

function percent(ratio: number): string {
  return `${(ratio * 100).toFixed(4)}%`;
}

function format(value: number): string {
  return String(Number(value.toFixed(2)));
}

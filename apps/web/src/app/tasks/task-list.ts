import { afterRenderEffect, ChangeDetectionStrategy, Component, computed, effect, ElementRef, HostListener, inject, signal, viewChild } from '@angular/core';
import {
  canMoveTo,
  childrenOf,
  compareMoments,
  depthOf,
  etas,
  openSession,
  Rollup,
  rollups,
  Status,
  STATUS_ORDER,
  subtreeStatus,
  Todo,
  TodoId,
  todoTimeline,
  CheckIn,
  descendantsOf,
} from '@tasks/core';
import { ClockService } from '../services/clock.service';
import { TodoActions } from '../services/todo-actions.service';
import { WorkspaceStore } from '../services/workspace.store';
import { ViewService } from '../services/view.service';
import { Clown } from '../ui/clown';
import { ZoomDial } from '../ui/zoom-dial';
import { LEVEL_COLORS, TaskRow } from './task-row';
import { TimelineAxis, TimelineLane } from './timeline-lane';
import { buildScale, LaidFlag, layoutFlags, layoutRow, LEGEND, LEGEND_DAY_TOTAL, rowItems, RowItem, ticksOf } from './timeline-scale';

export interface RowModel {
  todo: Todo;
  depth: number;
  hasChildren: boolean;
  collapsed: boolean;
  rollup: Rollup;
  status: Status;
  /** The bar of the selected ancestor, drawn next to this row while that ancestor is selected */
  guide: { depth: number; color: string } | null;
}

type Column = 'name' | 'creation' | 'running' | 'completion' | 'weight' | 'counter' | 'status';
interface Sort {
  column: Column;
  direction: 1 | -1;
}

const SORT_KEY = 'tasks-sort';
/** The dates live in the details panel; sorting by them stays possible (creation is the default) */
const COLUMNS: { column: Column; title: string }[] = [
  { column: 'name', title: 'Title' },
  { column: 'weight', title: 'Weight' },
  { column: 'counter', title: 'Time spent' },
  { column: 'status', title: 'Status' },
];

type DropZone = 'before' | 'inside' | 'after';

/** The original header + task lines, now as a tree (sorting applies among siblings) */
@Component({
  selector: 't-task-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [TaskRow, TimelineLane, ZoomDial, Clown],
  template: `
    <div id="header" class="task-line header" [class.timeline-mode]="view.mode() === 'timeline'">
      @for (item of view.mode() === 'timeline' ? columns.slice(0, 1) : columns; track item.column) {
        <span [class]="'task-line-' + item.column" [class.sort-asc]="sort().column === item.column && sort().direction === 1"
              [class.sort-desc]="sort().column === item.column && sort().direction === -1"
              (click)="toggleSort(item.column)">{{ item.title }}</span>
      }
      @if (view.mode() === 'timeline') {
        <span class="timeline-head">
          <span class="timeline-ranges">
            <span class="suggestion-separator">Zoom</span>
            <t-zoom-dial [value]="view.zoom()" (changed)="setZoom($event)" />
            <span class="material-icons timeline-info" [class.open]="legendOpen()" title="Legend"
                  (click)="$event.stopPropagation(); legendOpen.set(!legendOpen())">info_outline</span>
            @if (legendOpen()) {
              <div class="timeline-legend-pop" (click)="$event.stopPropagation()">
                @for (item of legend(); track item.label) {
                  <span class="item">
                    <t-timeline-lane class="legend-lane" [items]="item.items" [axis]="legendAxis" [open]="false" />{{ item.label }}
                  </span>
                }
                <span class="item">
                  <t-timeline-lane class="legend-lane" [items]="[]" [flags]="legendFlag" [axis]="legendAxis" [open]="false" />Check-in
                </span>
              </div>
            }
          </span>
          <span #viewport class="timeline-ticks">
            <span class="lane-inner" [style.width.px]="axis()?.width ?? 0" [style.transform]="'translateX(' + -(axis()?.scroll ?? 0) + 'px)'">
              @for (tick of axis()?.ticks ?? []; track tick.at) {
                <span class="timeline-tick" [style.left.px]="tick.x">{{ tick.label }}</span>
              }
            </span>
          </span>
          <span #scroller class="timeline-scroller" (scroll)="scrolled(scroller)">
            <span [style.width.px]="axis()?.width ?? 0"></span>
          </span>
        </span>
      }
    </div>
    <!-- Fill of day-total beads -->
    <svg width="0" height="0" style="position: absolute" aria-hidden="true">
      <defs>
        <pattern id="bead-stripes" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="4" height="8" fill="#fff7b3" />
        </pattern>
      </defs>
    </svg>
    <div id="tasks" tClown [class.timeline-mode]="view.mode() === 'timeline'" (wheel)="wheel($event)"
         (pointerdown)="touchStart($event)" (pointermove)="touchMove($event)" (pointerup)="touch = null" (pointercancel)="touch = null">
      @for (row of rows(); track row.todo.id) {
        <t-task-row [row]="row" [maxWeight]="maxWeight()" [axis]="axis()" [lane]="lanes()?.get(row.todo.id + '') ?? null"
                    [ownLane]="lanes()?.get(row.todo.id + ':own') ?? null"
                    [flags]="flags()?.get(row.todo.id + '') ?? []" [ownFlags]="flags()?.get(row.todo.id + ':own') ?? []" [expanded]="expanded() === row.todo.id" [eta]="etaMap().get(row.todo.id)"
                    [dragging]="dragId() === row.todo.id"
                    [dropZone]="drop()?.id === row.todo.id ? drop()!.zone : null"
                    (toggleDetails)="toggleDetails(row.todo.id)" (toggleCollapse)="toggleCollapse(row.todo.id)"
                    (dragStart)="dragId.set(row.todo.id)" (dragEnd)="endDrag()"
                    (dragOver)="dragOver(row, $event)" (dropped)="dropOn(row, $event)" />
      }
    </div>
  `,
})
export class TaskList {
  private readonly store = inject(WorkspaceStore);
  private readonly clock = inject(ClockService);
  private readonly actions = inject(TodoActions);
  protected readonly view = inject(ViewService);
  /** One bead (or line) per kind, drawn by the lane itself */
  protected readonly legend = computed(() => {
    const lanes = this.lanes();
    const dayTotals = lanes != null && [...lanes.values()].some(list => list.some(item => item.approximate));
    return dayTotals ? [...LEGEND, LEGEND_DAY_TOTAL] : LEGEND;
  });
  protected readonly legendAxis: TimelineAxis = { width: 56, scroll: 0, ticks: [] };
  protected readonly legendFlag: LaidFlag[] = [{ x: 26, at: 0, progress: 0.5, note: '' }];

  protected readonly columns = COLUMNS;
  protected readonly sort = signal<Sort>(readSort());
  protected readonly expanded = signal<TodoId | null>(null);
  protected readonly collapsed = signal<Set<TodoId>>(new Set());
  protected readonly dragId = signal<TodoId | null>(null);
  protected readonly drop = signal<{ id: TodoId; zone: DropZone } | null>(null);

  private readonly rollupMap = computed(() => {
    const workspace = this.store.workspace();
    return workspace == null ? new Map<TodoId, Rollup>() : rollups(workspace, this.clock.now());
  });

  protected readonly rows = computed<RowModel[]>(() => {
    const workspace = this.store.workspace();
    if (workspace == null) return [];
    const rollup = this.rollupMap();
    const collapsed = this.collapsed();
    const compare = this.comparator();
    const selected = this.expanded();
    const selectedDepth = selected == null || !workspace.todos.some(todo => todo.id === selected) ? null : depthOf(workspace, selected);
    const result: RowModel[] = [];
    const visit = (parentId: TodoId | null, depth: number, guide: RowModel['guide']) => {
      const children = childrenOf(workspace, parentId)
        .map(todo => ({ todo, rollup: rollup.get(todo.id)!, status: subtreeStatus(workspace, todo.id) }))
        .sort(compare);
      for (const child of children) {
        const hasChildren = childrenOf(workspace, child.todo.id).length > 0;
        const isCollapsed = hasChildren && collapsed.has(child.todo.id);
        result.push({ ...child, depth, hasChildren, collapsed: isCollapsed, guide });
        if (hasChildren && !isCollapsed) {
          const own = child.todo.id === selected && selectedDepth != null ? { depth: selectedDepth, color: levelColor(selectedDepth) } : guide;
          visit(child.todo.id, depth + 1, own);
        }
      }
    };
    visit(null, 1, null);
    return result;
  });

  private readonly etaMap = computed(() => {
    const document = this.store.document();
    const minute = Math.floor(this.clock.now() / 60000) * 60000;
    return document == null ? new Map() : etas(document.workspace, minute, document.archive.todos, document.velocity);
  });

  // Timeline: one stretched axis shared by all visible rows (and implicit leaves) --------------

  private readonly viewport = viewChild<ElementRef<HTMLElement>>('viewport');
  private readonly scroller = viewChild<ElementRef<HTMLElement>>('scroller');
  /** Visible track width, measured */
  private readonly visible = signal(800);
  /** Horizontal scroll; null = stuck to the right end (now) */
  private readonly scroll = signal<number | null>(null);

  /** Each visible row's items; a macrotask also has its implicit leaf's, under "<id>:own" */
  private readonly items = computed(() => {
    const workspace = this.store.workspace();
    if (this.view.mode() !== 'timeline' || workspace == null) return null;
    const now = Math.floor(this.clock.now() / 60000) * 60000;
    const result = new Map<string, RowItem[]>();
    const checkins = new Map<string, CheckIn[]>();
    for (const row of this.rows()) {
      result.set(`${row.todo.id}`, rowItems(todoTimeline(workspace, row.todo, now, true)));
      // A macrotask's own line shows its whole subtree's check-ins; its implicit leaf only its own
      checkins.set(`${row.todo.id}`, [row.todo, ...(row.hasChildren ? descendantsOf(workspace, row.todo.id) : [])].flatMap(todo => todo.checkins));
      if (row.hasChildren && !row.collapsed) {
        result.set(`${row.todo.id}:own`, rowItems(todoTimeline(workspace, row.todo, now, false)));
        checkins.set(`${row.todo.id}:own`, row.todo.checkins);
      }
    }
    return { now, result, checkins };
  });

  private readonly scale = computed(() => {
    const items = this.items();
    if (items == null) return null;
    const all = [...items.result.values()];
    const from = Math.min(items.now - 3600000, ...all.flatMap(list => list.map(item => item.start)));
    return buildScale(all, from, items.now, this.visible() * this.view.zoom());
  });

  protected readonly lanes = computed(() => {
    const items = this.items();
    const scale = this.scale();
    if (items == null || scale == null) return null;
    return new Map([...items.result].map(([key, list]) => [key, layoutRow(list, scale)]));
  });

  protected readonly flags = computed(() => {
    const items = this.items();
    const scale = this.scale();
    if (items == null || scale == null) return null;
    return new Map([...items.checkins].map(([key, list]) => [key, layoutFlags(list, scale)]));
  });

  protected readonly axis = computed<TimelineAxis | null>(() => {
    const scale = this.scale();
    if (scale == null) return null;
    // Shorter than the track (zoomed out): stays aligned to now, on the right
    const max = scale.width - this.visible();
    const scroll = this.scroll();
    return {
      width: scale.width,
      scroll: scroll == null || max <= 0 ? max : Math.min(max, Math.max(0, scroll)),
      ticks: ticksOf(scale, this.store.workspace()?.timezone ?? 'UTC'),
    };
  });

  /** Zooms around the middle of what is visible (or stays at now, when stuck to it) */
  protected setZoom(zoom: number): void {
    const axis = this.axis();
    const scroll = this.scroll();
    if (axis != null && scroll != null) {
      const middle = (scroll + this.visible() / 2) / axis.width;
      const width = axis.width * (zoom / this.view.zoom());
      this.scroll.set(Math.max(0, middle * width - this.visible() / 2));
    }
    this.view.setZoom(zoom);
  }

  /** Set while the scrollbar is moved by code, so its scroll event is not taken as the user's */
  private syncing = false;

  protected scrolled(scroller: HTMLElement): void {
    if (this.syncing) {
      this.syncing = false;
      return;
    }
    const axis = this.axis();
    if (axis == null) return;
    const max = Math.max(0, axis.width - this.visible());
    this.scroll.set(scroller.scrollLeft >= max - 1 ? null : scroller.scrollLeft);
  }

  /** Sideways wheel (or shift + wheel) over the rows scrolls the timeline */
  protected wheel(event: WheelEvent): void {
    const axis = this.axis();
    if (axis == null) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.shiftKey ? event.deltaY : 0;
    if (delta === 0) return;
    event.preventDefault();
    this.scrollTo(axis.scroll + delta);
  }

  /**
   * Touch: a sideways swipe over the rows scrolls the timeline (the rows only pan vertically by
   * themselves, see styles.css); the direction is decided by the first few pixels.
   */
  protected touch: { id: number; x: number; y: number; scroll: number; sideways: boolean | null } | null = null;

  protected touchStart(event: PointerEvent): void {
    const axis = this.axis();
    if (event.pointerType !== 'touch' || axis == null) return;
    this.touch = { id: event.pointerId, x: event.clientX, y: event.clientY, scroll: axis.scroll, sideways: null };
  }

  protected touchMove(event: PointerEvent): void {
    const touch = this.touch;
    if (touch == null || event.pointerId !== touch.id) return;
    const dx = event.clientX - touch.x;
    const dy = event.clientY - touch.y;
    if (touch.sideways == null && Math.abs(dx) + Math.abs(dy) > 8) touch.sideways = Math.abs(dx) > Math.abs(dy);
    if (touch.sideways) this.scrollTo(touch.scroll - dx);
  }

  private scrollTo(position: number): void {
    const axis = this.axis();
    if (axis == null) return;
    const max = Math.max(0, axis.width - this.visible());
    const next = Math.min(max, Math.max(0, position));
    this.scroll.set(next >= max - 1 ? null : next);
  }

  /** The legend, next to the zoom; closes on any click elsewhere or Escape */
  protected readonly legendOpen = signal(false);

  @HostListener('document:click')
  @HostListener('document:keydown.escape')
  protected closeLegend(): void {
    this.legendOpen.set(false);
  }

  /** Bars are relative to the heaviest row (a macrotask's weight is its whole subtree's) */
  protected readonly maxWeight = computed(() => Math.max(1, ...[...this.rollupMap().values()].map(rollup => rollup.weight)));

  constructor() {
    // The visible track width sets the zoom's unit
    effect(onCleanup => {
      const element = this.viewport()?.nativeElement;
      if (element == null) return;
      const observer = new ResizeObserver(() => this.visible.set(Math.max(100, element.clientWidth)));
      observer.observe(element);
      onCleanup(() => observer.disconnect());
    });
    // Keep the scrollbar in step with wheel scrolling and zoom changes, once its new width is rendered
    afterRenderEffect(() => {
      const scroll = Math.max(0, this.axis()?.scroll ?? 0);
      const element = this.scroller()?.nativeElement;
      if (element != null && Math.abs(element.scrollLeft - scroll) > 1) {
        this.syncing = true;
        element.scrollLeft = scroll;
      }
    });
    // Collapsed macrotasks are remembered per workspace
    effect(() => {
      const uid = this.store.uid();
      this.expanded.set(null);
      this.collapsed.set(new Set(uid == null ? [] : readCollapsed(uid)));
    });
    // Any change of the data closes the details, like the original did after every action
    effect(() => {
      this.store.workspace()?.revision;
      this.expanded.set(null);
    });
  }

  private comparator() {
    const { column, direction } = this.sort();
    const value = (row: { todo: Todo; rollup: Rollup; status: Status }): number | string | null => {
      switch (column) {
        case 'name': return row.todo.name.toLocaleLowerCase();
        case 'creation': return row.todo.created;
        case 'running': return openSession(row.todo)?.start ?? null;
        case 'completion': return row.todo.completed;
        case 'weight': return row.rollup.weight;
        case 'counter': return row.rollup.totalMinutes;
        case 'status': return STATUS_ORDER[row.status];
      }
    };
    return (a: { todo: Todo; rollup: Rollup; status: Status }, b: { todo: Todo; rollup: Rollup; status: Status }) => {
      const va = value(a);
      const vb = value(b);
      const primary = typeof va === 'string' && typeof vb === 'string' ? va.localeCompare(vb) : compareMoments(va as number | null, vb as number | null);
      return direction * (primary || a.todo.created - b.todo.created);
    };
  }

  protected toggleSort(column: Column): void {
    const current = this.sort();
    const next: Sort = { column, direction: current.column === column && current.direction === 1 ? -1 : 1 };
    this.sort.set(next);
    try {
      localStorage.setItem(SORT_KEY, JSON.stringify(next));
    } catch {
      // not persisted
    }
  }

  protected toggleDetails(id: TodoId): void {
    this.expanded.set(this.expanded() === id ? null : id);
  }

  protected toggleCollapse(id: TodoId): void {
    const next = new Set(this.collapsed());
    if (next.has(id)) next.delete(id); else next.add(id);
    this.collapsed.set(next);
    const uid = this.store.uid();
    if (uid != null) {
      try {
        localStorage.setItem(`tasks-collapsed-${uid}`, JSON.stringify([...next]));
      } catch {
        // not persisted
      }
    }
  }

  // Drag & drop: top/bottom quarter of a row = before/after it, the middle = inside it ---------

  private target(row: RowModel, event: DragEvent): { parentId: TodoId | null; zone: DropZone } {
    const box = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const ratio = (event.clientY - box.top) / box.height;
    const zone: DropZone = ratio < 0.25 ? 'before' : ratio > 0.75 ? 'after' : 'inside';
    return { parentId: zone === 'inside' ? row.todo.id : row.todo.parentId, zone };
  }

  protected dragOver(row: RowModel, event: DragEvent): void {
    const dragged = this.dragId();
    const workspace = this.store.workspace();
    if (dragged == null || workspace == null || dragged === row.todo.id) {
      this.drop.set(null);
      return;
    }
    const { parentId, zone } = this.target(row, event);
    if (canMoveTo(workspace, dragged, parentId)) {
      event.preventDefault();
      this.drop.set({ id: row.todo.id, zone });
    } else {
      this.drop.set(null);
    }
  }

  protected async dropOn(row: RowModel, event: DragEvent): Promise<void> {
    event.preventDefault();
    const dragged = this.dragId();
    const workspace = this.store.workspace();
    this.endDrag();
    if (dragged == null || workspace == null || dragged === row.todo.id) return;
    const { parentId, zone } = this.target(row, event);
    if (!canMoveTo(workspace, dragged, parentId)) {
      shake(event.currentTarget as HTMLElement);
      return;
    }
    const siblings = childrenOf(workspace, parentId).filter(todo => todo.id !== dragged);
    const index = zone === 'inside' ? siblings.length : siblings.findIndex(todo => todo.id === row.todo.id) + (zone === 'after' ? 1 : 0);
    if (zone === 'inside' && this.collapsed().has(row.todo.id)) {
      this.toggleCollapse(row.todo.id);
    }
    void this.actions.move(dragged, parentId, index);
  }

  protected endDrag(): void {
    this.dragId.set(null);
    this.drop.set(null);
  }
}

function levelColor(depth: number): string {
  return LEVEL_COLORS[(depth - 1) % LEVEL_COLORS.length];
}

function shake(element: HTMLElement): void {
  element.classList.remove('shake');
  void element.offsetWidth;
  element.classList.add('shake');
}

function readSort(): Sort {
  try {
    const value = JSON.parse(localStorage.getItem(SORT_KEY) ?? 'null') as Sort | null;
    if (value != null && ['name', 'creation', 'running', 'completion', 'weight', 'counter', 'status'].includes(value.column) && (value.direction === 1 || value.direction === -1)) {
      return value;
    }
  } catch {
    // default
  }
  return { column: 'creation', direction: 1 };
}

function readCollapsed(uid: string): TodoId[] {
  try {
    const value = JSON.parse(localStorage.getItem(`tasks-collapsed-${uid}`) ?? '[]');
    return Array.isArray(value) ? value.filter(item => typeof item === 'number') : [];
  } catch {
    return [];
  }
}

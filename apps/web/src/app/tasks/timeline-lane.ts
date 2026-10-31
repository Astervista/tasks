import { ChangeDetectionStrategy, Component, ElementRef, inject, input, signal } from '@angular/core';
import { formatMinutes, formatMoment } from '@tasks/core';
import { ClockService } from '../services/clock.service';
import { WorkspaceStore } from '../services/workspace.store';
import { ITEM_STYLE, LaidFlag, LaidItem, Tick } from './timeline-scale';

/** The stretched axis as the list shares it: total length, horizontal scroll, labelled moments */
export interface TimelineAxis {
  width: number;
  scroll: number;
  ticks: Tick[];
}

/**
 * One row of the timeline: lines for paused / not started, beads for events and pieces of work.
 * A bead swells out of the line on free sides and shows a serrated edge where it touches another.
 */
@Component({
  selector: 't-timeline-lane',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'timeline-lane', '(mouseleave)': 'hover.set(null)' },
  template: `
    <span class="lane-clip">
      <span class="lane-inner" [style.width.px]="axis().width" [style.transform]="'translateX(' + -axis().scroll + 'px)'">
        @for (tick of axis().ticks; track tick.at) {
          <span class="timeline-grid" [style.left.px]="tick.x"></span>
        }
        <!-- Check-in flags stand behind the beads -->
        @for (flag of flags(); track flag.at) {
          <svg class="checkin-flag" [style.left.px]="flag.x" width="8" height="14" viewBox="0 0 8 14" aria-hidden="true"
               (mousemove)="trackFlag(flag, $event)">
            <rect x="0" y="0" width="1" height="14" />
            <path d="M1,0 L7,2.25 L1,4.5 Z" />
          </svg>
        }
        @for (item of items(); track $index) {
          @if (item.kind === 'line') {
            <span [class]="'lane-line lane-' + item.type" [style.left.px]="item.x" [style.width.px]="item.width" (mousemove)="track(item, $event)"></span>
          } @else {
            <span class="bead" [style.left.px]="item.x - item.capLeft" [style.width.px]="item.capLeft + item.width + item.capRight"
                  [style.color]="style(item).color" (mousemove)="track(item, $event)">
              <svg class="bead-shape" [attr.width]="item.capLeft + item.width + item.capRight" height="16"
                   [attr.viewBox]="'0 0 ' + (item.capLeft + item.width + item.capRight) + ' 16'" aria-hidden="true">
                <path [attr.d]="item.path" fill="currentColor" />
                @if (item.approximate) {<path [attr.d]="item.path" fill="url(#bead-stripes)" />}
              </svg>
              <span class="bead-icon material-icons" [style.left.px]="item.capLeft" [style.width.px]="item.width">{{ icon(item) }}</span>
            </span>
          }
        }
      </span>
    </span>
    @if (hover(); as tip) {
      <div class="stats-tooltip" [style.left.px]="tip.x" [style.top.px]="tip.y" [class.flip]="tip.flip">
        <div><b>{{ tip.label }}</b></div>
        <div style="color: #AAA">{{ tip.detail }}</div>
      </div>
    }
  `,
})
export class TimelineLane {
  private readonly store = inject(WorkspaceStore);
  private readonly clock = inject(ClockService);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly items = input.required<LaidItem[]>();
  readonly flags = input<LaidFlag[]>([]);
  readonly axis = input.required<TimelineAxis>();
  /** Still open: its last piece or line runs until now */
  readonly open = input(true);

  protected readonly hover = signal<{ label: string; detail: string; x: number; y: number; flip: boolean } | null>(null);

  protected style(item: LaidItem) {
    return ITEM_STYLE[item.type];
  }

  protected icon(item: LaidItem): string {
    return item.approximate ? 'event_note' : ITEM_STYLE[item.type].icon;
  }

  protected trackFlag(flag: LaidFlag, event: MouseEvent): void {
    const timezone = this.store.workspace()?.timezone ?? 'UTC';
    const detail = `${formatMoment(flag.at, timezone, this.clock.now())}${flag.note ? ` · ${flag.note}` : ''}`;
    this.place(`Check-in · ${Math.round(flag.progress * 100)}%`, detail, event);
  }

  protected track(item: LaidItem, event: MouseEvent): void {
    const timezone = this.store.workspace()?.timezone ?? 'UTC';
    const now = this.clock.now();
    const date = (moment: number) => formatMoment(moment, timezone, now);
    let detail: string;
    if (item.kind === 'event') {
      detail = date(item.start);
    } else if (item.approximate) {
      detail = `${formatMinutes((item.end - item.start) / 60000)} logged that day`;
    } else {
      const [startDay] = date(item.start).split(' · ');
      const [endDay, endTime] = date(item.end).split(' · ');
      const end = this.open() && item.end >= now - 60000 ? 'now' : endDay === startDay ? endTime : date(item.end);
      detail = `${date(item.start)} → ${end} · ${formatMinutes((item.end - item.start) / 60000)}`;
    }
    this.place(item.approximate ? 'Logged as a day total' : ITEM_STYLE[item.type].label, detail, event);
  }

  private place(label: string, detail: string, event: MouseEvent): void {
    const box = this.host.nativeElement.getBoundingClientRect();
    const x = event.clientX - box.left;
    const flip = x > box.width / 2;
    this.hover.set({ label, detail, x: flip ? x - 14 : x + 14, y: event.clientY - box.top + 14, flip });
  }
}

import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import {
  ancestorsOf,
  childrenOf,
  dailySeries,
  dayKeyToLabel,
  formatMinutes,
  AccuracySample,
  estimateAccuracy,
  minutesPerWeight,
  weightAccuracy,
  paceNote,
  projectEta,
  summarize,
  TodoId,
} from '@tasks/core';
import { ClockService } from '../services/clock.service';
import { WorkspaceStore } from '../services/workspace.store';
import { Modal } from '../ui/modal';

/**
 * Categorical hues for the chart, validated on the dark modal surface (#333) for lightness, chroma,
 * colorblind separation of neighbours and contrast. Fixed order; extra series fold into "Other".
 */
const SERIES_COLORS = ['#0e9e8f', '#d9760a', '#5b8cff', '#ff2e93', '#b65cff'];
const OTHER_COLOR = '#8a8a8a';
const RANGES = [7, 14, 30];

const CHART = { width: 720, height: 260, left: 44, right: 8, top: 10, bottom: 28 };

interface Bar {
  day: string;
  x: number;
  width: number;
  total: number;
  segments: { y: number; height: number; color: string; name: string; minutes: number }[];
}

@Component({
  selector: 't-stats-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal],
  template: `
    <t-modal #modal (closed)="done()()">
      <div class="modal-content">
        <h4 class="no-select">Statistics</h4>

        <div class="stats-tiles">
          <div class="stats-tile"><div class="label">Today</div><div class="value">{{ minutes(summary().today) }}</div></div>
          <div class="stats-tile"><div class="label">This week</div><div class="value">{{ minutes(summary().week) }}</div></div>
          <div class="stats-tile"><div class="label">All time</div><div class="value">{{ minutes(summary().total) }}</div></div>
          <div class="stats-tile"><div class="label">Done</div><div class="value">{{ percent() }}</div></div>
          <div class="stats-tile" [title]="eta().title"><div class="label">ETA</div><div class="value">{{ eta().label }}</div></div>
        </div>

        <div class="label" style="color: #AAA">Weight done: {{ weightText() }}</div>
        <div class="task-line-weight stats-weight">
          <span class="task-line-weight-back">{{ weightText() }}</span>
          <span class="task-line-weight-progress" [style.width]="weightWidth()">{{ weightText() }}</span>
        </div>

        <div>
          @for (crumb of crumbs(); track crumb.id; let i = $index) {
            <span class="sub-folder selected" [attr.sub-level]="'s' + (i % 7)" style="cursor: pointer"
                  (click)="parent.set(crumb.id)">{{ crumb.name }}</span>
          }
          <span class="suggestion-separator">Last</span>
          @for (range of ranges; track range) {
            <span class="sub-folder" [class.selected]="days() === range" sub-level="s4" (click)="days.set(range)">{{ range }} days</span>
          }
          <span class="sub-folder" [class.selected]="table()" sub-level="s3" (click)="table.set(!table())">table</span>
        </div>

        @if (chart().series.length === 0) {
          <div class="stats-empty">No time logged in these days.</div>
        } @else if (table()) {
          <table class="striped" style="margin-top: 15px">
            <thead><tr><th>Day</th>@for (series of legend(); track series.name) {<th>{{ series.name }}</th>}<th>Total</th></tr></thead>
            <tbody>
              @for (bar of bars(); track bar.day) {
                <tr>
                  <td>{{ bar.day }}</td>
                  @for (series of legend(); track series.name) {<td>{{ minutes(valueOf(bar, series.name)) }}</td>}
                  <td>{{ minutes(bar.total) }}</td>
                </tr>
              }
            </tbody>
          </table>
        } @else {
          <div #chartBoxElement class="stats-chart" (mouseleave)="hover.set(null)">
            <svg [attr.viewBox]="'0 0 ' + chartBox.width + ' ' + chartBox.height" role="img" aria-label="Minutes per day">
              @for (tick of ticks(); track tick.value) {
                <line [attr.x1]="chartBox.left" [attr.x2]="chartBox.width - chartBox.right" [attr.y1]="tick.y" [attr.y2]="tick.y"
                      stroke="#444" stroke-width="1" />
                <text class="axis" [attr.x]="chartBox.left - 6" [attr.y]="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
              }
              @for (bar of bars(); track bar.day; let i = $index) {
                <g>
                  @for (segment of bar.segments; track segment.name; let last = $last) {
                    <rect [attr.x]="bar.x" [attr.y]="segment.y" [attr.width]="bar.width" [attr.height]="segment.height"
                          [attr.fill]="segment.color" [attr.rx]="last ? 4 : 0" />
                  }
                  @if (showLabel(i)) {
                    <text class="axis" [attr.x]="bar.x + bar.width / 2" [attr.y]="chartBox.height - 8" text-anchor="middle">{{ shortDay(bar.day) }}</text>
                  }
                  <!-- Hit target taller and wider than the bar -->
                  <rect [attr.x]="bar.x - 2" [attr.y]="chartBox.top" [attr.width]="bar.width + 4" [attr.height]="plotHeight" fill="transparent"
                        (mousemove)="track(bar, $event, chartBoxElement)" />
                </g>
              }
            </svg>
            @if (hover(); as tip) {
              <div class="stats-tooltip" [style.left.px]="tip.x" [style.top.px]="tip.y" [class.flip]="tip.flip">
                <div><b>{{ longDay(tip.bar.day) }}</b> · {{ minutes(tip.bar.total) }}</div>
                @for (segment of tip.bar.segments.slice().reverse(); track segment.name) {
                  <div><span class="swatch" [style.background]="segment.color" style="display: inline-block; width: 10px; height: 10px; border-radius: 3px; margin-right: 6px"></span>{{ segment.name }}: {{ minutes(segment.minutes) }}</div>
                }
              </div>
            }
          </div>
          <div class="stats-legend">
            @for (series of legend(); track series.name) {
              <span class="item" [class.static]="!series.drill" [title]="series.drill ? 'Show its subtasks' : ''"
                    (click)="series.drill && parent.set(series.id)">
                <span class="swatch" [style.background]="series.color"></span>{{ series.name }}
                <span style="color: #AAA">{{ minutes(series.total) }}</span>
              </span>
            }
          </div>
        }

        <h5 class="stats-section no-select">Weight as an estimate</h5>
        @let weight = weightStats();
        <div class="stats-tiles">
          <div class="stats-tile" [title]="weight.rateTitle">
            <div class="label">1 weight point ≈</div>
            <div class="value">{{ weight.rate == null ? '—' : minutes(weight.rate) }}</div>
            <div class="label">{{ weight.rateSource }}</div>
          </div>
          <div class="stats-tile" title="Median distance between the time a todo took and its weight × the rate">
            <div class="label">Typically off by</div>
            <div class="value">{{ weight.error }}</div>
            <div class="label">{{ weight.samples }}</div>
          </div>
          <div class="stats-tile" title="The middle half of the finished todos took between these multiples of their weight guess">
            <div class="label">Usually takes</div>
            <div class="value">{{ weight.range }}</div>
            <div class="label">of the weight guess</div>
          </div>
          <div class="stats-tile" title="The same, for the todos you gave an explicit estimate">
            <div class="label">Your estimates: off by</div>
            <div class="value">{{ weight.estimateError }}</div>
            <div class="label">{{ weight.estimateSamples }}</div>
          </div>
        </div>
        @if (scatter(); as plot) {
          @if (table()) {
            <table class="striped">
              <thead><tr><th>ToDo</th><th>Weight</th><th>Guess</th><th>Took</th><th>×</th></tr></thead>
              <tbody>
                @for (dot of plot.dots; track dot.sample.id) {
                  <tr>
                    <td>{{ dot.sample.name }}</td><td>{{ dot.sample.weight }}</td><td>{{ minutes(dot.sample.predicted) }}</td>
                    <td>{{ minutes(dot.sample.actual) }}</td><td>{{ ratio(dot.sample.ratio) }}</td>
                  </tr>
                }
              </tbody>
            </table>
          } @else {
            <div #scatterBox class="stats-chart" (mouseleave)="dotHover.set(null)">
              <svg [attr.viewBox]="'0 0 ' + chartBox.width + ' ' + chartBox.height" role="img" aria-label="Time taken against weight">
                @for (tick of plot.yTicks; track tick.value) {
                  <line [attr.x1]="chartBox.left" [attr.x2]="chartBox.width - chartBox.right" [attr.y1]="tick.y" [attr.y2]="tick.y" stroke="#444" stroke-width="1" />
                  <text class="axis" [attr.x]="chartBox.left - 6" [attr.y]="tick.y + 4" text-anchor="end">{{ tick.label }}</text>
                }
                @for (tick of plot.xTicks; track tick.value) {
                  <text class="axis" [attr.x]="tick.x" [attr.y]="chartBox.height - 8" text-anchor="middle">{{ tick.label }}</text>
                }
                <text class="axis" [attr.x]="chartBox.width - chartBox.right" [attr.y]="chartBox.height - 8" text-anchor="end">weight →</text>
                <!-- The rate: what each weight "should" take -->
                <line [attr.x1]="plot.line.x1" [attr.y1]="plot.line.y1" [attr.x2]="plot.line.x2" [attr.y2]="plot.line.y2"
                      stroke="gold" stroke-width="2" stroke-dasharray="6 4" />
                @for (dot of plot.dots; track dot.sample.id) {
                  <circle [attr.cx]="dot.x" [attr.cy]="dot.y" r="5" [attr.fill]="dot.color" stroke="#333" stroke-width="2" />
                  <circle [attr.cx]="dot.x" [attr.cy]="dot.y" r="12" fill="transparent" (mousemove)="trackDot(dot.sample, $event, scatterBox)" />
                }
              </svg>
              @if (dotHover(); as tip) {
                <div class="stats-tooltip" [style.left.px]="tip.x" [style.top.px]="tip.y" [class.flip]="tip.flip">
                  <div><b>{{ tip.sample.name }}</b></div>
                  <div>Weight {{ tip.sample.weight }} · guess {{ minutes(tip.sample.predicted) }}</div>
                  <div>Took {{ minutes(tip.sample.actual) }} ({{ ratio(tip.sample.ratio) }})</div>
                </div>
              }
            </div>
            <div class="stats-legend">
              <span class="item static"><span class="swatch" style="background: #0e9e8f"></span>faster than the guess</span>
              <span class="item static"><span class="swatch" style="background: #d9760a"></span>slower than the guess</span>
              <span class="item static"><span class="swatch" style="background: gold; height: 3px"></span>weight × {{ weight.rate == null ? '' : minutes(weight.rate) }}</span>
            </div>
          }
        } @else {
          <div class="stats-empty">Finish a todo with logged time to see how weight turns into time.</div>
        }
      </div>
      <div class="modal-footer">
        <a class="modal-close button white-text" (click)="modal.close()">Close</a>
      </div>
    </t-modal>
  `,
})
export class StatsDialog {
  private readonly store = inject(WorkspaceStore);
  private readonly clock = inject(ClockService);
  readonly done = input.required<() => void>();

  protected readonly ranges = RANGES;
  protected readonly chartBox = CHART;
  protected readonly plotHeight = CHART.height - CHART.top - CHART.bottom;
  protected readonly days = signal(14);
  protected readonly parent = signal<TodoId | null>(null);
  protected readonly table = signal(false);
  protected readonly dotHover = signal<{ sample: AccuracySample; x: number; y: number; flip: boolean } | null>(null);

  /** Rate of this project (archive included), else of all projects, and how accurate it is */
  protected readonly weightStats = computed(() => {
    const document = this.store.document();
    const now = this.minute();
    const todos = document == null ? [] : [...document.workspace.todos, ...document.archive.todos];
    const own = minutesPerWeight(todos, now);
    const rate = own ?? document?.velocity ?? null;
    const weight = weightAccuracy(todos, rate, now);
    const estimates = estimateAccuracy(todos, now);
    const plural = (count: number, what: string) => `${count} ${what}${count === 1 ? '' : 's'}`;
    return {
      rate,
      rateSource: own != null ? 'in this project' : rate != null ? 'across all projects' : 'nothing finished yet',
      rateTitle: document?.velocity != null ? `Across all projects: ${formatMinutes(document.velocity)} per point` : '',
      accuracy: weight,
      error: weight.typicalError == null ? '—' : `±${Math.round(weight.typicalError * 100)}%`,
      samples: weight.samples.length === 0 ? 'no finished todos' : `over ${plural(weight.samples.length, 'finished todo')}`,
      range: weight.low == null || weight.high == null ? '—' : `${ratio(weight.low)} – ${ratio(weight.high)}`,
      estimateError: estimates.typicalError == null ? '—' : `±${Math.round(estimates.typicalError * 100)}%`,
      estimateSamples: estimates.samples.length === 0 ? 'none estimated yet' : `over ${plural(estimates.samples.length, 'estimate')}`,
    };
  });

  /** Weight (x) against time taken (y): dots off the gold rate line show how good weight is */
  protected readonly scatter = computed(() => {
    const { accuracy, rate } = this.weightStats();
    if (accuracy.samples.length === 0 || rate == null) return null;
    const maxWeight = Math.max(...accuracy.samples.map(sample => sample.weight)) * 1.1;
    const maxMinutes = niceMax(Math.max(...accuracy.samples.map(sample => sample.actual), maxWeight * rate));
    const x = (weight: number) => CHART.left + (weight / maxWeight) * (CHART.width - CHART.left - CHART.right);
    const y = (minutes: number) => CHART.top + this.plotHeight * (1 - minutes / maxMinutes);
    const step = maxWeight <= 10 ? 1 : maxWeight <= 30 ? 5 : 10;
    const xTicks = [];
    for (let value = step; value < maxWeight; value += step) xTicks.push({ value, x: x(value), label: String(value) });
    return {
      dots: accuracy.samples.map(sample => ({
        sample,
        x: x(sample.weight),
        y: y(sample.actual),
        color: sample.ratio > 1 ? '#d9760a' : '#0e9e8f',
      })),
      line: { x1: x(0), y1: y(0), x2: x(maxWeight), y2: y(Math.min(maxMinutes, maxWeight * rate)) },
      xTicks,
      yTicks: [0, 0.25, 0.5, 0.75, 1].map(share => ({ value: share, y: y(share * maxMinutes), label: shortMinutes(share * maxMinutes) })),
    };
  });

  protected trackDot(sample: AccuracySample, event: MouseEvent, box: HTMLElement): void {
    const rect = box.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const flip = x > rect.width / 2;
    this.dotHover.set({ sample, x: flip ? x - 14 : x + 14, y: event.clientY - rect.top + 14, flip });
  }

  protected ratio(value: number): string {
    return ratio(value);
  }

  protected readonly hover = signal<{ bar: Bar; x: number; y: number; flip: boolean } | null>(null);

  /** Recomputed every minute is plenty for statistics */
  private readonly minute = computed(() => Math.floor(this.clock.now() / 60000) * 60000);

  protected readonly summary = computed(() => {
    const document = this.store.document();
    return document == null
      ? { today: 0, week: 0, total: 0, weight: { done: 0, total: 0 } }
      : summarize(document.workspace, document.archive, this.minute());
  });

  protected readonly eta = computed(() => {
    const document = this.store.document();
    if (document == null) return { label: '—', title: '' };
    const eta = projectEta(document.workspace, document.archive, this.minute(), document.velocity);
    if (document.workspace.todos.every(todo => todo.completed != null)) return { label: 'Done ✔', title: '' };
    const title = `About ${formatMinutes(eta.remaining)} of work left` +
      (eta.unknown > 0 ? `, plus ${eta.unknown} todo(s) without a guess` : '') +
      `. ${paceNote(eta)}`;
    return { label: eta.finish != null ? dayKeyToLabel(eta.finish, 'medium') : '?', title };
  });

  protected readonly percent = computed(() => {
    const { done, total } = this.summary().weight;
    return total === 0 ? '—' : `${Math.round((done / total) * 100)}%`;
  });
  protected readonly weightText = computed(() => `${round(this.summary().weight.done)}/${round(this.summary().weight.total)}`);
  protected readonly weightWidth = computed(() => {
    const { done, total } = this.summary().weight;
    return `${total === 0 ? 0 : (done / total) * 100}%`;
  });

  protected readonly chart = computed(() => {
    const document = this.store.document();
    if (document == null) return { days: [], series: [] };
    return dailySeries(document.workspace, document.archive, this.parent(), this.days(), this.minute());
  });

  /** Drill-down path: All > macrotask > … */
  protected readonly crumbs = computed(() => {
    const workspace = this.store.workspace();
    const parent = this.parent();
    const root = { id: null as TodoId | null, name: 'All' };
    if (workspace == null || parent == null || !workspace.todos.some(todo => todo.id === parent)) return [root];
    const chain = [workspace.todos.find(todo => todo.id === parent)!, ...ancestorsOf(workspace, parent)].reverse();
    return [root, ...chain.map(todo => ({ id: todo.id as TodoId | null, name: todo.name }))];
  });

  /**
   * Hues follow the entity: a series keeps the color of its position among its siblings, whatever
   * the range or ranking; siblings past the palette fold into "Other".
   */
  protected readonly legend = computed(() => {
    const document = this.store.document();
    const series = this.chart().series;
    if (document == null) return [];
    const parent = this.parent();
    // A drilled-into macrotask's own time is its implicit leaf, first among its children
    const siblings = [...(parent == null ? [] : [parent]), ...childrenOf(document.workspace, parent).map(todo => todo.id),
      ...childrenOf(document.archive, parent).map(todo => todo.id)];
    const hasChildren = (id: TodoId) => childrenOf(document.workspace, id).length > 0 || childrenOf(document.archive, id).length > 0;
    const named: { id: TodoId; name: string; color: string; total: number; drill: boolean; values: number[] }[] = [];
    const other = { id: -1, name: 'Other', color: OTHER_COLOR, total: 0, drill: false, values: this.chart().days.map(() => 0) };
    for (const item of series) {
      const index = siblings.indexOf(item.id);
      const total = item.values.reduce((sum, value) => sum + value, 0);
      if (index >= 0 && index < SERIES_COLORS.length) {
        const implicit = item.id === parent;
        named.push({ id: item.id, name: implicit ? 'Itself' : item.name, color: SERIES_COLORS[index], total,
          drill: !implicit && hasChildren(item.id), values: item.values });
      } else {
        other.total += total;
        item.values.forEach((value, day) => (other.values[day] += value));
      }
    }
    named.sort((a, b) => siblings.indexOf(a.id) - siblings.indexOf(b.id));
    return other.total > 0 ? [...named, other] : named;
  });

  private readonly maxTotal = computed(() => {
    const totals = this.chart().days.map((_, day) => this.legend().reduce((sum, series) => sum + series.values[day], 0));
    return niceMax(Math.max(1, ...totals));
  });

  protected readonly ticks = computed(() => {
    const max = this.maxTotal();
    return [0, 0.25, 0.5, 0.75, 1].map(ratio => ({
      value: ratio * max,
      y: CHART.top + this.plotHeight * (1 - ratio),
      label: shortMinutes(ratio * max),
    }));
  });

  protected readonly bars = computed<Bar[]>(() => {
    const days = this.chart().days;
    const legend = this.legend();
    const slot = (CHART.width - CHART.left - CHART.right) / Math.max(1, days.length);
    const width = Math.max(2, Math.min(28, slot * 0.6));
    const scale = this.plotHeight / this.maxTotal();
    return days.map((day, index) => {
      let y = CHART.top + this.plotHeight;
      const segments: Bar['segments'] = [];
      for (const series of legend) {
        const minutes = series.values[index];
        if (minutes <= 0) continue;
        const height = minutes * scale;
        // 2px surface gap between stacked segments
        const gap = segments.length > 0 ? 2 : 0;
        y -= height;
        segments.push({ y, height: Math.max(0.5, height - gap), color: series.color, name: series.name, minutes });
      }
      return {
        day,
        x: CHART.left + slot * index + (slot - width) / 2,
        width,
        total: segments.reduce((sum, segment) => sum + segment.minutes, 0),
        segments,
      };
    });
  });

  /**
   * Tooltip position inside the chart box (the dialog is transformed, so fixed positioning would be
   * off); past the middle it opens to the left of the pointer so it never overflows
   */
  protected track(bar: Bar, event: MouseEvent, box: HTMLElement): void {
    const rect = box.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const flip = x > rect.width / 2;
    this.hover.set({ bar, x: flip ? x - 14 : x + 14, y: event.clientY - rect.top + 14, flip });
  }

  protected valueOf(bar: Bar, name: string): number {
    return bar.segments.find(segment => segment.name === name)?.minutes ?? 0;
  }

  protected showLabel(index: number): boolean {
    const count = this.chart().days.length;
    const every = count <= 14 ? 1 : count <= 31 ? 3 : 7;
    return (count - 1 - index) % every === 0;
  }

  protected minutes(value: number): string {
    return formatMinutes(value);
  }

  protected shortDay(day: string): string {
    return dayKeyToLabel(day, 'short');
  }

  protected longDay(day: string): string {
    return dayKeyToLabel(day, 'long');
  }
}

/** 1.4 -> "1.4×" */
function ratio(value: number): string {
  return `${Number(value.toFixed(value < 10 ? 2 : 1))}×`;
}

function round(value: number): string {
  return String(Number(value.toFixed(2)));
}

/** A round axis maximum in minutes: 15m, 30m, 1h, 2h, … */
function niceMax(minutes: number): number {
  const steps = [15, 30, 60, 120, 180, 240, 360, 480, 600, 720, 960, 1200, 1440];
  return steps.find(step => step >= minutes) ?? Math.ceil(minutes / 1440) * 1440;
}

function shortMinutes(minutes: number): string {
  return minutes >= 60 ? `${Number((minutes / 60).toFixed(1))}h` : `${Math.round(minutes)}m`;
}

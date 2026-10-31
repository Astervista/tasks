import { ChangeDetectionStrategy, Component, computed, ElementRef, inject, output, signal, viewChild, afterNextRender } from '@angular/core';
import { dayKeyToLabel, formatMinutes, paceNote, WorkspaceSummary } from '@tasks/core';
import { ClockService } from '../services/clock.service';
import { WorkspaceStore } from '../services/workspace.store';

/**
 * The home page: every project with its status, time, progress and ETA. Type to filter (name and
 * description), ↑↓ to move, Enter to open. Projects are told apart by uid; names may repeat.
 */
@Component({
  selector: 't-project-list',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'project-page' },
  template: `
    <div id="project-search">
      <span class="material-icons" style="color: #AAA; margin: 0 6px 0 16px">search</span>
      <input #search type="text" autocomplete="off" placeholder="Filter projects" [value]="filter()"
             (input)="filter.set($any($event.target).value)" (keydown)="key($event)" />
      <span class="button project-new" (click)="create.emit(filter().trim())">New project</span>
    </div>
    <div class="task-line header project-line">
      <span class="project-name">Project</span>
      <span class="project-status">Status</span>
      <span class="project-time">Today · week</span>
      <span class="project-progress">Done</span>
      <span class="project-eta">ETA</span>
    </div>
    <div class="project-rows">
      @for (project of projects(); track project.uid; let i = $index) {
        <div class="task-line project-line" [class.selected-row]="i === selected()" (click)="open.emit(project.uid)"
             (mouseenter)="selected.set(i)">
          <span class="project-name">
            <span class="sub-folder selected" [attr.sub-level]="'s' + (colorOf(project) % 7)">{{ project.name }}</span>
            @if (project.description) {
              <span class="project-description-line">{{ firstLine(project.description) }}</span>
            }
            @if (project.running; as running) {
              <span class="project-running">
                <span class="material-icons lime-text">play_arrow</span>{{ running.name }} · {{ since(running.since) }}
              </span>
            }
          </span>
          <span class="project-status">
            <span class="material-icons green-text">done</span>{{ project.counts.done }}
            <span class="material-icons lime-text">play_arrow</span>{{ project.counts.running }}
            <span class="material-icons amber-text">pause</span>{{ project.counts.paused }}
            <span class="material-icons red-text">stop</span>{{ project.counts.new }}
          </span>
          <span class="project-time">
            {{ minutes(project.summary.today) }} <span style="color: #AAA">· {{ minutes(project.summary.week) }}</span>
          </span>
          <span class="project-progress task-line-weight">
            <span class="task-line-weight-back">{{ percent(project) }}</span>
            <span class="task-line-weight-progress" [style.width]="percent(project)">{{ percent(project) }}</span>
          </span>
          <span class="project-eta" [title]="etaTitle(project)">{{ eta(project) }}</span>
        </div>
      } @empty {
        <div class="stats-empty">
          {{ filter() ? 'No project matches “' + filter() + '”.' : 'No projects yet: create one, or run “tasks init” in a project folder.' }}
        </div>
      }
    </div>
  `,
})
export class ProjectList {
  private readonly store = inject(WorkspaceStore);
  private readonly clock = inject(ClockService);
  readonly open = output<string>();
  readonly create = output<string>();

  protected readonly filter = signal('');
  protected readonly selected = signal(0);
  private readonly search = viewChild.required<ElementRef<HTMLInputElement>>('search');

  /** Running first, then recently opened, then by name; filtered on name and description */
  protected readonly projects = computed(() => {
    const recent = this.store.recent();
    const rank = (item: WorkspaceSummary) => (item.running != null ? -1 : recent.includes(item.uid) ? recent.indexOf(item.uid) : recent.length);
    const needle = this.filter().trim().toLowerCase();
    return [...(this.store.workspaces() ?? [])]
      .filter(item => needle === '' || item.name.toLowerCase().includes(needle) || item.description.toLowerCase().includes(needle))
      .sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  });

  /** A project keeps its chip color whatever the filter or order */
  private readonly colors = computed(() => {
    const sorted = [...(this.store.workspaces() ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.uid.localeCompare(b.uid));
    return new Map(sorted.map((item, index) => [item.uid, index]));
  });

  constructor() {
    afterNextRender(() => this.search().nativeElement.focus());
  }

  protected colorOf(project: WorkspaceSummary): number {
    return this.colors().get(project.uid) ?? 0;
  }

  protected key(event: KeyboardEvent): void {
    const count = this.projects().length;
    if (event.key === 'ArrowDown' && count > 0) {
      event.preventDefault();
      this.selected.set((this.selected() + 1) % count);
    } else if (event.key === 'ArrowUp' && count > 0) {
      event.preventDefault();
      this.selected.set((this.selected() + count - 1) % count);
    } else if (event.key === 'Enter') {
      const project = this.projects()[this.selected()];
      if (project != null) this.open.emit(project.uid);
      else this.create.emit(this.filter().trim());
    } else if (event.key === 'Escape') {
      this.filter.set('');
    } else {
      this.selected.set(0);
    }
  }

  protected firstLine(text: string): string {
    return text.split('\n')[0];
  }

  protected minutes(value: number): string {
    return formatMinutes(value);
  }

  protected since(start: number): string {
    return formatMinutes((this.clock.now() - start) / 60000);
  }

  protected percent(project: WorkspaceSummary): string {
    const { done, total } = project.summary.weight;
    return `${total === 0 ? 0 : Math.round((done / total) * 100)}%`;
  }

  protected eta(project: WorkspaceSummary): string {
    const { eta, counts } = project;
    if (counts.new + counts.paused + counts.running === 0) return '✔ done';
    if (eta.finish != null) return dayKeyToLabel(eta.finish, 'medium');
    return eta.unknown > 0 ? '?' : '—';
  }

  protected etaTitle(project: WorkspaceSummary): string {
    const { eta } = project;
    const parts = [`About ${formatMinutes(eta.remaining)} of work left`];
    if (eta.unknown > 0) parts.push(`${eta.unknown} todo(s) without a guess: add an estimate or a check-in`);
    parts.push(paceNote(eta));
    return parts.join('; ');
  }
}

import { ChangeDetectionStrategy, Component, computed, inject, output } from '@angular/core';
import { dayKeyToLabel, formatMinutes, paceNote, projectEta } from '@tasks/core';
import { ClockService } from '../services/clock.service';
import { ViewService } from '../services/view.service';
import { WorkspaceStore } from '../services/workspace.store';

/** The slim bar above an open project: back, the project (click to edit), its description and ETA */
@Component({
  selector: 't-project-bar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    @if (store.workspace(); as workspace) {
      <div id="address-bar" class="project-bar">
        <span class="material-icons project-back" title="All projects" (click)="back.emit()">arrow_back</span>
        <span class="sub-folder selected crumb" sub-level="s0" title="Edit name and description" (click)="edit.emit()">{{ workspace.name }}</span>
        <span class="project-description" [title]="workspace.description">{{ workspace.description.split('\\n')[0] }}</span>
        <span class="project-bar-eta" [title]="eta().title">{{ eta().label }}</span>
        <span class="view-switch">
          <span class="material-icons" [class.active]="view.mode() === 'table'" title="Table" (click)="view.setMode('table')">view_list</span>
          <span class="material-icons" [class.active]="view.mode() === 'timeline'" title="Timeline" (click)="view.setMode('timeline')">timeline</span>
        </span>
      </div>
    }
  `,
})
export class ProjectBar {
  protected readonly store = inject(WorkspaceStore);
  protected readonly view = inject(ViewService);
  private readonly clock = inject(ClockService);
  readonly back = output<void>();
  readonly edit = output<void>();

  /** Recomputed once a minute */
  private readonly minute = computed(() => Math.floor(this.clock.now() / 60000) * 60000);

  protected readonly eta = computed(() => {
    const document = this.store.document();
    if (document == null) return { label: '', title: '' };
    const eta = projectEta(document.workspace, document.archive, this.minute(), document.velocity);
    const open = document.workspace.todos.some(todo => todo.completed == null);
    if (!open) return { label: 'All done ✔', title: '' };
    const left = `~${formatMinutes(eta.remaining)} left`;
    const label = eta.finish != null ? `ETA ${dayKeyToLabel(eta.finish, 'medium')} · ${left}` : eta.unknown > 0 ? `${left} + ${eta.unknown} unguessed` : left;
    const title = paceNote(eta);
    return { label, title };
  });
}

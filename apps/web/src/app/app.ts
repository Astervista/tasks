import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { filter, map } from 'rxjs';
import { ConfirmDialog } from './dialogs/confirm-dialog';
import { StatsDialog } from './dialogs/stats-dialog';
import { TodoDialog } from './dialogs/todo-dialog';
import { CheckInDialog } from './dialogs/checkin-dialog';
import { ProjectDialog } from './dialogs/project-dialog';
import { ProjectBar } from './projects/project-bar';
import { ProjectList } from './projects/project-list';
import { randomClownColor } from './ui/clown';
import { DialogService } from './services/dialog.service';
import { WorkspaceStore } from './services/workspace.store';
import { StatusBar } from './status/status-bar';
import { TaskList } from './tasks/task-list';
import { Modal } from './ui/modal';

/**
 * The page: address bar (workspace picker), task list and status bar, plus the original
 * loading hourglass and error screen. Routes: "/" picks a workspace, "/w/:uid" shows one.
 */
@Component({
  selector: 't-root',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [ProjectList, ProjectBar, TaskList, StatusBar, TodoDialog, ConfirmDialog, StatsDialog, ProjectDialog, CheckInDialog, Modal],
  template: `
    @if (store.connection() === 'ready') {
      @if (store.workspace()) {
        <t-project-bar (back)="leave()" (edit)="editProject()" />
        <t-task-list />
        <t-status-bar (openWorkspace)="go($event)" />
      } @else if (!routeUid()) {
        <t-project-list (open)="go($event)" (create)="dialogs.project.set({ name: $event, description: '', editing: false })" />
      }
    }
    <div id="effects"></div>
    <div id="loading" [style.transform]="store.connection() === 'loading' ? 'scale(1)' : 'scale(0)'">
      <svg height="24px" viewBox="0 0 24 24" width="24px" id="hourglass">
        <defs>
          <clipPath id="hourglass-shape">
            <path d="M8 2c-1.1 0-2 .9-2 2v3.17c0 .53.21 1.04.59 1.42L10 12l-3.42 3.42c-.37.38-.58.89-.58 1.42V20c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2v-3.16c0-.53-.21-1.04-.58-1.41L14 12l3.41-3.4c.38-.38.59-.89.59-1.42V4c0-1.1-.9-2-2-2H8z" />
          </clipPath>
        </defs>
        <rect x="0" width="24" fill="gold" clip-path="url(#hourglass-shape)" id="hourglass-sand-up"></rect>
        <rect x="0" width="24" fill="gold" clip-path="url(#hourglass-shape)" id="hourglass-sand-down"></rect>
        <path fill="white" d="M8 2c-1.1 0-2 .9-2 2v3.17c0 .53.21 1.04.59 1.42L10 12l-3.42 3.42c-.37.38-.58.89-.58 1.42V20c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2v-3.16c0-.53-.21-1.04-.58-1.41L14 12l3.41-3.4c.38-.38.59-.89.59-1.42V4c0-1.1-.9-2-2-2H8zm8 14.5V19c0 .55-.45 1-1 1H9c-.55 0-1-.45-1-1v-2.5l4-4 4 4zm-4-5l-4-4V5c0-.55.45-1 1-1h6c.55 0 1 .45 1 1v2.5l-4 4z" />
      </svg>
    </div>
    <div id="error" style="font-size: 33px"
         [style.transform]="store.connection() === 'offline' ? 'scale(1)' : 'scale(0)'"
         [style.pointer-events]="store.connection() === 'offline' ? 'all' : 'none'">
      <svg height="312px" viewBox="0 0 24 24" width="24px" id="triangle-error">
        <path fill="crimson" id="triangle-error-triangle" d="M4.47 21h15.06c1.54 0 2.5-1.67 1.73-3L13.73 4.99c-.77-1.33-2.69-1.33-3.46 0L2.74 18c-.77 1.33.19 3 1.73 3z" />
        <path fill="white" id="triangle-error-path" d="M12 14c-.55 0-1-.45-1-1v-2c0-.55.45-1 1-1s1 .45 1 1v2c0 .55-.45 1-1 1zm1 4h-2v-2h2v2z" />
      </svg>
      <span>Error connecting. </span>
      <span><span style="cursor: pointer; color: #ff3c63" (click)="start()">Click here</span> to retry</span>
    </div>

    @if (dialogs.todo(); as request) {
      <t-todo-dialog [data]="request.data" [workspace]="store.workspace()!" [save]="request.save" [done]="closeTodoDialog" />
    }
    @if (dialogs.confirm(); as data) {
      <t-confirm-dialog [data]="data" [done]="closeConfirm" />
    }
    @if (dialogs.project(); as project) {
      <t-project-dialog [initialName]="project.name" [initialDescription]="project.description" [editing]="project.editing"
                        [save]="saveProject" [done]="closeProject" />
    }
    @if (dialogs.checkIn(); as request) {
      <t-checkin-dialog [name]="request.todo.name" [initial]="request.initial" [save]="saveCheckIn(request.todo.id)" [done]="closeCheckIn" />
    }
    @if (dialogs.stats() && store.workspace()) {
      <t-stats-dialog [done]="closeStats" />
    }
    @if (store.failure(); as message) {
      <t-modal #failure (closed)="store.failure.set(null)">
        <div class="modal-content">
          <h4 class="no-select">Oops</h4>
          <p>{{ message }}</p>
        </div>
        <div class="modal-footer">
          <a class="modal-close button white-text" (click)="failure.close()">OK</a>
        </div>
      </t-modal>
    }
  `,
})
export class App {
  protected readonly store = inject(WorkspaceStore);
  protected readonly dialogs = inject(DialogService);
  private readonly router = inject(Router);

  private readonly url = toSignal(
    this.router.events.pipe(filter(event => event instanceof NavigationEnd), map(event => (event as NavigationEnd).urlAfterRedirects)),
    { initialValue: this.router.url },
  );
  protected readonly routeUid = computed(() => /^\/w\/([0-9a-f-]{36})/.exec(this.url())?.[1] ?? null);

  protected readonly closeTodoDialog = () => this.dialogs.todo.set(null);
  protected readonly closeConfirm = () => this.dialogs.confirm.set(null);
  protected readonly closeStats = () => this.dialogs.stats.set(false);
  protected readonly closeProject = () => this.dialogs.project.set(null);
  protected readonly closeCheckIn = () => this.dialogs.checkIn.set(null);
  protected saveCheckIn(id: number) {
    return (progress: number, note: string) => this.store.checkIn(id, progress, note);
  }
  protected readonly saveProject = async (name: string, description: string): Promise<boolean> => {
    if (this.dialogs.project()?.editing) {
      return this.store.updateWorkspace(name, description);
    }
    const uid = await this.store.createWorkspace(name, description);
    if (uid != null) this.go(uid);
    return uid != null;
  };

  constructor() {
    // The page scrollbar gets its own clown color too
    document.documentElement.style.setProperty('--clown', randomClownColor());
    void this.start();
    // The URL decides which workspace is open
    effect(() => {
      const uid = this.routeUid();
      const ready = this.store.connection() === 'ready';
      untracked(async () => {
        if (!ready) return;
        if (uid == null) {
          this.store.close();
          document.title = 'Todo';
        } else if (uid !== this.store.uid()) {
          if (!(await this.store.open(uid))) {
            void this.router.navigateByUrl('/');
          }
        }
      });
    });
    effect(() => {
      const workspace = this.store.workspace();
      if (workspace != null) document.title = `${workspace.name} · Todo`;
    });
  }

  protected async start(): Promise<void> {
    await this.store.start();
  }

  protected editProject(): void {
    const workspace = this.store.workspace();
    if (workspace != null) {
      this.dialogs.project.set({ name: workspace.name, description: workspace.description, editing: true });
    }
  }

  protected go(uid: string): void {
    void this.router.navigate(['/w', uid]);
  }

  protected leave(): void {
    void this.router.navigateByUrl('/');
  }
}

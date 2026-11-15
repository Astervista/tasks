import { ChangeDetectionStrategy, Component, input, OnInit, signal, viewChild } from '@angular/core';
import { Modal } from '../ui/modal';
import { TextField } from '../ui/text-field';

/** Create a project, or rename / describe the open one */
@Component({
  selector: 't-project-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, TextField],
  template: `
    <t-modal #modal (closed)="done()()">
      <div class="modal-content">
        <h4 class="no-select">{{ editing() ? 'Edit project' : 'New project' }}</h4>
        <t-text-field label="Name" helper="The project's title, also the # heading of its TODO.md"
                      error="Please insert a name" [invalid]="nameInvalid()" [(value)]="name" [autofocus]="true"
                      (keydown)="key($event)" />
        <t-text-field label="Description" [multiline]="true" [(value)]="description" />
        @if (editing()) {
          <t-text-field label="Archive done ToDos after (days)" helper="Done top-level ToDos move to TODO.archive.md after this many days"
                        error="A whole number of days, 0 or more" [invalid]="daysInvalid()" [(value)]="days" (keydown)="key($event)" />
        }
      </div>
      <div class="modal-footer">
        <a class="button white-text" style="background-color: #8b65fd" (click)="submit()">OK</a>
        <a class="modal-close button white-text" (click)="modal.close()">Cancel</a>
      </div>
    </t-modal>
  `,
})
export class ProjectDialog implements OnInit {
  readonly initialName = input('');
  readonly initialDescription = input('');
  readonly editing = input(false);
  readonly initialArchiveAfterDays = input<number | null>(null);
  readonly save = input.required<(name: string, description: string, archiveAfterDays: number | null) => Promise<boolean>>();
  readonly done = input.required<() => void>();

  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly nameInvalid = signal(false);
  protected readonly days = signal('');
  protected readonly daysInvalid = signal(false);
  private readonly modal = viewChild.required<Modal>('modal');
  private saving = false;

  ngOnInit(): void {
    this.name.set(this.initialName());
    this.description.set(this.initialDescription());
    this.days.set(String(this.initialArchiveAfterDays() ?? ''));
  }

  protected key(event: KeyboardEvent): void {
    if (event.key === 'Enter') void this.submit();
  }

  protected async submit(): Promise<void> {
    const name = this.name().trim();
    this.nameInvalid.set(name === '');
    const days = this.editing() ? Number(this.days().trim()) : null;
    this.daysInvalid.set(days != null && (this.days().trim() === '' || !Number.isInteger(days) || days < 0));
    if (name === '' || this.daysInvalid() || this.saving) return;
    this.saving = true;
    const ok = await this.save()(name, this.description(), days);
    this.saving = false;
    if (ok) this.modal().close();
  }
}

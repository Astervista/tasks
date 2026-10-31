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
  readonly save = input.required<(name: string, description: string) => Promise<boolean>>();
  readonly done = input.required<() => void>();

  protected readonly name = signal('');
  protected readonly description = signal('');
  protected readonly nameInvalid = signal(false);
  private readonly modal = viewChild.required<Modal>('modal');
  private saving = false;

  ngOnInit(): void {
    this.name.set(this.initialName());
    this.description.set(this.initialDescription());
  }

  protected key(event: KeyboardEvent): void {
    if (event.key === 'Enter') void this.submit();
  }

  protected async submit(): Promise<void> {
    const name = this.name().trim();
    this.nameInvalid.set(name === '');
    if (name === '' || this.saving) return;
    this.saving = true;
    const ok = await this.save()(name, this.description());
    this.saving = false;
    if (ok) this.modal().close();
  }
}

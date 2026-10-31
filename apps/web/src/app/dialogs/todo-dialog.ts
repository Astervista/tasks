import { ChangeDetectionStrategy, Component, computed, input, OnInit, signal, viewChild } from '@angular/core';
import { canMoveTo, depthOf, formatDuration, hasChildren, MAX_DEPTH, parseDuration, TodoFields, TodoId, Workspace } from '@tasks/core';
import { Modal } from '../ui/modal';
import { TextField } from '../ui/text-field';

export interface TodoDialogData {
  /** Edited todo; null to add */
  id: TodoId | null;
  name: string;
  weight: number;
  desc: string;
  estimate: number | null;
  parentId: TodoId | null;
}

/** Add / edit a todo, with the original dialog's fields plus the parent macrotask */
@Component({
  selector: 't-todo-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, TextField],
  template: `
    <t-modal #modal (closed)="closed()">
      <div class="modal-content">
        <h4 class="no-select">{{ data().id == null ? 'Add ToDo' : 'Edit ToDo' }}</h4>
        <t-text-field #title label="Title" helper="Insert a title for the ToDo" error="Please insert a valid title"
                      [invalid]="titleInvalid()" [(value)]="name" [autofocus]="true" (keydown)="enter($event)" />
        <t-text-field #weightField [label]="macro() ? 'Own weight' : 'Weight'"
                      [helper]="macro() ? 'Just the macrotask, not its subtasks (0 = none)' : 'How hard it is'"
                      error="Please insert a valid weight" [invalid]="weightInvalid()" [(value)]="weight"
                      (keydown)="weightKey($event)" />
        <t-text-field [label]="macro() ? 'Own estimate' : 'Estimate'"
                      helper="Optional, e.g. 4h or 1h 30m"
                      error="Please write it like 4h, 90m or 1h 30m" [invalid]="estimateInvalid()" [(value)]="estimate"
                      (keydown)="enter($event)" />
        <div style="margin-top: 30px">
          <label class="select-label" for="parent-select">Part of</label>
          <select id="parent-select" class="browser-default dark-select" (change)="parentId.set(parse($any($event.target).value))">
            <option value="" [selected]="parentId() == null">— top level —</option>
            @for (option of parents(); track option.id) {
              <option [value]="option.id" [selected]="option.id === parentId()">{{ option.label }}</option>
            }
          </select>
        </div>
        <t-text-field label="Description" [multiline]="true" [(value)]="desc" />
      </div>
      <div class="modal-footer">
        <a class="button white-text" style="background-color: #8b65fd" (click)="submit()">OK</a>
        <a class="modal-close button white-text" (click)="modal.close()">Cancel</a>
      </div>
    </t-modal>
  `,
})
export class TodoDialog implements OnInit {
  readonly data = input.required<TodoDialogData>();
  readonly workspace = input.required<Workspace>();
  readonly save = input.required<(fields: TodoFields, parentId: TodoId | null) => Promise<boolean>>();
  readonly done = input.required<() => void>();

  protected readonly name = signal('');
  protected readonly weight = signal('1');
  protected readonly desc = signal('');
  protected readonly estimate = signal('');
  protected readonly estimateInvalid = signal(false);
  protected readonly parentId = signal<TodoId | null>(null);
  protected readonly titleInvalid = signal(false);
  protected readonly weightInvalid = signal(false);
  private readonly modal = viewChild.required<Modal>('modal');
  private readonly weightField = viewChild.required<TextField>('weightField');
  private saving = false;

  /** Editing a macrotask: weight and estimate are its implicit leaf's (the work on it itself) */
  protected readonly macro = computed(() => {
    const id = this.data().id;
    return id != null && hasChildren(this.workspace(), id);
  });

  /** Parents that keep everything within MAX_DEPTH levels and do not create a cycle */
  protected readonly parents = computed(() => {
    const workspace = this.workspace();
    const id = this.data().id;
    return workspace.todos
      .filter(todo => (id == null ? depthOf(workspace, todo.id) < MAX_DEPTH : canMoveTo(workspace, id, todo.id)))
      .map(todo => ({
        id: todo.id,
        label: `${'   '.repeat(depthOf(workspace, todo.id) - 1)}${todo.name}`,
      }));
  });

  ngOnInit(): void {
    const data = this.data();
    this.name.set(data.name);
    this.weight.set(String(data.weight));
    this.desc.set(data.desc);
    this.estimate.set(data.estimate == null ? '' : formatDuration(data.estimate));
    this.parentId.set(data.parentId);
  }

  protected parse(value: string): TodoId | null {
    return value === '' ? null : Number(value);
  }

  protected enter(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      void this.submit();
    }
  }

  /** Arrow keys change the weight (shift: by 10); only numbers can be typed */
  protected weightKey(event: KeyboardEvent): void {
    if (event.key === 'Enter') {
      void this.submit();
      return;
    }
    const delta = event.key === 'ArrowUp' ? 1 : event.key === 'ArrowDown' ? -1 : 0;
    if (delta !== 0) {
      event.preventDefault();
      const current = Number(this.weight());
      if (Number.isFinite(current)) {
        this.weightField().setValue(String(Math.max(0, current + delta * (event.shiftKey ? 10 : 1))));
      }
    } else if (event.key.length === 1 && !/[0-9.]/.test(event.key) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
    }
  }

  protected async submit(): Promise<void> {
    const name = this.name().replace(/[\n\r]/g, ' ').trim();
    const weight = Number(this.weight());
    this.titleInvalid.set(name === '');
    this.weightInvalid.set(!(this.weight().trim() !== '' && Number.isFinite(weight) && weight >= 0));
    const estimateText = this.estimate().trim();
    const estimate = estimateText === '' ? null : parseDuration(estimateText);
    this.estimateInvalid.set(estimateText !== '' && (estimate == null || estimate <= 0));
    if (this.titleInvalid() || this.weightInvalid() || this.estimateInvalid() || this.saving) {
      return;
    }
    this.saving = true;
    const ok = await this.save()({ name, weight, desc: this.desc(), estimate }, this.parentId());
    this.saving = false;
    if (ok) {
      this.modal().close();
    }
  }

  protected closed(): void {
    this.done()();
  }
}

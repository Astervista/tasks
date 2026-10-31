import { ChangeDetectionStrategy, Component, input, viewChild } from '@angular/core';
import { Modal } from '../ui/modal';

export interface ConfirmChoice {
  label: string;
  color?: string;
  action: () => void | Promise<unknown>;
}

export interface ConfirmData {
  title: string;
  text: string;
  /** Rendered right to left like the original footer; Cancel is always added */
  choices: ConfirmChoice[];
  cancelLabel?: string;
}

/** The original "Delete ToDo?" / "Another ToDo is running" style of dialog, with any set of choices */
@Component({
  selector: 't-confirm-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal],
  template: `
    <t-modal #modal (closed)="done()()">
      <div class="modal-content">
        <h4 class="no-select">{{ data().title }}</h4>
        <p>{{ data().text }}</p>
      </div>
      <div class="modal-footer">
        @for (choice of data().choices; track choice.label) {
          <a class="modal-close button white-text" [style.background-color]="choice.color" (click)="choose(choice)">{{ choice.label }}</a>
        }
        <a class="modal-close button white-text" (click)="modal.close()">{{ data().cancelLabel ?? 'Cancel' }}</a>
      </div>
    </t-modal>
  `,
})
export class ConfirmDialog {
  readonly data = input.required<ConfirmData>();
  readonly done = input.required<() => void>();
  private readonly modal = viewChild.required<Modal>('modal');

  protected choose(choice: ConfirmChoice): void {
    this.modal().close();
    void choice.action();
  }
}

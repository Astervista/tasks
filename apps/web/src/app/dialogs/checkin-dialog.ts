import { ChangeDetectionStrategy, Component, input, OnInit, signal, viewChild } from '@angular/core';
import { Modal } from '../ui/modal';
import { TextField } from '../ui/text-field';

/** "How far along is it?": a progress report that refines the ETA */
@Component({
  selector: 't-checkin-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, TextField],
  template: `
    <t-modal #modal (closed)="done()()">
      <div class="modal-content">
        <h4 class="no-select">Check in</h4>
        <p>How far along is “{{ name() }}”?</p>
        <div class="checkin-steps">
          @for (step of steps; track step) {
            <span class="sub-folder" [class.selected]="progress() === step" [attr.sub-level]="'s' + ($index % 7)"
                  (click)="progress.set(step)">{{ step }}%</span>
          }
        </div>
        <p class="range-field">
          <input type="range" min="0" max="100" step="5" [value]="progress()" (input)="progress.set(+$any($event.target).value)" />
        </p>
        <t-text-field label="Note (optional)" [(value)]="note" (keydown)="key($event)" />
      </div>
      <div class="modal-footer">
        <a class="button white-text" style="background-color: #8b65fd" (click)="submit()">Check in · {{ progress() }}%</a>
        <a class="modal-close button white-text" (click)="modal.close()">Cancel</a>
      </div>
    </t-modal>
  `,
})
export class CheckInDialog implements OnInit {
  readonly name = input.required<string>();
  readonly initial = input<number | null>(null);
  readonly save = input.required<(progress: number, note: string) => Promise<boolean>>();
  readonly done = input.required<() => void>();

  protected readonly steps = [10, 25, 50, 75, 90];
  protected readonly progress = signal(25);
  protected readonly note = signal('');
  private readonly modal = viewChild.required<Modal>('modal');

  ngOnInit(): void {
    const initial = this.initial();
    if (initial != null) this.progress.set(Math.round(initial * 100));
  }

  protected key(event: KeyboardEvent): void {
    if (event.key === 'Enter') void this.submit();
  }

  protected async submit(): Promise<void> {
    if (await this.save()(this.progress() / 100, this.note())) {
      this.modal().close();
    }
  }
}

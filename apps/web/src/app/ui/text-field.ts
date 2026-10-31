import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  computed,
  ElementRef,
  input,
  model,
  output,
  signal,
  viewChild,
} from '@angular/core';
import { Clown } from './clown';

let nextId = 0;

/** Materialize text input: floating label, helper text, red error text when invalid */
@Component({
  selector: 't-text-field',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Clown],
  template: `
    <div class="input-field col s6" [style.margin-top]="multiline() ? '20px' : '30px'" style="margin-bottom: 0">
      @if (multiline()) {
        <textarea #field tClown [id]="id" class="materialize-textarea" [value]="value()"
                  (input)="changed($event)" (focus)="focused.set(true)" (blur)="focused.set(false)"></textarea>
      } @else {
        <input #field [id]="id" type="text" autocomplete="off" [value]="value()" [class.invalid]="invalid()"
               (input)="changed($event)" (focus)="focused.set(true)" (blur)="focused.set(false)"
               (keydown)="keydown.emit($event)" />
      }
      <label [for]="id" [class.active]="active()">{{ label() }}</label>
      @if (helper()) {
        <span class="helper-text" [attr.data-error]="error()">{{ helper() }}</span>
      }
    </div>
  `,
})
export class TextField {
  readonly label = input.required<string>();
  readonly helper = input('');
  readonly error = input('');
  readonly invalid = input(false);
  readonly multiline = input(false);
  readonly autofocus = input(false);
  readonly value = model('');
  readonly keydown = output<KeyboardEvent>();

  protected readonly id = `field-${nextId++}`;
  protected readonly focused = signal(false);
  protected readonly active = computed(() => this.focused() || this.value() !== '');
  private readonly field = viewChild<ElementRef<HTMLInputElement | HTMLTextAreaElement>>('field');

  constructor() {
    afterNextRender(() => {
      this.resize();
      if (this.autofocus()) {
        this.field()?.nativeElement.focus();
      }
    });
  }

  /** Programmatic value change (keeps the caret logic of the browser out of the way) */
  setValue(value: string): void {
    this.value.set(value);
    const element = this.field()?.nativeElement;
    if (element != null) element.value = value;
  }

  protected changed(event: Event): void {
    this.value.set((event.target as HTMLInputElement).value);
    this.resize();
  }

  /** Grows the textarea with its content, like Materialize's autoresize */
  private resize(): void {
    const element = this.field()?.nativeElement;
    if (element instanceof HTMLTextAreaElement) {
      element.style.height = 'auto';
      element.style.height = `${Math.max(100, element.scrollHeight)}px`;
    }
  }
}

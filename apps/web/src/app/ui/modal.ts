import { ChangeDetectionStrategy, Component, HostListener, output, signal } from '@angular/core';
import { Clown } from './clown';

/**
 * Materialize's modal (same markup and classes, so legacy.css styles it), animated in CSS.
 * The parent renders it while needed and removes it on (closed), after the closing animation.
 */
@Component({
  selector: 't-modal',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Clown],
  template: `
    <div class="modal-overlay open" [class.modal-in]="!closing()" [class.modal-out]="closing()" (click)="close()"></div>
    <div class="modal open" role="dialog" aria-modal="true" tClown
         [class.modal-in]="!closing()" [class.modal-out]="closing()" (animationend)="animationEnd($event)">
      <ng-content />
    </div>
  `,
})
export class Modal {
  readonly closed = output<void>();
  protected readonly closing = signal(false);

  close(): void {
    this.closing.set(true);
  }

  @HostListener('document:keydown.escape')
  protected escape(): void {
    this.close();
  }

  protected animationEnd(event: AnimationEvent): void {
    if (this.closing() && event.animationName === 'modal-out') {
      this.closed.emit();
    }
  }
}

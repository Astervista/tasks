import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';

/** Pixels of drag (or wheel) that double the zoom */
const PER_DOUBLING = 80;

/**
 * An endless rolling dial: drag it sideways (or scroll over it) and the ridges roll, the value
 * grows or shrinks exponentially. Double-click goes back to 1 (fit).
 */
@Component({
  selector: 't-zoom-dial',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: {
    class: 'zoom-dial',
    title: 'Drag or scroll to zoom · double-click to fit',
    '(pointerdown)': 'grab($event)',
    '(pointermove)': 'drag($event)',
    '(pointerup)': 'release($event)',
    '(pointercancel)': 'release($event)',
    '(wheel)': 'wheel($event)',
    '(dblclick)': 'changed.emit(1)',
  },
  template: `
    <span class="zoom-dial-wheel" [style.background-position]="'0 0, ' + roll() + 'px 0'"></span>
    <span class="zoom-dial-value">{{ label() }}</span>
  `,
})
export class ZoomDial {
  readonly value = input.required<number>();
  readonly min = input(1 / 64);
  readonly max = input(16384);
  readonly changed = output<number>();

  private dragging: { x: number } | null = null;

  /**
   * How far the wheel has turned: every drag and scroll turns it, even past the limits, so it never
   * stops rolling; the value follows it but stays within min … max.
   */
  protected readonly roll = signal(0);
  protected readonly label = computed(() => {
    const value = this.value();
    if (Math.abs(value - 1) < 0.02) return 'fit';
    return `${value < 10 ? Number(value.toFixed(value < 1 ? 2 : 1)) : Math.round(value)}×`;
  });

  protected grab(event: PointerEvent): void {
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    this.dragging = { x: event.clientX };
  }

  protected drag(event: PointerEvent): void {
    if (this.dragging == null) return;
    this.turn(event.clientX - this.dragging.x);
    this.dragging = { x: event.clientX };
  }

  protected release(event: PointerEvent): void {
    this.dragging = null;
    (event.currentTarget as HTMLElement).releasePointerCapture?.(event.pointerId);
  }

  protected wheel(event: WheelEvent): void {
    event.preventDefault();
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : -event.deltaY;
    this.turn(delta / 3);
  }

  /** Turns the wheel by `pixels` (right = zoom in) */
  private turn(pixels: number): void {
    this.roll.update(roll => roll + pixels);
    const value = Math.min(this.max(), Math.max(this.min(), this.value() * 2 ** (pixels / PER_DOUBLING)));
    if (value !== this.value()) this.changed.emit(value);
  }
}

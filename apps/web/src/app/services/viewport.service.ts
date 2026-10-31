import { Injectable, signal } from '@angular/core';

/** Phone-sized screens, where the layout gets compact (the same breakpoint as styles.css) */
export const COMPACT_QUERY = '(max-width: 700px)';

@Injectable({ providedIn: 'root' })
export class ViewportService {
  private readonly query = window.matchMedia(COMPACT_QUERY);
  readonly compact = signal(this.query.matches);

  constructor() {
    this.query.addEventListener('change', event => this.compact.set(event.matches));
  }
}

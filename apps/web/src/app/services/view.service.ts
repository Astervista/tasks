import { Injectable, signal } from '@angular/core';

export type ListView = 'table' | 'timeline';


/** How the open project's todos are shown: the table, or the same rows on a time axis */
@Injectable({ providedIn: 'root' })
export class ViewService {
  readonly mode = signal<ListView>(read('tasks-view') === 'timeline' ? 'timeline' : 'table');
  readonly zoom = signal<number>(readZoom());

  setMode(mode: ListView): void {
    this.mode.set(mode);
    write('tasks-view', mode);
  }

  setZoom(zoom: number): void {
    this.zoom.set(zoom);
    write('tasks-timeline-zoom', zoom.toFixed(3));
  }
}

/** Timeline zoom: the stretched timeline's length, in widths of the visible track (1 = fit; less packs it tighter, down to the beads' own widths) */
function readZoom(): number {
  const value = Number(read('tasks-timeline-zoom'));
  return Number.isFinite(value) && value > 0 ? value : 1;
}

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // not remembered
  }
}

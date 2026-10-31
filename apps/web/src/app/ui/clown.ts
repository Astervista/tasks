import { Directive, ElementRef, inject } from '@angular/core';

/** The chip palette: every scrolling surface gets one of these for its scrollbar */
export const CLOWN_COLORS = ['#ff2222', 'orangered', 'orange', 'teal', 'royalblue', '#c4f', 'deeppink', 'gold', 'forestgreen', '#8b65fd'];

export function randomClownColor(): string {
  return CLOWN_COLORS[Math.floor(Math.random() * CLOWN_COLORS.length)];
}

/** Gives the element (and what scrolls inside it) a random clown-colored scrollbar */
@Directive({ selector: '[tClown]' })
export class Clown {
  constructor() {
    inject<ElementRef<HTMLElement>>(ElementRef).nativeElement.style.setProperty('--clown', randomClownColor());
  }
}

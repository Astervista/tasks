import { Injectable } from '@angular/core';

interface Particle {
  element: HTMLSpanElement;
  position: [number, number];
  velocity: [number, number];
  terminal: number;
  drag: number;
  gravity: number;
  twirlAmpl: number;
  angleX: number;
  angleY: number;
  angleZ: number;
  angleSpeed: number;
}

/** The original confetti burst, on the #effects layer */
@Injectable({ providedIn: 'root' })
export class ConfettiService {
  private interval: ReturnType<typeof setInterval> | null = null;

  burst(): void {
    const container = document.getElementById('effects');
    if (container == null) return;
    if (this.interval != null) clearInterval(this.interval);
    container.replaceChildren();
    const particles: Particle[] = [];
    const frameLength = 1000 / 30;
    const frameLengthScaled = frameLength * 3;
    const bias = Math.random() * 0.3 + 0.35;
    const offsetHeight = container.offsetHeight;

    const generate = (): Particle => {
      const direction = Math.random() > bias;
      const element = document.createElement('span');
      element.className = 'particle';
      element.style.backgroundColor = `hsl(${Math.random() * 359}, ${Math.random() * 20 + 80}%, ${Math.random() * 20 + 50}%)`;
      element.style.width = `${Math.random() * 8 + 6}px`;
      element.style.height = `${Math.random() * 8 + 6}px`;
      element.style.borderRadius = `${Math.random() * 8}px`;
      element.style.display = 'none';
      container.append(element);
      const angle = 1.1 * Math.random() + 0.4;
      const velocityScaling = 0.4 + Math.random() * 0.8;
      return {
        element,
        position: [(direction ? 0 : 1) * container.offsetWidth, offsetHeight],
        velocity: [
          (direction ? 1 : -1) * frameLengthScaled * Math.cos(angle) * velocityScaling,
          -frameLengthScaled * Math.sin(angle) * velocityScaling,
        ],
        terminal: 0.3 * frameLengthScaled * (0.8 + Math.random() * 0.4),
        drag: 1 - 0.003 * frameLength * (0.8 + Math.random() * 0.4),
        gravity: 7e-3 * frameLengthScaled * (0.8 + Math.random() * 0.4),
        twirlAmpl: offsetHeight * 0.01 * (0.8 + Math.random() * 0.4),
        angleX: Math.random() * 6,
        angleY: Math.random() * 6,
        angleZ: Math.random() * 6,
        angleSpeed: 0.0035 * frameLength * (0.8 + Math.random() * 0.4),
      };
    };

    for (let i = 0; i < 30; i++) particles.push(generate());
    const start = Date.now();
    this.interval = setInterval(() => {
      container.style.display = '';
      if (particles.length < 100 && Math.random() < 0.7 && Date.now() - start < 10000) {
        particles.push(generate());
      }
      if (particles.length === 0 && this.interval != null) {
        clearInterval(this.interval);
        this.interval = null;
      }
      for (let i = particles.length - 1; i >= 0; i--) {
        const p = particles[i];
        const twirl = p.twirlAmpl * (1.2 + Math.sin(p.angleY) * 0.4);
        const top = p.position[1] + twirl * (Math.cos(p.angleX) * 0.6 * Math.sin(p.angleX));
        p.element.style.display = '';
        p.element.style.left = `${p.position[0] + twirl * 2 * Math.sin(p.angleX)}px`;
        p.element.style.top = `${top}px`;
        p.element.style.transform = `rotateX(${p.angleX}rad) rotateY(${p.angleY}rad) rotateZ(${p.angleZ}rad)`;
        p.position[0] += p.velocity[0];
        p.position[1] += p.velocity[1];
        p.velocity[0] *= p.drag;
        p.velocity[1] = Math.min(p.terminal, p.velocity[1] * p.drag + p.gravity);
        p.angleX -= p.angleSpeed;
        p.angleY -= p.angleSpeed * 0.6;
        p.angleZ -= p.angleSpeed * 0.4;
        if (top > offsetHeight + 30) {
          p.element.remove();
          particles.splice(i, 1);
        }
      }
    }, frameLength);
  }
}

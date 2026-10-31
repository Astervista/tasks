import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AuthService } from '../services/api.service';
import { Modal } from '../ui/modal';
import { TextField } from '../ui/text-field';

/** Asks once for the server token (the TASKS_TOKEN of the server) */
@Component({
  selector: 't-login-dialog',
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [Modal, TextField],
  template: `
    <t-modal>
      <div class="modal-content">
        <h4 class="no-select">Hello there!</h4>
        <p>This server needs its access token (the <code>TASKS_TOKEN</code> it was started with).</p>
        <t-text-field label="Token" helper="It stays in this browser" error="That token was refused"
                      [invalid]="refused()" [(value)]="token" [autofocus]="true" (keydown)="key($event)" />
      </div>
      <div class="modal-footer">
        <a class="button white-text" style="background-color: #8b65fd" (click)="submit()">Enter</a>
      </div>
    </t-modal>
  `,
})
export class LoginDialog {
  private readonly auth = inject(AuthService);
  protected readonly token = signal('');
  protected readonly refused = signal(this.auth.token() != null);

  protected key(event: KeyboardEvent): void {
    if (event.key === 'Enter') this.submit();
  }

  protected submit(): void {
    const token = this.token().trim();
    if (token !== '') {
      this.auth.set(token);
    }
  }
}

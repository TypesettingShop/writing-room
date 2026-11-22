import { $, addDisposableListener, append } from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { ManuscriptAuth } from '../../../services/manuscript/common/manuscriptService.js';

export class WelcomeAccount extends Disposable {
  private readonly form: HTMLFormElement;
  private readonly email: HTMLInputElement;
  private readonly password: HTMLInputElement;
  private readonly submit: HTMLButtonElement;
  private readonly switchMode: HTMLButtonElement;
  private readonly error: HTMLElement;
  private readonly google: HTMLAnchorElement;
  private readonly window: Window;
  private createAccount = false;
  private submitting = false;
  private providers: Promise<boolean> | undefined;

  constructor(parent: HTMLElement, private readonly auth: ManuscriptAuth | undefined) {
    super();
    this.window = parent.ownerDocument.defaultView!;
    this.error = append(parent, $('p.welcome-account-error', { role: 'alert' }));
    this.form = append(parent, $('form', { class: 'welcome-account-form', method: 'post', novalidate: '', hidden: '' }));
    this.email = append(append(this.form, $('label', null, 'Email')), $('input', {
      type: 'email', name: 'email', autocomplete: 'username', required: '',
    }));
    this.password = append(append(this.form, $('label', null, 'Password')), $('input', {
      type: 'password', name: 'password', required: '',
    }));
    const actions = append(this.form, $('.welcome-account-actions'));
    this.submit = append(actions, $('button', { type: 'submit' }));
    this.switchMode = append(actions, $('button', { type: 'button' }));
    this.google = append(this.form, $('a', { hidden: '' }, 'Continue with Google'));
    this.setMode(false);
    this._register(addDisposableListener(this.form, 'submit', event => {
      event.preventDefault();
      void this.submitCredentials();
    }));
    this._register(addDisposableListener(this.switchMode, 'click', () => this.setMode(!this.createAccount)));
    this._register(addDisposableListener(this.google, 'focus', () => this.updateGoogleLink()));
    this._register(addDisposableListener(this.google, 'click', () => this.updateGoogleLink()));
  }

  get visible(): boolean {
    return !this.form.hidden;
  }

  show(): void {
    if (!this.auth || this.visible) {
      return;
    }
    this.form.hidden = false;
    const providers = this.auth.hasGoogle().catch(() => false);
    this.providers = providers;
    void providers.then(google => {
      if (this.providers === providers && google) {
        this.updateGoogleLink();
        this.google.hidden = false;
      }
    });
  }

  hide(): void {
    if (!this.visible) {
      return;
    }
    this.providers = undefined;
    this.form.hidden = true;
    this.google.hidden = true;
    this.email.value = '';
    this.setMode(false);
  }

  showGoogleCancellation(): void {
    this.showError('Google sign-in was canceled.');
  }

  override dispose(): void {
    this.hide();
    super.dispose();
  }

  private updateGoogleLink(): void {
    const { pathname, search } = this.window.location;
    this.google.href = '/api/auth/oauth/google/start?' + new URLSearchParams({ returnTo: pathname + search });
  }

  private showError(message: string): void {
    this.error.textContent = message;
  }

  private setMode(createAccount: boolean): void {
    this.createAccount = createAccount;
    this.form.action = createAccount ? '/api/auth/signup' : '/api/auth/login';
    this.password.autocomplete = createAccount ? 'new-password' : 'current-password';
    this.password.value = '';
    this.submit.textContent = createAccount ? 'Create Account' : 'Sign In';
    this.switchMode.textContent = createAccount ? 'Sign In' : 'Create Account';
    this.showError('');
  }

  private async submitCredentials(): Promise<void> {
    if (!this.auth || !this.visible || this.submitting) {
      return;
    }
    this.showError('');
    this.setSubmitting(true);
    try {
      await this.auth.signIn(this.email.value, this.password.value, this.createAccount);
    } catch (error) {
      if (this.visible) {
        this.showError(error instanceof Error ? error.message : 'Could not sign in. Try again.');
      }
    } finally {
      this.password.value = '';
      this.setSubmitting(false);
    }
  }

  private setSubmitting(submitting: boolean): void {
    this.submitting = submitting;
    this.email.readOnly = submitting;
    this.password.readOnly = submitting;
    this.submit.disabled = submitting;
    this.switchMode.disabled = submitting;
    this.google.inert = submitting;
  }
}

import { ApiFailure, apiFetch, GENERIC_FAILURE } from './api.js';
import { byId, el, setText, setVisible, text } from './dom.js';

interface Account {
  id: string;
  email: string;
}

function asFailure(error: unknown): ApiFailure {
  return error instanceof ApiFailure ? error : new ApiFailure(0, 'unknown', GENERIC_FAILURE);
}

function start(): void {
  const status = byId('status');
  const signedOut = byId('signed-out');
  const signedIn = byId('signed-in');
  const signInForm = byId<HTMLFormElement>('signin-form');
  const registerForm = byId<HTMLFormElement>('register-form');
  const toggle = byId<HTMLButtonElement>('toggle-panel');
  const alertRegion = byId('signed-out-alert');
  const accountEmail = byId('account-email');
  const logoutButton = byId<HTMLButtonElement>('logout');

  // Module scope only: no token, no email, no id in localStorage or a readable
  // cookie. The session stays where F-002 put it.
  let account: Account | undefined;

  function clearAlert(): void {
    alertRegion.replaceChildren();
    setVisible(alertRegion, false);
  }

  function showAlert(failure: ApiFailure): void {
    alertRegion.replaceChildren();
    if (failure.status >= 500 || failure.code === 'unknown' || failure.status === 0) {
      alertRegion.appendChild(text(failure.status === 0 ? failure.message : GENERIC_FAILURE));
      if (failure.requestId) {
        alertRegion.appendChild(el('span', ` Reference: ${failure.requestId}`));
      }
    } else {
      // 4xx messages from this API are already written for a person to read.
      alertRegion.appendChild(text(failure.message));
    }
    setVisible(alertRegion, true);
    alertRegion.focus();
  }

  function showSignedIn(next: Account): void {
    account = next;
    setText(accountEmail, next.email);
    setVisible(signedOut, false);
    setVisible(signedIn, true);
  }

  function showSignedOut(): void {
    account = undefined;
    setText(accountEmail, '');
    setVisible(signedIn, false);
    setVisible(signedOut, true);
    showSignInForm();
  }

  function showSignInForm(): void {
    setVisible(signInForm, true);
    setVisible(registerForm, false);
    setText(toggle, 'Create an account');
  }

  function showRegisterForm(): void {
    setVisible(signInForm, false);
    setVisible(registerForm, true);
    setText(toggle, 'Sign in instead');
  }

  async function submitCredentials(form: HTMLFormElement, path: string): Promise<void> {
    const button = form.querySelector<HTMLButtonElement>('button[type="submit"]');
    const body = {
      email: form.querySelector<HTMLInputElement>('input[name="email"]')?.value ?? '',
      password: form.querySelector<HTMLInputElement>('input[name="password"]')?.value ?? '',
    };

    // Disabling the button until the request settles is also the double-submit guard.
    if (button) button.disabled = true;
    try {
      clearAlert();
      showSignedIn(await apiFetch<Account>(path, { method: 'POST', body }));
      form.reset();
    } catch (error) {
      showAlert(asFailure(error));
    } finally {
      if (button) button.disabled = false;
    }
  }

  async function logOut(): Promise<void> {
    logoutButton.disabled = true;
    try {
      await apiFetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Any failure still returns the browser to the signed-out state.
    } finally {
      logoutButton.disabled = false;
      clearAlert();
      showSignedOut();
    }
  }

  async function bootstrap(): Promise<void> {
    try {
      showSignedIn(await apiFetch<Account>('/api/auth/me'));
    } catch (error) {
      const failure = asFailure(error);
      showSignedOut();
      // 401 is the expected first visit, not an error worth showing.
      if (failure.status !== 401) showAlert(failure);
    } finally {
      setVisible(status, false);
    }
  }

  signInForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCredentials(signInForm, '/api/auth/login');
  });

  registerForm.addEventListener('submit', (event) => {
    event.preventDefault();
    void submitCredentials(registerForm, '/api/auth/register');
  });

  toggle.addEventListener('click', () => {
    clearAlert();
    if (registerForm.hidden) showRegisterForm();
    else showSignInForm();
  });

  logoutButton.addEventListener('click', () => {
    if (account) void logOut();
  });

  clearAlert();
  void bootstrap();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => start(), { once: true });
} else {
  start();
}

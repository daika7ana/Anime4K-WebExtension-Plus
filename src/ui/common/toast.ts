/**
 * Shared themed toast notification system.
 *
 * Replaces `alert()` calls with non-blocking, auto-dismissing themed toasts
 * that stack vertically and respect the Material Design 3 theme system.
 */

export type ToastType = 'info' | 'success' | 'error';

const CONTAINER_ID = 'anime4k-toast-container';
const TOAST_CLASS = 'anime4k-toast';
const REMOVING_CLASS = 'removing';
const EXIT_ANIMATION_MS = 200;

const ICON_MAP: Readonly<Record<ToastType, string>> = {
  info: '\u2139\uFE0F',
  success: '\u2705',
  error: '\u26A0\uFE0F',
};

function getOrCreateContainer(): HTMLElement | null {
  let container = document.getElementById(CONTAINER_ID);
  if (container) return container;
  if (!document.body) return null;

  container = document.createElement('div');
  container.id = CONTAINER_ID;
  document.body.appendChild(container);
  return container;
}

function createToastElement(message: string, type: ToastType): HTMLElement {
  const toast = document.createElement('div');
  toast.className = `${TOAST_CLASS} toast-${type}`;

  const icon = document.createElement('span');
  icon.className = 'toast-icon';
  icon.textContent = ICON_MAP[type];

  const msg = document.createElement('span');
  msg.className = 'toast-message';
  msg.textContent = message;

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.setAttribute('aria-label', 'Close');
  close.textContent = '\u00D7';

  toast.appendChild(icon);
  toast.appendChild(msg);
  toast.appendChild(close);
  return toast;
}

/**
 * Remove a toast element and clear its auto-dismiss timer.
 * @param toast - The toast HTMLElement returned by showToast.
 */
export function removeToast(toast: HTMLElement): void {
  if (!toast.parentNode) return;

  const timerId = Number(toast.dataset.timerId);
  if (timerId) {
    clearTimeout(timerId);
    delete toast.dataset.timerId;
  }

  toast.classList.add(REMOVING_CLASS);
  setTimeout(() => {
    toast.remove();
  }, EXIT_ANIMATION_MS);
}

/**
 * Show a themed toast notification.
 *
 * @param message - The message text to display.
 * @param type - Toast variant: 'info' (default), 'success', or 'error'.
 *   Controls color/icon via CSS classes (toast-info, toast-success, toast-error).
 * @param durationMs - Auto-dismiss duration in milliseconds. Defaults to 4000.
 *   Set to 0 to disable auto-dismiss (manual close only).
 * @returns The created toast HTMLElement (mainly for testing).
 */
export function showToast(message: string, type: ToastType = 'info', durationMs = 4000): HTMLElement {
  const container = getOrCreateContainer();
  if (!container) {
    // Defensive: no document.body available (e.g. non-DOM environment)
    const dummy = document.createElement('div');
    dummy.className = `${TOAST_CLASS} toast-${type}`;
    return dummy;
  }

  const toast = createToastElement(message, type);

  // Manual close via close button
  const closeBtn = toast.querySelector<HTMLButtonElement>('.toast-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      removeToast(toast);
    });
  }

  // Auto-dismiss timer
  if (durationMs > 0) {
    const timerId = window.setTimeout(() => {
      removeToast(toast);
    }, durationMs);
    toast.dataset.timerId = String(timerId);
  }

  container.appendChild(toast);
  return toast;
}

/**
 * Dismiss all active toasts. Useful for cleanup in tests.
 */
export function dismissAllToasts(): void {
  const container = document.getElementById(CONTAINER_ID);
  if (!container) return;

  const toasts = Array.from(container.querySelectorAll<HTMLElement>(`.${TOAST_CLASS}`));
  for (const toast of toasts) {
    removeToast(toast);
  }
}

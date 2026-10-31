import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showToast, removeToast, dismissAllToasts } from './toast';

describe('showToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('creates a toast container on first call', () => {
    expect(document.getElementById('anime4k-toast-container')).toBeNull();

    showToast('Hello');

    const container = document.getElementById('anime4k-toast-container');
    expect(container).not.toBeNull();
    expect(container!.tagName).toBe('DIV');
  });

  it('reuses the existing container on subsequent calls', () => {
    const toast1 = showToast('First');
    const toast2 = showToast('Second');

    const containers = document.querySelectorAll('#anime4k-toast-container');
    expect(containers.length).toBe(1);

    // Both toasts are in the same container
    const container = document.getElementById('anime4k-toast-container')!;
    expect(container.contains(toast1)).toBe(true);
    expect(container.contains(toast2)).toBe(true);
  });

  it('creates a toast with correct classes for type="info" (default)', () => {
    const toast = showToast('Info message');

    expect(toast.classList.contains('anime4k-toast')).toBe(true);
    expect(toast.classList.contains('toast-info')).toBe(true);
  });

  it('creates a toast with correct classes for type="success"', () => {
    const toast = showToast('Success!', 'success');

    expect(toast.classList.contains('anime4k-toast')).toBe(true);
    expect(toast.classList.contains('toast-success')).toBe(true);
  });

  it('creates a toast with correct classes for type="error"', () => {
    const toast = showToast('Error!', 'error');

    expect(toast.classList.contains('anime4k-toast')).toBe(true);
    expect(toast.classList.contains('toast-error')).toBe(true);
  });

  it('sets the message text in the .toast-message element', () => {
    const toast = showToast('Custom message text');

    const msgEl = toast.querySelector('.toast-message');
    expect(msgEl).not.toBeNull();
    expect(msgEl!.textContent).toBe('Custom message text');
  });

  it('contains an icon element', () => {
    const toast = showToast('Test');

    const iconEl = toast.querySelector('.toast-icon');
    expect(iconEl).not.toBeNull();
    expect(iconEl!.textContent).toBeTruthy();
  });

  it('contains a close button', () => {
    const toast = showToast('Test');

    const closeBtn = toast.querySelector<HTMLButtonElement>('.toast-close');
    expect(closeBtn).not.toBeNull();
    expect(closeBtn!.textContent).toContain('\u00D7');
  });

  it('appends toasts to container in stacking order (newest at bottom)', () => {
    const toast1 = showToast('First');
    const toast2 = showToast('Second');
    const toast3 = showToast('Third');

    const container = document.getElementById('anime4k-toast-container')!;
    const children = Array.from(container.children);
    expect(children[0]).toBe(toast1);
    expect(children[1]).toBe(toast2);
    expect(children[2]).toBe(toast3);
  });

  it('returns the toast HTMLElement', () => {
    const toast = showToast('Test');

    expect(toast).toBeInstanceOf(HTMLElement);
    expect(toast.classList.contains('anime4k-toast')).toBe(true);
  });

  it('auto-dismisses after durationMs', () => {
    const toast = showToast('Auto-dismiss', 'info', 2000);

    // Toast should be in the DOM
    expect(document.body.contains(toast)).toBe(true);

    // Advance time past the duration
    vi.advanceTimersByTime(2100);

    // After exit animation delay, toast should be removed
    vi.advanceTimersByTime(200);

    expect(document.body.contains(toast)).toBe(false);
  });

  it('does NOT auto-dismiss when durationMs is 0', () => {
    const toast = showToast('Persistent', 'info', 0);

    expect(document.body.contains(toast)).toBe(true);

    vi.advanceTimersByTime(10000);
    // Even after exit animation delay, still present
    vi.advanceTimersByTime(200);

    expect(document.body.contains(toast)).toBe(true);
  });

  it('close button click removes the toast', () => {
    const toast = showToast('Closable');
    const closeBtn = toast.querySelector<HTMLButtonElement>('.toast-close')!;

    expect(document.body.contains(toast)).toBe(true);

    closeBtn.click();

    // Exit animation timer fires
    vi.advanceTimersByTime(200);

    expect(document.body.contains(toast)).toBe(false);
  });

  it('handles missing document.body defensively (returns a dummy element, no throw)', () => {
    // Remove body to simulate missing document.body
    const body = document.body;
    document.documentElement.removeChild(body);

    const toast = showToast('No body');

    // Should not throw, should return a div
    expect(toast).toBeInstanceOf(HTMLElement);
    expect(toast.tagName).toBe('DIV');
    expect(toast.classList.contains('anime4k-toast')).toBe(true);
    // Should NOT be in document since body doesn't exist
    expect(document.documentElement.contains(toast)).toBe(false);

    // Restore body for cleanup
    document.documentElement.appendChild(body);
  });
});

describe('removeToast', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('removes the toast from the DOM', () => {
    const toast = showToast('Dismiss me');

    expect(document.body.contains(toast)).toBe(true);

    removeToast(toast);
    vi.advanceTimersByTime(200);

    expect(document.body.contains(toast)).toBe(false);
  });

  it('clears the auto-dismiss timer when called before timer fires', () => {
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    const toast = showToast('Early dismiss', 'info', 5000);

    removeToast(toast);
    vi.advanceTimersByTime(200);

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it('no-op if the toast is already removed', () => {
    const toast = showToast('Already gone');

    // Remove the toast from the DOM manually
    toast.remove();

    // Should not throw
    expect(() => removeToast(toast)).not.toThrow();
  });

  it('no-op if removeToast is called twice', () => {
    const toast = showToast('Double dismiss');

    removeToast(toast);
    vi.advanceTimersByTime(200);

    // Second call on already-removed toast should not throw
    expect(() => removeToast(toast)).not.toThrow();
  });
});

describe('dismissAllToasts', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('removes all toasts from the container', () => {
    const toast1 = showToast('Toast A');
    const toast2 = showToast('Toast B');
    const toast3 = showToast('Toast C');

    dismissAllToasts();
    vi.advanceTimersByTime(200);

    expect(document.body.contains(toast1)).toBe(false);
    expect(document.body.contains(toast2)).toBe(false);
    expect(document.body.contains(toast3)).toBe(false);
  });

  it('leaves the container in the DOM', () => {
    showToast('Test');
    dismissAllToasts();
    vi.advanceTimersByTime(200);

    const container = document.getElementById('anime4k-toast-container');
    expect(container).not.toBeNull();
  });

  it('is safe to call when no toasts exist', () => {
    showToast('Test');
    dismissAllToasts();
    vi.advanceTimersByTime(200);

    // Second call on empty container should not throw
    expect(() => dismissAllToasts()).not.toThrow();
  });

  it('is safe to call when container does not exist', () => {
    // No toast ever shown, so no container
    expect(() => dismissAllToasts()).not.toThrow();
  });
});

/**
 * Material Design Theme Manager
 * Handles theme switching and persistence
 */

type ThemeMode = 'light' | 'dark' | 'auto';

let currentTheme: ThemeMode = 'auto';

/**
 * Apply theme to the DOM
 */
function applyTheme(): void {
  const root = document.documentElement;

  // Remove existing theme classes
  root.classList.remove('light', 'dark');

  if (currentTheme === 'auto') {
    // Auto mode: follow system preference
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (prefersDark) {
      root.classList.add('dark');
    } else {
      root.classList.add('light');
    }
  } else {
    // Manual mode: apply the selected theme directly
    root.classList.add(currentTheme);
  }
}

/**
 * Load theme settings from storage
 */
async function loadTheme(): Promise<void> {
  try {
    const result = await chrome.storage.sync.get(['theme']);
    if (result.theme && ['light', 'dark', 'auto'].includes(result.theme)) {
      currentTheme = result.theme as ThemeMode;
    }
    applyTheme();
  } catch (error) {
    console.warn('Failed to load theme from storage:', error);
    applyTheme();
  }
}

/**
 * Save theme settings to storage
 */
async function saveTheme(): Promise<void> {
  try {
    await chrome.storage.sync.set({ theme: currentTheme });
  } catch (error) {
    console.warn('Failed to save theme to storage:', error);
  }
}

/**
 * Listen for system theme changes
 */
function setupSystemThemeListener(): void {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  mediaQuery.addEventListener('change', () => {
    if (currentTheme === 'auto') {
      applyTheme();
    }
  });
}

/**
 * Set the theme mode
 */
function setTheme(theme: ThemeMode): void {
  currentTheme = theme;
  applyTheme();
  saveTheme();
}

/**
 * Get the current theme mode
 */
function getTheme(): ThemeMode {
  return currentTheme;
}

let initialized = false;

/**
 * Load the saved theme and start following system preference.
 * Call once per page entry; safe to call again (no-op).
 */
function initTheme(): void {
  if (initialized) return;
  initialized = true;
  loadTheme();
  setupSystemThemeListener();
}

export const themeManager = { initTheme, setTheme, getTheme };

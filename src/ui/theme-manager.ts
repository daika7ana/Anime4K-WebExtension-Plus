/**
 * Material Design Theme Manager
 * Handles theme switching and persistence
 */

export type ThemeMode = 'light' | 'dark' | 'auto';

export class ThemeManager {
  private static instance: ThemeManager;
  private currentTheme: ThemeMode = 'auto';

  private constructor() {
    this.loadTheme();
    this.setupSystemThemeListener();
  }

  public static getInstance(): ThemeManager {
    if (!ThemeManager.instance) {
      ThemeManager.instance = new ThemeManager();
    }
    return ThemeManager.instance;
  }

  /**
   * Set the theme mode
   */
  public setTheme(theme: ThemeMode): void {
    this.currentTheme = theme;
    this.applyTheme();
    this.saveTheme();
  }

  /**
   * Get the current theme mode
   */
  public getTheme(): ThemeMode {
    return this.currentTheme;
  }

  /**
   * Apply theme to the DOM
   */
  private applyTheme(): void {
    const root = document.documentElement;
    
    // Remove existing theme classes
    root.classList.remove('light', 'dark');
    
    if (this.currentTheme === 'auto') {
      // Auto mode: follow system preference
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      if (prefersDark) {
        root.classList.add('dark');
      } else {
        root.classList.add('light');
      }
    } else {
      // Manual mode: apply the selected theme directly
      root.classList.add(this.currentTheme);
    }
  }

  /**
   * Load theme settings from storage
   */
  private async loadTheme(): Promise<void> {
    try {
      const result = await chrome.storage.sync.get(['theme']);
      if (result.theme && ['light', 'dark', 'auto'].includes(result.theme)) {
        this.currentTheme = result.theme as ThemeMode;
      }
      this.applyTheme();
    } catch (error) {
      console.warn('Failed to load theme from storage:', error);
      this.applyTheme();
    }
  }

  /**
   * Save theme settings to storage
   */
  private async saveTheme(): Promise<void> {
    try {
      await chrome.storage.sync.set({ theme: this.currentTheme });
    } catch (error) {
      console.warn('Failed to save theme to storage:', error);
    }
  }

  /**
   * Listen for system theme changes
   */
  private setupSystemThemeListener(): void {
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', () => {
      if (this.currentTheme === 'auto') {
        this.applyTheme();
      }
    });
  }

  /**
   * Get the currently applied theme (resolves auto mode)
   */
  public getEffectiveTheme(): 'light' | 'dark' {
    if (this.currentTheme === 'auto') {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    return this.currentTheme;
  }

  /**
   * Switch to the next theme
   */
  public toggleTheme(): void {
    const themes: ThemeMode[] = ['light', 'dark', 'auto'];
    const currentIndex = themes.indexOf(this.currentTheme);
    const nextIndex = (currentIndex + 1) % themes.length;
    this.setTheme(themes[nextIndex]);
  }
}

// Export singleton instance
export const themeManager = ThemeManager.getInstance();
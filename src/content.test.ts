import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted ensures these are available when vi.mock factories execute
const { mockInitializeOnPage, mockDeinitializeOnPage, mockHandleSettingsUpdate,
        mockIsUrlWhitelisted, mockGetWhitelistRules } = vi.hoisted(() => ({
  mockInitializeOnPage: vi.fn(),
  mockDeinitializeOnPage: vi.fn(),
  mockHandleSettingsUpdate: vi.fn(),
  mockIsUrlWhitelisted: vi.fn().mockReturnValue(false),
  mockGetWhitelistRules: vi.fn().mockResolvedValue([]),
}));

vi.mock('@core/video/video-manager', () => ({
  initializeOnPage: mockInitializeOnPage,
  deinitializeOnPage: mockDeinitializeOnPage,
  handleSettingsUpdate: mockHandleSettingsUpdate,
}));

vi.mock('@utils/whitelist', () => ({
  isUrlWhitelisted: mockIsUrlWhitelisted,
  getWhitelistRules: mockGetWhitelistRules,
}));

describe('content.ts', () => {
  let messageListener: (request: any, sender: any, sendResponse: (response?: any) => void) => boolean | void;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInitializeOnPage.mockClear();
    mockDeinitializeOnPage.mockClear();
    mockHandleSettingsUpdate.mockClear();
    mockIsUrlWhitelisted.mockReturnValue(false);
    mockGetWhitelistRules.mockResolvedValue([]);

    // chrome.storage.sync.get is used with await (promise style) in content.ts
    (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
      (_keys: any) => Promise.resolve({ whitelistEnabled: false })
    );
  });

  async function loadContentScript() {
    vi.resetModules();

    let capturedListener: any = null;
    (chrome.runtime.onMessage.addListener as ReturnType<typeof vi.fn>).mockImplementation(
      (listener: any) => { capturedListener = listener; }
    );

    await import('./content.js');
    messageListener = capturedListener;

    // Give async evaluateAndApplyWhitelistState time to complete
    await new Promise(r => setTimeout(r, 50));
  }

  describe('initialization', () => {
    it('calls initializeOnPage when whitelist is disabled', async () => {
      (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
        (_keys: any) => Promise.resolve({ whitelistEnabled: false })
      );

      await loadContentScript();

      expect(mockInitializeOnPage).toHaveBeenCalled();
    });

    it('calls initializeOnPage when whitelist enabled and URL matches', async () => {
      (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
        (_keys: any) => Promise.resolve({ whitelistEnabled: true })
      );
      mockGetWhitelistRules.mockResolvedValue([{ pattern: 'example.com/*', enabled: true }]);
      mockIsUrlWhitelisted.mockReturnValue(true);

      await loadContentScript();

      expect(mockInitializeOnPage).toHaveBeenCalled();
    });

    it('does NOT call initializeOnPage when whitelist enabled and URL does not match', async () => {
      (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
        (_keys: any) => Promise.resolve({ whitelistEnabled: true })
      );
      mockGetWhitelistRules.mockResolvedValue([{ pattern: 'other.com/*', enabled: true }]);
      mockIsUrlWhitelisted.mockReturnValue(false);

      await loadContentScript();

      expect(mockInitializeOnPage).not.toHaveBeenCalled();
    });

    it('defaults to initializing on storage error (extension context invalidated)', async () => {
      (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
        (_keys: any) => Promise.reject(new Error('Extension context invalidated'))
      );

      await loadContentScript();

      expect(mockInitializeOnPage).toHaveBeenCalled();
    });
  });

  describe('message handling', () => {
    it('registers a message listener', async () => {
      await loadContentScript();

      expect(chrome.runtime.onMessage.addListener).toHaveBeenCalled();
      expect(messageListener).toBeDefined();
    });

    it('SETTINGS_UPDATED delegates to handleSettingsUpdate', async () => {
      await loadContentScript();

      const sendResponse = vi.fn();
      const request = { type: 'SETTINGS_UPDATED', settings: { modifiedModeId: 'test' } };

      const result = messageListener(request, {}, sendResponse);

      expect(mockHandleSettingsUpdate).toHaveBeenCalledWith(request.settings, sendResponse);
      expect(result).toBe(true); // async response indicator
    });

    it('URL_UPDATED re-evaluates whitelist state', async () => {
      (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
        (_keys: any) => Promise.resolve({ whitelistEnabled: false })
      );

      await loadContentScript();
      mockInitializeOnPage.mockClear();

      // Send URL_UPDATED — should trigger re-evaluation
      // Since whitelist is disabled and isCurrentlyActive is already true,
      // no action should be taken (state unchanged)
      messageListener({ type: 'URL_UPDATED' }, {}, vi.fn());
      await new Promise(r => setTimeout(r, 50));

      // No re-initialization since already active
      expect(mockInitializeOnPage).not.toHaveBeenCalled();
      expect(mockDeinitializeOnPage).not.toHaveBeenCalled();
    });

    it('unknown message type returns false', async () => {
      await loadContentScript();

      const result = messageListener({ type: 'UNKNOWN_TYPE' }, {}, vi.fn());

      expect(result).toBe(false);
    });
  });

  describe('whitelist state transitions', () => {
    it('deactivates when URL stops matching whitelist', async () => {
      // Start with whitelist matching
      (chrome.storage.sync.get as ReturnType<typeof vi.fn>).mockImplementation(
        (_keys: any) => Promise.resolve({ whitelistEnabled: true })
      );
      mockGetWhitelistRules.mockResolvedValue([{ pattern: 'example.com/*', enabled: true }]);
      mockIsUrlWhitelisted.mockReturnValue(true);

      await loadContentScript();

      expect(mockInitializeOnPage).toHaveBeenCalled();
      mockInitializeOnPage.mockClear();

      // Now URL stops matching
      mockIsUrlWhitelisted.mockReturnValue(false);

      // Trigger re-evaluation via URL_UPDATED
      messageListener({ type: 'URL_UPDATED' }, {}, vi.fn());
      await new Promise(r => setTimeout(r, 50));

      expect(mockDeinitializeOnPage).toHaveBeenCalled();
    });
  });
});

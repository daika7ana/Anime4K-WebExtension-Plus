import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

/**
 * background.ts registers listeners at module load, so its collaborators are
 * mocked and the chrome namespace is augmented before it is imported below.
 */
const mocks = vi.hoisted(() => ({
  ensureLatestConfig: vi.fn(),
  getSettings: vi.fn(),
  getLocalSettings: vi.fn(),
  onMessage: vi.fn(),
  sendTabMessage: vi.fn(),
}));

vi.mock('@utils/migration', () => ({
  ensureLatestConfig: mocks.ensureLatestConfig,
}));

vi.mock('@utils/settings', () => ({
  getSettings: mocks.getSettings,
  getLocalSettings: mocks.getLocalSettings,
}));

vi.mock('@utils/messaging', () => ({
  onMessage: mocks.onMessage,
  sendTabMessage: mocks.sendTabMessage,
}));

type InstalledListener = (details: { reason: string }) => Promise<void>;

let installedListener: InstalledListener | undefined;
let startupListener: (() => Promise<void>) | undefined;

// Augment the shared chrome stub from test-setup.ts with the APIs background.ts
// touches at module load, capturing the registered listeners.
const chromeAny = chrome as unknown as Record<string, any>;
chromeAny.runtime.onInstalled = {
  addListener: vi.fn((fn: InstalledListener) => {
    installedListener = fn;
  }),
};
chromeAny.runtime.onStartup = {
  addListener: vi.fn((fn: () => Promise<void>) => {
    startupListener = fn;
  }),
};
chromeAny.runtime.getURL = vi.fn((path: string) => `chrome-extension://test/${path}`);
chromeAny.runtime.openOptionsPage = vi.fn();
chromeAny.tabs.create = vi.fn();
chromeAny.tabs.query = vi.fn();
chromeAny.tabs.onUpdated = { addListener: vi.fn() };
chromeAny.commands = { onCommand: { addListener: vi.fn() } };
chromeAny.declarativeNetRequest = {
  updateEnabledRulesets: vi.fn().mockResolvedValue(undefined),
};

// Import for side effects (listener registration). Must happen after the
// chrome augmentation above; vi.mock factories remain hoisted. The specifier is
// stored in a variable so TypeScript's node16 resolver does not demand a `.js`
// extension on the dynamic import.
const backgroundModuleSpecifier = './background';

beforeAll(async () => {
  await import(backgroundModuleSpecifier);
});

describe('background onInstalled startup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    mocks.ensureLatestConfig.mockResolvedValue(undefined);
    mocks.getSettings.mockResolvedValue({ enableCrossOriginFix: false });
    mocks.getLocalSettings.mockResolvedValue({ hasCompletedOnboarding: false });
    mocks.onMessage.mockReturnValue(() => {});
    mocks.sendTabMessage.mockResolvedValue(undefined);

    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({});
    chromeAny.declarativeNetRequest.updateEnabledRulesets.mockResolvedValue(undefined);
  });

  it('continues other startup steps when ensureLatestConfig throws', async () => {
    mocks.ensureLatestConfig.mockRejectedValueOnce(new Error('migration boom'));

    await installedListener!({ reason: 'install' });

    expect(mocks.ensureLatestConfig).toHaveBeenCalledTimes(1);
    // checkBenchmarkCrash + updateDNRuleset still ran…
    expect(chrome.storage.local.get).toHaveBeenCalledWith(['_benchmarkInProgress']);
    expect(chromeAny.declarativeNetRequest.updateEnabledRulesets).toHaveBeenCalledTimes(1);
    // …and onboarding still opened.
    expect(mocks.getLocalSettings).toHaveBeenCalled();
    expect(chromeAny.tabs.create).toHaveBeenCalledWith({
      url: 'chrome-extension://test/onboarding.html',
    });
  });

  it('continues later steps when checkBenchmarkCrash throws', async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('storage boom'),
    );

    await installedListener!({ reason: 'update' });

    expect(mocks.ensureLatestConfig).toHaveBeenCalledTimes(1);
    expect(chromeAny.declarativeNetRequest.updateEnabledRulesets).toHaveBeenCalledTimes(1);
    expect(chromeAny.tabs.create).toHaveBeenCalledTimes(1);
  });

  it('does not open onboarding for a non-install/update reason', async () => {
    await installedListener!({ reason: 'chrome_update' });

    expect(chromeAny.tabs.create).not.toHaveBeenCalled();
    expect(chromeAny.declarativeNetRequest.updateEnabledRulesets).toHaveBeenCalledTimes(1);
  });

  it('isolates onStartup steps from each other', async () => {
    (chrome.storage.local.get as unknown as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error('storage boom'),
    );

    await startupListener!();

    expect(chromeAny.declarativeNetRequest.updateEnabledRulesets).toHaveBeenCalledTimes(1);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock CSS imports (they cause issues in jsdom)
vi.mock('./onboarding.css', () => ({}));
vi.mock('../common-vars.css', () => ({}));

// Mock theme manager
const mockInitTheme = vi.fn();
vi.mock('../theme-manager', () => ({
  themeManager: { initTheme: mockInitTheme },
}));

// Mock i18n
const mockApplyI18n = vi.fn();
vi.mock('@utils/i18n', () => ({
  t: vi.fn((key: string) => key),
  applyI18n: mockApplyI18n,
}));

// Mock settings
const mockSaveLocalSettings = vi.fn();
vi.mock('@utils/settings', () => ({
  saveLocalSettings: mockSaveLocalSettings,
}));

// Mock messaging
const mockSendMessage = vi.fn();
vi.mock('@utils/messaging', () => ({
  sendMessage: mockSendMessage,
}));

// Mock GPU benchmark
vi.mock('@core/gpu/gpu-benchmark', () => ({
  runGPUBenchmark: vi.fn(),
}));

function setupDOM(withElements = true): void {
  document.body.innerHTML = withElements
    ? `
    <div class="onboarding-container">
      <div class="step-indicator">
        <div class="step active">1</div>
        <div class="step-line"></div>
        <div class="step">2</div>
        <div class="step-line"></div>
        <div class="step">3</div>
      </div>
      <div class="step-content active" id="step-1">
        <button id="start-test">Start Test</button>
        <button id="skip-test">Skip</button>
      </div>
      <div class="step-content" id="step-2">
        <button id="confirm-tier">Continue</button>
      </div>
      <div class="step-content" id="step-3">
        <button id="finish">Finish</button>
        <button id="open-options">Open Options</button>
      </div>
      <div class="unsupported-screen" id="unsupported-screen" style="display: none;">
        <div class="unsupported-icon">⚠️</div>
        <h2 data-i18n="unsupportedTitle">WebGPU Not Supported</h2>
      </div>
    </div>
  `
    : '';
}

describe('WebGPU fallback onboarding', () => {
  let originalGpu: GPU | undefined;

  beforeEach(() => {
    // Reset mocks
    vi.clearAllMocks();
    // Save original navigator.gpu state
    originalGpu = (navigator as any).gpu;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    // Restore original navigator.gpu
    if (originalGpu === undefined) {
      delete (navigator as any).gpu;
    } else {
      Object.defineProperty(navigator, 'gpu', {
        value: originalGpu,
        configurable: true,
        writable: true,
      });
    }
    vi.resetModules();
  });

  it('shows unsupported screen when navigator.gpu is undefined', async () => {
    // Ensure navigator.gpu is undefined
    delete (navigator as any).gpu;

    setupDOM();

    // Dynamically import to trigger DOMContentLoaded handler with current DOM
    await import('./onboarding.js');

    // Dispatch DOMContentLoaded
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Unsupported screen should be visible
    const unsupportedScreen = document.getElementById('unsupported-screen')!;
    expect(unsupportedScreen.style.display).toBe('block');

    // Step indicator should be hidden
    const stepIndicator = document.querySelector('.step-indicator') as HTMLElement;
    expect(stepIndicator.style.display).toBe('none');

    // Step contents should be hidden
    const stepContents = document.querySelectorAll('.step-content');
    stepContents.forEach(el => {
      expect((el as HTMLElement).style.display).toBe('none');
    });

    // applyI18n should have been called with the unsupported screen
    expect(mockApplyI18n).toHaveBeenCalledWith(unsupportedScreen);

    // Benchmark should NOT have been called
    expect(mockSaveLocalSettings).not.toHaveBeenCalled();
  });

  it('proceeds with normal onboarding when navigator.gpu is available', async () => {
    // Ensure navigator.gpu is defined
    Object.defineProperty(navigator, 'gpu', {
      value: { requestAdapter: vi.fn() },
      configurable: true,
      writable: true,
    });

    setupDOM();

    // Dynamically import to trigger DOMContentLoaded handler
    await import('./onboarding.js');

    // Dispatch DOMContentLoaded
    document.dispatchEvent(new Event('DOMContentLoaded'));

    // Unsupported screen should remain hidden
    const unsupportedScreen = document.getElementById('unsupported-screen')!;
    expect(unsupportedScreen.style.display).toBe('none');

    // Step indicator should be visible (no inline display:none set)
    const stepIndicator = document.querySelector('.step-indicator') as HTMLElement;
    expect(stepIndicator.style.display).not.toBe('none');

    // Step content #1 should be visible (it has "active" class, which makes it display:block via CSS)
    const step1 = document.getElementById('step-1') as HTMLElement;
    expect(step1.classList.contains('active')).toBe(true);

    // Theme should have been initialized
    expect(mockInitTheme).toHaveBeenCalled();
  });
});

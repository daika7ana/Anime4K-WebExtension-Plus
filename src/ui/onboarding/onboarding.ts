import './onboarding.css';
import '../common-vars.css';
import { saveLocalSettings } from '@utils/settings';
import type { BenchmarkProgress } from '@/types';
import { runGPUBenchmark } from '@core/gpu/gpu-benchmark';
import { themeManager } from '../theme-manager';
import type { PerformanceTier, GPUBenchmarkResult } from '@/types';

// Tier display names
const TIER_DISPLAY: Record<PerformanceTier, { icon: string; name: string }> = {
    performance: { icon: '🚀', name: chrome.i18n.getMessage('tierPerformance') || 'Fast' },
    balanced: { icon: '⚖️', name: chrome.i18n.getMessage('tierBalanced') || 'Balanced' },
    quality: { icon: '🎨', name: chrome.i18n.getMessage('tierQuality') || 'Quality' },
    ultra: { icon: '🔬', name: chrome.i18n.getMessage('tierUltra') || 'Ultra' },
};

let currentStep = 1;
let selectedTier: PerformanceTier = 'balanced';
let benchmarkResult: GPUBenchmarkResult | null = null;

document.addEventListener('DOMContentLoaded', async () => {
    // Initialize theme
    themeManager.getTheme();

    // Apply internationalization
    applyI18n();

    // Get elements
    const startTestBtn = document.getElementById('start-test') as HTMLButtonElement;
    const skipTestBtn = document.getElementById('skip-test') as HTMLButtonElement;
    const confirmTierBtn = document.getElementById('confirm-tier') as HTMLButtonElement;
    const finishBtn = document.getElementById('finish') as HTMLButtonElement;
    const openOptionsBtn = document.getElementById('open-options') as HTMLButtonElement;
    const tierButtons = document.querySelectorAll<HTMLButtonElement>('.tier-btn');

    // Step 1: GPU Test
    startTestBtn.addEventListener('click', async () => {
        startTestBtn.disabled = true;
        skipTestBtn.style.display = 'none';

        const testStatus = document.getElementById('test-status')!;
        const progressContainer = document.getElementById('progress-container')!;
        const progressFill = document.getElementById('progress-fill')!;
        const progressText = document.getElementById('progress-text')!;

        testStatus.style.display = 'none';
        progressContainer.style.display = 'block';

        try {
            benchmarkResult = await runGPUBenchmark((progress: BenchmarkProgress) => {
                progressFill.style.width = `${progress.progress * 100}%`;
                if (progress.completed) {
                    progressText.textContent = chrome.i18n.getMessage('testComplete') || 'Test complete!';
                } else {
                    // Convert tier key to internationalized text
                    const tierKey = `tier${progress.tier.charAt(0).toUpperCase()}${progress.tier.slice(1)}` as const;
                    const tierName = chrome.i18n.getMessage(tierKey) || progress.tier;
                    progressText.textContent = chrome.i18n.getMessage('testingTier', [tierName]) || `Testing ${tierName}...`;
                }
            });

            selectedTier = benchmarkResult.tier;

            // Save results
            await saveLocalSettings({
                performanceTier: selectedTier,
                gpuBenchmarkResult: benchmarkResult,
            });

            // Update result display
            updateResultDisplay();

            // Jump to step 2
            goToStep(2);
        } catch (error) {
            console.error('Benchmark failed:', error);
            progressText.textContent = chrome.i18n.getMessage('testFailedDefault') || 'Test failed. Using default settings.';
            selectedTier = 'balanced';

            await saveLocalSettings({ performanceTier: selectedTier });

            setTimeout(() => goToStep(2), 2000);
        }
    });

    // Skip test
    skipTestBtn.addEventListener('click', async () => {
        selectedTier = 'balanced';
        await saveLocalSettings({ performanceTier: selectedTier });
        goToStep(2);
    });

    // Tier selection
    tierButtons.forEach(btn => {
        btn.addEventListener('click', () => {
            const tier = btn.getAttribute('data-tier') as PerformanceTier;
            selectedTier = tier;
            updateTierButtons();
        });
    });

    // Confirm tier
    confirmTierBtn.addEventListener('click', async () => {
        await saveLocalSettings({
            performanceTier: selectedTier,
            hasCompletedOnboarding: true,
        });
        // Notify all renderers to update
        chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED' });
        goToStep(3);
    });

    // Finish
    finishBtn.addEventListener('click', () => {
        window.close();
    });

    openOptionsBtn.addEventListener('click', () => {
        chrome.runtime.openOptionsPage();
        window.close();
    });
});

function applyI18n(): void {
    document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
        const key = el.getAttribute('data-i18n');
        if (key) {
            const message = chrome.i18n.getMessage(key);
            if (message) el.textContent = message;
        }
    });
}

function goToStep(step: number): void {
    // Update step indicators
    document.querySelectorAll('.step').forEach((el, i) => {
        el.classList.remove('active', 'completed');
        if (i + 1 < step) el.classList.add('completed');
        if (i + 1 === step) el.classList.add('active');
    });

    // Update content
    document.querySelectorAll('.step-content').forEach((el, i) => {
        el.classList.toggle('active', i + 1 === step);
    });

    currentStep = step;

    if (step === 2) {
        updateTierButtons();
    }
}

function updateResultDisplay(): void {
    const resultTier = document.getElementById('result-tier')!;
    const resultDesc = document.getElementById('result-desc')!;

    const display = TIER_DISPLAY[selectedTier];
    resultTier.textContent = `${display.icon} ${display.name}`;

    // Only show recommendation text if the selected tier matches the benchmark-recommended tier
    if (benchmarkResult && selectedTier === benchmarkResult.tier) {
        resultDesc.textContent = chrome.i18n.getMessage('resultDesc') || 'This tier is recommended based on your hardware.';
        resultDesc.style.display = 'block';
    } else if (benchmarkResult) {
        // User selected a different tier
        resultDesc.textContent = chrome.i18n.getMessage('manuallySelected') || 'You have selected a different tier.';
        resultDesc.style.display = 'block';
    } else {
        // Test was skipped
        resultDesc.textContent = chrome.i18n.getMessage('defaultTier') || 'Default tier selected.';
        resultDesc.style.display = 'block';
    }
}

function updateTierButtons(): void {
    document.querySelectorAll<HTMLButtonElement>('.tier-btn').forEach(btn => {
        const tier = btn.getAttribute('data-tier');
        btn.classList.toggle('active', tier === selectedTier);
    });

    updateResultDisplay();
}

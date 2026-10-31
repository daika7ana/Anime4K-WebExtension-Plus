import './onboarding.css';
import '../common-vars.css';
import { saveLocalSettings } from '@utils/settings';
import { sendMessage } from '@utils/messaging';
import { t, applyI18n, TIER_DISPLAY } from '@utils/i18n';
import type { BenchmarkProgress } from '@/types';
import { runGPUBenchmark } from '@core/gpu/gpu-benchmark';
import { themeManager } from '../theme-manager';
import type { PerformanceTier, GPUBenchmarkResult } from '@/types';

let selectedTier: PerformanceTier = 'balanced';
let benchmarkResult: GPUBenchmarkResult | null = null;

document.addEventListener('DOMContentLoaded', async () => {
    themeManager.initTheme();

    // Apply internationalization
    applyI18n();

    // Check WebGPU support before proceeding
    if (!navigator.gpu) {
        showUnsupportedScreen();
        return;
    }

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

        const testStatus = document.getElementById('test-status');
        const progressContainer = document.getElementById('progress-container');
        const progressFill = document.getElementById('progress-fill');
        const progressText = document.getElementById('progress-text');
        if (!testStatus || !progressContainer || !progressFill || !progressText) {
          console.error('Required benchmark UI elements not found');
          startTestBtn.disabled = false;
          skipTestBtn.style.display = 'block';
          return;
        }

        testStatus.style.display = 'none';
        progressContainer.style.display = 'block';

        try {
            benchmarkResult = await runGPUBenchmark((progress: BenchmarkProgress) => {
                progressFill.style.width = `${progress.progress * 100}%`;
                if (progress.completed) {
                    progressText.textContent = t('testComplete', 'Test complete!');
                } else {
                    // Convert tier key to internationalized text
                    const tierKey = `tier${progress.tier.charAt(0).toUpperCase()}${progress.tier.slice(1)}` as const;
                    const tierName = t(tierKey, progress.tier);
                    progressText.textContent = t('testingTier', `Testing ${tierName}...`, [tierName]);
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
            progressText.textContent = t('testFailedDefault', 'Test failed. Using default settings.');
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
        sendMessage({ type: 'SETTINGS_UPDATED' });
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

function showUnsupportedScreen(): void {
    // Hide step indicator and all step content
    const stepIndicator = document.querySelector('.step-indicator') as HTMLElement;
    if (stepIndicator) {
        stepIndicator.style.display = 'none';
    }
    document.querySelectorAll('.step-content').forEach(el => {
        (el as HTMLElement).style.display = 'none';
    });

    // Show unsupported screen
    const unsupportedScreen = document.getElementById('unsupported-screen');
    if (unsupportedScreen) {
        unsupportedScreen.style.display = 'block';
        // Apply i18n to the newly visible content
        applyI18n(unsupportedScreen);
    }
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

    if (step === 2) {
        updateTierButtons();
    }
}

function updateResultDisplay(): void {
    const resultTier = document.getElementById('result-tier');
    const resultDesc = document.getElementById('result-desc');
    if (!resultTier || !resultDesc) {
      console.error('Required result display elements not found');
      return;
    }

    const display = TIER_DISPLAY[selectedTier];
    resultTier.textContent = `${display.icon} ${display.name}`;

    // Only show recommendation text if the selected tier matches the benchmark-recommended tier
    if (benchmarkResult && selectedTier === benchmarkResult.tier) {
        resultDesc.textContent = t('resultDesc', 'This tier is recommended based on your hardware.');
        resultDesc.style.display = 'block';
    } else if (benchmarkResult) {
        // User selected a different tier
        resultDesc.textContent = t('manuallySelected', 'You have selected a different tier.');
        resultDesc.style.display = 'block';
    } else {
        // Test was skipped
        resultDesc.textContent = t('defaultTier', 'Default tier selected.');
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

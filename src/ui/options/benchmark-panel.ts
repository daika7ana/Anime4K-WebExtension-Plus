/**
 * Performance Benchmark panel for the options page.
 *
 * Runs a GPU benchmark across all tiers and lets the user apply
 * the recommended tier, or manually switch tiers via the selector.
 */
import { runGPUBenchmark } from '@core/gpu/gpu-benchmark';
import { saveLocalSettings } from '@utils/settings';
import type { PerformanceTier } from '@/types';
import { t, TIER_DISPLAY } from '@utils/i18n';
import { showToast } from '../common/toast';

import type { AppContext } from './modes-panel';

export function initBenchmarkPanel(
  ctx: AppContext,
  runBenchmarkBtn: HTMLButtonElement,
  tierSelect: HTMLSelectElement,
  onTierChanged: () => void,
): void {

  // --- Tier Select Change ---
  tierSelect.addEventListener('change', async (e) => {
    const tier = (e.target as HTMLSelectElement).value as PerformanceTier;
    ctx.setTier(tier);
    await saveLocalSettings({ performanceTier: tier });
    onTierChanged();
    ctx.notifyUpdate();
  });

  // --- Run Benchmark ---
  runBenchmarkBtn.addEventListener('click', async () => {
    runBenchmarkBtn.disabled = true;
    runBenchmarkBtn.textContent = t('testing', 'Testing...');

    // Show progress bar
    const progressContainer = document.getElementById('benchmark-progress');
    const progressFill = document.getElementById('benchmark-progress-fill');
    const progressText = document.getElementById('benchmark-progress-text');
    if (progressContainer) progressContainer.style.display = 'block';

    try {
      const result = await runGPUBenchmark((progress) => {
        if (progressFill) progressFill.style.width = `${progress.progress * 100}%`;
        if (progressText) {
          if (progress.completed) {
            progressText.textContent = t('testComplete', 'Test complete!');
          } else {
            const tierKey = `tier${progress.tier.charAt(0).toUpperCase()}${progress.tier.slice(1)}` as const;
            const tierName = t(tierKey, progress.tier);
            progressText.textContent = t('testingTier', `Testing ${tierName}...`, [tierName]);
          }
        }
      });

      // Ask user whether to apply the recommended tier
      const recommended = TIER_DISPLAY[result.tier];
      const tierLabel = `${recommended.icon} ${recommended.name}`;
      const confirmMessage = t('confirmApplyTier', `Test complete! Recommended tier: ${tierLabel}\n\nApply this tier?`, [tierLabel]);

      if (confirm(confirmMessage)) {
        await saveLocalSettings({
          performanceTier: result.tier,
          gpuBenchmarkResult: result,
        });
        ctx.setTier(result.tier);
        onTierChanged();
        ctx.notifyUpdate(); // Notify all renderers to update
      }
    } catch (error) {
      console.error('Benchmark failed:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      showToast(t('testFailed', 'Test failed') + ': ' + errorMsg, 'error');
    }

    // Hide progress bar
    if (progressContainer) progressContainer.style.display = 'none';
    runBenchmarkBtn.disabled = false;
    runBenchmarkBtn.textContent = t('startTest', 'Start Test');
  });
}

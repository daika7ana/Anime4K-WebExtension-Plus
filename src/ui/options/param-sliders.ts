import type { EnhancementEffect, EffectClassName, ParamSliderConfig } from '../../types';

// ===== Param Slider Configuration =====

/**
 * Factory for sliders that represent a value in the [0, 1] range as a 0–100 percentage.
 * Centralises the toSlider/fromSlider pair so adding a new percent-style param is one line.
 */
const percent = (
  cfg: Omit<ParamSliderConfig, 'toSlider' | 'fromSlider' | 'sliderMin' | 'sliderMax'>,
): ParamSliderConfig => ({
  ...cfg,
  sliderMin: 0,
  sliderMax: 100,
  toSlider: (v) => Math.round(v * 100),
  fromSlider: (v) => v / 100,
});

const PARAM_REGISTRY: Record<EffectClassName, ParamSliderConfig[]> = {
  CAS: [percent({
    paramKey: 'sharpness',
    labelKey: 'sharpness',
    labelFallback: 'Sharpness',
    defaultValue: 0.5,
    formatValue: (v) => Math.round(v * 100) + '%',
  })],
  DoG: [{
    paramKey: 'strength',
    labelKey: 'strength',
    labelFallback: 'Strength',
    sliderMin: 10, sliderMax: 100, defaultValue: 4,
    toSlider: (v) => Math.round(v * 10),
    fromSlider: (v) => v / 10,
    formatValue: (v) => v.toFixed(1),
  }],
  BilateralMean: [
    percent({
      paramKey: 'strength',
      labelKey: 'intensitySigma',
      labelFallback: 'Intensity σ',
      defaultValue: 0.2,
      formatValue: (v) => v.toFixed(2),
    }),
    {
      paramKey: 'strength2',
      labelKey: 'spatialSigma',
      labelFallback: 'Spatial σ',
      sliderMin: 5, sliderMax: 50, defaultValue: 2,
      toSlider: (v) => Math.round(v * 10),
      fromSlider: (v) => v / 10,
      formatValue: (v) => v.toFixed(1),
    },
  ],
  Debanding: [
    percent({
      paramKey: 'strength',
      labelKey: 'debandingStrength',
      labelFallback: 'Debanding',
      defaultValue: 0.5,
      formatValue: (v) => v.toFixed(2),
    }),
    percent({
      paramKey: 'bandThreshold',
      labelKey: 'debandingThreshold',
      labelFallback: 'Threshold',
      defaultValue: 0.08,
      formatValue: (v) => v.toFixed(2),
    }),
  ],
};

/**
 * Renders param sliders for a given effect using the descriptor registry.
 * Only sliders for params present on the effect are rendered.
 */
export function renderParamSliders(
  effect: EnhancementEffect,
  modeId: string,
  effectItem: HTMLElement,
  wrapper: HTMLElement,
  saveCallback: (modeId: string) => Promise<void>,
): void {
  // The className field is typed as a plain string, but only the union members of EffectClassName
  // have registered sliders. Cast at the lookup boundary so a typo elsewhere would still surface
  // as a missing entry (undefined) rather than a type error masking a real bug.
  const configs = PARAM_REGISTRY[effect.className as EffectClassName];
  if (!configs || !effect.params) return;

  for (const cfg of configs) {
    // Auto-populate the default for params that were added after the effect was created
    // (e.g. bandThreshold on a Debanding effect created before the param existed).
    // The default lives in effect.params and gets persisted on the user's first slider change.
    if (!(cfg.paramKey in effect.params!)) {
      effect.params![cfg.paramKey] = cfg.defaultValue;
    }

    const paramContainer = document.createElement('div');
    paramContainer.className = 'effect-param-container';

    const label = document.createElement('label');
    label.textContent = chrome.i18n.getMessage(cfg.labelKey) || cfg.labelFallback;
    label.className = 'effect-param-label';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(cfg.sliderMin);
    slider.max = String(cfg.sliderMax);
    slider.value = String(cfg.toSlider(effect.params[cfg.paramKey] ?? cfg.defaultValue));
    slider.className = 'effect-param-slider';

    const valueDisplay = document.createElement('span');
    valueDisplay.textContent = cfg.formatValue(cfg.fromSlider(Number(slider.value)));
    valueDisplay.className = 'effect-param-value';

    slider.addEventListener('input', () => {
      valueDisplay.textContent = cfg.formatValue(cfg.fromSlider(Number(slider.value)));
    });

    slider.addEventListener('change', async () => {
      const newValue = cfg.fromSlider(Number(slider.value));
      effect.params![cfg.paramKey] = newValue;
      await saveCallback(modeId);
    });

    // Prevent slider interactions from triggering drag on the parent effect item.
    // setPointerCapture ensures pointerup still fires on the slider even if the cursor
    // leaves it (e.g. drags outside) — without it, pointerleave would re-enable drag
    // mid-interaction and the browser could initiate a drag on the effect card.
    slider.addEventListener('pointerdown', (e) => {
      effectItem.draggable = false;
      slider.setPointerCapture(e.pointerId);
    });
    slider.addEventListener('pointerup', () => { effectItem.draggable = true; });
    slider.addEventListener('lostpointercapture', () => { effectItem.draggable = true; });

    paramContainer.appendChild(label);
    paramContainer.appendChild(slider);
    paramContainer.appendChild(valueDisplay);
    wrapper.appendChild(paramContainer);
  }
}

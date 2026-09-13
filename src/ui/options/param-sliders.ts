import type { EnhancementEffect, ParamSliderConfig } from '../../types';
import type { EffectParamSchema } from 'anime4k-webgpu-async';
import { t } from '@utils/i18n';
import { resolveEffectReference } from '@utils/effect-registry';

// ===== Param Slider Configuration =====

/**
 * Presentation overrides applied on top of the generic descriptor-schema
 * defaults, keyed by descriptor id then param key. Only needed where the
 * generic percent / decimal formatting does not already match the established UX.
 */
interface SliderPresentation {
  sliderMin?: number;
  sliderMax?: number;
  toSlider?: (v: number) => number;
  fromSlider?: (v: number) => number;
  formatValue?: (v: number) => string;
}

const PARAM_PRESENTATION: Record<string, Record<string, SliderPresentation>> = {
  'anime4k/Denoise/BilateralMean': { strength: { formatValue: (v) => v.toFixed(2) } },
  'anime4k/Debanding/Debanding': {
    strength: { formatValue: (v) => v.toFixed(2) },
    bandThreshold: { formatValue: (v) => v.toFixed(2) },
  },
};

/**
 * Build one slider config from a numeric descriptor schema param using the
 * generic presentational defaults: `[0,1]` schemas render as a 0–100 percentage,
 * everything else as a 10× scaled slider with one-decimal display.
 */
function buildSliderConfig(
  paramKey: string,
  param: EffectParamSchema,
  presentation?: SliderPresentation,
): ParamSliderConfig {
  const min = param.min ?? 0;
  const max = param.max ?? 1;
  const isPercent = min >= 0 && max <= 1;
  const defaultValue = typeof param.defaultValue === 'number' ? param.defaultValue : 0;

  const base: ParamSliderConfig = {
    paramKey,
    labelKey: param.labelKey ?? paramKey,
    labelFallback: param.labelFallback ?? paramKey,
    sliderMin: isPercent ? 0 : Math.round(min * 10),
    sliderMax: isPercent ? 100 : Math.round(max * 10),
    defaultValue,
    toSlider: isPercent ? (v) => Math.round(v * 100) : (v) => Math.round(v * 10),
    fromSlider: isPercent ? (v) => v / 100 : (v) => v / 10,
    formatValue: isPercent ? (v) => Math.round(v * 100) + '%' : (v) => v.toFixed(1),
  };

  return { ...base, ...presentation };
}

/**
 * Renders param sliders for a given effect, deriving the controls from the
 * resolved descriptor's `paramsSchema`. Only sliders for numeric schema params
 * are rendered.
 */
export function renderParamSliders(
  effect: EnhancementEffect,
  modeId: string,
  effectItem: HTMLElement,
  wrapper: HTMLElement,
  saveCallback: (modeId: string) => Promise<void>,
): void {
  const resolution = resolveEffectReference(effect);
  const descriptor = resolution.status === 'resolved' ? resolution.effect.descriptor : undefined;
  const schema = descriptor?.paramsSchema;
  const params = effect.params;
  if (!schema || !params) return;

  for (const [paramKey, param] of Object.entries(schema)) {
    if (param.type !== 'number') continue;

    const cfg = buildSliderConfig(
      paramKey,
      param,
      descriptor ? PARAM_PRESENTATION[descriptor.id]?.[paramKey] : undefined,
    );

    // Auto-populate the default for params that were added after the effect was created
    // (e.g. bandThreshold on a Debanding effect created before the param existed).
    // The default lives in effect.params and gets persisted on the user's first slider change.
    if (!(cfg.paramKey in params)) {
      params[cfg.paramKey] = cfg.defaultValue;
    }

    const paramContainer = document.createElement('div');
    paramContainer.className = 'effect-param-container';

    const label = document.createElement('label');
    label.textContent = t(cfg.labelKey, cfg.labelFallback);
    label.className = 'effect-param-label';

    const slider = document.createElement('input');
    slider.type = 'range';
    slider.min = String(cfg.sliderMin);
    slider.max = String(cfg.sliderMax);
    slider.value = String(cfg.toSlider(params[cfg.paramKey] ?? cfg.defaultValue));
    slider.className = 'effect-param-slider';

    const valueDisplay = document.createElement('span');
    valueDisplay.textContent = cfg.formatValue(cfg.fromSlider(Number(slider.value)));
    valueDisplay.className = 'effect-param-value';

    slider.addEventListener('input', () => {
      valueDisplay.textContent = cfg.formatValue(cfg.fromSlider(Number(slider.value)));
    });

    slider.addEventListener('change', async () => {
      const newValue = cfg.fromSlider(Number(slider.value));
      params[cfg.paramKey] = newValue;
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

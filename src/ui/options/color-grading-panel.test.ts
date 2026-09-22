/**
 * Regression tests for the color-grading parameter sliders (differentiator).
 *
 * Color grading is exposed as six numeric sliders. These tests assert the
 * controls render, a change propagates into the settings object and triggers a
 * save, reset restores the default, and the enable/disable toggle works.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderColorGradingSliders, setColorGradingSlidersEnabled } from './color-grading-panel';
import type { ColorGradingSettings } from '@/types';

function defaults(): ColorGradingSettings {
  return {
    enabled: true,
    brightness: 0,
    gamma: 1,
    contrast: 1,
    saturation: 1,
    vibrance: 0,
    exposure: 0,
  };
}

function render(settings: ColorGradingSettings, enabled = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const onSave = vi.fn().mockResolvedValue(undefined);
  renderColorGradingSliders(settings, container, enabled, onSave);
  const sliders = Array.from(container.querySelectorAll<HTMLInputElement>('input.effect-param-slider'));
  const resets = Array.from(container.querySelectorAll<HTMLButtonElement>('.btn-reset-param'));
  return { container, onSave, sliders, resets };
}

// Slider order is fixed by COLOR_GRADING_PARAMS:
// [exposure, brightness, contrast, gamma, saturation, vibrance]
const EXPOSURE = 0;
const GAMMA = 3;
const SATURATION = 4;

describe('renderColorGradingSliders', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('renders one slider + reset button per color-grading param', () => {
    const { sliders, resets } = render(defaults());

    expect(sliders).toHaveLength(6);
    expect(resets).toHaveLength(6);
    for (const slider of sliders) {
      expect(slider.type).toBe('range');
    }
  });

  it('reflects the current settings in the slider positions', () => {
    const settings = defaults();
    settings.exposure = 1.5;
    settings.gamma = 2;
    settings.saturation = 0.5;

    const { sliders } = render(settings);

    expect(sliders[EXPOSURE].value).toBe('150');
    expect(sliders[GAMMA].value).toBe('200');
    expect(sliders[SATURATION].value).toBe('50');
  });

  it('propagates an exposure change into settings and calls onSave', async () => {
    const settings = defaults();
    const { sliders, onSave } = render(settings);

    sliders[EXPOSURE].value = '150';
    sliders[EXPOSURE].dispatchEvent(new Event('change'));
    await Promise.resolve();

    expect(settings.exposure).toBeCloseTo(1.5, 5);
    expect(onSave).toHaveBeenCalledWith(settings);
  });

  it('propagates a gamma change into settings', async () => {
    const settings = defaults();
    const { sliders, onSave } = render(settings);

    sliders[GAMMA].value = '200';
    sliders[GAMMA].dispatchEvent(new Event('change'));
    await Promise.resolve();

    expect(settings.gamma).toBeCloseTo(2, 5);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it('reset restores the param default and saves', async () => {
    const settings = defaults();
    settings.gamma = 3;
    const { resets, onSave } = render(settings);

    resets[GAMMA].dispatchEvent(new Event('click'));
    await Promise.resolve();

    expect(settings.gamma).toBe(1);
    expect(onSave).toHaveBeenCalledWith(settings);
  });

  it('disables every slider and reset button when grading is off', () => {
    const { sliders, resets } = render(defaults(), false);

    expect(sliders.every((s) => s.disabled)).toBe(true);
    expect(resets.every((b) => b.disabled)).toBe(true);
  });

  it('setColorGradingSlidersEnabled toggles controls after render', () => {
    const { container } = render(defaults(), false);

    setColorGradingSlidersEnabled(container, true);

    const sliders = Array.from(container.querySelectorAll<HTMLInputElement>('input.effect-param-slider'));
    const resets = Array.from(container.querySelectorAll<HTMLButtonElement>('.btn-reset-param'));
    expect(sliders.every((s) => !s.disabled)).toBe(true);
    expect(resets.every((b) => !b.disabled)).toBe(true);
  });
});

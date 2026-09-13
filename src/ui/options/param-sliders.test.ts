/**
 * Regression tests for the per-effect numeric parameter sliders (differentiator).
 *
 * These assert that the slider registry renders the right controls and that a
 * slider change propagates a converted numeric value back onto the effect params
 * and persists via the save callback — i.e. the sliders are actually wired up.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderParamSliders } from './param-sliders';
import type { EnhancementEffect } from '@/types';

function makeEffect(className: string, params?: Record<string, number>): EnhancementEffect {
  return { id: `test/${className}`, name: className, className, params };
}

function render(effect: EnhancementEffect, saveCallback = vi.fn().mockResolvedValue(undefined)) {
  const effectItem = document.createElement('div');
  const wrapper = document.createElement('div');
  document.body.appendChild(wrapper);
  renderParamSliders(effect, 'mode-1', effectItem, wrapper, saveCallback);
  const sliders = Array.from(wrapper.querySelectorAll<HTMLInputElement>('input.effect-param-slider'));
  const values = Array.from(wrapper.querySelectorAll<HTMLElement>('.effect-param-value'));
  return { effect, effectItem, wrapper, sliders, values, saveCallback };
}

describe('renderParamSliders', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  describe('CAS sharpness slider', () => {
    it('renders a 0–100 slider reflecting the default sharpness of 0.5', () => {
      const { sliders, effect } = render(makeEffect('CAS', {}));

      expect(sliders).toHaveLength(1);
      expect(sliders[0].type).toBe('range');
      expect(sliders[0].min).toBe('0');
      expect(sliders[0].max).toBe('100');
      expect(sliders[0].value).toBe('50');
      // Missing params are auto-populated with the registry default so persistence works.
      expect(effect.params!.sharpness).toBe(0.5);
    });

    it('propagates a slider change to effect.params and the save callback', async () => {
      const { sliders, effect, saveCallback } = render(makeEffect('CAS', { sharpness: 0.5 }));

      sliders[0].value = '80';
      sliders[0].dispatchEvent(new Event('change'));
      await Promise.resolve();

      expect(effect.params!.sharpness).toBeCloseTo(0.8, 5);
      expect(saveCallback).toHaveBeenCalledWith('mode-1');
    });

    it('reflects a changed value in the numeric display on input', () => {
      const { sliders, values } = render(makeEffect('CAS', { sharpness: 0.5 }));

      sliders[0].value = '80';
      sliders[0].dispatchEvent(new Event('input'));

      expect(values[0].textContent).toBe('80%');
    });
  });

  describe('Debanding sliders', () => {
    it('renders both strength and bandThreshold with converted defaults', () => {
      const { sliders, effect } = render(makeEffect('Debanding', {}));

      expect(sliders).toHaveLength(2);
      expect(sliders[0].value).toBe('50'); // strength 0.5
      expect(sliders[1].value).toBe('8');  // bandThreshold 0.08
      expect(effect.params!.strength).toBe(0.5);
      expect(effect.params!.bandThreshold).toBeCloseTo(0.08, 5);
    });

    it('formats both values with two decimals', () => {
      const { values } = render(makeEffect('Debanding', { strength: 0.5, bandThreshold: 0.08 }));

      expect(values[0].textContent).toBe('0.50');
      expect(values[1].textContent).toBe('0.08');
    });

    it('converts a bandThreshold slider change back to the [0,1] param', async () => {
      const { sliders, effect, saveCallback } = render(
        makeEffect('Debanding', { strength: 0.5, bandThreshold: 0.08 }),
      );

      sliders[1].value = '30';
      sliders[1].dispatchEvent(new Event('change'));
      await Promise.resolve();

      expect(effect.params!.bandThreshold).toBeCloseTo(0.3, 5);
      expect(effect.params!.strength).toBe(0.5);
      expect(saveCallback).toHaveBeenCalledWith('mode-1');
    });
  });

  describe('BilateralMean sliders', () => {
    it('renders strength (percent, 2-decimal) and strength2 (scaled, 1-decimal)', () => {
      const { sliders, values, effect } = render(makeEffect('BilateralMean', {}));

      expect(sliders).toHaveLength(2);
      // strength 0.2 → 0–100 percent slider, two-decimal display.
      expect(sliders[0].min).toBe('0');
      expect(sliders[0].max).toBe('100');
      expect(sliders[0].value).toBe('20');
      expect(values[0].textContent).toBe('0.20');
      // strength2 2 → 5–50 scaled slider, one-decimal display.
      expect(sliders[1].min).toBe('5');
      expect(sliders[1].max).toBe('50');
      expect(sliders[1].value).toBe('20');
      expect(values[1].textContent).toBe('2.0');
      expect(effect.params!.strength).toBe(0.2);
      expect(effect.params!.strength2).toBe(2);
    });

    it('converts a strength slider change back to the [0,1] param', async () => {
      const { sliders, effect, saveCallback } = render(
        makeEffect('BilateralMean', { strength: 0.2, strength2: 2 }),
      );

      sliders[0].value = '55';
      sliders[0].dispatchEvent(new Event('change'));
      await Promise.resolve();

      expect(effect.params!.strength).toBeCloseTo(0.55, 5);
      expect(saveCallback).toHaveBeenCalledWith('mode-1');
    });
  });

  describe('DoG strength slider', () => {
    it('captures the non-percent slider range and conversion', async () => {
      const { sliders, effect } = render(makeEffect('DoG', { strength: 4 }));

      expect(sliders).toHaveLength(1);
      expect(sliders[0].min).toBe('10');
      expect(sliders[0].max).toBe('100');
      expect(sliders[0].value).toBe('40');

      sliders[0].value = '60';
      sliders[0].dispatchEvent(new Event('change'));
      await Promise.resolve();

      expect(effect.params!.strength).toBeCloseTo(6, 5);
    });
  });

  describe('guards', () => {
    it('renders nothing for an effect whose descriptor declares no paramsSchema (ClampHighlights)', () => {
      const { sliders } = render(makeEffect('ClampHighlights', { foo: 1 }));
      expect(sliders).toHaveLength(0);
    });

    it('renders nothing when the effect has no params object', () => {
      const { sliders } = render(makeEffect('CAS', undefined));
      expect(sliders).toHaveLength(0);
    });
  });

  describe('drag interaction guards', () => {
    it('disables dragging on the parent item while the slider is captured', () => {
      const { sliders, effectItem } = render(makeEffect('CAS', { sharpness: 0.5 }));
      const slider = sliders[0];
      // jsdom does not implement pointer capture; stub it to observe the handler.
      (slider as unknown as { setPointerCapture: (id: number) => void }).setPointerCapture = vi.fn();

      slider.dispatchEvent(new Event('pointerdown'));
      expect(effectItem.draggable).toBe(false);

      slider.dispatchEvent(new Event('pointerup'));
      expect(effectItem.draggable).toBe(true);
    });
  });
});

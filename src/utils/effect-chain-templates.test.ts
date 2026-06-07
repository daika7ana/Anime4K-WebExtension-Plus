import { describe, it, expect } from 'vitest';
import { resolveEffectChain } from './effect-chain-templates';
import { AVAILABLE_EFFECTS } from './effects-map';
import type { BaseMode, PerformanceTier } from '../types';

const BASE_MODES: BaseMode[] = ['A', 'B', 'C', 'A+A', 'B+B', 'C+A'];
const TIERS: PerformanceTier[] = ['performance', 'balanced', 'quality', 'ultra'];

// Build a lookup of valid classNames from the catalog
const validClassNames = new Set(AVAILABLE_EFFECTS.map(e => e.className));

describe('resolveEffectChain', () => {
  // Exhaustive: every base mode × every tier
  for (const baseMode of BASE_MODES) {
    for (const tier of TIERS) {
      it(`${baseMode} @ ${tier} returns a non-empty chain of valid effects`, () => {
        const chain = resolveEffectChain(baseMode, tier);

        expect(chain.length).toBeGreaterThan(0);

        for (const effect of chain) {
          // Every effect must come from the catalog
          expect(validClassNames.has(effect.className)).toBe(true);
          expect(effect.id).toBeTruthy();
          expect(effect.name).toBeTruthy();
        }
      });
    }
  }

  it('all chains start with ClampHighlights', () => {
    for (const baseMode of BASE_MODES) {
      for (const tier of TIERS) {
        const chain = resolveEffectChain(baseMode, tier);
        expect(chain[0].className).toBe('ClampHighlights');
      }
    }
  });

  it('chains differ between performance and quality tiers', () => {
    for (const baseMode of BASE_MODES) {
      const perf = resolveEffectChain(baseMode, 'performance').map(e => e.className);
      const quality = resolveEffectChain(baseMode, 'quality').map(e => e.className);
      expect(perf).not.toEqual(quality);
    }
  });

  it('A+A chain is longer than A chain (same tier)', () => {
    const a = resolveEffectChain('A', 'balanced');
    const aa = resolveEffectChain('A+A', 'balanced');
    expect(aa.length).toBeGreaterThan(a.length);
  });

  it('B+B chain is longer than B chain (same tier)', () => {
    const b = resolveEffectChain('B', 'balanced');
    const bb = resolveEffectChain('B+B', 'balanced');
    expect(bb.length).toBeGreaterThan(b.length);
  });

  it('C+A chain combines C and A patterns', () => {
    const chain = resolveEffectChain('C+A', 'balanced');
    // C+A should have DenoiseCNN (from C) + Restore+Upscale (from A)
    const classNames = chain.map(e => e.className);
    expect(classNames).toContain('DenoiseCNNx2VL'); // from C
    expect(classNames.some(cn => cn.startsWith('CNN') && !cn.includes('Denoise'))).toBe(true); // from A
  });

  it('performance tier uses smaller models than quality tier', () => {
    // Mode A: performance uses CNNM, quality uses CNNUL
    const perfA = resolveEffectChain('A', 'performance');
    const qualityA = resolveEffectChain('A', 'quality');

    const perfRestore = perfA.find(e => e.className === 'CNNM');
    const qualityRestore = qualityA.find(e => e.className === 'CNNUL');

    expect(perfRestore).toBeDefined();
    expect(qualityRestore).toBeDefined();
  });

  it('ultra tier uses largest upscale models', () => {
    const ultra = resolveEffectChain('A', 'ultra');
    const classNames = ultra.map(e => e.className);
    // Ultra should use CNNx2UL for upscaling
    expect(classNames).toContain('CNNx2UL');
  });

  it('returns effects with correct structure', () => {
    const chain = resolveEffectChain('A', 'balanced');
    for (const effect of chain) {
      expect(effect).toHaveProperty('id');
      expect(effect).toHaveProperty('name');
      expect(effect).toHaveProperty('className');
      expect(typeof effect.id).toBe('string');
      expect(typeof effect.name).toBe('string');
      expect(typeof effect.className).toBe('string');
    }
  });
});

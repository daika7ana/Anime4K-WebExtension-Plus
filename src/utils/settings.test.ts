import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  synchronizeEffectsForCustomModes,
  getEffectsForMode,
  BUILTIN_MODES,
} from './settings';
import { AVAILABLE_EFFECTS } from './effects-map';
import { resolveEffectChain } from './effect-chain-templates';
import type { CustomMode, BuiltInMode, EnhancementEffect, PerformanceTier } from '../types';

describe('BUILTIN_MODES', () => {
  it('contains exactly 6 modes', () => {
    expect(BUILTIN_MODES).toHaveLength(6);
  });

  it('each mode has required fields', () => {
    for (const mode of BUILTIN_MODES) {
      expect(mode).toHaveProperty('id');
      expect(mode).toHaveProperty('baseMode');
      expect(mode).toHaveProperty('name');
      expect(mode.isBuiltIn).toBe(true);
    }
  });

  it('covers all base modes', () => {
    const baseModes = BUILTIN_MODES.map(m => m.baseMode);
    expect(baseModes).toContain('A');
    expect(baseModes).toContain('B');
    expect(baseModes).toContain('C');
    expect(baseModes).toContain('A+A');
    expect(baseModes).toContain('B+B');
    expect(baseModes).toContain('C+A');
  });
});

describe('synchronizeEffectsForCustomModes', () => {
  it('returns empty array for empty input', () => {
    expect(synchronizeEffectsForCustomModes([])).toEqual([]);
  });

  it('preserves mode structure', () => {
    const modes: CustomMode[] = [
      { id: 'custom-1', name: 'My Mode', isBuiltIn: false, effects: [] },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('custom-1');
    expect(result[0].name).toBe('My Mode');
    expect(result[0].isBuiltIn).toBe(false);
  });

  it('resolves effect IDs to catalog effects', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [{ id: casEffect.id, name: 'Old Name', className: 'CAS' }],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0].name).toBe(casEffect.name);
  });

  it('preserves user-customized params over catalog defaults', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [{ ...casEffect, params: { sharpness: 0.9 } }],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects[0].params).toEqual({ sharpness: 0.9 });
  });

  it('drops effects whose IDs are not in the catalog', () => {
    const modes: CustomMode[] = [
      {
        id: 'custom-1',
        name: 'Test',
        isBuiltIn: false,
        effects: [
          { id: 'nonexistent/effect', name: 'Ghost', className: 'Ghost' },
        ],
      },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result[0].effects).toHaveLength(0);
  });

  it('handles multiple modes independently', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const modes: CustomMode[] = [
      { id: 'c1', name: 'Mode 1', isBuiltIn: false, effects: [casEffect] },
      { id: 'c2', name: 'Mode 2', isBuiltIn: false, effects: [] },
    ];
    const result = synchronizeEffectsForCustomModes(modes);
    expect(result).toHaveLength(2);
    expect(result[0].effects).toHaveLength(1);
    expect(result[1].effects).toHaveLength(0);
  });
});

describe('getEffectsForMode', () => {
  it('resolves built-in mode effects based on tier', () => {
    const mode: BuiltInMode = { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true };
    const effects = getEffectsForMode(mode, 'balanced');
    // Should match resolveEffectChain('A', 'balanced')
    const expected = resolveEffectChain('A', 'balanced');
    expect(effects).toEqual(expected);
  });

  it('returns different effects for different tiers', () => {
    const mode: BuiltInMode = { id: 'builtin-mode-a', baseMode: 'A', name: 'Mode A', isBuiltIn: true };
    const perfEffects = getEffectsForMode(mode, 'performance');
    const qualityEffects = getEffectsForMode(mode, 'quality');
    // Performance and quality should have different effect chains
    expect(perfEffects.map(e => e.className)).not.toEqual(qualityEffects.map(e => e.className));
  });

  it('returns custom mode effects directly without tier resolution', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const mode: CustomMode = {
      id: 'custom-1',
      name: 'My Custom',
      isBuiltIn: false,
      effects: [casEffect],
    };
    const effects = getEffectsForMode(mode, 'performance');
    expect(effects).toEqual([casEffect]);
  });

  it('custom mode ignores tier parameter', () => {
    const casEffect = AVAILABLE_EFFECTS.find(e => e.className === 'CAS')!;
    const mode: CustomMode = {
      id: 'custom-1',
      name: 'My Custom',
      isBuiltIn: false,
      effects: [casEffect],
    };
    expect(getEffectsForMode(mode, 'performance')).toEqual(getEffectsForMode(mode, 'ultra'));
  });

  it('each built-in base mode resolves to non-empty effects for each tier', () => {
    const tiers: PerformanceTier[] = ['performance', 'balanced', 'quality', 'ultra'];
    for (const builtin of BUILTIN_MODES) {
      for (const tier of tiers) {
        const effects = getEffectsForMode(builtin, tier);
        expect(effects.length).toBeGreaterThan(0);
      }
    }
  });
});

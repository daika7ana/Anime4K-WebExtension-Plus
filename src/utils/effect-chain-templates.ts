/**
 * Effect chain templates
 * Based on official Anime4K mode definitions:
 * - Mode A: Restore -> Upscale (optimized for high blur/compression artifacts)
 * - Mode B: Restore_Soft -> Upscale (optimized for downscaling ringing/low blur)
 * - Mode C: Upscale_Denoise -> Upscale (no degradation images/wallpapers)
 */

import type { BaseMode, PerformanceTier, EnhancementEffect } from '../types';
import { AVAILABLE_EFFECTS } from './effects-map';

/**
 * Effect chain template definitions
 * baseMode × performanceTier → className[]
 */
const EFFECT_CHAIN_TEMPLATES: Record<BaseMode, Record<PerformanceTier, string[]>> = {
    'A': {
        performance: ['ClampHighlights', 'CNNM', 'CNNx2M', 'CNNx2M'],
        balanced: ['ClampHighlights', 'CNNVL', 'CNNx2VL', 'CNNx2M'],
        quality: ['ClampHighlights', 'CNNUL', 'CNNx2UL', 'CNNx2VL'],
        ultra: ['ClampHighlights', 'CNNUL', 'CNNx2UL', 'CNNx2UL'],
    },
    'B': {
        performance: ['ClampHighlights', 'CNNSoftM', 'CNNx2M', 'CNNx2M'],
        balanced: ['ClampHighlights', 'CNNSoftVL', 'CNNx2VL', 'CNNx2M'],
        quality: ['ClampHighlights', 'CNNSoftVL', 'CNNx2UL', 'CNNx2VL'],  // CNNSoftUL does not exist, using CNNSoftVL
        ultra: ['ClampHighlights', 'CNNSoftVL', 'CNNx2UL', 'CNNx2UL'],    // CNNSoftUL does not exist, using CNNSoftVL
    },
    'C': {
        performance: ['ClampHighlights', 'DenoiseCNNx2VL', 'CNNx2M'],
        balanced: ['ClampHighlights', 'DenoiseCNNx2VL', 'CNNx2M'],
        quality: ['ClampHighlights', 'DenoiseCNNx2VL', 'CNNx2VL'],  // DenoiseCNNx2UL does not exist, using DenoiseCNNx2VL
        ultra: ['ClampHighlights', 'DenoiseCNNx2VL', 'CNNx2UL'],    // DenoiseCNNx2UL does not exist, using DenoiseCNNx2VL
    },
    'A+A': {
        performance: ['ClampHighlights', 'CNNM', 'CNNx2M', 'CNNM', 'CNNx2M'],
        balanced: ['ClampHighlights', 'CNNVL', 'CNNx2VL', 'CNNVL', 'CNNx2M'],
        quality: ['ClampHighlights', 'CNNUL', 'CNNx2UL', 'CNNUL', 'CNNx2VL'],
        ultra: ['ClampHighlights', 'CNNUL', 'CNNx2UL', 'CNNUL', 'CNNx2UL', 'CNNUL', 'CNNx2VL'],
    },
    'B+B': {
        performance: ['ClampHighlights', 'CNNSoftM', 'CNNx2M', 'CNNSoftM', 'CNNx2M'],
        balanced: ['ClampHighlights', 'CNNSoftVL', 'CNNx2VL', 'CNNSoftVL', 'CNNx2M'],
        quality: ['ClampHighlights', 'CNNSoftVL', 'CNNx2UL', 'CNNSoftVL', 'CNNx2VL'],  // CNNSoftUL does not exist
        ultra: ['ClampHighlights', 'CNNSoftVL', 'CNNx2UL', 'CNNSoftVL', 'CNNx2UL'],    // CNNSoftUL does not exist
    },
    'C+A': {
        performance: ['ClampHighlights', 'DenoiseCNNx2VL', 'CNNM', 'CNNx2M'],
        balanced: ['ClampHighlights', 'DenoiseCNNx2VL', 'CNNVL', 'CNNx2M'],
        quality: ['ClampHighlights', 'DenoiseCNNx2VL', 'CNNUL', 'CNNx2VL'],  // DenoiseCNNx2UL does not exist
        ultra: ['ClampHighlights', 'DenoiseCNNx2VL', 'CNNUL', 'CNNx2UL'],    // DenoiseCNNx2UL does not exist
    },
};

/**
 * Resolve the effect chain for a given base mode and performance tier
 * @param baseMode Base mode (A, B, C, A+A, B+B, C+A)
 * @param tier Performance tier (performance, balanced, quality, ultra)
 * @returns Array of effects
 */
export function resolveEffectChain(
    baseMode: BaseMode,
    tier: PerformanceTier
): EnhancementEffect[] {
    const classNames = EFFECT_CHAIN_TEMPLATES[baseMode][tier];
    return classNames
        .map(className => AVAILABLE_EFFECTS.find(e => e.className === className))
        .filter((e): e is EnhancementEffect => !!e);
}



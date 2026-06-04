/**
 * Enhancement mode constants
 * Defines available Anime4K enhancement modes and their identifiers
 */
export const MODES = {
  ModeA: 'ModeA',
  ModeB: 'ModeB',
  ModeC: 'ModeC',
  ModeAA: 'ModeAA',
  ModeBB: 'ModeBB',
  ModeCA: 'ModeCA',
} as const;

/**
 * Resolution setting constants
 * Defines all available resolution options and their identifiers
 */
export const RESOLUTIONS = {
  DEFAULT: 'x2',    // Default resolution setting
  x2: 'x2',         // 2x upscale
  x4: 'x4',         // 4x upscale
  x8: 'x8',         // 8x upscale
  '720p': '720p',   // 720p fixed resolution
  '1080p': '1080p', // 1080p fixed resolution
  '2k': '2k',       // 2K resolution
  '4k': '4k',       // 4K resolution
  native: 'native'  // Native resolution
} as const;

/**
 * Initialization attribute marker
 * Used to mark video elements that have been initialized
 */
export const ANIME4K_APPLIED_ATTR = 'data-anime4k-applied';

/**
 * Button class name
 * CSS class name used to identify the enhancement button
 */
export const ANIME4K_BUTTON_CLASS = 'anime4k-button';
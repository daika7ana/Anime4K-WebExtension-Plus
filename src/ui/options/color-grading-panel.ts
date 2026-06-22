import type { ColorGradingSettings } from '@/types'

// Param keys that are numeric (excludes `enabled` which is boolean)
type ColorGradingNumericKey = 'brightness' | 'gamma' | 'contrast' | 'saturation' | 'vibrance' | 'exposure'

// Slider configs for the 6 color grading params.
// Each maps a param value to a slider position and back.
const COLOR_GRADING_PARAMS: {
  paramKey: ColorGradingNumericKey
  labelKey: string
  labelFallback: string
  descKey: string
  descFallback: string
  sliderMin: number
  sliderMax: number
  defaultValue: number
  toSlider: (v: number) => number
  fromSlider: (v: number) => number
  formatValue: (v: number) => string
}[] = [
  {
    paramKey: 'exposure',
    labelKey: 'exposure',
    labelFallback: 'Exposure',
    descKey: 'exposureDesc',
    descFallback: 'Controls the overall light level. Measured in EV stops.',
    sliderMin: -300, sliderMax: 300, defaultValue: 0,
    toSlider: (v: number) => Math.round(v * 100),
    fromSlider: (v: number) => v / 100,
    formatValue: (v: number) => (v > 0 ? '+' : '') + v.toFixed(2) + ' EV',
  },
  {
    paramKey: 'brightness',
    labelKey: 'brightness',
    labelFallback: 'Brightness',
    descKey: 'brightnessDesc',
    descFallback: 'Adjusts the overall lightness or darkness of the image.',
    sliderMin: -100, sliderMax: 100, defaultValue: 0,
    toSlider: (v: number) => Math.round(v * 100),
    fromSlider: (v: number) => v / 100,
    formatValue: (v: number) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%',
  },
  {
    paramKey: 'contrast',
    labelKey: 'contrast',
    labelFallback: 'Contrast',
    descKey: 'contrastDesc',
    descFallback: 'Controls the difference between light and dark areas.',
    sliderMin: 0, sliderMax: 200, defaultValue: 100,
    toSlider: (v: number) => Math.round(v * 100),
    fromSlider: (v: number) => v / 100,
    formatValue: (v: number) => Math.round(v * 100) + '%',
  },
  {
    paramKey: 'gamma',
    labelKey: 'gamma',
    labelFallback: 'Gamma',
    descKey: 'gammaDesc',
    descFallback: 'Adjusts midtone brightness. Higher values brighten, lower values darken.',
    sliderMin: 10, sliderMax: 400, defaultValue: 100,
    toSlider: (v: number) => Math.round(v * 100),
    fromSlider: (v: number) => v / 100,
    formatValue: (v: number) => v.toFixed(2),
  },
  {
    paramKey: 'saturation',
    labelKey: 'saturation',
    labelFallback: 'Saturation',
    descKey: 'saturationDesc',
    descFallback: 'Controls the intensity of all colors uniformly.',
    sliderMin: 0, sliderMax: 200, defaultValue: 100,
    toSlider: (v: number) => Math.round(v * 100),
    fromSlider: (v: number) => v / 100,
    formatValue: (v: number) => Math.round(v * 100) + '%',
  },
  {
    paramKey: 'vibrance',
    labelKey: 'vibrance',
    labelFallback: 'Vibrance',
    descKey: 'vibranceDesc',
    descFallback: 'Selectively boosts less-saturated colors while preserving already vivid ones.',
    sliderMin: -100, sliderMax: 100, defaultValue: 0,
    toSlider: (v: number) => Math.round(v * 100),
    fromSlider: (v: number) => v / 100,
    formatValue: (v: number) => (v > 0 ? '+' : '') + Math.round(v * 100) + '%',
  },
]

/**
 * Renders the color grading sliders into the container.
 * @param settings The current color grading settings
 * @param container The DOM element to render sliders into
 * @param enabled Whether the sliders should be interactive
 * @param onSave Callback invoked when a slider value changes
 */
export function renderColorGradingSliders(
  settings: ColorGradingSettings,
  container: HTMLElement,
  enabled: boolean,
  onSave: (settings: ColorGradingSettings) => Promise<void>,
): void {
  container.textContent = ''

  for (const cfg of COLOR_GRADING_PARAMS) {
    const paramContainer = document.createElement('div')
    paramContainer.className = 'effect-param-container'

    // Left side: label + description
    const labelContainer = document.createElement('div')
    labelContainer.className = 'effect-param-label-container'

    const label = document.createElement('label')
    label.textContent = chrome.i18n.getMessage(cfg.labelKey) || cfg.labelFallback
    label.className = 'effect-param-label'

    const desc = document.createElement('span')
    desc.textContent = chrome.i18n.getMessage(cfg.descKey) || cfg.descFallback
    desc.className = 'effect-param-desc'

    labelContainer.appendChild(label)
    labelContainer.appendChild(desc)

    const slider = document.createElement('input')
    slider.type = 'range'
    slider.min = String(cfg.sliderMin)
    slider.max = String(cfg.sliderMax)
    slider.value = String(cfg.toSlider(settings[cfg.paramKey] ?? cfg.defaultValue))
    slider.className = 'effect-param-slider'
    slider.disabled = !enabled

    const valueDisplay = document.createElement('span')
    valueDisplay.textContent = cfg.formatValue(cfg.fromSlider(Number(slider.value)))
    valueDisplay.className = 'effect-param-value'

    slider.addEventListener('input', () => {
      valueDisplay.textContent = cfg.formatValue(cfg.fromSlider(Number(slider.value)))
    })

    slider.addEventListener('change', async () => {
      const newValue = cfg.fromSlider(Number(slider.value))
      ;(settings as Record<ColorGradingNumericKey, number>)[cfg.paramKey] = newValue
      await onSave(settings)
    })

    // Reset button — restores this param to its default value
    const resetBtn = document.createElement('button')
    resetBtn.className = 'btn-reset-param'
    resetBtn.title = 'Reset'
    resetBtn.disabled = !enabled
    resetBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/></svg>'
    resetBtn.addEventListener('click', async () => {
      // defaultValue is already in slider-space (e.g. gamma default = 100)
      slider.value = String(cfg.defaultValue)
      const paramVal = cfg.fromSlider(cfg.defaultValue)
      ;(settings as Record<ColorGradingNumericKey, number>)[cfg.paramKey] = paramVal
      valueDisplay.textContent = cfg.formatValue(paramVal)
      await onSave(settings)
    })

    paramContainer.appendChild(labelContainer)
    paramContainer.appendChild(slider)
    paramContainer.appendChild(valueDisplay)
    paramContainer.appendChild(resetBtn)
    container.appendChild(paramContainer)
  }
}

/**
 * Enables or disables all sliders and reset buttons in the container.
 */
export function setColorGradingSlidersEnabled(container: HTMLElement, enabled: boolean): void {
  container.querySelectorAll<HTMLInputElement>('input.effect-param-slider').forEach(slider => {
    slider.disabled = !enabled
  })
  container.querySelectorAll<HTMLButtonElement>('.btn-reset-param').forEach(btn => {
    btn.disabled = !enabled
  })
}

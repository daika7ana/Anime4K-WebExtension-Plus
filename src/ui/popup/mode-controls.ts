// mode-controls.ts — Enhancement mode dropdown rendering and interaction
import type { EnhancementMode, CustomMode } from '@/types';
import { BUILTIN_MODES } from '@utils/settings';
import { t } from '@utils/i18n';
import { getModeDescription } from './mode-guidance';

export function initModeControls(opts: {
  modeSelect: HTMLSelectElement;
  onModeChanged: () => void;
}): {
  render: (settings: {
    enhancementModes: EnhancementMode[];
    customModes: CustomMode[];
    selectedModeId: string;
  }) => void;
} {
  const { modeSelect, onModeChanged } = opts;

  const render = (settings: {
    enhancementModes: EnhancementMode[];
    customModes: CustomMode[];
    selectedModeId: string;
  }) => {
    modeSelect.innerHTML = '';

    // Built-in modes group
    const builtInGroup = document.createElement('optgroup');
    builtInGroup.label = t('builtInModes', 'Built-in Modes');
    BUILTIN_MODES.forEach(mode => {
      const option = document.createElement('option');
      option.value = mode.id;
      option.textContent = mode.name;
      option.title = getModeDescription(mode.baseMode);
      builtInGroup.appendChild(option);
    });
    modeSelect.appendChild(builtInGroup);

    // Custom modes group (if any)
    if (settings.customModes && settings.customModes.length > 0) {
      const customGroup = document.createElement('optgroup');
      customGroup.label = t('customModes', 'Custom Modes');
      settings.customModes.forEach(mode => {
        const option = document.createElement('option');
        option.value = mode.id;
        option.textContent = mode.name;
        customGroup.appendChild(option);
      });
      modeSelect.appendChild(customGroup);
    }

    modeSelect.value = settings.selectedModeId;
  };

  // Update tier button state when mode selection changes
  modeSelect.addEventListener('change', () => {
    onModeChanged();
  });

  return { render };
}

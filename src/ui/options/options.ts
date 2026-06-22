import './options.css';
import '../common-vars.css';
import { getSettings, saveSettings, synchronizeEffectsForCustomModes, getEffectsForMode, getLocalSettings, saveLocalSettings } from '@utils/settings';
import type { WhitelistRule } from '@/types';
import { validateRulePattern, removeWhitelistRule, updateWhitelistRule, addWhitelistRule } from '@utils/whitelist';
import { AVAILABLE_EFFECTS } from '@utils/effects-map';
import type { EnhancementMode, EnhancementEffect, CustomMode, PerformanceTier } from '@/types';
import { themeManager } from '../theme-manager';
import { renderParamSliders } from './param-sliders';
import { renderColorGradingSliders, setColorGradingSlidersEnabled } from './color-grading-panel';
import { Sidebar } from './Sidebar';
import { runGPUBenchmark } from '@core/gpu/gpu-benchmark';


import type { Anime4KWebExtSettings } from '@/types';

// --- Global State ---
let settingsState: Anime4KWebExtSettings;
let currentTier: PerformanceTier = 'balanced'; // Current performance tier

// --- UI Elements ---
const modesContainer = document.getElementById('modes-container') as HTMLElement;
const addModeBtn = document.getElementById('add-mode-btn') as HTMLButtonElement;
const importModesBtn = document.getElementById('import-modes-btn') as HTMLButtonElement;
const exportModesBtn = document.getElementById('export-modes-btn') as HTMLButtonElement;
const rulesContainer = document.getElementById('rules-container') as HTMLElement;
const addRuleBtn = document.getElementById('add-rule') as HTMLButtonElement;
const importBtn = document.getElementById('import-btn') as HTMLButtonElement;
const exportBtn = document.getElementById('export-btn') as HTMLButtonElement;
const crossOriginFixToggle = document.getElementById('cross-origin-fix-toggle') as HTMLInputElement;
const colorGradingToggle = document.getElementById('color-grading-toggle') as HTMLInputElement;
const colorGradingSliders = document.getElementById('color-grading-sliders') as HTMLElement;
const themeSelect = document.getElementById('theme-select') as HTMLSelectElement;
const versionNumberSpan = document.getElementById('version-number') as HTMLSpanElement;

// --- Smart Features UI Elements ---
const runBenchmarkBtn = document.getElementById('run-benchmark-btn') as HTMLButtonElement;
const tierSelect = document.getElementById('tier-select') as HTMLSelectElement;

// --- Drag and Drop State ---
let draggedElement: HTMLElement | null = null;
let draggedModeId: string | null = null;
let draggedEffectIndex: number | null = null;

// --- File Helper Functions ---
const downloadJSON = (data: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const openFile = (): Promise<string> => {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json,application/json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (event) => {
          resolve(event.target?.result as string);
        };
        reader.onerror = (error) => {
          reject(error);
        };
        reader.readAsText(file);
      } else {
        reject(new Error('No file selected'));
      }
    };
    input.click();
  });
};

/**
 * Renders the enhancement mode UI based on the current settingsState.
 */
const renderModesUI = () => {
  // 1. Preserve expanded state before re-rendering
  const expandedModeIds = new Set<string>();
  modesContainer.querySelectorAll('.mode-card:not(.collapsed)').forEach(card => {
    const modeId = (card as HTMLElement).dataset.modeId;
    if (modeId) expandedModeIds.add(modeId);
  });

  modesContainer.textContent = ''; // Clear existing cards

  const builtInModes = settingsState.enhancementModes.filter(m => m.isBuiltIn);
  const customModes = settingsState.enhancementModes.filter(m => !m.isBuiltIn);

  const renderModeCard = (mode: EnhancementMode) => {
    const card = document.createElement('div');
    card.className = 'mode-card collapsed';
    card.dataset.modeId = mode.id;
    card.draggable = true;

    // --- Drag and drop for mode reordering ---
    card.addEventListener('dragstart', (e) => {
      if (!card.classList.contains('collapsed')) {
        e.preventDefault();
        return;
      }
      draggedElement = card;
      draggedModeId = mode.id;
      e.dataTransfer!.effectAllowed = 'move';
      e.dataTransfer!.setData('text/plain', mode.id);
      setTimeout(() => card.classList.add('dragging'), 0);
    });

    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      draggedElement = null;
      draggedModeId = null;
    });

    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      const target = card;
      if (draggedElement && draggedElement !== target) {
        target.classList.add('drag-over');
      }
    });

    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));

    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      if (!draggedModeId || draggedModeId === mode.id) return;

      const fromIndex = settingsState.enhancementModes.findIndex(m => m.id === draggedModeId);
      const toIndex = settingsState.enhancementModes.findIndex(m => m.id === mode.id);

      if (fromIndex > -1 && toIndex > -1) {
        const [movedMode] = settingsState.enhancementModes.splice(fromIndex, 1);
        settingsState.enhancementModes.splice(toIndex, 0, movedMode);

        renderModesUI(); // Re-render from state
        await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] }); // Persist changes
        notifyUpdate();
      }
    });

    // --- Card Header ---
    const cardHeader = document.createElement('div');
    cardHeader.className = 'mode-card-header';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'btn-toggle-collapse';

    // Create SVG icon safely
    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("class", "menu-icon");
    svg.setAttribute("width", "20");
    svg.setAttribute("height", "20");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");

    const polyline = document.createElementNS(svgNS, "polyline");
    polyline.setAttribute("points", "9 18 15 12 9 6");
    svg.appendChild(polyline);

    toggleBtn.appendChild(svg);
    toggleBtn.title = chrome.i18n.getMessage('expandCollapse') || 'Expand/Collapse';
    toggleBtn.addEventListener('click', () => {
      card.classList.toggle('collapsed');
    });

    const modeName = document.createElement('h2');
    modeName.textContent = mode.name;
    modeName.contentEditable = String(!mode.isBuiltIn);
    modeName.title = mode.isBuiltIn ? (chrome.i18n.getMessage('builtInModeCannotRename') || 'Built-in modes cannot be renamed.') : (chrome.i18n.getMessage('clickToRename') || 'Click to rename');
    modeName.addEventListener('blur', async (e) => {
      if (mode.isBuiltIn) return;
      const newName = (e.target as HTMLElement).textContent?.trim() || '';
      const targetMode = settingsState.enhancementModes.find(m => m.id === mode.id);
      if (targetMode && newName && newName !== targetMode.name) {
        targetMode.name = newName;
        mode.name = newName; // Update local object for consistency
        await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
        notifyUpdate(mode.id);
      } else {
        (e.target as HTMLElement).textContent = mode.name;
      }
    });

    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = chrome.i18n.getMessage('delete') || 'Delete';
    deleteBtn.className = 'btn btn-danger';
    deleteBtn.style.display = mode.isBuiltIn ? 'none' : 'block';
    deleteBtn.onclick = async () => {
      if (confirm(chrome.i18n.getMessage('deleteModeConfirm', [mode.name]))) {
        const deletedModeId = mode.id;
        settingsState.enhancementModes = settingsState.enhancementModes.filter(m => m.id !== deletedModeId);
        if (settingsState.selectedModeId === deletedModeId) {
          settingsState.selectedModeId = 'builtin-mode-a'; // Fall back to default mode
        }
        renderModesUI();
        await saveSettings({
          customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[],
          selectedModeId: settingsState.selectedModeId
        });
        notifyUpdate(deletedModeId);
      }
    };

    // Clone button — creates a custom copy of a built-in mode
    const cloneBtn = document.createElement('button');
    cloneBtn.textContent = chrome.i18n.getMessage('clone') || 'Clone';
    cloneBtn.className = 'btn btn-outline';
    cloneBtn.style.display = mode.isBuiltIn ? 'block' : 'none';
    cloneBtn.onclick = async () => {
      const effectsToClone = getEffectsForMode(mode, currentTier);
      const clonedMode: CustomMode = {
        id: `custom-${Date.now()}`,
        name: `${mode.name} (Copy)`,
        isBuiltIn: false,
        effects: effectsToClone.map(e => ({ ...e, params: e.params ? { ...e.params } : undefined })),
      };
      settingsState.enhancementModes.unshift(clonedMode);
      renderModesUI();
      await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
      notifyUpdate(clonedMode.id);
    };

    cardHeader.appendChild(toggleBtn);
    cardHeader.appendChild(modeName);
    cardHeader.appendChild(cloneBtn);
    cardHeader.appendChild(deleteBtn);
    card.appendChild(cardHeader);

    // --- Summary (shown when collapsed) ---
    const summary = document.createElement('div');
    summary.className = 'mode-summary';
    // Get effect chain based on mode type
    const modeEffects = getEffectsForMode(mode, currentTier);
    const effectNames = modeEffects.map((e: EnhancementEffect) => e.name.split('/').pop());
    const summaryText = effectNames.length > 3
      ? effectNames.slice(0, 3).join(' > ') + ' ...'
      : effectNames.join(' > ');
    summary.textContent = summaryText || (chrome.i18n.getMessage('noEffects') || 'No effects');
    card.appendChild(summary);

    // --- Card Content (shown when expanded) ---
    const cardContent = document.createElement('div');
    cardContent.className = 'mode-card-content';
    const effectsList = document.createElement('ul');
    effectsList.className = 'effects-list';

    modeEffects.forEach((effect: EnhancementEffect, index: number) => {
      const effectItem = document.createElement('li');
      effectItem.className = 'effect-item';
      const effectName = document.createElement('span');
      effectName.textContent = effect.name;

      // --- Configurable parameters (e.g. CAS sharpness, DoG strength) ---
      const effectContent = document.createElement('div');
      effectContent.className = 'effect-content';
      effectContent.appendChild(effectName);

      if (effect.params && !mode.isBuiltIn) {
        const paramsWrapper = document.createElement('div');
        paramsWrapper.className = 'effect-params-wrapper';
        renderParamSliders(effect, mode.id, effectItem, paramsWrapper, async (modeId) => {
          await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
          notifyUpdate(modeId);
        });
        effectContent.appendChild(paramsWrapper);
      }

      effectItem.appendChild(effectContent);

      if (!mode.isBuiltIn) {
        effectItem.draggable = true;

        // --- Drag and drop for effect reordering ---
        effectItem.addEventListener('dragstart', (e) => {
          e.stopPropagation();
          draggedElement = effectItem;
          draggedModeId = mode.id;
          draggedEffectIndex = index;
          e.dataTransfer!.effectAllowed = 'move';
          setTimeout(() => effectItem.classList.add('dragging'), 0);
        });

        effectItem.addEventListener('dragend', (e) => {
          e.stopPropagation();
          effectItem.classList.remove('dragging');
          draggedElement = null;
          draggedModeId = null;
          draggedEffectIndex = null;
        });

        effectItem.addEventListener('dragover', (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (draggedModeId === mode.id) {
            effectItem.classList.add('drag-over');
          }
        });

        effectItem.addEventListener('dragleave', (e) => {
          e.stopPropagation();
          effectItem.classList.remove('drag-over');
        });

        effectItem.addEventListener('drop', async (e) => {
          e.preventDefault();
          e.stopPropagation();
          effectItem.classList.remove('drag-over');
          if (draggedModeId !== mode.id || draggedEffectIndex === null || draggedEffectIndex === index) return;

          const targetMode = settingsState.enhancementModes.find(m => m.id === mode.id);
          if (targetMode && !targetMode.isBuiltIn) {
            const [movedEffect] = targetMode.effects.splice(draggedEffectIndex, 1);
            targetMode.effects.splice(index, 0, movedEffect);
            renderModesUI();
            await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
            notifyUpdate(mode.id);
          }
        });

        // --- Effect Action Buttons ---
        const effectActions = document.createElement('div');
        effectActions.className = 'effect-actions';

        const createMoveBtn = (dir: 'up' | 'down') => {
          const btn = document.createElement('button');

          // Create SVG arrow icon safely
          const svgNS = "http://www.w3.org/2000/svg";
          const arrowSvg = document.createElementNS(svgNS, "svg");
          arrowSvg.setAttribute("width", "12");
          arrowSvg.setAttribute("height", "12");
          arrowSvg.setAttribute("viewBox", "0 0 24 24");
          arrowSvg.setAttribute("fill", "currentColor");

          const arrowPath = document.createElementNS(svgNS, "path");
          // Use path data for up/down triangles
          if (dir === 'up') {
            arrowPath.setAttribute("d", "M12 4l-8 8h16z"); // Up triangle
          } else {
            arrowPath.setAttribute("d", "M12 20l-8-8h16z"); // Down triangle
          }
          arrowSvg.appendChild(arrowPath);

          btn.appendChild(arrowSvg);
          btn.className = 'btn-move-effect';
          btn.title = chrome.i18n.getMessage(dir === 'up' ? 'moveUp' : 'moveDown') || (dir === 'up' ? 'Move Up' : 'Move Down');
          btn.disabled = (dir === 'up' && index === 0) || (dir === 'down' && index === mode.effects.length - 1);
          btn.onclick = async () => {
            const targetMode = settingsState.enhancementModes.find(m => m.id === mode.id);
            if (targetMode && !targetMode.isBuiltIn) {
              const newIndex = dir === 'up' ? index - 1 : index + 1;
              const [movedEffect] = targetMode.effects.splice(index, 1);
              targetMode.effects.splice(newIndex, 0, movedEffect);
              renderModesUI();
              await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
              notifyUpdate(mode.id);
            }
          };
          return btn;
        };

        const removeEffectBtn = document.createElement('button');
        removeEffectBtn.textContent = '×';
        removeEffectBtn.className = 'btn-remove-effect';
        removeEffectBtn.title = chrome.i18n.getMessage('removeEffect') || 'Remove effect';
        removeEffectBtn.onclick = async () => {
          const targetMode = settingsState.enhancementModes.find(m => m.id === mode.id);
          if (targetMode && !targetMode.isBuiltIn) {
            targetMode.effects.splice(index, 1);
            renderModesUI();
            await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
            notifyUpdate(mode.id);
          }
        };

        effectActions.appendChild(createMoveBtn('up'));
        effectActions.appendChild(createMoveBtn('down'));
        effectActions.appendChild(removeEffectBtn);
        effectItem.appendChild(effectActions);
      }
      effectsList.appendChild(effectItem);
    });
    cardContent.appendChild(effectsList);

    // --- Add Effect Dropdown (for custom modes) ---
    if (!mode.isBuiltIn) {
      const addEffectContainer = document.createElement('div');
      addEffectContainer.className = 'add-effect-container';
      const effectSelect = document.createElement('select');
      const defaultOption = document.createElement('option');
      defaultOption.textContent = chrome.i18n.getMessage('addEffect') || 'Add effect...';
      defaultOption.disabled = true;
      defaultOption.selected = true;
      effectSelect.appendChild(defaultOption);

      AVAILABLE_EFFECTS.forEach(availEffect => {
        const option = document.createElement('option');
        option.value = availEffect.id;
        option.textContent = availEffect.name;
        effectSelect.appendChild(option);
      });

      effectSelect.onchange = async (e) => {
        const selectedEffectId = (e.target as HTMLSelectElement).value;
        const effectToAdd = AVAILABLE_EFFECTS.find(ef => ef.id === selectedEffectId);
        const targetMode = settingsState.enhancementModes.find(m => m.id === mode.id);

        if (targetMode && !targetMode.isBuiltIn && effectToAdd) {
          targetMode.effects.push(effectToAdd);
          renderModesUI();
          await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
          notifyUpdate(mode.id);
        }
        (e.target as HTMLSelectElement).value = defaultOption.value; // Reset dropdown
      };
      addEffectContainer.appendChild(effectSelect);
      cardContent.appendChild(addEffectContainer);
    }

    card.appendChild(cardContent);

    // 2. Restore expanded state after rendering
    if (expandedModeIds.has(mode.id)) {
      card.classList.remove('collapsed');
    }

    modesContainer.appendChild(card);
  };

  // Custom Modes section
  if (customModes.length > 0) {
    const customHeader = document.createElement('div');
    customHeader.className = 'modes-section-header';
    customHeader.textContent = chrome.i18n.getMessage('customModes') || 'Custom Modes';
    modesContainer.appendChild(customHeader);
    customModes.forEach(renderModeCard);
  }

  // Built-in Modes section
  if (builtInModes.length > 0) {
    const builtInHeader = document.createElement('div');
    builtInHeader.className = 'modes-section-header';
    builtInHeader.textContent = chrome.i18n.getMessage('builtInModes') || 'Built-in Modes';
    modesContainer.appendChild(builtInHeader);
    builtInModes.forEach(renderModeCard);
  }
};

/**
 * Renders the whitelist rules UI based on the current settingsState.
 */
const renderRulesUI = () => {
  rulesContainer.textContent = ''; // Clear existing rules
  settingsState.whitelist.forEach((rule) => {
    const row = document.createElement('tr');

    const patternCell = document.createElement('td');
    const patternInput = document.createElement('input');
    patternInput.type = 'text';
    patternInput.value = rule.pattern;
    patternInput.className = 'pattern-input';
    patternInput.addEventListener('change', async (e) => {
      const newPattern = (e.target as HTMLInputElement).value;
      if (validateRulePattern(newPattern)) {
        await updateWhitelistRule(rule.pattern, newPattern);
        rule.pattern = newPattern; // Update state
      } else {
        alert(chrome.i18n.getMessage('invalidPattern') || 'Invalid pattern format');
        (e.target as HTMLInputElement).value = rule.pattern;
      }
    });
    patternCell.appendChild(patternInput);

    const enabledCell = document.createElement('td');
    enabledCell.className = 'cell-center';
    const switchLabel = document.createElement('label');
    switchLabel.className = 'switch';
    const enabledCheckbox = document.createElement('input');
    enabledCheckbox.type = 'checkbox';
    enabledCheckbox.checked = rule.enabled;
    enabledCheckbox.addEventListener('change', async (e) => {
      const enabled = (e.target as HTMLInputElement).checked;
      await updateWhitelistRule(rule.pattern, enabled);
      rule.enabled = enabled; // Update state
    });
    const sliderSpan = document.createElement('span');
    sliderSpan.className = 'slider round';
    switchLabel.appendChild(enabledCheckbox);
    switchLabel.appendChild(sliderSpan);
    enabledCell.appendChild(switchLabel);

    const actionsCell = document.createElement('td');
    const deleteBtn = document.createElement('button');
    deleteBtn.textContent = chrome.i18n.getMessage('delete') || 'Delete';
    deleteBtn.className = 'action-btn';
    deleteBtn.addEventListener('click', async () => {
      await removeWhitelistRule(rule.pattern);
      settingsState.whitelist = settingsState.whitelist.filter(r => r.pattern !== rule.pattern);
      renderRulesUI();
    });
    actionsCell.appendChild(deleteBtn);

    row.appendChild(enabledCell);
    row.appendChild(patternCell);
    row.appendChild(actionsCell);
    rulesContainer.appendChild(row);
  });
};

const notifyUpdate = (modifiedModeId?: string) => {
  chrome.runtime.sendMessage({ type: 'SETTINGS_UPDATED', modifiedModeId });
};

const setupInternationalization = () => {
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(element => {
    const key = element.getAttribute('data-i18n');
    if (key) {
      const message = chrome.i18n.getMessage(key);
      if (message) {
        if (element.tagName === 'TITLE') document.title = message;
        else element.textContent = message;
      }
    }
  });

  // Add icons to tier select options
  const tierIcons: Record<string, string> = {
    performance: '🚀',
    balanced: '⚖️',
    quality: '🎨',
    ultra: '🔬'
  };
  document.querySelectorAll<HTMLOptionElement>('#tier-select option').forEach(option => {
    const icon = tierIcons[option.value];
    if (icon && option.textContent && !option.textContent.startsWith(icon)) {
      option.textContent = `${icon} ${option.textContent}`;
    }
  });
};

const renderGeneralSettingsUI = async () => {
  crossOriginFixToggle.checked = settingsState.enableCrossOriginFix;
  themeSelect.value = themeManager.getTheme();


  // Smart features UI
  const localSettings = await getLocalSettings();

  // Tier selector
  if (tierSelect) {
    tierSelect.value = localSettings.performanceTier;
  }
};

const renderAboutSectionUI = () => {
  if (versionNumberSpan) {
    const manifest = chrome.runtime.getManifest();
    versionNumberSpan.textContent = manifest.version;
  }
}

const renderColorGradingUI = () => {
  colorGradingToggle.checked = settingsState.colorGrading.enabled;
  renderColorGradingSliders(
    settingsState.colorGrading,
    colorGradingSliders,
    settingsState.colorGrading.enabled,
    async (updated) => {
      settingsState.colorGrading = updated;
      await saveSettings({ colorGrading: updated });
      notifyUpdate();
    },
  );
};

const setupEventListeners = () => {
  // --- General Settings Listeners ---
  crossOriginFixToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    settingsState.enableCrossOriginFix = enabled;
    await saveSettings({ enableCrossOriginFix: enabled });
    notifyUpdate();
  });

  // --- Theme Switch Listener ---
  themeSelect.addEventListener('change', (e) => {
    const selectedTheme = (e.target as HTMLSelectElement).value as 'light' | 'dark' | 'auto';
    themeManager.setTheme(selectedTheme);
  });

  // --- Color Grading Listener ---
  colorGradingToggle.addEventListener('change', async (e) => {
    const enabled = (e.target as HTMLInputElement).checked;
    settingsState.colorGrading.enabled = enabled;
    setColorGradingSlidersEnabled(colorGradingSliders, enabled);
    await saveSettings({ colorGrading: settingsState.colorGrading });
    notifyUpdate();
  });

  // --- Smart Features Listeners ---
  if (tierSelect) {
    tierSelect.addEventListener('change', async (e) => {
      const tier = (e.target as HTMLSelectElement).value as PerformanceTier;
      currentTier = tier;
      await saveLocalSettings({ performanceTier: tier });
      renderGeneralSettingsUI();
      renderModesUI();
      notifyUpdate();
    });
  }

  if (runBenchmarkBtn) {
    runBenchmarkBtn.addEventListener('click', async () => {
      runBenchmarkBtn.disabled = true;
      runBenchmarkBtn.textContent = chrome.i18n.getMessage('testing') || 'Testing...';

      // Show progress bar
      const progressContainer = document.getElementById('benchmark-progress');
      const progressFill = document.getElementById('benchmark-progress-fill');
      const progressText = document.getElementById('benchmark-progress-text');
      if (progressContainer) progressContainer.style.display = 'block';

      try {
        const result = await runGPUBenchmark((progress) => {
          // Update progress bar
          if (progressFill) progressFill.style.width = `${progress.progress * 100}%`;
          if (progressText) {
            if (progress.completed) {
              progressText.textContent = chrome.i18n.getMessage('testComplete') || 'Test complete!';
            } else {
              // Convert tier key to internationalized text
              const tierKey = `tier${progress.tier.charAt(0).toUpperCase()}${progress.tier.slice(1)}` as const;
              const tierName = chrome.i18n.getMessage(tierKey) || progress.tier;
              progressText.textContent = chrome.i18n.getMessage('testingTier', [tierName]) || `Testing ${tierName}...`;
            }
          }
        });

        // Ask user whether to apply the recommended tier
        const tierNames: Record<PerformanceTier, string> = {
          performance: `🚀 ${chrome.i18n.getMessage('tierPerformance') || 'Fast'}`,
          balanced: `⚖️ ${chrome.i18n.getMessage('tierBalanced') || 'Balanced'}`,
          quality: `🎨 ${chrome.i18n.getMessage('tierQuality') || 'Quality'}`,
          ultra: `🔬 ${chrome.i18n.getMessage('tierUltra') || 'Ultra'}`
        };
        const confirmMessage = chrome.i18n.getMessage('confirmApplyTier', [tierNames[result.tier]])
          || `Test complete! Recommended tier: ${tierNames[result.tier]}\n\nApply this tier?`;

        if (confirm(confirmMessage)) {
          await saveLocalSettings({
            performanceTier: result.tier,
            gpuBenchmarkResult: result,
          });
          currentTier = result.tier;
          renderGeneralSettingsUI();
          renderModesUI();
          notifyUpdate(); // Notify all renderers to update
        }
      } catch (error) {
        console.error('Benchmark failed:', error);
        const errorMsg = error instanceof Error ? error.message : String(error);
        alert((chrome.i18n.getMessage('testFailed') || 'Test failed') + ': ' + errorMsg);
      }

      // Hide progress bar
      if (progressContainer) progressContainer.style.display = 'none';
      runBenchmarkBtn.disabled = false;
      runBenchmarkBtn.textContent = chrome.i18n.getMessage('startTest') || 'Start Test';
    });
  }

  // --- Mode Listeners ---
  addModeBtn.addEventListener('click', async () => {
    const newMode: EnhancementMode = {
      id: `custom-${Date.now()}`,
      name: chrome.i18n.getMessage('newCustomModeName') || 'New Custom Mode',
      isBuiltIn: false,
      effects: [],
    };
    settingsState.enhancementModes.unshift(newMode);
    renderModesUI();
    await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
  });

  // --- Whitelist Listeners ---
  addRuleBtn.addEventListener('click', async () => {
    const newPattern = '*.example.com/*';
    // Prevent duplicate additions from the UI
    if (settingsState.whitelist.some(r => r.pattern === newPattern)) {
      alert(chrome.i18n.getMessage('ruleAlreadyExists') || 'This rule already exists.');
      return;
    }
    await addWhitelistRule(newPattern, true);
    // Re-fetch state to reflect changes
    settingsState.whitelist = (await getSettings()).whitelist;
    renderRulesUI();
  });

  // --- Mode Import/Export Listeners ---
  exportModesBtn.addEventListener('click', () => {
    const customModes = settingsState.enhancementModes.filter(mode => !mode.isBuiltIn);
    downloadJSON(customModes, 'anime4k-modes.json');
  });

  importModesBtn.addEventListener('click', async () => {
    try {
      const json = await openFile();
      const importedModes = JSON.parse(json) as EnhancementMode[];

      if (!Array.isArray(importedModes)) throw new Error('Invalid format: not an array');

      const newModes: CustomMode[] = [];
      for (const mode of importedModes) {
        if (typeof mode !== 'object' || typeof mode.name !== 'string' || !Array.isArray((mode as any).effects)) {
          console.warn('Skipping invalid mode object on import:', mode);
          continue;
        }

        const newMode: CustomMode = {
          id: `custom-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`,
          name: mode.name,
          isBuiltIn: false,
          effects: (mode as any).effects,
        };
        newModes.push(newMode);
      }

      // Synchronize effects for custom modes
      const syncedNewModes = synchronizeEffectsForCustomModes(newModes);
      const allCustomModes = [...settingsState.customModes, ...syncedNewModes];
      settingsState.customModes = allCustomModes;
      settingsState.enhancementModes = [
        ...settingsState.enhancementModes.filter(m => m.isBuiltIn),
        ...allCustomModes,
      ];

      renderModesUI();
      await saveSettings({ customModes: settingsState.customModes });
      notifyUpdate();
      alert(chrome.i18n.getMessage('importSuccess') || 'Import successful');
    } catch (error) {
      if (error instanceof Error && error.message === 'No file selected') {
        console.log('File import cancelled.');
        return;
      }
      console.error('Import failed:', error);
      alert(chrome.i18n.getMessage('importError') || 'Import failed: invalid format or file error.');
    }
  });

  // --- Whitelist Import/Export Listeners ---
  exportBtn.addEventListener('click', () => {
    downloadJSON(settingsState.whitelist, 'anime4k-whitelist.json');
  });

  importBtn.addEventListener('click', async () => {
    try {
      const json = await openFile();
      const rules = JSON.parse(json);
      if (!Array.isArray(rules)) throw new Error('Invalid format: not an array');

      const validRules: WhitelistRule[] = [];
      for (const rule of rules) {
        if (typeof rule === 'object' && rule.pattern && typeof rule.pattern === 'string' && typeof rule.enabled === 'boolean' && validateRulePattern(rule.pattern)) {
          validRules.push(rule as WhitelistRule);
        } else {
          console.warn('Skipping invalid whitelist rule on import:', rule);
        }
      }

      settingsState.whitelist = validRules;
      await saveSettings({ whitelist: settingsState.whitelist });
      renderRulesUI();
      alert(chrome.i18n.getMessage('importSuccess') || 'Import successful');
    } catch (error) {
      if (error instanceof Error && error.message === 'No file selected') {
        console.log('File import cancelled.');
        return;
      }
      console.error('Import failed:', error);
      alert(chrome.i18n.getMessage('importError') || 'Import failed: invalid format or file error.');
    }
  });

  // --- Message Listeners ---
  chrome.runtime.onMessage.addListener(async (message) => {
    if (message.type === 'WHITELIST_UPDATED') {
      // Re-fetch settings to get the latest whitelist from other parts of the extension
      settingsState = await getSettings();
      renderRulesUI();
    } else if (message.type === 'SETTINGS_UPDATED') {
      // Re-fetch settings and local settings to update tier and effect chain display
      settingsState = await getSettings();
      const localSettings = await getLocalSettings();
      currentTier = localSettings.performanceTier;
      renderModesUI();
      console.log('[Options] Settings updated, tier:', currentTier);
    }
  });
};

/**
 * Main initialization function.
 */
document.addEventListener('DOMContentLoaded', async () => {
  // Initialize theme
  themeManager.getTheme(); // This will automatically apply the saved theme

  setupInternationalization();

  // Initialize sidebar
  try {
    const sidebar = new Sidebar();
    sidebar.initialize();
  } catch (error) {
    console.error('Failed to initialize sidebar:', error);
  }

  if (!modesContainer || !addModeBtn || !importModesBtn || !exportModesBtn || !rulesContainer || !addRuleBtn || !importBtn || !exportBtn) {
    console.error('Required UI elements not found. Aborting initialization.');
    return;
  }

  // Load initial state from storage
  settingsState = await getSettings();

  // Read local settings to get current tier
  const localSettings = await getLocalSettings();
  currentTier = localSettings.performanceTier;

  // Initial UI rendering from state
  renderModesUI();
  renderRulesUI();
  renderGeneralSettingsUI();
  renderAboutSectionUI();
  renderColorGradingUI();

  // Attach all event listeners
  setupEventListeners();
});
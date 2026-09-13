/**
 * Enhancement Modes panel for the options page.
 *
 * Renders built-in and custom mode cards with drag-and-drop reordering,
 * expand/collapse, effect chain editing, cloning, and import/export.
 */
import { getEffectsForMode, getLocalSettings, saveSettings, synchronizeEffectsForCustomModes } from '@utils/settings';
import { resolveEffectReference } from '@utils/effect-registry';
import { AVAILABLE_EFFECTS } from '@utils/effects-map';
import type { EnhancementMode, EnhancementEffect, CustomMode, PerformanceTier } from '@/types';
import { renderParamSliders } from './param-sliders';
import { t } from '@utils/i18n';
import { downloadJSON, openFile } from './import-export';
import { formatValidationIssues, parseAndValidateModesImport } from '@utils/validation';
import { showToast } from '../common/toast';

// --- Drag and Drop State (module-local — no other panel touches it) ---
let draggedElement: HTMLElement | null = null;
let draggedModeId: string | null = null;
let draggedEffectIndex: number | null = null;

export interface AppContext {
  getState(): import('@/types').Anime4KWebExtSettings;
  getTier(): PerformanceTier;
  setTier(tier: PerformanceTier): void;
  refresh(): Promise<void>;
  notifyUpdate(modifiedModeId?: string): void;
  /**
   * Set by {@link initModesPanel}. Other panels (notably the General panel's
   * "Fast mode" toggle) call this to re-render the modes panel immediately
   * after a local-settings change that affects the preserve-detail policy note.
   * The options page's own cross-context listener never receives the options
   * page's own `SETTINGS_UPDATED` message, so an explicit refresh is required.
   */
  refreshModesPanel?: () => void;
}

export function initModesPanel(
  ctx: AppContext,
  modesContainer: HTMLElement,
  addModeBtn: HTMLButtonElement,
  exportModesBtn: HTMLButtonElement,
  importModesBtn: HTMLButtonElement,
): { render(): void } {

  // -----------------------------------------------------------------------
  //  "Fast mode — Preserve detail" policy cache
  // -----------------------------------------------------------------------
  // The local setting is read asynchronously, but render() rebuilds every card
  // synchronously. Cache the latest value once here and reuse it for the whole
  // pass (never await per effect). A changed value triggers one re-render.
  let preserveDetail = true;
  let policyFetchInFlight = false;

  /** Resolve an effect and report whether it is a restore-category effect. */
  function isRestoreEffect(effect: EnhancementEffect): boolean {
    const resolution = resolveEffectReference(effect);
    return (
      resolution.status === 'resolved' &&
      resolution.effect.descriptor.category === 'restore'
    );
  }

  function refreshPreserveDetailPolicy(): void {
    if (policyFetchInFlight) return;
    policyFetchInFlight = true;
    getLocalSettings()
      .then((local) => {
        const next = local.preserveDetail ?? true;
        if (next !== preserveDetail) {
          preserveDetail = next;
          render();
        }
      })
      .catch(() => {
        // Keep the last known policy value if storage is unavailable.
      })
      .finally(() => {
        policyFetchInFlight = false;
      });
  }

  // -----------------------------------------------------------------------
  //  Main render function
  // -----------------------------------------------------------------------
  function render() {
    const settingsState = ctx.getState();
    const currentTier = ctx.getTier();

    // Refresh the cached policy asynchronously for this/next pass.
    refreshPreserveDetailPolicy();

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
        if (e.dataTransfer) {
          e.dataTransfer.effectAllowed = 'move';
          e.dataTransfer.setData('text/plain', mode.id);
        }
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

          render(); // Re-render from state
          await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] }); // Persist changes
          ctx.notifyUpdate();
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
      toggleBtn.title = t('expandCollapse', 'Expand/Collapse');
      toggleBtn.addEventListener('click', () => {
        card.classList.toggle('collapsed');
      });

      const modeName = document.createElement('h2');
      modeName.textContent = mode.name;
      modeName.contentEditable = String(!mode.isBuiltIn);
      modeName.title = mode.isBuiltIn ? (t('builtInModeCannotRename', 'Built-in modes cannot be renamed.')) : (t('clickToRename', 'Click to rename'));
      modeName.addEventListener('blur', async (e) => {
        if (mode.isBuiltIn) return;
        const newName = (e.target as HTMLElement).textContent?.trim() || '';
        const targetMode = settingsState.enhancementModes.find(m => m.id === mode.id);
        if (targetMode && newName && newName !== targetMode.name) {
          targetMode.name = newName;
          mode.name = newName; // Update local object for consistency
          await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
          ctx.notifyUpdate(mode.id);
        } else {
          (e.target as HTMLElement).textContent = mode.name;
        }
      });

      const deleteBtn = document.createElement('button');
      deleteBtn.textContent = t('delete', 'Delete');
      deleteBtn.className = 'btn btn-danger';
      deleteBtn.style.display = mode.isBuiltIn ? 'none' : 'block';
      deleteBtn.onclick = async () => {
        if (confirm(t('deleteModeConfirm', undefined, [mode.name]))) {
          const deletedModeId = mode.id;
          settingsState.enhancementModes = settingsState.enhancementModes.filter(m => m.id !== deletedModeId);
          if (settingsState.selectedModeId === deletedModeId) {
            settingsState.selectedModeId = 'builtin-mode-a'; // Fall back to default mode
          }
          render();
          await saveSettings({
            customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[],
            selectedModeId: settingsState.selectedModeId,
          });
          ctx.notifyUpdate(deletedModeId);
        }
      };

      // Clone button — creates a custom copy of a built-in mode
      const cloneBtn = document.createElement('button');
      cloneBtn.textContent = t('clone', 'Clone');
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
        render();
        await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
        ctx.notifyUpdate(clonedMode.id);
      };

      cardHeader.appendChild(toggleBtn);
      cardHeader.appendChild(modeName);
      cardHeader.appendChild(cloneBtn);
      cardHeader.appendChild(deleteBtn);
      card.appendChild(cardHeader);

      // --- Summary (shown when collapsed) ---
      const summary = document.createElement('div');
      summary.className = 'mode-summary';
      const modeEffects = getEffectsForMode(mode, currentTier);
      const effectNames = modeEffects.map((e: EnhancementEffect) => e.name.split('/').pop());
      const summaryText = effectNames.length > 3
        ? effectNames.slice(0, 3).join(' > ') + ' ...'
        : effectNames.join(' > ');
      summary.textContent = summaryText || (t('noEffects', 'No effects'));
      card.appendChild(summary);

      // Whether this chain contains any restore-category effect. Computed from
      // the descriptors, not from runtime geometry (see note below).
      const hasRestoreEffects = modeEffects.some(isRestoreEffect);

      // --- Card Content (shown when expanded) ---
      const cardContent = document.createElement('div');
      cardContent.className = 'mode-card-content';

      // Policy note — not a computed prediction. Suppression depends on runtime
      // geometry (source resolution, render target, upscale factors), so we
      // describe the policy only. Applies to built-in and custom modes alike.
      if (preserveDetail && hasRestoreEffects) {
        const policyNote = document.createElement('p');
        policyNote.className = 'mode-policy-note';
        policyNote.textContent = t(
          'preserveDetailModeNote',
          'Trailing restore passes may be skipped by "Fast mode". Turning it off runs the full chain, which is not always higher quality.',
        );
        cardContent.appendChild(policyNote);
      }

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

        const effectNameRow = document.createElement('div');
        effectNameRow.className = 'effect-name-row';
        effectNameRow.appendChild(effectName);

        // Restore-category effects are subject to the "Fast mode"
        // policy. This is a policy marker, not a claim that this effect will be
        // skipped: whether suppression happens depends on runtime geometry.
        if (isRestoreEffect(effect)) {
          const policyBadge = document.createElement('span');
          policyBadge.className = 'effect-policy-badge';
          policyBadge.textContent = t('restorePolicyBadge', 'Restore');
          policyBadge.title = t(
            'restorePolicyBadgeTitle',
            'Restore pass — may be skipped when "Fast mode" is on.',
          );
          effectNameRow.appendChild(policyBadge);
        }

        effectContent.appendChild(effectNameRow);

        if (effect.params && !mode.isBuiltIn) {
          const paramsWrapper = document.createElement('div');
          paramsWrapper.className = 'effect-params-wrapper';
          renderParamSliders(effect, mode.id, effectItem, paramsWrapper, async (modeId) => {
            await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
            ctx.notifyUpdate(modeId);
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
            if (e.dataTransfer) {
              e.dataTransfer.effectAllowed = 'move';
            }
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
              render();
              await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
              ctx.notifyUpdate(mode.id);
            }
          });

          // --- Effect Action Buttons ---
          const effectActions = document.createElement('div');
          effectActions.className = 'effect-actions';

          const createMoveBtn = (dir: 'up' | 'down') => {
            const btn = document.createElement('button');

            const arrowSvg = document.createElementNS(svgNS, "svg");
            arrowSvg.setAttribute("width", "12");
            arrowSvg.setAttribute("height", "12");
            arrowSvg.setAttribute("viewBox", "0 0 24 24");
            arrowSvg.setAttribute("fill", "currentColor");

            const arrowPath = document.createElementNS(svgNS, "path");
            if (dir === 'up') {
              arrowPath.setAttribute("d", "M12 4l-8 8h16z");
            } else {
              arrowPath.setAttribute("d", "M12 20l-8-8h16z");
            }
            arrowSvg.appendChild(arrowPath);

            btn.appendChild(arrowSvg);
            btn.className = 'btn-move-effect';
            btn.title = t(dir === 'up' ? 'moveUp' : 'moveDown', dir === 'up' ? 'Move Up' : 'Move Down');
            btn.disabled = (dir === 'up' && index === 0) || (dir === 'down' && index === mode.effects.length - 1);
            btn.onclick = async () => {
              const targetMode = settingsState.enhancementModes.find(m => m.id === mode.id);
              if (targetMode && !targetMode.isBuiltIn) {
                const newIndex = dir === 'up' ? index - 1 : index + 1;
                const [movedEffect] = targetMode.effects.splice(index, 1);
                targetMode.effects.splice(newIndex, 0, movedEffect);
                render();
                await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
                ctx.notifyUpdate(mode.id);
              }
            };
            return btn;
          };

          const removeEffectBtn = document.createElement('button');
          removeEffectBtn.textContent = '×';
          removeEffectBtn.className = 'btn-remove-effect';
          removeEffectBtn.title = t('removeEffect', 'Remove effect');
          removeEffectBtn.onclick = async () => {
            const targetMode = settingsState.enhancementModes.find(m => m.id === mode.id);
            if (targetMode && !targetMode.isBuiltIn) {
              targetMode.effects.splice(index, 1);
              render();
              await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
              ctx.notifyUpdate(mode.id);
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
        defaultOption.textContent = t('addEffect', 'Add effect...');
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
            render();
            await saveSettings({ customModes: settingsState.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
            ctx.notifyUpdate(mode.id);
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
      customHeader.textContent = t('customModes', 'Custom Modes');
      modesContainer.appendChild(customHeader);
      customModes.forEach(renderModeCard);
    }

    // Built-in Modes section
    if (builtInModes.length > 0) {
      const builtInHeader = document.createElement('div');
      builtInHeader.className = 'modes-section-header';
      builtInHeader.textContent = t('builtInModes', 'Built-in Modes');
      modesContainer.appendChild(builtInHeader);
      builtInModes.forEach(renderModeCard);
    }
  }

  // Expose the renderer through the shared context so other panels can refresh
  // the preserve-detail policy note immediately after a local-settings change.
  ctx.refreshModesPanel = render;

  // -----------------------------------------------------------------------
  //  Add Mode
  // -----------------------------------------------------------------------
  addModeBtn.addEventListener('click', async () => {
    const state = ctx.getState();
    const newMode: EnhancementMode = {
      id: `custom-${Date.now()}`,
      name: t('newCustomModeName', 'New Custom Mode'),
      isBuiltIn: false,
      effects: [],
    };
    state.enhancementModes.unshift(newMode);
    render();
    await saveSettings({ customModes: state.enhancementModes.filter(m => !m.isBuiltIn) as CustomMode[] });
  });

  // -----------------------------------------------------------------------
  //  Export Modes
  // -----------------------------------------------------------------------
  exportModesBtn.addEventListener('click', () => {
    const customModes = ctx.getState().enhancementModes.filter(mode => !mode.isBuiltIn);
    downloadJSON(customModes, 'anime4k-modes.json');
  });

  // -----------------------------------------------------------------------
  //  Import Modes
  // -----------------------------------------------------------------------
  importModesBtn.addEventListener('click', async () => {
    try {
      const json = await openFile();
      const result = parseAndValidateModesImport(json);

      // Atomic: reject the whole payload rather than partially applying valid modes.
      if (!result.ok) {
        console.error('Import validation failed:', result.issues);
        showToast(
          `${t('importError', 'Import failed: invalid format or file error.')} (${formatValidationIssues(result.issues)})`,
          'error',
        );
        return;
      }

      const state = ctx.getState();
      const syncedNewModes = synchronizeEffectsForCustomModes(result.value);
      const allCustomModes = [...state.customModes, ...syncedNewModes];
      state.customModes = allCustomModes;
      state.enhancementModes = [
        ...state.enhancementModes.filter(m => m.isBuiltIn),
        ...allCustomModes,
      ];

      render();
      await saveSettings({ customModes: state.customModes });
      ctx.notifyUpdate();
      showToast(t('importSuccess', 'Import successful'), 'success');
    } catch (error) {
      if (error instanceof Error && error.message === 'No file selected') {
        console.log('File import cancelled.');
        return;
      }
      console.error('Import failed:', error);
      showToast(t('importError', 'Import failed: invalid format or file error.'), 'error');
    }
  });

  return { render };
}

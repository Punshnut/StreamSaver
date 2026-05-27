import { QUALITY_SET, QUALITY_ORDER_MAP } from './constants.js';
import { debug, createResult, isMenuEntryUsable, getMenuEntryText, wait, clickElementSafely, waitForCondition } from './utils.js';
import { serializeRect } from './geometry.js';
import { findVisibleMenuRoots, findSettingsMenuRootsByText } from './menu-find.js';
import { normalizeQualityLabel, extractResolutionQuality, labelHasSourceAlias, inferSourceAliasTargets, qualityLabelMatchesTarget, analyzeQualityEntryText } from './quality-matching.js';
import { openSettingsMenu } from './settings-menu.js';

/** Keeps option diagnostics compact before shipping them through extension messaging. */
export function compactSelectionPreview(option) {
  return {
    label: option.label,
    normalized: option.normalized,
    selected: option.selected,
    selectedConfidence: option.selectedConfidence,
    selectedScore: option.selectedScore,
    selectionSignals: option.selectionSignals,
    deselectionSignals: option.deselectionSignals
  };
}

/** Maps raw quality options to compact diagnostic previews. */
export function toSelectionPreviews(options) {
  return Array.isArray(options) ? options.map((option) => compactSelectionPreview(option)) : [];
}

/** Creates a consistent unknown-quality result payload. */
export function createUnknownCurrentQualityResult(message, reason, options, extraDetails = {}) {
  return createResult(false, 'CURRENT_QUALITY_UNKNOWN', message, {
    quality: 'unknown',
    reason,
    options: toSelectionPreviews(options),
    ...extraDetails
  });
}

/** Returns the configured order index for one normalized quality value. */
export function getQualityOrder(quality) {
  if (!QUALITY_SET.has(quality)) {
    return -1;
  }
  return QUALITY_ORDER_MAP[quality];
}

/** Extracts numeric quality value from normalized key (e.g. "1080p" -> 1080). */
export function parseNumericQualityValue(quality) {
  if (!QUALITY_SET.has(quality) || quality === 'Source') {
    return null;
  }
  const numeric = Number.parseInt(String(quality), 10);
  return Number.isFinite(numeric) ? numeric : null;
}

/** Deduplicates and sorts visible quality levels from low to high. */
export function collectSortedAvailableQualityLevels(options) {
  const available = new Set();
  for (const option of Array.isArray(options) ? options : []) {
    const normalized = normalizeQualityLabel(option?.normalized || option?.label || '');
    if (QUALITY_SET.has(normalized)) {
      available.add(normalized);
    }

    // Source-like labels can still contain a concrete resolution (e.g. 1080p60).
    const extracted = extractResolutionQuality(option?.label || '');
    if (QUALITY_SET.has(extracted)) {
      available.add(extracted);
    }
  }

  return Array.from(available).sort((a, b) => getQualityOrder(a) - getQualityOrder(b));
}

/** Resolves boundary fallback when requested quality is outside available range. */
export function resolveOutOfRangeQualityTarget(targetQuality, options) {
  const normalizedTarget = normalizeQualityLabel(targetQuality);
  if (!normalizedTarget) {
    return createResult(false, 'INVALID_TARGET_QUALITY', 'Target quality is not recognized.', {
      targetQuality
    });
  }

  const availableQualities = collectSortedAvailableQualityLevels(options);
  if (availableQualities.length === 0) {
    return createResult(false, 'NO_QUALITY_OPTIONS', 'No quality options are available for fallback resolution.', {
      requestedQuality: normalizedTarget
    });
  }

  const numericAvailableQualities = availableQualities
    .map((quality) => ({ quality, value: parseNumericQualityValue(quality) }))
    .filter((entry) => Number.isFinite(entry.value))
    .sort((a, b) => a.value - b.value);
  const targetNumeric = parseNumericQualityValue(normalizedTarget);

  if (Number.isFinite(targetNumeric) && numericAvailableQualities.length > 0) {
    const lowestNumeric = numericAvailableQualities[0];
    const highestNumeric = numericAvailableQualities[numericAvailableQualities.length - 1];

    if (targetNumeric > highestNumeric.value) {
      return createResult(true, 'QUALITY_FALLBACK_TO_HIGHEST', 'Requested quality is above available range.', {
        requestedQuality: normalizedTarget,
        resolvedQuality: highestNumeric.quality,
        direction: 'down',
        boundary: 'highest',
        availableQualities
      });
    }

    if (targetNumeric < lowestNumeric.value) {
      return createResult(true, 'QUALITY_FALLBACK_TO_LOWEST', 'Requested quality is below available range.', {
        requestedQuality: normalizedTarget,
        resolvedQuality: lowestNumeric.quality,
        direction: 'up',
        boundary: 'lowest',
        availableQualities
      });
    }
  } else if (Number.isFinite(targetNumeric) && availableQualities.includes('Source')) {
    // Fallback when only source-like entries are available.
    return createResult(true, 'QUALITY_FALLBACK_TO_HIGHEST', 'Requested quality is above available range.', {
      requestedQuality: normalizedTarget,
      resolvedQuality: 'Source',
      direction: 'down',
      boundary: 'highest',
      availableQualities
    });
  }

  if (normalizedTarget === 'Source' && !availableQualities.includes('Source') && numericAvailableQualities.length > 0) {
    const highestNumeric = numericAvailableQualities[numericAvailableQualities.length - 1];
    return createResult(true, 'QUALITY_FALLBACK_TO_HIGHEST', 'Source is unavailable; using highest available resolution.', {
      requestedQuality: normalizedTarget,
      resolvedQuality: highestNumeric.quality,
      direction: 'down',
      boundary: 'highest',
      availableQualities
    });
  }

  return createResult(false, 'QUALITY_TARGET_WITHIN_RANGE', 'Requested quality is within available range.', {
    requestedQuality: normalizedTarget,
    availableQualities
  });
}

/** Collects practical selection indicators from one quality menu option element. */
export function analyzeQualityOptionSelectionState(entry, label) {
  const positiveSignals = [];
  const negativeSignals = [];
  let score = 0;

  // Use weighted signals to resolve conflicting selection indicators.
  const addPositive = (signal, weight) => {
    positiveSignals.push(signal);
    score += weight;
  };
  // Negative signals lower confidence for this option.
  const addNegative = (signal, weight) => {
    negativeSignals.push(signal);
    score -= weight;
  };

  const ariaChecked = String(entry.getAttribute('aria-checked') || '').toLowerCase();
  if (ariaChecked === 'true') addPositive('aria-checked=true', 8);
  if (ariaChecked === 'false') addNegative('aria-checked=false', 8);

  const ariaSelected = String(entry.getAttribute('aria-selected') || '').toLowerCase();
  if (ariaSelected === 'true') addPositive('aria-selected=true', 8);
  if (ariaSelected === 'false') addNegative('aria-selected=false', 8);

  const ariaCurrentRaw = String(entry.getAttribute('aria-current') || '').toLowerCase();
  if (ariaCurrentRaw && ariaCurrentRaw !== 'false') {
    addPositive(`aria-current=${ariaCurrentRaw}`, 5);
  }

  const checkedInput = entry.querySelector('input[type="radio"]:checked, input[type="checkbox"]:checked');
  if (checkedInput) {
    addPositive('checked-input', 8);
  }

  const classDataText = [
    String(entry.className || ''),
    String(entry.getAttribute('data-a-target') || ''),
    String(entry.getAttribute('data-test-selector') || ''),
    String(entry.getAttribute('data-state') || '')
  ].join(' ').toLowerCase();

  if (/\b(selected|is-selected|active|is-active|checked|current)\b/.test(classDataText)) {
    addPositive('active-class-or-data', 3);
  }

  const entryLabelText = String(label || '').toLowerCase();
  if (/\b(current|aktuell|selected)\b/.test(entryLabelText)) {
    addPositive('label-current-marker', 2);
  }

  const indicatorSelector =
    '[aria-label*="check" i], [aria-label*="selected" i], [data-a-target*="check" i], [class*="checkmark" i], [class*="selected" i], svg';
  const indicatorNodes = Array.from(entry.querySelectorAll(indicatorSelector)).filter((node) => {
    if (!(node instanceof Element) || !node.isConnected) return false;
    if (node.getAttribute('aria-hidden') === 'true') return false;
    const s = window.getComputedStyle(node);
    return s.display !== 'none' && s.visibility !== 'hidden' && s.visibility !== 'collapse';
  });
  const hasCheckIndicator = indicatorNodes.some((node) => {
    const visibleText = getMenuEntryText(node);
    if (/[✓✔☑]/.test(visibleText)) {
      return true;
    }
    const aria = String(node.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('check') || aria.includes('selected')) {
      return true;
    }
    const classData = [
      String(node.className || ''),
      String(node.getAttribute('data-a-target') || '')
    ].join(' ').toLowerCase();
    return /\b(check|checkmark|selected|active)\b/.test(classData);
  });
  if (hasCheckIndicator) {
    addPositive('visible-check-indicator', 4);
  }

  const hasStrongPositiveSignal =
    positiveSignals.includes('aria-checked=true') ||
    positiveSignals.includes('aria-selected=true') ||
    positiveSignals.includes('checked-input');
  const hasStrongNegativeSignal =
    negativeSignals.includes('aria-checked=false') ||
    negativeSignals.includes('aria-selected=false');

  let selected = false;
  let selectedConfidence = 'low';

  if (hasStrongPositiveSignal && !hasStrongNegativeSignal) {
    selected = true;
    selectedConfidence = 'high';
  } else if (!hasStrongNegativeSignal && score >= 7) {
    selected = true;
    selectedConfidence = 'medium';
  }

  if (hasStrongNegativeSignal && !hasStrongPositiveSignal) {
    selected = false;
    selectedConfidence = 'low';
  }

  return {
    selected,
    selectedScore: score,
    selectedConfidence,
    selectionSignals: positiveSignals,
    deselectionSignals: negativeSignals
  };
}

/** Captures visible quality options and marks which one appears selected. */
export function collectVisibleQualityOptions() {
  const menuRoots = findVisibleMenuRoots();
  if (menuRoots.length === 0) {
    return createResult(false, 'MENU_NOT_VISIBLE', 'No visible menu to collect quality options from.');
  }

  const selector =
    'button, [role="menuitem"], [role="menuitemradio"], [role="option"], [data-a-target], label';
  const optionsByKey = new Map();

  for (const menuRoot of menuRoots) {
    const entries = Array.from(menuRoot.querySelectorAll(selector))
      .filter((entry) => isMenuEntryUsable(entry))
      .filter((entry) => !entry.matches('a[href]'));
    for (const entry of entries) {
      const label = getMenuEntryText(entry);
      if (!label) {
        continue;
      }

      const normalized = normalizeQualityLabel(label);
      if (!normalized) {
        continue;
      }

      const key = `${normalized}:${label.toLowerCase()}`;
      const selectionState = analyzeQualityOptionSelectionState(entry, label);
      const option = {
        element: entry,
        label,
        normalized,
        selected: selectionState.selected,
        selectedConfidence: selectionState.selectedConfidence,
        selectedScore: selectionState.selectedScore,
        selectionSignals: selectionState.selectionSignals,
        deselectionSignals: selectionState.deselectionSignals
      };

      const existing = optionsByKey.get(key);
      if (!existing) {
        optionsByKey.set(key, option);
        continue;
      }

      const isHigherSignal =
        option.selectedScore > existing.selectedScore ||
        (option.selected && !existing.selected) ||
        (option.selected === existing.selected && option.selectedConfidence === 'high' && existing.selectedConfidence !== 'high');

      if (isHigherSignal) {
        optionsByKey.set(key, option);
      }
    }
  }

  const options = Array.from(optionsByKey.values());

  if (options.length === 0) {
    return createResult(false, 'NO_QUALITY_OPTIONS', 'No visible quality options were detected.');
  }

  debug('collectVisibleQualityOptions: parsed options', options.map((option) => compactSelectionPreview(option)));

  return createResult(true, 'QUALITY_OPTIONS_COLLECTED', 'Collected visible quality options.', {
    options
  });
}

/** Infers selected quality from option state, else unknown. */
export function detectCurrentSelectedQuality(existingOptions = null) {
  let options = existingOptions;
  if (!Array.isArray(options)) {
    const optionsResult = collectVisibleQualityOptions();
    if (!optionsResult.ok) {
      return createResult(false, optionsResult.code, optionsResult.message, {
        quality: 'unknown',
        options: [],
        optionsResult
      });
    }
    options = optionsResult.details.options;
  }

  const selectedCandidates = options
    .filter((option) => option.selected)
    .sort((a, b) => b.selectedScore - a.selectedScore);

  if (selectedCandidates.length === 1) {
    const selected = selectedCandidates[0];
    debug('detectCurrentSelectedQuality: inferred from single selected candidate', compactSelectionPreview(selected));
    return createResult(true, 'CURRENT_QUALITY_DETECTED', `Detected current quality: ${selected.normalized}.`, {
      quality: selected.normalized,
      method: selected.selectedConfidence === 'high' ? 'selection-signals-high' : 'selection-signals-medium',
      selectedOption: compactSelectionPreview(selected),
      options: toSelectionPreviews(options)
    });
  }

  if (selectedCandidates.length > 1) {
    const top = selectedCandidates[0];
    const runnerUp = selectedCandidates[1];
    const topLead = top.selectedScore - runnerUp.selectedScore;

    if (top.selectedConfidence === 'high' && topLead >= 4) {
      debug('detectCurrentSelectedQuality: multiple selected candidates; top candidate chosen by score lead', {
        top: compactSelectionPreview(top),
        runnerUp: compactSelectionPreview(runnerUp),
        topLead
      });
      return createResult(true, 'CURRENT_QUALITY_DETECTED_BY_SCORE', `Detected current quality: ${top.normalized}.`, {
        quality: top.normalized,
        method: 'score-lead-disambiguation',
        topLead,
        selectedOption: compactSelectionPreview(top),
        selectedCandidates: toSelectionPreviews(selectedCandidates),
        options: toSelectionPreviews(options)
      });
    }

    debug('detectCurrentSelectedQuality: ambiguous selected candidates', {
      selectedCandidates: toSelectionPreviews(selectedCandidates)
    });
    return createUnknownCurrentQualityResult('Current quality is ambiguous in submenu state.', 'multiple-selected-candidates', options, {
      selectedCandidates: toSelectionPreviews(selectedCandidates)
    });
  }

  debug('detectCurrentSelectedQuality: no selected indicators found in submenu options', {
    options: toSelectionPreviews(options)
  });
  return createUnknownCurrentQualityResult(
    'No reliable selected quality indicator found in submenu state.',
    'no-selection-indicator',
    options
  );
}

/** Selects the best strict match for target quality. */
export function findBestMatchingQualityOption(targetQuality, existingOptions = null, matchOptions = {}) {
  const normalizedTarget = normalizeQualityLabel(targetQuality);
  if (!normalizedTarget) {
    return createResult(false, 'INVALID_TARGET_QUALITY', 'Target quality is not recognized.', {
      targetQuality
    });
  }

  let options = existingOptions;
  if (!Array.isArray(options)) {
    const optionsResult = collectVisibleQualityOptions();
    if (!optionsResult.ok) {
      return createResult(false, optionsResult.code, optionsResult.message, optionsResult.details);
    }
    options = optionsResult.details.options;
  }

  const candidates = options.filter((option) => qualityLabelMatchesTarget(option.label, normalizedTarget, matchOptions));
  if (candidates.length === 0) {
    return createResult(false, 'QUALITY_MATCH_NOT_FOUND', `Requested ${normalizedTarget} is not available.`, {
      normalizedTarget,
      available: options.map((option) => option.label),
      allowSourceAliasForTargets:
        matchOptions.allowSourceAliasForTargets instanceof Set
          ? Array.from(matchOptions.allowSourceAliasForTargets)
          : []
    });
  }

  let chosen = candidates[0];
  if (normalizedTarget === 'Source') {
    // Prefer explicit "source" labels over aliases like "chunked".
    const explicitSource = candidates.find((option) => option.label.toLowerCase().includes('source'));
    if (explicitSource) {
      chosen = explicitSource;
    }
  }

  if (normalizedTarget !== 'Source') {
    const explicitResolutionCandidates = candidates.filter((option) => {
      return extractResolutionQuality(option.label) === normalizedTarget;
    });
    const preferred = explicitResolutionCandidates.length > 0 ? explicitResolutionCandidates : candidates;
    const alreadySelected = preferred.find((option) => option.selected);
    chosen = alreadySelected || preferred[0];
  } else {
    // Return already-selected target first to avoid extra clicks.
    const alreadySelected = candidates.find((option) => option.selected);
    if (alreadySelected) {
      chosen = alreadySelected;
    }
  }

  return createResult(true, 'QUALITY_MATCH_FOUND', 'Found best matching quality option.', {
    option: chosen,
    normalizedTarget,
    available: options.map((option) => option.label),
    alreadySelected: Boolean(chosen.selected)
  });
}

/** Finds the quality/resolution entry inside the currently open settings menu. */
export function findQualityMenuEntry() {
  const menuRoots = findVisibleMenuRoots();
  const seenRoots = new Set(menuRoots);
  for (const root of findSettingsMenuRootsByText()) {
    if (!seenRoots.has(root)) {
      seenRoots.add(root);
      menuRoots.push(root);
    }
  }

  if (menuRoots.length === 0) {
    return createResult(false, 'MENU_NOT_VISIBLE', 'No visible menu to search for quality entry.');
  }

  const selector = 'button, [role="menuitem"], [role="option"], [role="button"], a, [data-a-target], div, span';
  const qualityLabels = ['quality', 'qualität', 'video quality', 'resolution', 'auflösung'];
  const candidates = [];

  for (const menuRoot of menuRoots) {
    const entries = Array.from(menuRoot.querySelectorAll(selector)).filter((entry) => isMenuEntryUsable(entry));
    for (const entry of entries) {
      const entryText = getMenuEntryText(entry) || String(entry.textContent || '').replace(/\s+/g, ' ').trim();
      if (!entryText) {
        continue;
      }
      const analysis = analyzeQualityEntryText(entryText);

      const text = entryText.toLowerCase();
      const labelMatch = qualityLabels.some((label) => text.includes(label));
      if (!labelMatch && !analysis.isQualityEntry) {
        continue;
      }

      const score =
        (labelMatch ? 4 : 0) +
        (analysis.matchedBy.includes('qualityLabel') ? 3 : 0) +
        (entry.matches('button, [role="button"], [role="menuitem"]') ? 2 : 0) +
        (text.includes('qualität') || text.includes('quality') ? 2 : 0) +
        (text.includes('resolution') || text.includes('auflösung') ? 1 : 0);

      candidates.push({
        element: entry,
        label: entryText,
        score,
        matchedVariant: labelMatch ? 'localizedLabel' : analysis.matchedBy.join('+'),
        rect: serializeRect(entry.getBoundingClientRect())
      });
    }
  }

  if (candidates.length > 0) {
    candidates.sort((a, b) => b.score - a.score || a.label.length - b.label.length);
    debug('findQualityMenuEntry: quality candidates', candidates.slice(0, 8).map((candidate) => ({
      label: candidate.label,
      score: candidate.score,
      matchedVariant: candidate.matchedVariant,
      rect: candidate.rect
    })));
    const best = candidates[0];
    debug('findQualityMenuEntry: matched quality entry', {
      text: best.label,
      matchedVariant: best.matchedVariant,
      score: best.score
    });
    return createResult(true, 'QUALITY_ENTRY_FOUND', 'Found quality menu entry.', {
      element: best.element,
      label: best.label,
      matchedVariant: best.matchedVariant
    });
  }

  return createResult(false, 'QUALITY_ENTRY_NOT_FOUND', 'Quality entry was not found in visible menus.');
}

/** Allows continuing when settings state is recoverable. */
export function canProceedAfterSettingsResult(settingsResult) {
  if (settingsResult?.ok) {
    return true;
  }

  const recoverableCodes = new Set([
    'SETTINGS_MENU_ALREADY_OPEN_AMBIGUOUS',
    'SETTINGS_MENU_NOT_EXACTLY_ONE',
    'MULTIPLE_MENUS_OPEN'
  ]);
  if (recoverableCodes.has(settingsResult?.code)) {
    return true;
  }

  const acceptedCount =
    settingsResult?.details?.menuState?.acceptedCount ??
    settingsResult?.details?.acceptedCount ??
    0;
  return Number(acceptedCount) > 0;
}

/** Opens the quality submenu and waits for options. */
export async function openQualitySubmenu() {
  debug('openQualitySubmenu: opening settings first');

  const settingsResult = await openSettingsMenu();
  if (!canProceedAfterSettingsResult(settingsResult)) {
    return createResult(false, settingsResult.code, settingsResult.message, settingsResult.details);
  }
  if (!settingsResult.ok) {
    debug('openQualitySubmenu: proceeding with already-open/ambiguous settings state', settingsResult);
  }

  let qualityEntryResult = findQualityMenuEntry();
  if (!qualityEntryResult.ok) {
    const waitQualityResult = await waitForCondition(() => {
      const maybeEntry = findQualityMenuEntry();
      return maybeEntry.ok ? maybeEntry : null;
    }, {
      timeoutMs: 1200,
      intervalMs: 80,
      description: 'quality menu entry'
    });

    if (!waitQualityResult.ok) {
      return createResult(false, 'QUALITY_ENTRY_NOT_FOUND', 'Could not find quality entry after opening settings.', {
        settingsResult,
        waitQualityResult
      });
    }

    qualityEntryResult = waitQualityResult.details.value;
  }

  debug('openQualitySubmenu: clicking quality entry', qualityEntryResult.details.label);
  const clickResult = clickElementSafely(qualityEntryResult.details.element, { prepare: false });
  if (!clickResult.ok) {
    return createResult(false, clickResult.code, 'Failed to click quality entry.', clickResult.details);
  }

  const optionsWaitResult = await waitForCondition(() => {
    const optionsResult = collectVisibleQualityOptions();
    return optionsResult.ok ? optionsResult : null;
  }, {
    timeoutMs: 1400,
    intervalMs: 90,
    description: 'visible quality options'
  });

  if (!optionsWaitResult.ok) {
    return createResult(false, 'QUALITY_OPTIONS_NOT_FOUND', 'Quality submenu did not render visible options in time.', {
      qualityEntryLabel: qualityEntryResult.details.label,
      optionsWaitResult
    });
  }

  // Small stability window: Firefox renders quality rows slower than Chrome.
  // Waiting briefly after the first options appear gives remaining rows time to render
  // before the caller begins matching, reducing reliance on the pre-fallback retry.
  await wait(150);

  const optionsResult = optionsWaitResult.details.value;
  debug('openQualitySubmenu: quality options visible', { count: optionsResult.details.options.length });

  return createResult(true, 'QUALITY_SUBMENU_OPEN', 'Quality submenu opened successfully.', {
    qualityEntryLabel: qualityEntryResult.details.label,
    options: optionsResult.details.options
  });
}

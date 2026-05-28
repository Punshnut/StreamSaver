/**
 * content/quality-menu.js
 *
 * All logic for reading and navigating the Twitch quality submenu. This module
 * does not click quality options itself — that is handled by quality-apply.js.
 *
 * deployQualityPanel()     — opens settings, finds and clicks the quality row,
 *                            waits for quality options to render
 * scanQualityOptions()     — collects all visible quality menu entries and scores
 *                            each one for "is this the currently selected option"
 * readActiveQuality()      — infers which quality is selected from scan results
 * aimQualityOption()       — finds the best matching entry for a target quality
 * snapQualityToRange()     — boundary fallback when the target is outside the
 *                            range of available options (e.g. stream max is 720p
 *                            but user requested 1080p → pick 720p instead)
 * probeOptionState()       — weighted signal collector for selection detection
 *                            (aria-checked, aria-selected, checked inputs, etc.)
 * findQualityMenuEntry()   — locates the "Quality / Qualität" row inside the
 *                            currently open settings overlay
 * rankQualityTiers()       — deduplicates and sorts available quality labels
 * canProceedAfterSettingsResult() — whether automation can continue after a
 *                            partially-successful settings open
 */

import { QUALITY_SET, QUALITY_ORDER_MAP } from './constants.js';
import { debug, createResult, isMenuEntryUsable, getMenuEntryText, wait, stealthClick, awaitSignal } from './utils.js';
import { serializeRect } from './geometry.js';
import { scanMenuRoots, findSettingsMenuRootsByText } from './menu-find.js';
import { parseQualityTag, extractResolutionQuality, labelHasSourceAlias, inferSourceAliasTargets, qualityLabelMatchesTarget, analyzeQualityEntryText } from './quality-matching.js';
import { deploySettingsPanel } from './settings-menu.js';

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
export function rankQualityTiers(options) {
  const available = new Set();
  for (const option of Array.isArray(options) ? options : []) {
    const normalized = parseQualityTag(option?.normalized || option?.label || '');
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
export function snapQualityToRange(targetQuality, options) {
  const normalizedTarget = parseQualityTag(targetQuality);
  if (!normalizedTarget) {
    return createResult(false, 'INVALID_TARGET_QUALITY', 'Target quality is not recognized.', {
      targetQuality
    });
  }

  const availableQualities = rankQualityTiers(options);
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

/**
 * Collects practical selection indicators from one quality menu option element.
 *
 * Signal weights reflect how authoritatively each attribute expresses "selected":
 *   8 — aria-checked / aria-selected / checked-input: W3C ARIA spec defines these as the
 *       canonical way to communicate checked/selected state on interactive elements. Twitch
 *       setting these is an explicit semantic declaration we can trust unconditionally.
 *   5 — aria-current: valid selection indicator, but also used for navigation context (e.g.
 *       "current page" in breadcrumbs), so it's strong but not authoritative on its own.
 *   4 — visible checkmark icon: reliable if present, but depends on CSS not hiding it and
 *       on Twitch's SVG/icon implementation — visual-only, no semantic guarantee.
 *   3 — active/selected/checked CSS class or data-state: heuristic based on Twitch's internal
 *       class names. Not standardized, can change with a UI update.
 *   2 — "current"/"aktuell"/"selected" in the label text: the weakest hint — Twitch sometimes
 *       appends "(current)" to the selected option as a plain-text cue.
 *
 * Confidence levels:
 *   'high'   — a strong positive (weight 8) with no contradicting strong negative.
 *   'medium' — score ≥ 7 with no strong negative (e.g. aria-current=5 + checkmark=4,
 *              or two mid-weight signals). Threshold of 7 requires at least two
 *              independent positive signals — one alone isn't enough.
 *   'low'    — anything below 7, or contradicting strong signals (both aria-checked=true
 *              and aria-checked=false present, indicating broken/conflicting markup).
 */
export function probeOptionState(entry, label) {
  const positiveSignals = [];
  const negativeSignals = [];
  let score = 0;

  const addPositive = (signal, weight) => {
    positiveSignals.push(signal);
    score += weight;
  };
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
export function scanQualityOptions() {
  const menuRoots = scanMenuRoots();
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

      const normalized = parseQualityTag(label);
      if (!normalized) {
        continue;
      }

      const key = `${normalized}:${label.toLowerCase()}`;
      const selectionState = probeOptionState(entry, label);
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

  debug('scanQualityOptions: parsed options', options.map((option) => compactSelectionPreview(option)));

  return createResult(true, 'QUALITY_OPTIONS_COLLECTED', 'Collected visible quality options.', {
    options
  });
}

/** Infers selected quality from option state, else unknown. */
export function readActiveQuality(existingOptions = null) {
  let options = existingOptions;
  if (!Array.isArray(options)) {
    const optionsResult = scanQualityOptions();
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
    debug('readActiveQuality: inferred from single selected candidate', compactSelectionPreview(selected));
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
      debug('readActiveQuality: multiple selected candidates; top candidate chosen by score lead', {
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

    debug('readActiveQuality: ambiguous selected candidates', {
      selectedCandidates: toSelectionPreviews(selectedCandidates)
    });
    return createUnknownCurrentQualityResult('Current quality is ambiguous in submenu state.', 'multiple-selected-candidates', options, {
      selectedCandidates: toSelectionPreviews(selectedCandidates)
    });
  }

  debug('readActiveQuality: no selected indicators found in submenu options', {
    options: toSelectionPreviews(options)
  });
  return createUnknownCurrentQualityResult(
    'No reliable selected quality indicator found in submenu state.',
    'no-selection-indicator',
    options
  );
}

/** Selects the best strict match for target quality. */
export function aimQualityOption(targetQuality, existingOptions = null, matchOptions = {}) {
  const normalizedTarget = parseQualityTag(targetQuality);
  if (!normalizedTarget) {
    return createResult(false, 'INVALID_TARGET_QUALITY', 'Target quality is not recognized.', {
      targetQuality
    });
  }

  let options = existingOptions;
  if (!Array.isArray(options)) {
    const optionsResult = scanQualityOptions();
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
  const menuRoots = scanMenuRoots();
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
export async function deployQualityPanel() {
  debug('deployQualityPanel: opening settings first');

  const settingsResult = await deploySettingsPanel();
  if (!canProceedAfterSettingsResult(settingsResult)) {
    return createResult(false, settingsResult.code, settingsResult.message, settingsResult.details);
  }
  if (!settingsResult.ok) {
    debug('deployQualityPanel: proceeding with already-open/ambiguous settings state', settingsResult);
  }

  let qualityEntryResult = findQualityMenuEntry();
  if (!qualityEntryResult.ok) {
    const waitQualityResult = await awaitSignal(() => {
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

  debug('deployQualityPanel: clicking quality entry', qualityEntryResult.details.label);
  const clickResult = stealthClick(qualityEntryResult.details.element, { prepare: false });
  if (!clickResult.ok) {
    return createResult(false, clickResult.code, 'Failed to click quality entry.', clickResult.details);
  }

  const optionsWaitResult = await awaitSignal(() => {
    const optionsResult = scanQualityOptions();
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

  // Twitch renders the first quality row immediately when the submenu opens, then appends
  // remaining rows (lower bitrates) in a deferred React flush. Without this pause,
  // scanQualityOptions() often sees only the top 1–2 rows, and the 5-attempt retry loop
  // inside engageQuality() would have to absorb the wait instead — adding unpredictable
  // latency there. 150 ms is empirically tuned to cover the flush on both Chrome and Firefox.
  await wait(150);

  const optionsResult = optionsWaitResult.details.value;
  debug('deployQualityPanel: quality options visible', { count: optionsResult.details.options.length });

  return createResult(true, 'QUALITY_SUBMENU_OPEN', 'Quality submenu opened successfully.', {
    qualityEntryLabel: qualityEntryResult.details.label,
    options: optionsResult.details.options
  });
}

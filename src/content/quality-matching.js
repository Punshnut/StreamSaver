/**
 * content/quality-matching.js
 *
 * Pure string-matching helpers that normalize raw Twitch menu labels into the
 * canonical quality keys ('160p', '360p', …, 'Source', 'Auto') and determine
 * whether a given label matches a target quality.
 *
 * These functions are locale-aware: SOURCE_TERMS and AUTO_TERMS include
 * translated equivalents (e.g. "Quelle", "Automatisch") so they work across
 * all Twitch UI languages without extra branching at the call site.
 *
 * parseQualityTag(label)       — maps any label to a canonical quality key or ''
 * hasResolutionValue(text, n)  — safely matches a resolution number without
 *                                false positives from partial matches (e.g.
 *                                "1080" must not match "21080")
 * extractResolutionQuality()   — extracts the resolution part of a Source-like
 *                                label (e.g. "1080p60 (Source)" → '1080p')
 * labelHasSourceAlias()        — true when a label contains any SOURCE_TERM
 * inferSourceAliasTargets()    — builds the set of concrete resolutions that
 *                                map to source-like labels in this stream
 * analyzeQualityEntryText()    — determines whether a settings row looks like
 *                                the quality row (vs subtitles, advanced, etc.)
 * qualityLabelMatchesTarget()  — central matcher used by aimQualityOption()
 */

import { SOURCE_TERMS, AUTO_TERMS, QUALITY_SET, QUALITY_ENTRY_TERMS, RESOLUTION_PATTERN } from './constants.js';

/** Normalizes Twitch quality labels into extension-level quality keys. */
export function parseQualityTag(label) {
  const raw = String(label || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return '';
  }

  const lower = raw.toLowerCase();

  // Check Auto first — "Auto" can appear before resolution info in some labels.
  if (AUTO_TERMS.some((term) => lower.startsWith(term))) return 'Auto';
  // Source check: labels like "Source", "Quelle", "Chunked", "1080p60 (source)".
  if (SOURCE_TERMS.some((term) => lower.includes(term))) return 'Source';

  // Resolution checks in descending order so "1440" doesn't accidentally match
  // a label that also contains "1080" earlier in the string.
  if (hasResolutionValue(lower, '2160')) return '2160p';
  if (hasResolutionValue(lower, '1440')) return '1440p';
  if (hasResolutionValue(lower, '1080')) return '1080p';
  if (hasResolutionValue(lower, '720')) return '720p';
  if (hasResolutionValue(lower, '480')) return '480p';
  if (hasResolutionValue(lower, '360')) return '360p';
  if (hasResolutionValue(lower, '160')) return '160p';
  return '';
}

/** Matches one numeric resolution token while avoiding partial number collisions.
 *  The pattern requires the value to be preceded by a non-digit (or start of string)
 *  and followed by an optional frame-rate suffix like "60" in "1080p60". */
export function hasResolutionValue(text, value) {
  const lower = String(text || '').toLowerCase();
  // Pattern breakdown (example: value = "1080"):
  //   (^|[^0-9])      — left guard: digit must be preceded by a non-digit or start-of-string.
  //                     Implemented as a capture group rather than a lookbehind to avoid a
  //                     RegExp lookbehind assertion, which has patchy support in older engines.
  //                     .test() ignores the captured character so it doesn't affect the match.
  //                     Prevents "21080" from matching "1080".
  //   ${value}        — the literal resolution digits ("1080").
  //   (?:\\s*p\\d*)?  — optional fps suffix: matches "1080", "1080p", "1080p60", "1080 p30".
  //   (?=$|[^0-9])    — zero-width right lookahead (not lookbehind): checks that whatever
  //                     follows the optional suffix is either end-of-string or a non-digit,
  //                     without consuming it. Prevents a bare "1080" from matching inside
  //                     "10801" when the optional p-group matched nothing.
  const pattern = new RegExp(`(^|[^0-9])${value}(?:\\s*p\\d*)?(?=$|[^0-9])`, 'i');
  return pattern.test(lower);
}

/** Extracts a normalized resolution key from option text.
 *  Used to pull the concrete resolution out of labels like "1080p60 (Source)"
 *  so we know the stream is actually 1080p when shown as Source. */
export function extractResolutionQuality(label) {
  const lower = String(label || '').toLowerCase();
  if (!lower) {
    return '';
  }
  // Same order as parseQualityTag — highest first to avoid substring collisions.
  if (hasResolutionValue(lower, '2160')) return '2160p';
  if (hasResolutionValue(lower, '1440')) return '1440p';
  if (hasResolutionValue(lower, '1080')) return '1080p';
  if (hasResolutionValue(lower, '720')) return '720p';
  if (hasResolutionValue(lower, '480')) return '480p';
  if (hasResolutionValue(lower, '360')) return '360p';
  if (hasResolutionValue(lower, '160')) return '160p';
  return '';
}

/** Detects whether a label uses any source-level alias terms.
 *  Covers "source", "quelle", "chunked" and any future SOURCE_TERMS additions. */
export function labelHasSourceAlias(label) {
  const lower = String(label || '').toLowerCase();
  return SOURCE_TERMS.some((term) => lower.includes(term));
}

/** Infers which concrete resolutions are represented by source-like menu labels.
 *  E.g. if the quality entry label says "1080p60 (source)" we add '1080p' to
 *  the set so that when the user targets '1080p', a source-aliased entry counts
 *  as a match. Also scans each option label for the same pattern. */
export function inferSourceAliasTargets(qualityEntryLabel, options = []) {
  const inferred = new Set();

  // Helper: only add when the label is source-like AND contains a resolution.
  const maybeAdd = (label) => {
    if (!labelHasSourceAlias(label)) {
      return; // not a source-type label — skip
    }
    const resolution = extractResolutionQuality(label);
    if (resolution && QUALITY_SET.has(resolution)) {
      inferred.add(resolution); // this resolution can be matched via a source label
    }
  };

  // Check the settings row label (e.g. "1080p60 (Source)") first.
  maybeAdd(qualityEntryLabel);
  // Then check each option in the submenu — Twitch sometimes puts the resolution
  // inside the option label but not the settings row label (or vice versa).
  for (const option of Array.isArray(options) ? options : []) {
    if (option && typeof option.label === 'string') {
      maybeAdd(option.label);
    }
  }

  return inferred;
}

/** Checks whether a settings row looks like quality.
 *  Returns matchedBy[] to help the caller score ambiguous entries. */
export function analyzeQualityEntryText(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const matchedBy = [];

  // Direct quality keyword match (e.g. "Quality", "Qualität", "resolution").
  if (QUALITY_ENTRY_TERMS.some((term) => lower.includes(term))) {
    matchedBy.push('qualityLabel');
  }
  // The row shows a resolution number, suggesting it's the active quality summary.
  if (RESOLUTION_PATTERN.test(lower)) {
    matchedBy.push('resolutionValue');
  }
  // Source/chunked label in the row text.
  if (SOURCE_TERMS.some((term) => lower.includes(term))) {
    matchedBy.push('sourceLabel');
  }

  // Must have a quality label, OR a resolution + source hint (the summary row
  // that shows the current quality like "1080p60 (Source)").
  const isQualityEntry =
    matchedBy.includes('qualityLabel') ||
    (matchedBy.includes('resolutionValue') && matchedBy.includes('sourceLabel'));

  return { isQualityEntry, matchedBy };
}

/** Matches a requested quality against option text.
 *  Handles locale variations, Source-alias sets, and the allowSourceAliasForTargets
 *  set that lets a source-like entry count as a match for a numeric target. */
export function qualityLabelMatchesTarget(label, normalizedTarget, options = {}) {
  const lower = String(label || '').toLowerCase();
  // Reject empty labels or unknown target keys immediately.
  if (!lower || !QUALITY_SET.has(normalizedTarget)) {
    return false;
  }

  if (normalizedTarget === 'Auto') {
    // Auto can appear as "Auto", "Automatisch", "Automatique", etc.
    return AUTO_TERMS.some((term) => lower.startsWith(term));
  }

  if (normalizedTarget === 'Source') {
    // Source can appear as "Source", "Quelle", or "Chunked".
    return labelHasSourceAlias(lower);
  }

  // Numeric quality: check if the label's resolution matches the target.
  const resolution = extractResolutionQuality(lower);
  if (resolution === normalizedTarget) {
    return true;
  }

  // Source-alias override: if we know "1080p60 (source)" represents 1080p,
  // allow matching '1080p' against that source-like entry.
  const allowSourceAliasForTargets = options?.allowSourceAliasForTargets;
  const canUseSourceAlias =
    allowSourceAliasForTargets instanceof Set && allowSourceAliasForTargets.has(normalizedTarget);

  if (canUseSourceAlias && labelHasSourceAlias(lower)) {
    return true;
  }

  return false;
}

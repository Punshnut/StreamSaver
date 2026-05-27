import { SOURCE_TERMS, AUTO_TERMS, QUALITY_SET, QUALITY_ENTRY_TERMS, RESOLUTION_PATTERN } from './constants.js';

/** Normalizes Twitch quality labels into extension-level quality keys. */
export function normalizeQualityLabel(label) {
  const raw = String(label || '').replace(/\s+/g, ' ').trim();
  if (!raw) {
    return '';
  }

  const lower = raw.toLowerCase();
  if (AUTO_TERMS.some((term) => lower.startsWith(term))) return 'Auto';
  if (SOURCE_TERMS.some((term) => lower.includes(term))) return 'Source';
  if (hasResolutionValue(lower, '2160')) return '2160p';
  if (hasResolutionValue(lower, '1440')) return '1440p';
  if (hasResolutionValue(lower, '1080')) return '1080p';
  if (hasResolutionValue(lower, '720')) return '720p';
  if (hasResolutionValue(lower, '480')) return '480p';
  if (hasResolutionValue(lower, '360')) return '360p';
  if (hasResolutionValue(lower, '160')) return '160p';
  return '';
}

/** Matches one numeric resolution token while avoiding partial number collisions. */
export function hasResolutionValue(text, value) {
  const lower = String(text || '').toLowerCase();
  const pattern = new RegExp(`(^|[^0-9])${value}(?:\\s*p\\d*)?(?=$|[^0-9])`, 'i');
  return pattern.test(lower);
}

/** Extracts a normalized resolution key from option text. */
export function extractResolutionQuality(label) {
  const lower = String(label || '').toLowerCase();
  if (!lower) {
    return '';
  }
  if (hasResolutionValue(lower, '2160')) return '2160p';
  if (hasResolutionValue(lower, '1440')) return '1440p';
  if (hasResolutionValue(lower, '1080')) return '1080p';
  if (hasResolutionValue(lower, '720')) return '720p';
  if (hasResolutionValue(lower, '480')) return '480p';
  if (hasResolutionValue(lower, '360')) return '360p';
  if (hasResolutionValue(lower, '160')) return '160p';
  return '';
}

/** Detects whether a label uses any source-level alias terms. */
export function labelHasSourceAlias(label) {
  const lower = String(label || '').toLowerCase();
  return SOURCE_TERMS.some((term) => lower.includes(term));
}

/** Infers which concrete resolutions are represented by source-like menu labels. */
export function inferSourceAliasTargets(qualityEntryLabel, options = []) {
  const inferred = new Set();
  // Add source-like labels only when they include a concrete resolution.
  const maybeAdd = (label) => {
    if (!labelHasSourceAlias(label)) {
      return;
    }
    const resolution = extractResolutionQuality(label);
    if (resolution && QUALITY_SET.has(resolution)) {
      inferred.add(resolution);
    }
  };

  maybeAdd(qualityEntryLabel);
  for (const option of Array.isArray(options) ? options : []) {
    if (option && typeof option.label === 'string') {
      maybeAdd(option.label);
    }
  }

  return inferred;
}

/** Checks whether a settings row looks like quality. */
export function analyzeQualityEntryText(label) {
  const text = String(label || '').replace(/\s+/g, ' ').trim();
  const lower = text.toLowerCase();
  const matchedBy = [];

  if (QUALITY_ENTRY_TERMS.some((term) => lower.includes(term))) {
    matchedBy.push('qualityLabel');
  }
  if (RESOLUTION_PATTERN.test(lower)) {
    matchedBy.push('resolutionValue');
  }
  if (SOURCE_TERMS.some((term) => lower.includes(term))) {
    matchedBy.push('sourceLabel');
  }

  // Prefer explicit quality terms, but allow resolution+source hints.
  const isQualityEntry =
    matchedBy.includes('qualityLabel') ||
    (matchedBy.includes('resolutionValue') && matchedBy.includes('sourceLabel'));

  return { isQualityEntry, matchedBy };
}

/** Matches a requested quality against option text. */
export function qualityLabelMatchesTarget(label, normalizedTarget, options = {}) {
  const lower = String(label || '').toLowerCase();
  if (!lower || !QUALITY_SET.has(normalizedTarget)) {
    return false;
  }

  if (normalizedTarget === 'Auto') {
    // Auto can appear as Auto, Automatisch, Automatique, or similar.
    return AUTO_TERMS.some((term) => lower.startsWith(term));
  }

  if (normalizedTarget === 'Source') {
    // Source can appear as Source, Quelle, or Chunked.
    return labelHasSourceAlias(lower);
  }

  const resolution = extractResolutionQuality(lower);
  if (resolution === normalizedTarget) {
    return true;
  }

  const allowSourceAliasForTargets = options?.allowSourceAliasForTargets;
  const canUseSourceAlias =
    allowSourceAliasForTargets instanceof Set && allowSourceAliasForTargets.has(normalizedTarget);

  if (canUseSourceAlias && labelHasSourceAlias(lower)) {
    return true;
  }

  return false;
}

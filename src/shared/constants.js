/**
 * shared/constants.js
 *
 * Cross-boundary constants shared between the content script and the popup.
 * Keeping them here avoids duplicating the quality list in both bundles and
 * ensures both sides agree on the same canonical values and validation logic.
 */

export const QUALITY_VALUES = ['160p', '360p', '480p', '720p', '1080p', '1440p', '2160p', 'Source', 'Auto'];
export const QUALITY_SET = new Set(QUALITY_VALUES);
export const MODE_VALUES = {
  LOW: 'low',
  HIGH: 'high'
};
export const MODE_SET = new Set(Object.values(MODE_VALUES));

/** Returns value if it's a valid quality string, otherwise returns fallback. */
export function resolveQuality(value, fallback) {
  return QUALITY_SET.has(value) ? value : fallback;
}

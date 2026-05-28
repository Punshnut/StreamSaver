/**
 * content/geometry.js
 *
 * Tiny collection of rectangle helpers used throughout the content script
 * when reasoning about element positions (player bounds, menu placement, etc.).
 *
 * serializeRect(rect)   — converts a DOMRect to a plain object with rounded
 *                          integers; safe to include in debug log payloads and
 *                          cross-context messages
 * isRectInside()        — containment check with optional tolerance; used to
 *                          verify that a candidate button lies inside the player
 * isRectNear()          — proximity check; used to confirm a menu overlay is
 *                          adjacent to the player (not some unrelated panel)
 */

/** Serializes DOMRect values into compact integer coordinates for debug payloads. */
export function serializeRect(rect) {
  // Math.round so floating-point sub-pixel values don't clutter log output.
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

/** Checks whether `innerRect` is inside `outerRect`.
 *  tolerance allows a few pixels of overflow for sub-pixel rendering edge cases. */
export function isRectInside(outerRect, innerRect, tolerance = 0) {
  return (
    innerRect.left >= outerRect.left - tolerance &&
    innerRect.right <= outerRect.right + tolerance &&
    innerRect.top >= outerRect.top - tolerance &&
    innerRect.bottom <= outerRect.bottom + tolerance
  );
}

/** Checks whether two rectangles overlap or are nearby.
 *  threshold defines how far apart the rects can be and still count as "near". */
export function isRectNear(rectA, rectB, threshold = 40) {
  // Invert the "definitely not near" check — if none of the four gap conditions
  // are true, the rects must overlap or be within threshold pixels of each other.
  return !(
    rectA.right < rectB.left - threshold ||
    rectA.left > rectB.right + threshold ||
    rectA.bottom < rectB.top - threshold ||
    rectA.top > rectB.bottom + threshold
  );
}

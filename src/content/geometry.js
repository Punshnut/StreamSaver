/** Serializes DOMRect values into compact integer coordinates for debug payloads. */
export function serializeRect(rect) {
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height)
  };
}

/** Checks whether `innerRect` is inside `outerRect`. */
export function isRectInside(outerRect, innerRect, tolerance = 0) {
  return (
    innerRect.left >= outerRect.left - tolerance &&
    innerRect.right <= outerRect.right + tolerance &&
    innerRect.top >= outerRect.top - tolerance &&
    innerRect.bottom <= outerRect.bottom + tolerance
  );
}

/** Checks whether two rectangles overlap or are nearby. */
export function isRectNear(rectA, rectB, threshold = 40) {
  return !(
    rectA.right < rectB.left - threshold ||
    rectA.left > rectB.right + threshold ||
    rectA.bottom < rectB.top - threshold ||
    rectA.top > rectB.bottom + threshold
  );
}

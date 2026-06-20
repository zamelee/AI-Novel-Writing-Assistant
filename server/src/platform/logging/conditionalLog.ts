/**
 * Conditional console logger gated by the AI_NOVEL_DEBUG_LOG environment
 * variable. Default is OFF; set AI_NOVEL_DEBUG_LOG=1 (or "true"/"on"/"yes")
 * to enable verbose server logs that previously leaked to stdout in production.
 *
 * Use condLog() for debug/info output and condWarn() for warnings that should
 * still surface when debug logging is off (e.g. recoverable warnings).
 */

const TRUE_VALUES = new Set(["1", "true", "on", "yes"]);
const FALSE_VALUES = new Set(["0", "false", "off", "no"]);

let cached: boolean | null = null;

export function isConditionalDebugEnabled(): boolean {
  if (cached !== null) return cached;
  const raw = process.env.AI_NOVEL_DEBUG_LOG?.trim().toLowerCase();
  if (raw && FALSE_VALUES.has(raw)) {
    cached = false;
  } else if (raw && TRUE_VALUES.has(raw)) {
    cached = true;
  } else {
    cached = false;
  }
  return cached;
}

/** Reset the cache. Only used by tests. */
export function _resetConditionalDebugCache(): void {
  cached = null;
}

export function condLog(...args: unknown[]): void {
  if (isConditionalDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.log(...args);
  }
}

export function condWarn(...args: unknown[]): void {
  // Warnings always surface; only the payload is gated by debug mode.
  if (isConditionalDebugEnabled()) {
    // eslint-disable-next-line no-console
    console.warn(...args);
  }
}

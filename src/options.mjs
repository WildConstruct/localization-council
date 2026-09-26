/**
 * Flag parsing helpers. Bad values are usage errors (exit 2), never a silent
 * fallback: a threshold of NaN would make every comparison false and let rows
 * through.
 */

import { UsageError } from "./errors.mjs";

/**
 * Parse a numeric option. Returns `fallback` when the value is absent.
 * @param {unknown} value
 * @param {string} flag - e.g. "--meaning-threshold" (for the error message)
 * @param {number|null} fallback
 * @param {{ min?: number, max?: number, integer?: boolean }} [rules]
 */
export function numberOption(value, flag, fallback, { min, max, integer = false } = {}) {
  if (value === undefined || value === null) return fallback;
  const text = String(value).trim();
  const n = text === "" ? NaN : Number(text);
  const ok =
    Number.isFinite(n) &&
    (!integer || Number.isInteger(n)) &&
    (min === undefined || n >= min) &&
    (max === undefined || n <= max);
  if (!ok) {
    const range = [
      integer ? "an integer" : "a number",
      min !== undefined && max !== undefined ? `from ${min} to ${max}` : min !== undefined ? `≥ ${min}` : max !== undefined ? `≤ ${max}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    throw new UsageError(`${flag} must be ${range}, got "${value}"`);
  }
  return n;
}

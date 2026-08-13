// Auto-redaction + host-hidden ranges (security design §5).
//
// Two independent layers, applied in serializeMessage when the recipient
// role is `guest`:
//   1. Auto-redaction: regex patterns replace secret-looking substrings.
//   2. Host-hidden ranges: explicit {messageId, start, end} slices the host
//      marked hidden for a guest.
//
// Hosts always see the raw, unredacted text.
//
// Idempotency: the replacement tokens (`[redacted]`, `[email redacted]`,
// `[hidden by host]`) contain no pattern-matchable chars, so running the
// redaction pipeline twice on the same string yields the same output. The
// adapter must not re-redact already-redacted transcript history on replay.

/**
 * Auto-redaction patterns (security §5). Order matters only for the email
 * pattern, which is last so prior replacements can't break the local-part.
 * @type {Array<{re: RegExp, repl: string}>}
 */
export const REDACT_PATTERNS = [
  { re: /sk-ant-[A-Za-z0-9-_]+/g, repl: '[redacted]' },        // Anthropic keys
  { re: /sk-[A-Za-z0-9]{20,}/g, repl: '[redacted]' },          // generic API keys
  { re: /Bearer\s+[A-Za-z0-9._-]+/gi, repl: '[redacted]' },    // auth headers
  { re: /password\s*[:=]\s*\S+/gi, repl: '[redacted]' },       // password assignments
  { re: /\/Users\/\S+|\/home\/\S+|C:\\Users\\\S+/g, repl: '[redacted]' }, // local paths
  { re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, repl: '[email redacted]' },
];

/**
 * Apply every REDACT_PATTERN to `text`. Idempotent.
 * @param {string} text
 * @returns {string}
 */
export function redactForGuest(text) {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const { re, repl } of REDACT_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, repl);
  }
  return out;
}

/**
 * Replace `text.slice(start, end)` with `[hidden by host]` for each range.
 * Ranges are `{messageId, start, end}`. The caller filters by messageId
 * before calling (so this helper applies every range it receives). Applied
 * from highest start to lowest so earlier indices stay valid as we splice.
 *
 * Out-of-bounds or inverted ranges are skipped (never throw) — a malformed
 * range from the host must never crash the broadcast path.
 *
 * @param {string} text
 * @param {Array<{messageId: string, start: number, end: number}>} ranges
 * @returns {string}
 */
export function applyHiddenRanges(text, ranges) {
  if (typeof text !== 'string' || !ranges || ranges.length === 0) return text;
  const valid = ranges
    .filter((r) => r && typeof r.start === 'number' && typeof r.end === 'number'
      && r.start >= 0 && r.end <= text.length && r.start < r.end)
    .sort((a, b) => b.start - a.start);
  if (valid.length === 0) return text;
  let out = text;
  for (const r of valid) {
    out = out.slice(0, r.start) + '[hidden by host]' + out.slice(r.end);
  }
  return out;
}

/**
 * Full guest-view transform: auto-redact, then apply hidden ranges. The
 * ranges must already be filtered to the message being serialized.
 *
 * @param {string} text
 * @param {Array<{messageId: string, start: number, end: number}>} [ranges]
 * @returns {string}
 */
export function redactForGuestWithRanges(text, ranges) {
  const redacted = redactForGuest(text);
  return applyHiddenRanges(redacted, ranges);
}

// Per-connection flood guard: pure sliding-window helper. Extracted from
// server/index.js so it can be unit-tested without a socket (security design §9).

/**
 * Mutates `state.floodTimestamps` in place: drops entries older than
 * `windowMs` (relative to `now`), then decides whether a new message is
 * allowed. Returns `{ limited: true }` when `maxMsgs` messages already fall
 * inside the window; otherwise pushes `now` and returns `{ limited: false }`.
 *
 * @param {{ floodTimestamps?: number[] }} state
 * @param {number} now
 * @param {number} windowMs
 * @param {number} maxMsgs
 * @returns {{ limited: boolean }}
 */
export function floodCheck(state, now, windowMs, maxMsgs) {
  const ts = (state.floodTimestamps ?? []).filter((t) => now - t < windowMs);
  state.floodTimestamps = ts;
  if (ts.length >= maxMsgs) return { limited: true };
  ts.push(now);
  return { limited: false };
}

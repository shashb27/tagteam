import { describe, it, expect } from 'vitest';
import { floodCheck } from '../../server/flood.js';
import { FLOOD_WINDOW_MS, FLOOD_MAX_MSGS } from '../../server/config.js';

describe('floodCheck (per-connection sliding window)', () => {
  it('allows up to FLOOD_MAX_MSGS inside the window', () => {
    const state = { floodTimestamps: [] };
    const now = 10_000;
    for (let i = 0; i < FLOOD_MAX_MSGS; i++) {
      const r = floodCheck(state, now, FLOOD_WINDOW_MS, FLOOD_MAX_MSGS);
      expect(r.limited).toBe(false);
    }
    // window now full
    const r = floodCheck(state, now, FLOOD_WINDOW_MS, FLOOD_MAX_MSGS);
    expect(r.limited).toBe(true);
  });

  it('drops timestamps older than the window before counting', () => {
    const state = { floodTimestamps: [0, 1, 2] };
    // now is well past FLOOD_WINDOW_MS — old entries drop, message allowed
    const now = FLOOD_WINDOW_MS + 5_000;
    const r = floodCheck(state, now, FLOOD_WINDOW_MS, FLOOD_MAX_MSGS);
    expect(r.limited).toBe(false);
    expect(state.floodTimestamps).toEqual([now]);
  });

  it('limits when the window is saturated even with mixed ages', () => {
    const state = { floodTimestamps: [] };
    const t0 = 0;
    // fill window with FLOOD_MAX_MSGS at t0
    for (let i = 0; i < FLOOD_MAX_MSGS; i++) {
      floodCheck(state, t0, FLOOD_WINDOW_MS, FLOOD_MAX_MSGS);
    }
    // a later message still inside the window → limited
    const r = floodCheck(state, t0 + FLOOD_WINDOW_MS - 1, FLOOD_WINDOW_MS, FLOOD_MAX_MSGS);
    expect(r.limited).toBe(true);
  });

  it('pushes the new timestamp when allowed', () => {
    const state = { floodTimestamps: [] };
    floodCheck(state, 100, 1000, 5);
    expect(state.floodTimestamps).toEqual([100]);
  });

  it('does not push when limited', () => {
    const state = { floodTimestamps: [100, 101, 102, 103, 104, 105, 106, 107, 108, 109] };
    const before = state.floodTimestamps.length;
    const r = floodCheck(state, 110, 1000, 10);
    expect(r.limited).toBe(true);
    expect(state.floodTimestamps.length).toBe(before);
  });

  it('tolerates missing floodTimestamps array', () => {
    const state = {};
    const r = floodCheck(state, 5, 1000, 3);
    expect(r.limited).toBe(false);
    expect(state.floodTimestamps).toEqual([5]);
  });
});

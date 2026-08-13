import { describe, it, expect } from 'vitest';
import {
  redactForGuest, applyHiddenRanges, redactForGuestWithRanges, REDACT_PATTERNS,
} from '../../server/redact.js';

describe('redactForGuest — pattern coverage', () => {
  it('redacts Anthropic keys (sk-ant-...)', () => {
    expect(redactForGuest('my key is sk-ant-api03-secret-123-abc here'))
      .toBe('my key is [redacted] here');
  });
  it('redacts generic sk- keys (>=20 chars)', () => {
    expect(redactForGuest('token: sk-12345678901234567890'))
      .toBe('token: [redacted]');
  });
  it('does NOT redact a short sk- prefix (<20 chars)', () => {
    expect(redactForGuest('sk-short')).toBe('sk-short');
  });
  it('redacts Bearer tokens', () => {
    expect(redactForGuest('Authorization: Bearer abc.def.ghi-token'))
      .toBe('Authorization: [redacted]');
  });
  it('redacts password assignments (case-insensitive)', () => {
    // The pattern consumes the `password:` / `PASSWORD=` prefix too.
    expect(redactForGuest('password: hunter2 and PASSWORD=secret123'))
      .toBe('[redacted] and [redacted]');
  });
  it('redacts /Users/ and /home/ paths', () => {
    expect(redactForGuest('see /Users/shash/file and /home/bob/x'))
      .toBe('see [redacted] and [redacted]');
  });
  it('redacts C:\\Users\\ paths', () => {
    expect(redactForGuest('log at C:\\Users\\admin\\secrets'))
      .toBe('log at [redacted]');
  });
  it('redacts emails as [email redacted]', () => {
    expect(redactForGuest('reach me at sam@example.com please'))
      .toBe('reach me at [email redacted] please');
  });
});

describe('redactForGuest — idempotency', () => {
  it('running twice yields the same output', () => {
    const raw = 'key sk-ant-secret-abc and /Users/x then a@b.com';
    const once = redactForGuest(raw);
    const twice = redactForGuest(once);
    expect(twice).toBe(once);
    expect(once).not.toContain('sk-ant');
    expect(once).not.toContain('/Users/x');
    expect(once).not.toContain('a@b.com');
  });
  it('the [redacted] token is not itself re-redacted', () => {
    expect(redactForGuest('[redacted] and [email redacted]')).toBe('[redacted] and [email redacted]');
  });
});

describe('redactForGuest — edge cases', () => {
  it('passes through empty strings', () => {
    expect(redactForGuest('')).toBe('');
  });
  it('passes through non-secret text unchanged', () => {
    expect(redactForGuest('hello world')).toBe('hello world');
  });
  it('handles multiple secrets in one string', () => {
    const out = redactForGuest('sk-ant-aaa-bbb /Users/x a@b.com sk-ant-ccc-ddd');
    expect(out).toBe('[redacted] [redacted] [email redacted] [redacted]');
  });
});

describe('REDACT_PATTERNS export', () => {
  it('exposes 6 patterns', () => {
    expect(REDACT_PATTERNS).toHaveLength(6);
  });
});

describe('applyHiddenRanges', () => {
  it('replaces a single range with [hidden by host]', () => {
    expect(applyHiddenRanges('hello world', [{ messageId: 'm1', start: 6, end: 11 }]))
      .toBe('hello [hidden by host]');
  });
  it('replaces multiple ranges from right to left', () => {
    const text = '0123456789';
    const ranges = [
      { messageId: 'm', start: 2, end: 4 },
      { messageId: 'm', start: 6, end: 8 },
    ];
    expect(applyHiddenRanges(text, ranges)).toBe('01[hidden by host]45[hidden by host]89');
  });
  it('no-ops on empty ranges', () => {
    expect(applyHiddenRanges('hello', [])).toBe('hello');
    expect(applyHiddenRanges('hello', null)).toBe('hello');
  });
  it('skips out-of-bounds ranges', () => {
    expect(applyHiddenRanges('abc', [{ messageId: 'm', start: 0, end: 100 }])).toBe('abc');
    expect(applyHiddenRanges('abc', [{ messageId: 'm', start: 5, end: 9 }])).toBe('abc');
  });
  it('skips inverted (start >= end) ranges', () => {
    expect(applyHiddenRanges('abc', [{ messageId: 'm', start: 2, end: 1 }])).toBe('abc');
    expect(applyHiddenRanges('abc', [{ messageId: 'm', start: 1, end: 1 }])).toBe('abc');
  });
  it('handles start=0 and end=text.length', () => {
    expect(applyHiddenRanges('abc', [{ messageId: 'm', start: 0, end: 3 }])).toBe('[hidden by host]');
  });
});

describe('redactForGuestWithRanges', () => {
  it('auto-redacts first, then applies hidden ranges', () => {
    // "sk-ant-secret /Users/x" -> "[redacted] [redacted]" (21 chars: 10 + 1 + 10)
    const raw = 'sk-ant-secret /Users/x';
    const redacted = redactForGuest(raw);
    expect(redacted).toBe('[redacted] [redacted]');
    expect(redacted.length).toBe(21);
    // Hide the second [redacted] (indices 11..21).
    const out = redactForGuestWithRanges(raw, [{ messageId: 'm', start: 11, end: 21 }]);
    expect(out).toBe('[redacted] [hidden by host]');
  });
});

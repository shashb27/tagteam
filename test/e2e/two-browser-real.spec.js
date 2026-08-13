// TagTeam two-browser E2E — REAL opencode mode (no MOCK_CLAUDE).
// Same host+guest demo flow as two-browser.spec.js, but the assistant is a
// live opencode model. We assert STRUCTURE (non-empty streamed reply that
// addresses the guest by name) instead of canned mock strings.
//
// Tagged @real so it's filtered by: npm run test:e2e:real
// (the default `npm run test:e2e` mock config does not grep @real.)

import { test, expect } from '@playwright/test';

test.use({ trace: 'on-first-retry' });

const BASE = 'http://localhost:3998';

// Real model latency: allow up to 60s for a full streamed reply. The first
// token can take many seconds on a cold provider; `expect.poll` retries
// internally so this is a per-assertion wall-clock cap, not a fixed wait.
const STREAM_TIMEOUT = 60_000;

// Unique email per test run (M1 auth gate requires a logged-in account).
const SUFFIX = `${Date.now()}@tagteam.test`;
const hostEmail = `host-${SUFFIX}`;
const guestEmail = `guest-${SUFFIX}`;

// Register + login a fresh account on a fresh context, landing on the name gate.
async function authAccount(page, email, displayName) {
  await page.goto(BASE);
  await expect(page.locator('#auth')).toBeVisible({ timeout: 5000 });
  await page.locator('#auth-switch').click();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-name').fill(displayName);
  await page.locator('#auth-password').fill('Tagteam123!');
  await page.locator('#auth-btn').click();
  await expect(page.locator('#name-input')).toBeVisible({ timeout: 8000 });
}

test('two-browser real demo: host tags in guest, live opencode answers by name, host revokes/restores/kicks @real', async ({ browser }) => {
  // --- Two isolated contexts (sessions) in one browser ---
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  const guestPage = await guestCtx.newPage();

  // Collect console + server-frame evidence for the report.
  const hostFrames = [];
  hostPage.on('console', (m) => { if (m.type() === 'log') hostFrames.push(m.text()); });

  // ── 0. Auth gate: register both host and guest (M1) ──────────────────────
  await authAccount(hostPage, hostEmail, 'Ava');
  await authAccount(guestPage, guestEmail, 'Sam');

  // ── 1. Host starts a session as "Ava" ─────────────────────────────────────
  await hostPage.goto(BASE);
  await hostPage.locator('#name-input').fill('Ava');
  await hostPage.getByRole('button', { name: 'Start session' }).click();

  await expect(hostPage.locator('#composer')).toBeVisible({ timeout: 30_000 });

  // ── 2. Host sends a question; wait for a REAL streamed reply ──────────────
  // We don't assert canned text. We assert: the assistant turn appears in
  // the transcript with non-trivial text (a real model reply, not just the
  // turn header).
  await hostPage.locator('#composer-input').fill('In one sentence, what is a KV cache?');
  await hostPage.getByRole('button', { name: 'Send' }).click();

  // The assistant turn text exists and is non-trivial (longer than the
  // user's question + a few chars of header noise).
  await expect.poll(
    async () => {
      const txt = (await hostPage.locator('#transcript').innerText()) ?? '';
      return txt.length > 'In one sentence, what is a KV cache?'.length + 5;
    },
    { timeout: STREAM_TIMEOUT },
  ).toBe(true);

  // ── 3. Host clicks "Tag in a colleague" → invite modal with a URL ─────────
  await hostPage.getByRole('button', { name: 'Tag in a colleague' }).click();
  await expect(hostPage.locator('#modal')).not.toHaveClass(/\bhidden\b/);

  const inviteUrl = await hostPage.locator('#invite-url').inputValue();
  expect(inviteUrl).toMatch(/\/join\//);

  await hostPage.locator('#modal-close').click();
  await expect(hostPage.locator('#modal')).toHaveClass(/\bhidden\b/);

  // ── 4. Guest opens the invite URL and joins as "Sam" ──────────────────────
  await guestPage.goto(inviteUrl);
  await expect(guestPage.locator('#name-input')).toBeVisible();
  await guestPage.locator('#name-input').fill('Sam');
  await guestPage.getByRole('button', { name: 'Join session' }).click();
  await expect(guestPage.locator('#composer')).toBeVisible({ timeout: 30_000 });

  // ── 5. Guest sees the full transcript (host's earlier question visible) ───
  await expect.poll(
    () => guestPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('KV cache');

  // ── 6. Guest asks a question; live model addresses Sam BY NAME ────────────
  // The system prompt (server/turns.js) prefixes every human message with
  // "[Name]:" and instructs the model to address people by name. So the
  // assistant's reply to Sam's message should contain "Sam".
  await guestPage.locator('#composer-input').fill('Can you repeat my name back to me?');
  await guestPage.getByRole('button', { name: 'Send' }).click();

  // The assistant reply contains the guest's name ("Sam").
  await expect.poll(
    () => guestPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('Sam');

  // And the reply is non-trivially long (not just an empty turn).
  await expect.poll(
    async () => {
      const txt = (await guestPage.locator('#transcript').innerText()) ?? '';
      return txt.length > 'Can you repeat my name back to me?'.length + 10;
    },
    { timeout: STREAM_TIMEOUT },
  ).toBe(true);

  // ── 7. Host sees Sam's message + the assistant's reply live ───────────────
  await expect.poll(
    () => hostPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('repeat my name');

  await expect.poll(
    () => hostPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('Sam');

  // ── 8. Host revokes Sam to read-only (👁 button on Sam's roster row) ───────
  const samRowHost = hostPage.locator('#participants li', { hasText: 'Sam' });
  await expect(samRowHost).toBeVisible();
  await samRowHost.locator('.pt-ro').click();

  await expect(guestPage.locator('#composer-input')).toBeDisabled({ timeout: 10_000 });
  await expect(guestPage.getByRole('button', { name: 'Send' })).toBeDisabled({ timeout: 10_000 });

  // ── 9. Host restores Sam (👁 again) ───────────────────────────────────────
  await samRowHost.locator('.pt-ro').click();
  await expect(guestPage.locator('#composer-input')).toBeEditable({ timeout: 10_000 });
  await expect(guestPage.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 10_000 });

  // ── 10. Host kicks Sam (✕ → "Sure?") ─────────────────────────────────────
  await samRowHost.locator('.pt-kick').click();
  await expect(samRowHost.locator('.pt-kick')).toHaveText('Sure?');
  await samRowHost.locator('.pt-kick').click();

  await expect(guestPage.locator('#fatal')).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.locator('#fatal-title')).toHaveText(/removed from the session/);

  // The burned token cannot reconnect: reload → gate → join attempt → fatal.
  await guestPage.reload();
  await expect(guestPage.getByRole('button', { name: 'Join session' })).toBeVisible({ timeout: 10_000 });
  await guestPage.locator('#name-input').fill('Sam');
  await guestPage.getByRole('button', { name: 'Join session' }).click();

  await expect(guestPage.locator('#fatal')).toBeVisible({ timeout: 10_000 });
  await expect(guestPage.locator('#fatal-title')).toHaveText(/already used|single-use|removed/i);

  await hostCtx.close();
  await guestCtx.close();
});

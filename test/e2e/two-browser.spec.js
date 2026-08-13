// TagTeam two-browser E2E — mock mode (MOCK_CLAUDE=1).
// Reproduces the Ava (host) + Sam (guest) demo story end-to-end.

import { test, expect } from '@playwright/test';

test.use({ trace: 'on-first-retry' });

const BASE = 'http://localhost:3999';

// Mock streams word-by-word at ~25ms/word; allow up to 10s for a full reply.
const STREAM_TIMEOUT = 10000;

// Unique email per test run (M1 auth gate requires a logged-in account).
const SUFFIX = `${Date.now()}@tagteam.test`;
const hostEmail = `host-${SUFFIX}`;
const guestEmail = `guest-${SUFFIX}`;

// Register + login a fresh account on a fresh context, landing on the name gate.
async function authAccount(page, email, displayName) {
  await page.goto(BASE);
  await expect(page.locator('#auth')).toBeVisible({ timeout: 5000 });
  // Switch to register mode (the #auth-switch toggle says "Register" in login mode).
  await page.locator('#auth-switch').click();
  await page.locator('#auth-email').fill(email);
  await page.locator('#auth-name').fill(displayName);
  await page.locator('#auth-password').fill('Tagteam123!');
  await page.locator('#auth-btn').click();
  // On success → name gate (Start session) appears.
  await expect(page.locator('#name-input')).toBeVisible({ timeout: 8000 });
}

test('two-browser demo: host tags in guest, guest joins, host revokes/restores/kicks', async ({ browser }) => {
  // --- Two isolated contexts (sessions) in one browser ---
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  const guestPage = await guestCtx.newPage();

  // ── 0. Auth gate: register both host and guest (M1) ──────────────────────
  await authAccount(hostPage, hostEmail, 'Ava');
  await authAccount(guestPage, guestEmail, 'Sam');

  // ── 1. Host starts a session as "Ava" ─────────────────────────────────────
  await hostPage.goto(BASE);
  await hostPage.locator('#name-input').fill('Ava');
  await hostPage.getByRole('button', { name: 'Start session' }).click();

  // Wait until the chat screen is up (composer visible).
  await expect(hostPage.locator('#composer')).toBeVisible({ timeout: 10000 });

  // ── 2. Host sends the KV-cache question; wait for the mock streamed reply ─
  await hostPage.locator('#composer-input').fill("What's the KV cache bandwidth issue?");
  await hostPage.getByRole('button', { name: 'Send' }).click();

  await expect.poll(
    () => hostPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('kv_cache_gather');

  await expect.poll(
    () => hostPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('704 GB/s');

  // ── 3. Host clicks "Tag in a colleague" → invite modal with a URL ─────────
  await hostPage.getByRole('button', { name: 'Tag in a colleague' }).click();
  await expect(hostPage.locator('#modal')).not.toHaveClass(/\bhidden\b/);

  const inviteUrl = await hostPage.locator('#invite-url').inputValue();
  expect(inviteUrl).toMatch(/\/join\//);

  // Close the modal so it doesn't overlay the roster.
  await hostPage.locator('#modal-close').click();
  await expect(hostPage.locator('#modal')).toHaveClass(/\bhidden\b/);

  // ── 4. Guest opens the invite URL and joins as "Sam" ──────────────────────
  await guestPage.goto(inviteUrl);
  await expect(guestPage.locator('#name-input')).toBeVisible();
  await guestPage.locator('#name-input').fill('Sam');
  await guestPage.getByRole('button', { name: 'Join session' }).click();
  await expect(guestPage.locator('#composer')).toBeVisible({ timeout: 10000 });

  // ── 5. Guest sees the full transcript (host's earlier question visible) ───
  await expect.poll(
    () => guestPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain("What's the KV cache bandwidth issue?");

  // ── 6. Guest asks about errata E7; mock addresses Sam by name ─────────────
  await guestPage.locator('#composer-input').fill('Does errata E7 explain this?');
  await guestPage.getByRole('button', { name: 'Send' }).click();

  await expect.poll(
    () => guestPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('Sam');

  await expect.poll(
    () => guestPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('E7');

  // ── 7. Host sees Sam's message + the assistant's reply live ───────────────
  await expect.poll(
    () => hostPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('Does errata E7 explain this?');

  await expect.poll(
    () => hostPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('E7');

  // ── 8. Host revokes Sam to read-only (👁 button on Sam's roster row) ───────
  const samRowHost = hostPage.locator('#participants li', { hasText: 'Sam' });
  await expect(samRowHost).toBeVisible();
  await samRowHost.locator('.pt-ro').click();

  // Sam's composer should be disabled (textarea + send button).
  await expect(guestPage.locator('#composer-input')).toBeDisabled({ timeout: 5000 });
  await expect(guestPage.getByRole('button', { name: 'Send' })).toBeDisabled({ timeout: 5000 });

  // ── 9. Host restores Sam (👁 again) ───────────────────────────────────────
  await samRowHost.locator('.pt-ro').click();
  await expect(guestPage.locator('#composer-input')).toBeEditable({ timeout: 5000 });
  await expect(guestPage.getByRole('button', { name: 'Send' })).toBeEnabled({ timeout: 5000 });

  // ── 10. Host kicks Sam (✕ → "Sure?") ─────────────────────────────────────
  await samRowHost.locator('.pt-kick').click();
  await expect(samRowHost.locator('.pt-kick')).toHaveText('Sure?');
  await samRowHost.locator('.pt-kick').click();

  // Guest page shows the fatal "removed" screen.
  await expect(guestPage.locator('#fatal')).toBeVisible({ timeout: 5000 });
  await expect(guestPage.locator('#fatal-title')).toHaveText(/removed from the session/);

  // The burned token cannot reconnect: reload → gate → join attempt → fatal.
  await guestPage.reload();
  // Creds were cleared on kick, so the guest gate reappears.
  await expect(guestPage.getByRole('button', { name: 'Join session' })).toBeVisible({ timeout: 5000 });
  await guestPage.locator('#name-input').fill('Sam');
  await guestPage.getByRole('button', { name: 'Join session' }).click();

  // Server rejects the single-use (burned) token → fatal screen persists.
  await expect(guestPage.locator('#fatal')).toBeVisible({ timeout: 5000 });
  await expect(guestPage.locator('#fatal-title')).toHaveText(/already used|single-use|removed/i);

  await hostCtx.close();
  await guestCtx.close();
});

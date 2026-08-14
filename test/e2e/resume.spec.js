// TagTeam E2E — cross-device resume gate (task 1.19, mock mode).
// Context A starts a session + sends a message; context B (same account, fresh
// browser) resumes that session and sees the transcript.

import { test, expect } from '@playwright/test';

test.use({ trace: 'on-first-retry' });

const BASE = 'http://localhost:3999';
const STREAM_TIMEOUT = 10000;
const SUFFIX = `${Date.now()}@tagteam.test`;
const email = `resume-${SUFFIX}`;
const PASSWORD = 'Tagteam123!';

// Register + login a fresh account (copied from two-browser.spec.js).
async function authAccount(page, emailAddr, displayName) {
  await page.goto(BASE);
  await expect(page.locator('#auth')).toBeVisible({ timeout: 5000 });
  await page.locator('#auth-switch').click();
  await page.locator('#auth-email').fill(emailAddr);
  await page.locator('#auth-name').fill(displayName);
  await page.locator('#auth-password').fill(PASSWORD);
  await page.locator('#auth-btn').click();
  await expect(page.locator('#name-input')).toBeVisible({ timeout: 8000 });
}

test('cross-device resume: context B resumes context A session from same account', async ({ browser }) => {
  const ctxA = await browser.newContext();
  const ctxB = await browser.newContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();

  // ── 1. Context A: register Ava, start a session, send a message ──────────
  await authAccount(pageA, email, 'Ava');
  await pageA.goto(BASE);
  await pageA.locator('#name-input').fill('Ava');
  await pageA.getByRole('button', { name: 'Start session' }).click();
  await expect(pageA.locator('#composer')).toBeVisible({ timeout: 10000 });

  await pageA.locator('#composer-input').fill("What's the KV cache bandwidth issue?");
  await pageA.getByRole('button', { name: 'Send' }).click();

  // Wait for the mock streamed reply.
  await expect.poll(
    () => pageA.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('kv_cache_gather');

  // ── 2. Context B: log in with the SAME account (same userId) ─────────────
  await pageB.goto(BASE);
  await expect(pageB.locator('#auth')).toBeVisible({ timeout: 5000 });
  await pageB.locator('#auth-email').fill(email);
  await pageB.locator('#auth-password').fill(PASSWORD);
  await pageB.locator('#auth-btn').click();
  await expect(pageB.locator('#name-input')).toBeVisible({ timeout: 8000 });

  // ── 3. Context B sees context A's session via GET /api/sessions ──────────
  const sessionsRes = await pageB.request.get(`${BASE}/api/sessions`);
  expect(sessionsRes.status()).toBe(200);
  const sessionsBody = await sessionsRes.json();
  expect(sessionsBody.count).toBeGreaterThanOrEqual(1);

  // ── 4. Copy context A's resume creds into context B and reload ───────────
  // The web app persists {sessionId, participantId, resumeKey, hostKey, ...}
  // to sessionStorage under "tagteam.v1". A fresh context that logs in with the
  // same account + replays those creds triggers the resume join flow; the
  // server rebuilds the snapshot (transcript included) from SQLite/in-memory.
  const creds = await pageA.evaluate(() => sessionStorage.getItem('tagteam.v1'));
  expect(creds).toBeTruthy();
  await pageB.evaluate((c) => sessionStorage.setItem('tagteam.v1', c), creds);

  await pageB.goto(BASE);
  // Resume handshake fires automatically on boot when creds are present.
  await expect(pageB.locator('#composer')).toBeVisible({ timeout: 10000 });

  // ── 5. Context B sees the transcript from context A's session ────────────
  await expect.poll(
    () => pageB.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain("What's the KV cache bandwidth issue?");
  await expect.poll(
    () => pageB.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('kv_cache_gather');

  await ctxA.close();
  await ctxB.close();
});

// TagTeam E2E — redaction gate (task 1.10, mock mode).
// Host sends a fake secret; host sees raw text, guest sees [redacted].

import { test, expect } from '@playwright/test';

test.use({ trace: 'on-first-retry' });

const BASE = 'http://localhost:3999';
const STREAM_TIMEOUT = 10000;
const SUFFIX = `${Date.now()}@tagteam.test`;
const hostEmail = `host-${SUFFIX}`;
const guestEmail = `guest-${SUFFIX}`;

const SECRET_TEXT = 'My API key is sk-ant-test-1234567890abcdef and password=secret123';

// Register + login a fresh account on a fresh context (copied from two-browser.spec.js).
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

test('redaction: host sees raw secret, guest sees [redacted]', async ({ browser }) => {
  const hostCtx = await browser.newContext();
  const guestCtx = await browser.newContext();
  const hostPage = await hostCtx.newPage();
  const guestPage = await guestCtx.newPage();

  await authAccount(hostPage, hostEmail, 'Ava');
  await authAccount(guestPage, guestEmail, 'Sam');

  // Host starts a session.
  await hostPage.goto(BASE);
  await hostPage.locator('#name-input').fill('Ava');
  await hostPage.getByRole('button', { name: 'Start session' }).click();
  await expect(hostPage.locator('#composer')).toBeVisible({ timeout: 10000 });

  // Host tags in Sam → invite URL.
  await hostPage.getByRole('button', { name: 'Tag in a colleague' }).click();
  await expect(hostPage.locator('#modal')).not.toHaveClass(/\bhidden\b/);
  const inviteUrl = await hostPage.locator('#invite-url').inputValue();
  await hostPage.locator('#modal-close').click();

  // Guest joins via invite URL.
  await guestPage.goto(inviteUrl);
  await expect(guestPage.locator('#name-input')).toBeVisible();
  await guestPage.locator('#name-input').fill('Sam');
  await guestPage.getByRole('button', { name: 'Join session' }).click();
  await expect(guestPage.locator('#composer')).toBeVisible({ timeout: 10000 });

  // Host sends a message containing a fake Anthropic key + a password assignment.
  await hostPage.locator('#composer-input').fill(SECRET_TEXT);
  await hostPage.getByRole('button', { name: 'Send' }).click();

  // Host transcript contains the raw secret.
  await expect.poll(
    () => hostPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('sk-ant-test-1234567890abcdef');
  await expect.poll(
    () => hostPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('password=secret123');

  // Guest transcript contains [redacted] markers, not the raw secret.
  await expect.poll(
    () => guestPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).toContain('[redacted]');
  await expect.poll(
    () => guestPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).not.toContain('sk-ant-test-1234567890abcdef');
  await expect.poll(
    () => guestPage.locator('#transcript').innerText(),
    { timeout: STREAM_TIMEOUT },
  ).not.toContain('password=secret123');

  await hostCtx.close();
  await guestCtx.close();
});

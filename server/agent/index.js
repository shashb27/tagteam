// Backend selection (startup, once). Order of preference:
//   1. Agent SDK (@anthropic-ai/claude-agent-sdk) — uses the local Claude
//      Code CLI credentials, so it can work with NO API key. Probed with a
//      20s smoke test unless forced.
//   2. Messages API (@anthropic-ai/sdk) — when ANTHROPIC_API_KEY is set.
//   3. MOCK — canned streaming responses, zero credentials, so the
//      multiplayer demo always runs. Forceable via MOCK_CLAUDE=1.
//
// The chosen backend is global and reported in /healthz + the startup log.

import fs from 'node:fs';
import {
  TAGTEAM_AGENT, MOCK_CLAUDE, SDK_SMOKE_TIMEOUT_MS, DEMO_WORKSPACE_DIR,
} from '../config.js';
import { mockBackend } from './mockRunner.js';

function hasApiKey() {
  return Boolean(process.env.ANTHROPIC_API_KEY);
}

async function tryApiBackend() {
  const { apiBackend } = await import('./apiRunner.js');
  return apiBackend();
}

export async function createAgentBackend() {
  // Ensure the read-only workspace exists before any SDK process gets it as cwd.
  fs.mkdirSync(DEMO_WORKSPACE_DIR, { recursive: true });

  if (MOCK_CLAUDE || TAGTEAM_AGENT === 'mock') {
    console.log('[agent] MOCK backend forced (MOCK_CLAUDE=1 / TAGTEAM_AGENT=mock)');
    return mockBackend();
  }

  if (TAGTEAM_AGENT === 'api') {
    if (!hasApiKey()) {
      console.warn('[agent] TAGTEAM_AGENT=api but ANTHROPIC_API_KEY is unset — using MOCK backend');
      return mockBackend();
    }
    return tryApiBackend();
  }

  // Primary: Agent SDK.
  try {
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const { sdkBackend, smokeTest } = await import('./sdkRunner.js');
    if (TAGTEAM_AGENT === 'sdk') {
      // Forced: skip the smoke test and fail loudly at runtime instead.
      return sdkBackend(sdk);
    }
    console.log('[agent] probing Agent SDK (one-shot smoke test, up to 20s)…');
    await smokeTest(sdk, SDK_SMOKE_TIMEOUT_MS);
    return sdkBackend(sdk);
  } catch (err) {
    console.warn(`[agent] Agent SDK unavailable (${err?.message ?? err}) — falling back`);
  }

  // Secondary: streaming Messages API, if a key exists.
  if (hasApiKey()) {
    try {
      return await tryApiBackend();
    } catch (err) {
      console.warn(`[agent] Messages API backend unavailable (${err?.message ?? err}) — falling back`);
    }
  } else {
    console.warn('[agent] ANTHROPIC_API_KEY not set — Messages API backend skipped');
  }

  // Last resort: mock, so the demo always runs.
  console.warn('[agent] using MOCK backend — responses are canned and labeled "mock"');
  return mockBackend();
}

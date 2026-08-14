// Backend selection (startup, once). The opencode backend is primary;
// MOCK is the zero-credential fallback so the multiplayer demo always runs.
// Forceable via MOCK_CLAUDE=1.

import fs from 'node:fs';
import { MOCK_CLAUDE, DEMO_WORKSPACE_DIR } from '../config.js';
import { mockBackend } from './mockRunner.js';

export async function createAgentBackend() {
  // Ensure the read-only workspace exists before any backend uses it as cwd.
  fs.mkdirSync(DEMO_WORKSPACE_DIR, { recursive: true });

  if (MOCK_CLAUDE) {
    console.log('[agent] MOCK backend forced (MOCK_CLAUDE=1)');
    return mockBackend();
  }

  try {
    const { opencodeBackend } = await import('./opencodeRunner.js');
    return await opencodeBackend();
  } catch (err) {
    console.warn(
      `[agent] opencode unavailable: ${err?.message ?? err} — using mock`,
    );
    return mockBackend();
  }
}

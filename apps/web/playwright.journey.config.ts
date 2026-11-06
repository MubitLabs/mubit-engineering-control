import { tmpdir } from 'node:os'
import { defineConfig, devices } from '@playwright/test'

/**
 * The composed journey (handoff 33 B6), on a server built from this tree, with no mocked routes.
 * Each test starts its own scratch server on its own port, so this suite needs no screens lock.
 *
 * Deliberately NOT wired into CI or `pnpm check`. Build first, then:
 *   pnpm --dir apps/web exec playwright test --config playwright.journey.config.ts
 * That is the fake CLI and spends nothing. `MEC_JOURNEY_REAL=1` runs one real pass: see
 * test/journey.real.playwright.ts.
 */
export default defineConfig({
  testDir: 'test',
  testMatch: /journey\.real\.playwright\.ts/,
  outputDir: `${tmpdir()}/mec-web-journey`,
  // One at a time: each test is a server, real git and real processes.
  workers: 1,
  fullyParallel: false,
  retries: 0,
  // A fresh script's first exec has taken 25 s on this machine (M2.2's record).
  timeout: process.env.MEC_JOURNEY_REAL === '1' ? 600_000 : 180_000,
  use: {
    launchOptions: { args: ['--no-proxy-server'] },
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})

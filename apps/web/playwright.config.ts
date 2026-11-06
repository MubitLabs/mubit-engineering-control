import { tmpdir } from 'node:os'
import { defineConfig, devices } from '@playwright/test'

/**
 * The screenshot suite: every surface at each width in both themes, the keyboard-only
 * walkthrough, the old deep links and the §23 worked example, on the sample harnesses in
 * test/fixtures or on route mocks served through page.route, so the app speaks its real API
 * shapes.
 *
 * Deliberately NOT wired into CI (`pnpm check` never runs it): run it with
 * `pnpm test:screens`. Baselines land in test/__screenshots__; run artifacts
 * go to the OS temp dir so the repo's formatter never sees them.
 */
export default defineConfig({
  testDir: 'test',
  testMatch: /screens\.playwright\.ts/,
  snapshotDir: 'test/__screenshots__',
  outputDir: `${tmpdir()}/mec-web-playwright`,
  fullyParallel: true,
  retries: 0,
  timeout: 30_000,
  use: {
    // The bundled chromium follows the macOS SYSTEM proxy for 127.0.0.1 (env no_proxy is
    // ignored); real-server tests 502 behind it. No proxy inside the tests, ever.
    launchOptions: { args: ['--no-proxy-server'] },
    baseURL: 'http://127.0.0.1:4173',
    trace: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  expect: {
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio: 0.02,
    },
  },
  webServer: {
    // Dev server on a scratch port; /api is stubbed per-page, so the proxy
    // target (the runtime's 4100) is never reached. Host pinned: vite's
    // 'localhost' binds ::1 only on this machine, and the probe uses 127.0.0.1.
    command: 'pnpm exec vite --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: true,
    timeout: 30_000,
  },
})

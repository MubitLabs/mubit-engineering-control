import { configDefaults, defineConfig } from 'vitest/config'

// Suites follow the ownership table in docs/plan/PLAN_v4.1_parallel_split.md §2.
const T = '{test,spec}.{ts,tsx}'

const SHARED = [`packages/contracts/**/*.${T}`, 'packages/testkit/conformance.spec.ts']

const A_GIT = 'merge|conflict|impact'
const A_TESTKIT = 'memory-repositories|fake-engine|fake-slots|memory-core-for-engines'
const B_WEB = 'apps/web/src/features/{slots,terminal,wizard,repositories,scorecards}/**'

const B_ONLY = [
  'packages/{runtime,engines,slots}/**',
  'apps/desktop/**',
  B_WEB,
  `packages/git/**/!(${A_GIT}).${T}`,
  `packages/testkit/**/!(${A_TESTKIT}|conformance).${T}`,
]

export default defineConfig({
  test: {
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    passWithNoTests: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'a',
          include: [`{apps,packages,scripts}/**/*.${T}`],
          exclude: [...configDefaults.exclude, ...B_ONLY],
        },
      },
      {
        extends: true,
        test: {
          name: 'b',
          include: [
            ...SHARED,
            `packages/{runtime,engines,slots}/**/*.${T}`,
            `apps/desktop/**/*.${T}`,
            `${B_WEB}/*.${T}`,
            `packages/git/**/!(${A_GIT}).${T}`,
            `packages/testkit/**/!(${A_TESTKIT}).${T}`,
          ],
        },
      },
    ],
  },
})

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/{src,test}/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      MEC_TEST_DATABASE_URL: process.env.MEC_TEST_DATABASE_URL ?? 'postgres://mec:mec@127.0.0.1:5434/mec',
    },
  },
})

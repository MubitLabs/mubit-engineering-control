#!/usr/bin/env node
// Axe against a running server, the half of Stage B's gate the Vite harness cannot give: the real
// bundle on a real store. Not in CI, not in `pnpm check`.
//
//   node scripts/axe-server.mjs --theme light|dark <baseUrl> <#route>...
//
// Every route at the three widths of the matrix. No rule is disabled. The shell must be on the
// page, the page must take the theme, and axe must record a passing rule, so an empty page fails.
// The script reads routes only; seed the store through the server's own routes first.
import AxeBuilder from '@axe-core/playwright'
import { chromium } from '@playwright/test'

const THEME_KEY = 'mec-next-theme'
const THEMES = ['light', 'dark']
const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
]
const SURFACE = '.shell'

async function scan(context, url, theme) {
  const page = await context.newPage()
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  await page.locator(SURFACE).first().waitFor({ timeout: 30_000 })
  await page.evaluate(([key, value]) => localStorage.setItem(key, value), [THEME_KEY, theme])
  await page.reload({ waitUntil: 'domcontentloaded' })
  await page.locator(SURFACE).first().waitFor({ timeout: 30_000 })
  // The feed stays open, so the network never goes idle: wait for the first data, then the motion.
  await page.waitForTimeout(1_000)
  await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => {}))))
  const applied = await page.evaluate(() => document.documentElement.dataset.theme)
  if (applied !== theme) throw new Error(`the page did not take theme ${theme}: ${url}`)
  const outcome = await new AxeBuilder({ page }).include(SURFACE).analyze()
  await page.close()
  if (outcome.passes.length === 0) throw new Error(`axe recorded no passing rule: ${url}`)
  return outcome.violations.flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`))
}

async function main(argv) {
  const [flag, theme, base, ...routes] = argv
  if (flag !== '--theme' || !THEMES.includes(theme) || base === undefined || routes.length === 0) {
    throw new Error('usage: axe-server.mjs --theme light|dark <baseUrl> <#route>...')
  }
  const browser = await chromium.launch({ args: ['--no-proxy-server'] })
  let failed = false
  try {
    for (const viewport of WIDTHS) {
      const context = await browser.newContext({ viewport })
      for (const route of routes) {
        const lines = await scan(context, `${base}/${route}`, theme)
        console.log(
          `${lines.length === 0 ? 'PASS' : 'FAIL'} ${viewport.width} ${theme} ${route} ${lines.length}`,
        )
        for (const line of lines) console.log(`  ${line}`)
        failed ||= lines.length > 0
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }
  return failed ? 1 : 0
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (error) => {
    console.error(`FAIL ${error.message}`)
    process.exit(1)
  },
)

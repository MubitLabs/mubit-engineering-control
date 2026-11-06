import { expect, test } from '@playwright/test'
import { measureMotion, measurePage, measureReducedMotion, targetFor, walkFocus } from './limits'
import { cellsAt, openCell, THEMES, VIEWPORTS } from './matrix-cells'

/**
 * The measured limits over the whole matrix. Like the rest of the screens suite, deliberately not
 * in CI or `pnpm check`: run it with `pnpm --dir apps/web test:screens`.
 */

const BROKEN = '/test/fixtures/limits-broken.html'

test.use({ timezoneId: 'UTC', locale: 'en-GB' })

test.describe('the gate fails when a limit is broken', () => {
  test.use({ viewport: { width: 1024, height: 768 } })

  test('page limits', async ({ page }) => {
    await page.goto(BROKEN)
    const found = (await measurePage(page, 32)).join('\n')
    for (const pattern of [
      /small text 10px/,
      /short target 20px/,
      /narrow target 20px/,
      /short primary 34px/,
      /control edge/,
      /off the page/,
      /clipped by clip/,
      /clipped label/,
      /page scrolls sideways/,
    ]) {
      expect(found).toMatch(pattern)
    }
  })

  test('focus limits', async ({ page }) => {
    await page.goto(BROKEN)
    const { visited, found } = await walkFocus(page)
    expect(visited).toBeGreaterThan(4)
    const lines = found.join('\n')
    expect(lines).toMatch(/no 2px ring .*"No ring"/)
    expect(lines).toMatch(/no 2px ring .*"Thin ring"/)
    expect(lines).toMatch(/faint ring .*"Pale ring"/)
    expect(lines).toMatch(/ring clipped by .*"Ring cut off"/)
  })

  test('motion limits', async ({ page }) => {
    await page.goto(BROKEN)
    const found = (await measureMotion(page)).join('\n')
    expect(found).toMatch(/motion 400ms/)
    expect(found).toMatch(/motion 2000ms/)
  })

  test('reduced motion limits', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    await page.goto(BROKEN)
    const found = (await measureReducedMotion(page)).join('\n')
    expect(found).toMatch(/motion/)
    expect(found).toMatch(/running/)
  })

  test('reduced motion that is not on cannot pass', async ({ page }) => {
    await page.goto(BROKEN)
    expect(await measureReducedMotion(page)).toEqual(['reduced motion is not on'])
  })
})

for (const viewport of VIEWPORTS) {
  for (const theme of THEMES) {
    test.describe(`${viewport.name} ${theme}`, () => {
      test.use({ viewport: { width: viewport.width, height: viewport.height } })

      for (const cell of cellsAt(viewport.width)) {
        test(`${cell.name} ${viewport.name} ${theme} meets the limits`, async ({ page }) => {
          await openCell(page, theme, cell)
          expect(await measurePage(page, targetFor(viewport.width))).toEqual([])
          expect(await measureMotion(page)).toEqual([])
        })

        test(`${cell.name} ${viewport.name} ${theme} shows a ring on every stop`, async ({ page }) => {
          await openCell(page, theme, cell)
          const { visited, found } = await walkFocus(page)
          expect(found).toEqual([])
          expect(visited, 'focus stops').toBeGreaterThan(0)
        })
      }
    })
  }
}

for (const width of [1440, 390]) {
  test.describe(`reduced motion at ${width}`, () => {
    test.use({ viewport: { width, height: 844 } })

    for (const cell of cellsAt(width)) {
      test(`${cell.name} ${width} has no motion`, async ({ page }) => {
        await page.emulateMedia({ reducedMotion: 'reduce' })
        await openCell(page, 'light', cell)
        expect(await measureReducedMotion(page)).toEqual([])
      })
    }
  })
}

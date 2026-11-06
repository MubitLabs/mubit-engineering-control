import type { Page } from '@playwright/test'

/**
 * The measured limits of UI-OVERHAUL.md "Measurable acceptance", read from the page. Each returns
 * what broke as readable lines, so a passing cell is an empty list. Text contrast is axe's job
 * (a11y.screens.playwright.ts); this measures what axe does not.
 */

export const LIMITS = {
  minText: 12,
  bodyText: 14,
  primaryHeight: 40,
  desktopTarget: 32,
  mobileTarget: 44,
  mobileWidth: 760,
  control: 3,
  focusWidth: 2,
  motionMs: 160,
} as const

/** Small helpers the measures share. Sent to the page as source, so they close over nothing. */
const HELPERS = () => {
  type Rgba = [number, number, number, number]
  const parse = (value: string): Rgba => {
    const [r = 0, g = 0, b = 0, a = 1] = (value.match(/[\d.]+/g) ?? []).map(Number)
    return value.startsWith('rgb') ? [r, g, b, value.startsWith('rgba') ? a : 1] : [0, 0, 0, 0]
  }
  const over = (top: Rgba, under: Rgba): Rgba => {
    const [r, g, b, a] = top
    return [
      r * a + under[0] * (1 - a),
      g * a + under[1] * (1 - a),
      b * a + under[2] * (1 - a),
      a + under[3] * (1 - a),
    ]
  }
  const luminance = ([r, g, b]: Rgba) => {
    const [x = 0, y = 0, z = 0] = [r, g, b].map((part) => {
      const v = part / 255
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * x + 0.7152 * y + 0.0722 * z
  }
  const contrast = (a: Rgba, b: Rgba) => {
    const [hi, lo] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number]
    return (hi + 0.05) / (lo + 0.05)
  }
  /** The colour actually behind `el`: its own background, composited up to the page. */
  const backdrop = (el: Element | null): Rgba => {
    const layers: Rgba[] = []
    for (let at = el; at; at = at.parentElement) {
      const colour = parse(getComputedStyle(at).backgroundColor)
      if (colour[3] > 0) layers.push(colour)
      if (colour[3] === 1) break
    }
    return layers.reduceRight<Rgba>((under, top) => over(top, under), [255, 255, 255, 1])
  }
  const shown = (el: Element) => {
    const box = el.getBoundingClientRect()
    const style = getComputedStyle(el)
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
  }
  const label = (el: Element) =>
    `${el.tagName.toLowerCase()}.${el.getAttribute('class') ?? ''} "${(
      el.getAttribute('aria-label') ??
      el.textContent ??
      ''
    )
      .trim()
      .slice(0, 40)}"`
  const clips = (value: string) => value === 'hidden' || value === 'clip'
  return { parse, over, contrast, backdrop, shown, label, clips }
}

declare global {
  interface Window {
    __limits: ReturnType<typeof HELPERS>
  }
}

/** Puts the helpers on the page. Every measure below reads them from there. */
const install = (page: Page) => page.evaluate(`window.__limits = (${HELPERS.toString()})()`)

/** 44 at or under 760, 32 above it. */
export const targetFor = (width: number): number =>
  width <= LIMITS.mobileWidth ? LIMITS.mobileTarget : LIMITS.desktopTarget

/** Text sizes, target and primary sizes, field edges and clipping, for the whole page. */
export async function measurePage(page: Page, target: number): Promise<string[]> {
  await install(page)
  return page.evaluate(
    ({ limits, min }) => {
      const { parse, contrast, backdrop, shown, label, clips } = window.__limits
      const found: string[] = []
      const live = (el: Element) => shown(el) && !el.closest('[inert], .sr-only') && !el.matches('.skip-link')

      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      while (walker.nextNode()) {
        const parent = walker.currentNode.parentElement
        const text = walker.currentNode.textContent?.trim()
        if (!parent || !text || !shown(parent)) continue
        if (parent.closest('.sr-only, script, style, option, [inert]')) continue
        const size = Number.parseFloat(getComputedStyle(parent).fontSize)
        if (size < limits.minText) found.push(`small text ${size}px: ${text.slice(0, 40)}`)
        if (parent.closest('.message') && !parent.closest('.byline') && size < limits.bodyText) {
          found.push(`small body ${size}px: ${text.slice(0, 40)}`)
        }
      }

      const controls = 'button, a[href], select, input, textarea, summary, [role="tab"], [role="option"]'
      for (const control of document.querySelectorAll(controls)) {
        if (!live(control)) continue
        const box = control.getBoundingClientRect()
        const inline = control.matches('a') && control.closest('p, li, dd') !== null
        const native = control.matches('input[type="radio"], input[type="checkbox"]')
        const area = native ? (control.closest('label') ?? control).getBoundingClientRect() : box
        if (!inline && area.height < min) {
          found.push(`short target ${Math.round(area.height)}px: ${label(control)}`)
        }
        if (!inline && !native && control.matches('button') && box.width < min) {
          found.push(`narrow target ${Math.round(box.width)}px: ${label(control)}`)
        }
        if (control.matches('.btn-primary') && box.height < limits.primaryHeight) {
          found.push(`short primary ${Math.round(box.height)}px: ${label(control)}`)
        }

        // A field shows its edge at 3:1 against what is behind it. The composer's edge is its frame.
        if (control.matches('input:not([type="radio"], [type="checkbox"]), textarea, select')) {
          const frame = control.closest('.composer') ?? control
          const style = getComputedStyle(frame)
          const behind = backdrop(frame.parentElement)
          const edge = Math.max(
            ...['Top', 'Right', 'Bottom', 'Left'].map((side) => {
              const drawn =
                Number.parseFloat(style.getPropertyValue(`border-${side.toLowerCase()}-width`)) > 0
              return drawn
                ? contrast(parse(style.getPropertyValue(`border-${side.toLowerCase()}-color`)), behind)
                : 0
            }),
          )
          const fill = contrast(backdrop(frame), behind)
          if (!control.matches(':disabled') && Math.max(edge, fill) < limits.control) {
            found.push(`control edge ${Math.max(edge, fill).toFixed(2)}:1: ${label(control)}`)
          }
        }

        // Sideways only: a control below the fold of a scroller is reachable by scrolling.
        if (box.left < -0.5 || box.right > window.innerWidth + 0.5) {
          found.push(`off the page: ${label(control)}`)
        }
        for (let at = control.parentElement; at; at = at.parentElement) {
          if (!clips(getComputedStyle(at).overflowX)) continue
          const edge = at.getBoundingClientRect()
          if (box.left < edge.left - 0.5 || box.right > edge.right + 0.5) {
            found.push(`clipped by ${at.id || at.getAttribute('class') || at.tagName}: ${label(control)}`)
          }
        }
        if (
          control.matches('button, summary') &&
          control.scrollWidth > control.clientWidth + 1 &&
          !control.hasAttribute('title')
        ) {
          found.push(`clipped label: ${label(control)}`)
        }
      }

      const root = document.documentElement
      if (root.scrollWidth > window.innerWidth) found.push(`page scrolls sideways: ${root.scrollWidth}`)
      const scroller = document.querySelector('.scroller')
      if (scroller && scroller.scrollWidth > scroller.clientWidth + 1) {
        found.push(`scroller scrolls sideways: ${scroller.scrollWidth} over ${scroller.clientWidth}`)
      }
      return found
    },
    { limits: LIMITS, min: target },
  )
}

/** Every transition and animation on the page, pseudo-elements too, against the limit. */
export async function measureMotion(page: Page): Promise<string[]> {
  await install(page)
  return page.evaluate((limit) => {
    const { label } = window.__limits
    const ms = (value: string) => value.split(',').map((part) => Number.parseFloat(part) * 1000)
    const found: string[] = []
    for (const el of document.querySelectorAll('*')) {
      for (const pseudo of [undefined, '::before', '::after']) {
        const style = getComputedStyle(el, pseudo)
        const delays = ms(style.transitionDelay)
        const moves = ms(style.transitionDuration).map((value, index) => value + (delays[index] ?? 0))
        const animated = style.animationName === 'none' ? [0] : ms(style.animationDuration)
        const longest = Math.max(...moves, ...animated)
        if (longest > limit) found.push(`motion ${longest}ms: ${label(el)}${pseudo ?? ''}`)
      }
    }
    return found
  }, LIMITS.motionMs)
}

/** Under reduced motion nothing transitions or animates at all. */
export async function measureReducedMotion(page: Page): Promise<string[]> {
  await install(page)
  return page.evaluate(() => {
    const { label } = window.__limits
    if (!matchMedia('(prefers-reduced-motion: reduce)').matches) return ['reduced motion is not on']
    const found: string[] = []
    for (const el of document.querySelectorAll('*')) {
      for (const pseudo of [undefined, '::before', '::after']) {
        const style = getComputedStyle(el, pseudo)
        const moving = style.transitionDuration.split(',').some((part) => Number.parseFloat(part) > 0)
        if (moving || style.animationName !== 'none') found.push(`motion: ${label(el)}${pseudo ?? ''}`)
      }
    }
    for (const animation of document.getAnimations()) found.push(`running: ${animation.constructor.name}`)
    return found
  })
}

/** One look at what has focus: a 2px ring at 3:1 that nothing holding it cuts off. */
async function readFocus(page: Page): Promise<{ key: string | null; found: string[] }> {
  return page.evaluate((limits) => {
    const { parse, contrast, backdrop, label } = window.__limits
    const active = document.activeElement
    if (!active || active === document.body) return { key: null, found: [] }
    // The composer draws the ring for its field, on the frame around it.
    const ring = (active.matches('textarea') && active.closest('.composer')) || active
    const style = getComputedStyle(ring)
    const width = Number.parseFloat(style.outlineWidth)
    const found: string[] = []
    if (style.outlineStyle === 'none' || width < limits.focusWidth) {
      found.push(`no ${limits.focusWidth}px ring (${style.outlineStyle} ${width}px): ${label(active)}`)
      return { key: label(active), found }
    }
    const offset = Number.parseFloat(style.outlineOffset)
    const behind = offset < 0 ? backdrop(ring) : backdrop(ring.parentElement)
    const ratio = contrast(parse(style.outlineColor), behind)
    if (ratio < limits.control) found.push(`faint ring ${ratio.toFixed(2)}:1: ${label(active)}`)
    const box = ring.getBoundingClientRect()
    const reach = offset + width
    for (let at = ring.parentElement; at; at = at.parentElement) {
      const held = getComputedStyle(at)
      const edge = at.getBoundingClientRect()
      const sideways = box.left - reach < edge.left - 0.5 || box.right + reach > edge.right + 0.5
      // Something taller than the space it scrolls in cannot show all of its ring at once, and a
      // field brings its caret into view, not itself, so a tall one can run past the fold.
      const fits = box.height + 2 * reach <= edge.height && !active.matches('textarea')
      const upright = fits && (box.top - reach < edge.top - 0.5 || box.bottom + reach > edge.bottom + 0.5)
      if ((held.overflowX !== 'visible' && sideways) || (held.overflowY !== 'visible' && upright)) {
        found.push(`ring clipped by ${at.getAttribute('class') ?? at.tagName}: ${label(active)}`)
      }
    }
    return { key: label(active), found }
  }, LIMITS)
}

/** Tabs through the page from the top, reading the ring at each stop, until focus comes round. */
export async function walkFocus(page: Page, stops = 60): Promise<{ visited: number; found: string[] }> {
  await install(page)
  const found = new Set<string>()
  const seen = new Set<string>()
  for (let stop = 0; stop < stops; stop += 1) {
    await page.keyboard.press('Tab')
    const { key, found: lines } = await readFocus(page)
    for (const line of lines) found.add(line)
    if (key === null || seen.has(key)) break
    seen.add(key)
  }
  return { visited: seen.size, found: [...found] }
}

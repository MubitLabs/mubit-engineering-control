/**
 * Words for people: a cut lands between words, never inside one, and says it is a cut. A word
 * longer than half the room is cut where the room ends, so a path or a hash still shows.
 */
export function cutAtWord(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (clean.length <= max) return clean
  let cut = clean.slice(0, max - 1)
  const space = cut.lastIndexOf(' ')
  if (space > max / 2) cut = cut.slice(0, space)
  return `${cut.trimEnd()}…`
}

/** A work item's short name: the first line of the message that started it. */
export const TITLE_WORDS = 60

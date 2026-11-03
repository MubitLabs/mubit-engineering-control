import { describe, expect, it } from 'vitest'
import { formatCommandLines, parseCommandLines, splitArgs } from './commands'

describe('splitArgs', () => {
  it('splits on spaces and honours quotes and escapes', () => {
    expect(splitArgs('node --test "test/*.test.ts"')).toEqual(['node', '--test', 'test/*.test.ts'])
    expect(splitArgs(`node -e "console.log('a b')"`)).toEqual(['node', '-e', "console.log('a b')"])
    expect(splitArgs(`echo 'it''s' a\\ b ""`)).toEqual(['echo', 'its', 'a b', ''])
  })

  it('rejects an unclosed quote', () => {
    expect(() => splitArgs('echo "oops')).toThrow(/unclosed/)
  })
})

describe('parseCommandLines', () => {
  it('keeps colons inside the command and skips blank lines', () => {
    const { commands, errors } = parseCommandLines('test: node -e "process.exit(0)" http://x:1\n\n')
    expect(errors).toEqual([])
    expect(commands).toEqual([
      { name: 'test', argv: ['node', '-e', 'process.exit(0)', 'http://x:1'], timeoutSec: 600 },
    ])
  })

  it('explains each bad line', () => {
    const { errors } = parseCommandLines('pnpm test\nTest: x\nlint:\nok: a\nok: b')
    expect(errors).toEqual([
      'line 1: write it as "name: command"',
      'line 2: "Test" is not a valid name (lowercase letters, digits, - and _)',
      'line 3: "lint" has no command',
      'line 5: "ok" is used twice',
    ])
  })

  it('round-trips through formatCommandLines', () => {
    const text = `test: node --test 'test/a b.ts'\nlint: node -e 'console.log("x")'`
    const { commands } = parseCommandLines(text)
    expect(parseCommandLines(formatCommandLines(commands)).commands).toEqual(commands)
  })
})

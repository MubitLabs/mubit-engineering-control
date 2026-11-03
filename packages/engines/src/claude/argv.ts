/**
 * Builds the Claude Code headless argv from a launch specification (plan §9).
 * Pure: paths are provided by the runtime, which owns the settings and MCP config files.
 * `--bare` is deliberately absent (it ignores subscription logins; the probe watches for
 * it becoming the `-p` default — capability drift, plan §9 "verify on install").
 */

export type ClaudeArgvInput = {
  /** The prompt for `-p`; the runtime composes it from the brief. */
  prompt: string
  sessionId: string
  /** Per-attempt settings JSON path (plan §8.4). */
  settingsPath: string
  /** mec-tools MCP config JSON path (plan §6). */
  mcpConfigPath: string
  /** Read-only roles: `--restricted --permission-prompts none`. */
  readOnly: boolean
  /** Bridge tool approvals to `mcp__mec__confirm`, or ask nothing. */
  permissionMode: 'bridge' | 'none'
  maxTurns: number
  model?: string
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
  /** Same-home session resume. */
  resumeSessionId?: string
  /** API-key slots only: a client-side spend estimate. */
  maxBudgetUsd?: number
}

export function buildClaudeArgv(input: ClaudeArgvInput): string[] {
  const argv = [
    'claude',
    '-p',
    input.prompt,
    '--verbose',
    '--output-format',
    'stream-json',
    '--input-format',
    'stream-json',
  ]
  if (input.resumeSessionId) {
    argv.push('--resume', input.resumeSessionId)
  } else {
    argv.push('--session-id', input.sessionId)
  }
  argv.push(
    '--settings',
    input.settingsPath,
    '--setting-sources',
    'user',
    '--mcp-config',
    input.mcpConfigPath,
    '--strict-mcp-config',
    '--max-turns',
    String(input.maxTurns),
  )
  if (input.permissionMode === 'bridge') {
    argv.push('--permission-prompt-tool', 'mcp__mec__confirm')
  }
  if (input.readOnly) {
    argv.push('--restricted', '--permission-prompts', 'none')
  }
  for (const tool of input.allowedTools ?? []) argv.push('--allowedTools', tool)
  for (const tool of input.disallowedTools ?? []) argv.push('--disallowedTools', tool)
  if (input.model) argv.push('--model', input.model)
  if (input.maxBudgetUsd !== undefined) argv.push('--max-budget-usd', String(input.maxBudgetUsd))
  return argv
}

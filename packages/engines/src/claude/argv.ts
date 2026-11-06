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
  /** LaunchSpec.model.id — the resolved alias/id (`opus`, `gpt-6.1-sol`, …); absent = the engine default. */
  model?: string
  /** LaunchSpec.model.effort — Claude's `--effort` (low|medium|high|xhigh|max). */
  effort?: string
  /** The per-attempt subagent catalogue the runtime wrote (`--agents <file>`, review §4). */
  agentsPath?: string
  allowedTools?: readonly string[]
  disallowedTools?: readonly string[]
  /** Same-home session resume. */
  resumeSessionId?: string
  /** API-key slots only: a client-side spend estimate. */
  maxBudgetUsd?: number
}

export function buildClaudeArgv(input: ClaudeArgvInput): string[] {
  const argv = ['claude', '-p', input.prompt, '--verbose', '--output-format', 'stream-json']
  // NOTE: --input-format stream-json is deliberately absent in v0: with it, `-p` waits on a
  // stdin user-message that a one-shot spawn must write and close. Steering (send) brings the
  // two-way wiring; until then the objective rides the -p prompt.
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
    // Explicit: a linked slot's own settings may name another mode, and the prompt tool hears
    // nothing in a mode that does not ask.
    argv.push('--permission-prompt-tool', 'mcp__mec__confirm', '--permission-mode', 'default')
  }
  if (input.readOnly) {
    argv.push('--restricted', '--permission-prompts', 'none')
  }
  if (input.agentsPath) argv.push('--agents', input.agentsPath)
  for (const tool of input.allowedTools ?? []) argv.push('--allowedTools', tool)
  for (const tool of input.disallowedTools ?? []) argv.push('--disallowedTools', tool)
  if (input.model) argv.push('--model', input.model)
  if (input.effort) argv.push('--effort', input.effort)
  if (input.maxBudgetUsd !== undefined) argv.push('--max-budget-usd', String(input.maxBudgetUsd))
  return argv
}

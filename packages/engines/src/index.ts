export { ClaudeAdapter, type ClaudeAdapterDeps } from './claude/adapter'
export { buildClaudeArgv, type ClaudeArgvInput } from './claude/argv'
export { type ClaudeProbeResult, type ProbeRun, probeClaude, REQUIRED_FLAGS } from './claude/probe'
export { classifyClaudeError, type ParseOptions, parseClaudeStream } from './claude/stream'

// OpenCode V2 (plan §9): one `opencode serve --stdio` per slot, one server session per attempt.
export {
  OpenCodeAdapter,
  type OpenCodeAdapterDeps,
  type OpenCodeAuthList,
  type OpenCodePost,
  type OpenCodeSpawnFn,
  type OpenCodeSse,
} from './opencode/adapter'
export {
  classifyOpencodeError,
  createOpenCodeEventParser,
  OPENCODE_ENGINE_VERSION,
  type OpenCodeEventParser,
  parseOpenCodeEvents,
} from './opencode/protocol'

// Codex app-server (plan §9): one `codex app-server` per slot, one thread per attempt.
export {
  CODEX_PERMISSION_DEADLINE_MS,
  CodexAdapter,
  type CodexAdapterDeps,
  type CodexLoginStatus,
  type CodexNotifications,
  type CodexPost,
  type CodexVersionProbe,
} from './codex/adapter'
export {
  CODEX_ENGINE_VERSION,
  classifyCodexError,
  createCodexEventParser,
  type CodexEventParser,
  parseCodexEvents,
} from './codex/protocol'

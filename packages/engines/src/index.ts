export { ClaudeAdapter, type ClaudeAdapterDeps } from './claude/adapter'
export { buildClaudeArgv, type ClaudeArgvInput } from './claude/argv'
export { type ClaudeProbeResult, type ProbeRun, probeClaude, REQUIRED_FLAGS } from './claude/probe'
export {
  type ClaudeEventParser,
  classifyClaudeError,
  createClaudeEventParser,
  type ParseOptions,
  parseClaudeStream,
} from './claude/stream'
// Codex app-server (plan §9): one `codex app-server` per slot, one thread per attempt.
export {
  CODEX_FLAGS_VERIFIED,
  CODEX_PERMISSION_DEADLINE_MS,
  CodexAdapter,
  type CodexAdapterDeps,
  type CodexConnection,
  type CodexLoginStatus,
  type CodexNotifications,
  type CodexPost,
  type CodexVersionProbe,
} from './codex/adapter'
export {
  CODEX_ENGINE_VERSION,
  type CodexEventParser,
  classifyCodexError,
  createCodexEventParser,
  parseCodexEvents,
} from './codex/protocol'
// OpenCode V2 (plan §9): one `opencode serve --stdio` per slot, one server session per attempt.
export {
  OPENCODE_FLAGS_VERIFIED,
  OpenCodeAdapter,
  type OpenCodeAdapterDeps,
  type OpenCodeAuthList,
  type OpenCodeConnection,
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

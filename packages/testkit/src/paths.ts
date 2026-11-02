import { fileURLToPath } from 'node:url'

/** Stand-in `claude` binary for adapter tests. */
export const FAKE_CLAUDE_BIN = fileURLToPath(new URL('../fixtures/fake-claude.mjs', import.meta.url))
/** The `mec` MCP server source, run through tsx in tests (the runner build bundles it). */
export const MEC_MCP_SERVER_SOURCE = fileURLToPath(
  new URL('../../../apps/runner/src/mcp/server.ts', import.meta.url),
)

/** Absolute `--import` target for tsx, so the server runs from any working directory. */
export const TSX_LOADER = import.meta.resolve('tsx')

/** How the adapter should start the `mec` MCP server in tests. */
export const TEST_MCP_SERVER = {
  command: process.execPath,
  args: ['--import', TSX_LOADER, MEC_MCP_SERVER_SOURCE],
}

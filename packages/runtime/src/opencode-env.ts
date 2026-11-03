/**
 * OpenCode project-config fencing (plan §8.4; the §26 "Repo-config hazards" row).
 *
 * OpenCode merges project-level config from whatever repository the attempt works in —
 * `opencode.json`, `.opencode/plugins/*.TS`, commands and MCP servers — and those files
 * execute with the slot's credentials. Unless the user marked the repository trusted, the
 * slot layer therefore carries `OPENCODE_DISABLE_PROJECT_CONFIG=1`, so none of it loads;
 * the repository's instructions still reach the agent through the bundle's conventions
 * layer instead (manual proof: a repo `opencode.json` dials MCP even from `auth list`,
 * and the disable variable stops it).
 *
 * A trusted repository may load its project config, so the slot layer sets nothing — and
 * §8.4 then requires the slot's own `opencode.json` to override `mcp.servers` and
 * `plugins` BY NAME, so repo entries can never shadow or duplicate MEC's MCP wiring. That
 * override is config-file surgery, not an environment variable, and so belongs to the
 * caller that writes the slot config.
 */
export function opencodeSlotEnv(repoTrusted: boolean): Record<string, string> {
  return repoTrusted ? {} : { OPENCODE_DISABLE_PROJECT_CONFIG: '1' }
}

/**
 * Agent tool catalog (CloudUI-style provider list, trimmed to the CLIs the
 * timer plugin can actually spawn): each entry carries the spawn default and
 * the model ids the form picker offers. Framework-free — the runner resolves
 * execution profiles from it and the client renders pickers from it.
 */

/** One spawnable agent CLI (a CloudUI "provider"). */
export interface AgentToolDef {
  id: 'claude' | 'codex' | 'opencode'
  label: string
  /** Default spawn command (absolute path recommended — PATH is incomplete). */
  command: string
  /** Default args template ({{prompt}} / {{session}} / … placeholders apply). */
  args: string
  /** Flag used to pass the model id. */
  modelFlag: string
  /**
   * How the thinking level is passed: a trailing `--effort <level>` flag
   * (claude), a `-c model_reasoning_effort=<level>` config override (codex),
   * or `--variant <level>` (opencode, provider-specific). Absent → the CLI
   * takes no thinking level.
   */
  effortStyle?: 'flag' | 'config' | 'variant'
  /** Flag that pins a conversation id (trailing). */
  sessionFlag?: string
  /** Subcommand inserted after the first token to resume (codex: `exec resume <id>`). */
  resumeSubcommand?: string
  /** Model used when the job names none (overrides the server profile). */
  defaultModel?: string
  /**
   * Whether the server profile's model applies when neither the job nor
   * `defaultModel` names one. True for claude (profile.json drives it);
   * absent for codex/opencode — no flag is injected and the CLI's own
   * config decides.
   */
  inheritServerModel?: boolean
  /** Built-in model ids offered in the form's model picker. */
  models: readonly string[]
}

/**
 * Built-in tool defaults. Args carry the tool's unattended bypass flag —
 * timer jobs run with no one at the keyboard, so an approval prompt would
 * just hang until timeout (user-authorized).
 */
export const AGENT_TOOLS: readonly AgentToolDef[] = [
  {
    id: 'claude',
    label: 'Claude',
    command: 'claude',
    args: '--print --permission-mode bypassPermissions',
    modelFlag: '--model',
    effortStyle: 'flag',
    sessionFlag: '--resume',
    inheritServerModel: true,
    models: [
      'glm-5.3-flash', 'glm-5.3', 'glm-4.7', 'glm-4.6',
      'claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5',
    ],
  },
  {
    id: 'codex',
    label: 'Codex',
    command: 'codex',
    args: 'exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox',
    modelFlag: '--model',
    effortStyle: 'config',
    resumeSubcommand: 'resume',
    models: ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5', 'gpt-5.4'],
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    command: 'opencode',
    args: 'run --auto',
    modelFlag: '--model',
    effortStyle: 'variant',
    sessionFlag: '--session',
    models: ['anthropic/claude-sonnet-4-5', 'openai/gpt-5.4'],
  },
]

/** Resolve a tool id (job's `tool` field) to its catalog entry. */
export function resolveAgentTool(id: string | undefined): AgentToolDef | undefined {
  const key = id?.trim()
  if (key === undefined || key === '') return undefined
  return AGENT_TOOLS.find(tool => tool.id === key)
}

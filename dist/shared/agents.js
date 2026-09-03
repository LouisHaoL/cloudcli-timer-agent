/**
 * Agent tool catalog (CloudUI-style provider list, trimmed to the CLIs the
 * timer plugin can actually spawn): each entry carries the spawn default and
 * the model ids the form picker offers. Framework-free — the runner resolves
 * execution profiles from it and the client renders pickers from it.
 */
/**
 * Built-in tool defaults. Args carry the tool's unattended bypass flag —
 * timer jobs run with no one at the keyboard, so an approval prompt would
 * just hang until timeout (user-authorized).
 */
export const AGENT_TOOLS = [
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
];
/** Resolve a tool id (job's `tool` field) to its catalog entry. */
export function resolveAgentTool(id) {
    const key = id?.trim();
    if (key === undefined || key === '')
        return undefined;
    return AGENT_TOOLS.find(tool => tool.id === key);
}
//# sourceMappingURL=agents.js.map
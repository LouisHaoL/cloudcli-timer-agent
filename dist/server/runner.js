/**
 * Execution adapter: spawns agent and command jobs as child processes
 * (ported from dsh-timer-agent's spawn-based 'command' half; the dsh
 * in-process session half becomes a CLI process here — same model
 * cloudcli-cron uses, since a plugin server cannot reach host sessions).
 *
 * Agent jobs resolve a CLI profile (per-job override → server default):
 * `args` is a template where {{prompt}} / {{workdir}} / {{title}} / {{taskId}}
 * / {{session}} / {{scheduledFor}} are substituted; when {{prompt}} is absent
 * the prompt goes to the child's stdin. Command jobs spawn command + args
 * (quote-aware split) directly. Output is capped-captured; the tail is kept
 * in the ledger.
 */
import { spawn } from 'node:child_process';
import { appendCapped, splitCommandArgs, truncateOutputTail } from '../shared/command.js';
import { jobKind } from '../shared/jobs.js';
/** Default execution timeout (ms) when neither job nor profile sets one. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000;
/** Default model/thinking level for agent runs (the claude CLI honors both). */
export const DEFAULT_MODEL = 'glm-5.3-flash';
export const DEFAULT_EFFORT = 'medium';
export const DEFAULT_PROFILE = {
    // Prefer absolute paths: the plugin server's PATH is often incomplete.
    command: process.env.TIMER_AGENT_CLI ?? 'claude',
    args: '--print',
    model: DEFAULT_MODEL,
    effort: DEFAULT_EFFORT,
};
/** Template variables available in an agent job's args template. */
export function renderTemplate(template, vars) {
    const replacements = {
        prompt: vars.prompt,
        workdir: vars.job.workdir ?? '',
        title: vars.job.title,
        taskId: vars.job.id,
        session: vars.job.session ?? '',
        scheduledFor: new Date(vars.scheduledFor).toISOString(),
    };
    return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name) => name in replacements ? replacements[name] : whole);
}
/** Resolve the effective CLI profile for an agent job. */
export function resolveProfile(job, serverProfile) {
    const override = job.cli;
    const command = override?.command?.trim() || serverProfile.command;
    const args = override?.args?.trim() || serverProfile.args;
    const timeoutMs = job.timeoutMs && job.timeoutMs > 0
        ? job.timeoutMs
        : override?.timeoutMs && override.timeoutMs > 0
            ? override.timeoutMs
            : serverProfile.timeoutMs && serverProfile.timeoutMs > 0
                ? serverProfile.timeoutMs
                : DEFAULT_TIMEOUT_MS;
    return { command, args, timeoutMs };
}
/** Run one job attempt and settle into a {@link RunOutcome}. */
export function runJob(job, serverProfile, scheduledFor) {
    if (jobKind(job) === 'command')
        return runCommand(job, scheduledFor);
    return runAgent(job, serverProfile, scheduledFor);
}
/** Spawn the configured CLI, delivering the prompt via {{prompt}} or stdin. */
function runAgent(job, serverProfile, scheduledFor) {
    const prompt = job.prompt;
    const profile = resolveProfile(job, serverProfile);
    const template = profile.args;
    const usesPlaceholder = /\{\{\s*prompt\s*\}\}/.test(template);
    const argv = splitCommandArgs(renderTemplate(template, { prompt, job, scheduledFor }));
    // Model + thinking level (same mechanism scheduled-prompt uses: plain CLI
    // flags). Skipped when the args template already carries the flag itself.
    const model = job.model?.trim() || serverProfile.model?.trim() || DEFAULT_MODEL;
    const effort = job.effort?.trim() || serverProfile.effort?.trim() || DEFAULT_EFFORT;
    if (!argv.includes('--model'))
        argv.push('--model', model);
    if (!argv.includes('--effort'))
        argv.push('--effort', effort);
    if (profile.command.trim() === '') {
        return Promise.resolve({ result: 'failed', error: 'CLI profile has no command', exitCode: undefined, output: '', sessionId: undefined });
    }
    return spawnProcess({
        command: profile.command,
        argv,
        cwd: job.workdir || undefined,
        timeoutMs: profile.timeoutMs,
        stdin: usesPlaceholder ? undefined : prompt,
        settle: (code, output) => {
            // Best-effort conversation-id pickup so runs can be pinned later.
            const match = output.match(/(?:session[_ -]?id|"sessionId")[:=]\s*"?([0-9a-f-]{8,})/i);
            return {
                result: code === 0 ? 'succeeded' : 'failed',
                error: code === 0 ? undefined : `CLI exited with code ${code}`,
                sessionId: match?.[1],
            };
        },
    });
}
/** Spawn a command job's executable directly (no AI). */
function runCommand(job, scheduledFor) {
    const executable = (job.command ?? '').trim();
    if (executable === '') {
        return Promise.resolve({ result: 'failed', error: 'command job has no command', exitCode: undefined, output: '', sessionId: undefined });
    }
    let argv;
    try {
        argv = splitCommandArgs(job.args ?? '');
    }
    catch (error) {
        return Promise.resolve({ result: 'failed', error: String(error), exitCode: undefined, output: '', sessionId: undefined });
    }
    void scheduledFor;
    return spawnProcess({
        command: executable,
        argv,
        cwd: job.workdir || undefined,
        timeoutMs: job.timeoutMs && job.timeoutMs > 0 ? job.timeoutMs : DEFAULT_TIMEOUT_MS,
        stdin: undefined,
        settle: (code, output) => ({
            result: code === 0 ? 'succeeded' : 'failed',
            error: code === 0 ? undefined : `exited with code ${code}`,
            sessionId: undefined,
        }),
    });
}
/** Shared spawn plumbing: capture, timeout (SIGTERM), settle. */
function spawnProcess(request) {
    return new Promise(resolve => {
        let output = '';
        let settled = false;
        const child = spawn(request.command, request.argv, {
            cwd: request.cwd,
            env: { ...process.env },
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
        });
        const timer = setTimeout(() => {
            child.kill('SIGTERM');
        }, request.timeoutMs);
        const finish = (code, killed) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            const outcome = killed
                ? { result: 'cancelled', error: `timed out after ${request.timeoutMs}ms`, sessionId: undefined }
                : request.settle(code, output);
            resolve({ ...outcome, exitCode: code, output: truncateOutputTail(output) });
        };
        child.stdout?.on('data', (chunk) => { output = appendCapped(output, chunk.toString('utf8')); });
        child.stderr?.on('data', (chunk) => { output = appendCapped(output, chunk.toString('utf8')); });
        child.on('error', error => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            resolve({ result: 'failed', error: String(error), exitCode: undefined, output: truncateOutputTail(output), sessionId: undefined });
        });
        child.on('close', (code, signal) => finish(code ?? undefined, signal !== null && signal !== undefined));
        if (request.stdin === undefined)
            child.stdin?.end();
        else
            child.stdin?.end(request.stdin, 'utf8');
    });
}
//# sourceMappingURL=runner.js.map
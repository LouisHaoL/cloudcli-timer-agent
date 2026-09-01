/**
 * Timer x Agent domain model for the CloudCLI port (ported from
 * dsh-timer-agent src/core/jobs.ts). Same lifecycle state machine; the
 * execution half is spawn-based instead of dsh sessions:
 *
 * - 'agent' jobs run the job's prompt through a configured CLI process
 *   ({{prompt}} placeholder or stdin), optionally `--resume`-ing a pinned
 *   conversation id.
 * - 'command' jobs spawn `command + args` directly (no AI, no quota).
 *
 * Framework-free so the server, the client and the tests share one module.
 */
/** Resolve a job's kind; absent/unknown fields degrade to the 'agent' default. */
export function jobKind(job) {
    return job.kind === 'command' ? 'command' : 'agent';
}
export const ALL_STATUSES = ['idle', 'running', 'done', 'failed', 'archived'];
export function isJobStatus(value) {
    return typeof value === 'string' && ALL_STATUSES.includes(value);
}
/** Create a job from user input. */
export function createJob(input, now, id) {
    const kind = jobKind(input);
    const cron = (input.cron ?? '').trim();
    const interval = input.intervalMinutes !== undefined && input.intervalMinutes > 0
        ? Math.round(input.intervalMinutes)
        : undefined;
    const job = {
        id,
        title: input.title.trim(),
        description: (input.description ?? '').trim(),
        prompt: (input.prompt ?? '').trim(),
        ...(kind === 'command' ? { kind, command: (input.command ?? '').trim(), args: (input.args ?? '').trim() } : {}),
        status: 'idle',
        createdAt: now,
        updatedAt: now,
        executions: [],
        ...(cron !== '' || interval !== undefined
            ? {
                schedule: {
                    enabled: input.enabled ?? true,
                    cron: interval !== undefined ? '' : cron,
                    ...(interval !== undefined ? { intervalMinutes: interval } : {}),
                    nextRunAt: undefined,
                    lastTriggeredAt: undefined,
                },
            }
            : {}),
    };
    if (input.workdir?.trim())
        job.workdir = input.workdir.trim();
    if (input.model?.trim())
        job.model = input.model.trim();
    if (input.effort?.trim())
        job.effort = input.effort.trim();
    if (input.cli && (input.cli.command?.trim() || input.cli.args?.trim())) {
        job.cli = {
            ...(input.cli.command?.trim() ? { command: input.cli.command.trim() } : {}),
            ...(input.cli.args?.trim() ? { args: input.cli.args.trim() } : {}),
            ...(input.cli.timeoutMs && input.cli.timeoutMs > 0 ? { timeoutMs: Math.round(input.cli.timeoutMs) } : {}),
        };
    }
    if (input.session?.trim())
        job.session = input.session.trim();
    if (input.timeoutMs && input.timeoutMs > 0)
        job.timeoutMs = Math.round(input.timeoutMs);
    return job;
}
/** A command job's display/exec line (agent jobs → ''). */
export function commandLine(job) {
    if (jobKind(job) !== 'command')
        return '';
    return `${job.command ?? ''} ${job.args ?? ''}`.trim();
}
/** Clone a job with an updated status and a fresh updatedAt. */
export function withStatus(job, status, now) {
    return { ...job, status, updatedAt: now };
}
/** Stamp (or clear) a manual-run request. */
export function withRunRequest(job, requestedAt, now) {
    const next = { ...job, updatedAt: now };
    if (requestedAt === undefined)
        delete next.runRequestedAt;
    else
        next.runRequestedAt = requestedAt;
    return next;
}
/** Merge a schedule patch into a job (creating the rule when absent). */
export function withSchedule(job, patch, now) {
    const current = job.schedule;
    const schedule = {
        enabled: current?.enabled ?? false,
        cron: current?.cron ?? '',
        ...(current?.intervalMinutes !== undefined ? { intervalMinutes: current.intervalMinutes } : {}),
        nextRunAt: current?.nextRunAt,
        lastTriggeredAt: current?.lastTriggeredAt,
        ...(current?.skipNextAt !== undefined ? { skipNextAt: current.skipNextAt } : {}),
    };
    if ('enabled' in patch)
        schedule.enabled = patch.enabled ?? false;
    if ('cron' in patch)
        schedule.cron = patch.cron ?? '';
    if ('intervalMinutes' in patch) {
        if (patch.intervalMinutes !== undefined && patch.intervalMinutes > 0) {
            schedule.intervalMinutes = Math.round(patch.intervalMinutes);
            schedule.cron = '';
        }
        else
            delete schedule.intervalMinutes;
    }
    if ('nextRunAt' in patch)
        schedule.nextRunAt = patch.nextRunAt;
    if ('lastTriggeredAt' in patch)
        schedule.lastTriggeredAt = patch.lastTriggeredAt;
    if ('skipNextAt' in patch) {
        if (patch.skipNextAt === undefined)
            delete schedule.skipNextAt;
        else
            schedule.skipNextAt = patch.skipNextAt;
    }
    return { ...job, updatedAt: now, schedule };
}
/** Open a fresh execution on a job: status → 'running', record appended. */
export function startExecution(job, now, executionId, trigger) {
    const execution = {
        id: executionId,
        startedAt: now,
        endedAt: undefined,
        result: undefined,
        error: undefined,
        trigger,
    };
    return {
        job: { ...job, status: 'running', updatedAt: now, executions: [...job.executions, execution] },
        execution,
    };
}
/** Settle a running execution (no-op when already settled or not latest). */
export function settleExecution(job, executionId, outcome, now, error, extra) {
    const index = job.executions.findIndex(execution => execution.id === executionId);
    if (index === -1)
        return job;
    const execution = job.executions[index];
    if (execution.endedAt !== undefined)
        return job;
    const settled = {
        ...execution,
        endedAt: now,
        result: outcome,
        error,
        ...(extra?.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
        ...(extra?.output !== undefined ? { output: extra.output } : {}),
        ...(extra?.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
    };
    const executions = [...job.executions];
    executions[index] = settled;
    const status = outcome === 'succeeded' ? 'done'
        : outcome === 'failed' ? 'failed'
            : job.status === 'running' ? 'idle' : job.status;
    return { ...job, status, updatedAt: now, executions };
}
/** Cap the per-job execution history (most recent last). */
export const MAX_EXECUTIONS = 200;
/** Trim a job's execution history to the cap. */
export function trimExecutions(job) {
    if (job.executions.length <= MAX_EXECUTIONS)
        return job;
    return { ...job, executions: job.executions.slice(-MAX_EXECUTIONS) };
}
//# sourceMappingURL=jobs.js.map
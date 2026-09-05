/**
 * Ticker: drives due schedules at-most-once (ported from dsh-timer-agent's
 * TimerRunner). For every due job the stored `nextRunAt` is advanced BEFORE
 * the run fires — a crash mid-run can never double-trigger; a stopped server
 * simply misses runs (no catch-up replay). A job that is still running skips
 * its occurrence. One-shot jobs (no cron / interval) instead CONSUME their
 * `nextRunAt` when the run opens — scheduled fires, manual runs, success and
 * failure all spend the single shot (settleExecution archives the job), while
 * a skipped (already running) fire leaves it armed for the next tick.
 * Skip-once: a `schedule.skipNextAt` equal to the due instant
 * consumes the skip and advances without firing. Manual runs arrive through
 * the ledger's `runRequestedAt` stamp (HTTP → ticker), same as the dsh
 * browser/tool → host channel.
 */
import { intervalNextMs, isIntervalRule, isOneShotRule, isSchedulable, nextRunAtMs, scheduleNextMs, } from '../shared/schedule.js';
import { settleExecution, startExecution, trimExecutions, withRunRequest } from '../shared/jobs.js';
import { runJob } from './runner.js';
import { loadDispatchPolicy, nextInboxCandidate, routedWorkdir } from './dispatch.js';
/** Jobs with an execution in flight in this process (double-fire guard). */
const inFlight = new Set();
/**
 * Recompute a job's nextRunAt when missing/stale-past. Called on every tick
 * so newly created or imported jobs get a schedule without extra ceremony.
 */
function ensureNextRunAt(job, now) {
    const schedule = job.schedule;
    if (!schedule || !schedule.enabled || !isSchedulable(schedule))
        return job;
    // A one-shot's persisted instant is its whole schedule — never recomputed
    // here. A past instant (e.g. resumed after a pause) must still fire.
    if (isOneShotRule(schedule))
        return job;
    const current = schedule.nextRunAt;
    if (current !== undefined && current > now - 24 * 60 * 60 * 1000)
        return job;
    // Interval grids re-anchor on the last trigger, stacking whole intervals
    // forward past the gap — a restart/pause never shifts the grid to "now".
    // Cron has its own grid to re-anchor on.
    const next = isIntervalRule(schedule)
        ? intervalNextMs(schedule.lastTriggeredAt ?? (typeof current === 'number' ? current : undefined), schedule.intervalMinutes, now)
        : nextRunAtMs(schedule.cron, current !== undefined && current > now ? current : now);
    if (next === current)
        return job;
    return { ...job, updatedAt: now, schedule: { ...schedule, nextRunAt: next } };
}
/** Advance the schedule grid one step from the just-fired instant. */
function advanceSchedule(job, firedAt, now) {
    const schedule = job.schedule;
    if (!schedule || !isSchedulable(schedule))
        return job;
    const next = isIntervalRule(schedule)
        ? scheduleNextMs(schedule, firedAt)
        : nextRunAtMs(schedule.cron, Math.max(firedAt, schedule.nextRunAt ?? firedAt));
    const updatedSchedule = { ...schedule, nextRunAt: next, lastTriggeredAt: firedAt };
    if (updatedSchedule.skipNextAt !== undefined && updatedSchedule.skipNextAt <= now) {
        // A stale skip (its instant already passed while paused/down) clears here.
        delete updatedSchedule.skipNextAt;
    }
    return { ...job, updatedAt: now, schedule: updatedSchedule };
}
/**
 * One scheduler pass. Returns when all fired runs have been *started*
 * (their results settle asynchronously).
 */
export async function tick(store, profile, now = Date.now()) {
    const policy = await loadDispatchPolicy();
    const dueJobs = await store.mutate(jobs => {
        let changed = false;
        const next = [];
        const fired = [];
        for (const job of jobs) {
            let current = ensureNextRunAt(job, now);
            if (current !== job)
                changed = true;
            // Manual run request (run-now / retry channel through the ledger).
            if (current.runRequestedAt !== undefined && current.status !== 'running' && current.status !== 'archived') {
                const stamp = current.runRequestedAt;
                // A manual run counts as the last execution: an interval grid
                // re-anchors on it (下次 = 手动时刻 + N); cron keeps its own grid.
                const manualSchedule = current.schedule;
                if (manualSchedule !== undefined && isIntervalRule(manualSchedule)) {
                    current = {
                        ...current,
                        schedule: {
                            ...manualSchedule,
                            nextRunAt: now + manualSchedule.intervalMinutes * 60_000,
                            lastTriggeredAt: now,
                        },
                    };
                }
                // A manual run spends a one-shot's single shot too (settleExecution
                // archives the job when the run settles; 'cancelled' leaves nothing
                // armed either way — the shot is gone with the run that opened).
                if (manualSchedule !== undefined && isOneShotRule(manualSchedule)
                    && manualSchedule.nextRunAt !== undefined) {
                    current = {
                        ...current,
                        schedule: { ...manualSchedule, nextRunAt: undefined, lastTriggeredAt: now },
                    };
                }
                const opened = startExecution(withRunRequest(current, undefined, now), now, crypto.randomUUID(), 'manual');
                current = trimExecutions(opened.job);
                fired.push({ job: current, executionId: opened.execution.id, trigger: 'manual', scheduledFor: stamp });
                changed = true;
                next.push(current);
                continue;
            }
            const schedule = current.schedule;
            if (!schedule || !schedule.enabled || !isSchedulable(schedule) || current.status === 'archived') {
                next.push(current);
                continue;
            }
            const due = schedule.nextRunAt !== undefined && schedule.nextRunAt <= now;
            if (!due) {
                next.push(current);
                continue;
            }
            const firedAt = schedule.nextRunAt;
            if (schedule.skipNextAt === firedAt) {
                // Skip-once: consume the skip and move the grid forward silently.
                // (A one-shot refuses skips at the API layer; if one ever lands here,
                // only the skip stamp is cleared — the shot stays armed.)
                const skipCleared = { ...schedule, skipNextAt: undefined };
                const next2 = isOneShotRule(schedule)
                    ? { ...current, updatedAt: now, schedule: skipCleared }
                    : advanceSchedule({ ...current, schedule: skipCleared }, firedAt, now);
                next.push(next2);
                changed = true;
                continue;
            }
            if (current.status === 'running' || inFlight.has(current.id)) {
                // Still running: skip this occurrence, wait for the next cron match.
                // A one-shot leaves its shot armed — the next tick retries it.
                next.push(isOneShotRule(schedule) ? current : advanceSchedule(current, firedAt, now));
                changed = true;
                continue;
            }
            // At-most-once: advance the grid first, then fire. A one-shot instead
            // CONSUMES nextRunAt in this same mutate (there is no "next" to
            // compute): a crash between here and the run settling can never
            // double-trigger, and settleExecution archives the job afterwards.
            current = isOneShotRule(schedule)
                ? {
                    ...current,
                    updatedAt: now,
                    schedule: { ...schedule, nextRunAt: undefined, lastTriggeredAt: firedAt },
                }
                : advanceSchedule(current, firedAt, now);
            const opened = startExecution(current, now, crypto.randomUUID(), 'scheduled');
            current = trimExecutions(opened.job);
            fired.push({ job: current, executionId: opened.execution.id, trigger: 'scheduled', scheduledFor: firedAt });
            changed = true;
            next.push(current);
        }
        // Inbox auto-dispatch: fill idle capacity (the "timer-Agent" deciding
        // what to work on next when nothing else is running). A candidate that is
        // also due on a schedule has already been started above, so it no longer
        // satisfies `status === 'idle'` and is skipped here. Routing to a
        // `targetProject` happens at dispatch, overriding the job's `workdir`.
        if (policy.enabled) {
            const running = next.filter(item => item.status === 'running').length;
            let capacity = Math.max(0, policy.maxConcurrent - running);
            while (capacity > 0) {
                const candidate = nextInboxCandidate(next, policy, now);
                if (candidate === undefined)
                    break;
                const executionWorkdir = routedWorkdir(candidate);
                const routed = executionWorkdir !== undefined ? { ...candidate, workdir: executionWorkdir } : candidate;
                const opened = startExecution(routed, now, crypto.randomUUID(), 'dispatch');
                const dispatched = trimExecutions(opened.job);
                const index = next.findIndex(item => item.id === dispatched.id);
                if (index !== -1)
                    next[index] = dispatched;
                else
                    next.push(dispatched);
                fired.push({ job: dispatched, executionId: opened.execution.id, trigger: 'dispatch', scheduledFor: now });
                changed = true;
                capacity -= 1;
            }
        }
        if (!changed && fired.length === 0)
            return undefined;
        return { jobs: next, result: fired };
    });
    for (const fire of dueJobs ?? []) {
        void execute(store, profile, fire.job.id, fire.executionId, fire.scheduledFor);
    }
}
/** Run one opened execution to completion and settle it into the ledger. */
async function execute(store, profile, jobId, executionId, scheduledFor) {
    const job = await store.mutate(jobs => {
        const current = jobs.find(item => item.id === jobId);
        if (current === undefined || current.status !== 'running')
            return undefined;
        inFlight.add(jobId);
        return { jobs, result: current };
    });
    if (job === undefined) {
        inFlight.delete(jobId);
        return;
    }
    try {
        const outcome = await runJob(job, profile, scheduledFor);
        await store.mutate(jobs => {
            const current = jobs.find(item => item.id === jobId);
            if (current === undefined)
                return undefined;
            const settled = trimExecutions(settleExecution(current, executionId, outcome.result, Date.now(), outcome.error, {
                exitCode: outcome.exitCode,
                output: outcome.output,
                sessionId: outcome.sessionId,
            }));
            return { jobs: jobs.map(item => (item.id === jobId ? settled : item)), result: undefined };
        });
    }
    finally {
        inFlight.delete(jobId);
    }
}
//# sourceMappingURL=scheduler.js.map
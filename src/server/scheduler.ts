/**
 * Ticker: drives due schedules at-most-once (ported from dsh-timer-agent's
 * TimerRunner). For every due job the stored `nextRunAt` is advanced BEFORE
 * the run fires — a crash mid-run can never double-trigger; a stopped server
 * simply misses runs (no catch-up replay). A job that is still running skips
 * its occurrence. Skip-once: a `schedule.skipNextAt` equal to the due instant
 * consumes the skip and advances without firing. Manual runs arrive through
 * the ledger's `runRequestedAt` stamp (HTTP → ticker), same as the dsh
 * browser/tool → host channel.
 */
import { intervalNextMs, isIntervalRule, isSchedulable, nextRunAtMs, scheduleNextMs } from '../shared/schedule.js'
import type { JobRecord, ScheduleRule, TriggerSource } from '../shared/jobs.js'
import { settleExecution, startExecution, trimExecutions, withRunRequest } from '../shared/jobs.js'
import type { JobStore } from './store.js'
import type { ServerProfile } from './runner.js'
import { runJob } from './runner.js'

/** Jobs with an execution in flight in this process (double-fire guard). */
const inFlight = new Set<string>()

/**
 * Recompute a job's nextRunAt when missing/stale-past. Called on every tick
 * so newly created or imported jobs get a schedule without extra ceremony.
 */
function ensureNextRunAt(job: JobRecord, now: number): JobRecord {
  const schedule = job.schedule
  if (!schedule || !schedule.enabled || !isSchedulable(schedule)) return job
  const current = schedule.nextRunAt
  if (current !== undefined && current > now - 24 * 60 * 60 * 1000) return job
  // Interval grids re-anchor on the last trigger, stacking whole intervals
  // forward past the gap — a restart/pause never shifts the grid to "now".
  // Cron has its own grid to re-anchor on.
  const next = isIntervalRule(schedule)
    ? intervalNextMs(
        schedule.lastTriggeredAt ?? (typeof current === 'number' ? current : undefined),
        schedule.intervalMinutes!,
        now,
      )
    : nextRunAtMs(schedule.cron, current !== undefined && current > now ? current : now)
  if (next === current) return job
  return { ...job, updatedAt: now, schedule: { ...schedule, nextRunAt: next } }
}

/** Advance the schedule grid one step from the just-fired instant. */
function advanceSchedule(job: JobRecord, firedAt: number, now: number): JobRecord {
  const schedule = job.schedule
  if (!schedule || !isSchedulable(schedule)) return job
  const next = isIntervalRule(schedule)
    ? scheduleNextMs(schedule, firedAt)
    : nextRunAtMs(schedule.cron, Math.max(firedAt, schedule.nextRunAt ?? firedAt))
  const updatedSchedule: ScheduleRule = { ...schedule, nextRunAt: next, lastTriggeredAt: firedAt }
  if (updatedSchedule.skipNextAt !== undefined && updatedSchedule.skipNextAt <= now) {
    // A stale skip (its instant already passed while paused/down) clears here.
    delete updatedSchedule.skipNextAt
  }
  return { ...job, updatedAt: now, schedule: updatedSchedule }
}

/**
 * One scheduler pass. Returns when all fired runs have been *started*
 * (their results settle asynchronously).
 */
export async function tick(store: JobStore, profile: ServerProfile, now: number = Date.now()): Promise<void> {
  const dueJobs = await store.mutate(jobs => {
    let changed = false
    const next: JobRecord[] = []
    const fired: Array<{ job: JobRecord; executionId: string; trigger: TriggerSource; scheduledFor: number }> = []
    for (const job of jobs) {
      let current = ensureNextRunAt(job, now)
      if (current !== job) changed = true
      // Manual run request (run-now / retry channel through the ledger).
      if (current.runRequestedAt !== undefined && current.status !== 'running' && current.status !== 'archived') {
        const stamp = current.runRequestedAt
        // A manual run counts as the last execution: an interval grid
        // re-anchors on it (下次 = 手动时刻 + N); cron keeps its own grid.
        const manualSchedule = current.schedule
        if (manualSchedule !== undefined && isIntervalRule(manualSchedule)) {
          current = {
            ...current,
            schedule: {
              ...manualSchedule,
              nextRunAt: now + manualSchedule.intervalMinutes! * 60_000,
              lastTriggeredAt: now,
            },
          }
        }
        const opened = startExecution(withRunRequest(current, undefined, now), now, crypto.randomUUID(), 'manual')
        current = trimExecutions(opened.job)
        fired.push({ job: current, executionId: opened.execution.id, trigger: 'manual', scheduledFor: stamp })
        changed = true
        next.push(current)
        continue
      }
      const schedule = current.schedule
      if (!schedule || !schedule.enabled || !isSchedulable(schedule) || current.status === 'archived') {
        next.push(current)
        continue
      }
      const due = schedule.nextRunAt !== undefined && schedule.nextRunAt <= now
      if (!due) {
        next.push(current)
        continue
      }
      const firedAt = schedule.nextRunAt!
      if (schedule.skipNextAt === firedAt) {
        // Skip-once: consume the skip and move the grid forward silently.
        const next2 = advanceSchedule({ ...current, schedule: { ...schedule, skipNextAt: undefined } }, firedAt, now)
        next.push(next2)
        changed = true
        continue
      }
      if (current.status === 'running' || inFlight.has(current.id)) {
        // Still running: skip this occurrence, wait for the next cron match.
        next.push(advanceSchedule(current, firedAt, now))
        changed = true
        continue
      }
      // At-most-once: advance the grid first, then fire.
      current = advanceSchedule(current, firedAt, now)
      const opened = startExecution(current, now, crypto.randomUUID(), 'scheduled')
      current = trimExecutions(opened.job)
      fired.push({ job: current, executionId: opened.execution.id, trigger: 'scheduled', scheduledFor: firedAt })
      changed = true
      next.push(current)
    }
    if (!changed && fired.length === 0) return undefined
    return { jobs: next, result: fired }
  })
  for (const fire of dueJobs ?? []) {
    void execute(store, profile, fire.job.id, fire.executionId, fire.scheduledFor)
  }
}

/** Run one opened execution to completion and settle it into the ledger. */
async function execute(
  store: JobStore,
  profile: ServerProfile,
  jobId: string,
  executionId: string,
  scheduledFor: number,
): Promise<void> {
  const job = await store.mutate(jobs => {
    const current = jobs.find(item => item.id === jobId)
    if (current === undefined || current.status !== 'running') return undefined
    inFlight.add(jobId)
    return { jobs, result: current }
  })
  if (job === undefined) {
    inFlight.delete(jobId)
    return
  }
  try {
    const outcome = await runJob(job, profile, scheduledFor)
    await store.mutate(jobs => {
      const current = jobs.find(item => item.id === jobId)
      if (current === undefined) return undefined
      const settled = trimExecutions(
        settleExecution(current, executionId, outcome.result, Date.now(), outcome.error, {
          exitCode: outcome.exitCode,
          output: outcome.output,
          sessionId: outcome.sessionId,
        }),
      )
      return { jobs: jobs.map(item => (item.id === jobId ? settled : item)), result: undefined }
    })
  } finally {
    inFlight.delete(jobId)
  }
}

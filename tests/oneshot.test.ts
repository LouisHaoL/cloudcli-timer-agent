/**
 * v0.5.0 one-shot / nextRunAt scheduling semantics (ported from
 * dsh-timer-agent's tests/schedule.mts + tests/e2e.mts one-shot coverage).
 * Runs against the built dist/ (`npm test` builds first).
 *
 * Every ticker test gets its OWN ledger file in a temp dir: tick() fires
 * runs with `void execute(...)` and results settle asynchronously, so tests
 * poll until the ledger quiesces instead of assuming timings.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// Keep tests far away from the real ~/.cloudcli-timer-agent ledger.
process.env.TIMER_AGENT_HOME = mkdtempSync(join(tmpdir(), 'cloudcli-timer-agent-test-'))
import {
  intervalNextMs, isOneShotRule, isSchedulable, nextRunAtMs, resumeNextMs,
} from '../dist/shared/schedule.js'
import { createJob, settleExecution, startExecution, withSchedule } from '../dist/shared/jobs.js'
import { parseLedger } from '../dist/server/store.js'
import { JobStore } from '../dist/server/store.js'
import { tick } from '../dist/server/scheduler.js'
import { DEFAULT_PROFILE } from '../dist/server/runner.js'

const MIN = 60_000

/** A quiet profile: the "agent run" is `node -e "process.exit(0)"`. */
const quietProfile = { ...DEFAULT_PROFILE, command: 'node', args: '-e "process.exit(0)"' }

/** Per-test ledger (fresh file, no cross-test contention). */
let testSeq = 0
function freshStore(): JobStore {
  return new JobStore(join(mkdtempSync(join(tmpdir(), 'ta-')), `jobs-${++testSeq}.json`))
}

/** Wait until `predicate` holds on the ledger (execute settles async). */
async function untilSettled(store: JobStore, predicate: (jobs: ReturnType<typeof parseLedger>) => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const jobs = await store.load()
    if (predicate(jobs)) return
    if (Date.now() > deadline) throw new Error('timed out waiting for the ledger to settle')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

test('isOneShotRule: blank cron + no interval, regardless of nextRunAt', () => {
  assert.equal(isOneShotRule({ cron: '' }), true)
  assert.equal(isOneShotRule({ cron: '', nextRunAt: 123 }), true)
  assert.equal(isOneShotRule({ cron: '0 9 * * *' }), false)
  assert.equal(isOneShotRule({ cron: '', intervalMinutes: 5 }), false)
  assert.equal(isOneShotRule(undefined), true)
})

test('isSchedulable: nextRunAt alone (one-shot) counts; blank rule does not', () => {
  assert.equal(isSchedulable({ cron: '', nextRunAt: 123 }), true)
  assert.equal(isSchedulable({ cron: '' }), false)
  assert.equal(isSchedulable({ cron: '0 9 * * *' }), true)
  assert.equal(isSchedulable(undefined), false)
})

test('resumeNextMs: one-shot passes its persisted instant through, even past', () => {
  const past = Date.now() - 3 * 24 * 60 * 60_000
  assert.equal(resumeNextMs({ cron: '', nextRunAt: past }, Date.now() - MIN, Date.now()), past)
  assert.equal(resumeNextMs({ cron: '' }, undefined, Date.now()), undefined)
})

test('resumeNextMs: interval re-anchors on the real last execution', () => {
  const now = 1_000_000_000_000
  const base = now - 90 * MIN
  // Whole-interval stacking: 90min ago + 60min grid → next slot in 30min.
  assert.equal(resumeNextMs({ cron: '', intervalMinutes: 60 }, base, now), base + 2 * 60 * MIN)
  // Missing base degenerates to now + N.
  assert.equal(resumeNextMs({ cron: '', intervalMinutes: 30 }, undefined, now), now + 30 * MIN)
})

test('resumeNextMs: cron skips missed slots instead of replaying them', () => {
  const now = new Date(); now.setSeconds(0, 0)
  const longAgo = now.getTime() - 40 * 24 * 60 * 60_000
  const armed = resumeNextMs({ cron: '0 9 * * *' }, longAgo, now.getTime())
  assert.ok(armed !== undefined && armed > now.getTime(), 'resumed slot is in the future')
  assert.equal(armed, nextRunAtMs('0 9 * * *', now.getTime()))
})

test('createJob: runAt arms a one-shot schedule (no cron/interval)', () => {
  const runAt = Date.now() + 60 * MIN
  const job = createJob({ title: 't', prompt: 'p', runAt }, 1, 'j1')
  assert.ok(job.schedule)
  assert.equal(isOneShotRule(job.schedule), true)
  assert.equal(job.schedule.enabled, true)
  assert.equal(job.schedule.nextRunAt, runAt)
})

test('settleExecution: a consumed one-shot archives on success/failure, cancelled stays idle', () => {
  const base = { id: 'j1', title: 't', description: '', prompt: 'p', status: 'idle', createdAt: 1, updatedAt: 1, executions: [], schedule: { enabled: true, cron: '', nextRunAt: undefined, lastTriggeredAt: 5 } }
  for (const outcome of ['succeeded', 'failed'] as const) {
    const { execution } = startExecution({ ...base }, 10, `e-${outcome}`, 'scheduled')
    const settled = settleExecution({ ...base, executions: [execution] }, `e-${outcome}`, outcome, 20, undefined)
    assert.equal(settled.status, 'archived', outcome)
  }
  // 'cancelled' has not consumed the shot → regular flow (back to idle).
  const { execution } = startExecution({ ...base }, 10, 'e-cancel', 'manual')
  const cancelled = settleExecution({ ...base, executions: [execution] }, 'e-cancel', 'cancelled', 20, undefined)
  assert.equal(cancelled.status, 'idle')
})

test('withSchedule: pause keeps the persisted nextRunAt', () => {
  const job = createJob({ title: 't', prompt: 'p', runAt: 12345 }, 1, 'j1')
  const paused = withSchedule(job, { enabled: false }, 2)
  assert.equal(paused.schedule.nextRunAt, 12345)
  assert.equal(paused.schedule.enabled, false)
})

test('store: one-shot rows survive repair with evidence; legacy blank rules lose their schedule', () => {
  const ledger = JSON.stringify([
    { id: 'a', title: 'one-shot pending', createdAt: 1, updatedAt: 1, executions: [], schedule: { enabled: true, cron: '', nextRunAt: 999 } },
    { id: 'b', title: 'one-shot consumed', createdAt: 1, updatedAt: 1, executions: [], schedule: { enabled: true, cron: '', lastTriggeredAt: 55 } },
    { id: 'c', title: 'legacy blank rule', createdAt: 1, updatedAt: 1, executions: [], schedule: { enabled: true, cron: '' } },
  ])
  const jobs = parseLedger(ledger)
  assert.equal(jobs.length, 3)
  assert.equal(jobs[0].schedule?.enabled, true)
  assert.equal(jobs[0].schedule?.nextRunAt, 999)
  assert.equal(jobs[1].schedule?.enabled, false, 'consumed one-shot disarms (no pending instant)')
  assert.equal(jobs[2].schedule, undefined, 'blank rule dropped (never counts as a one-shot)')
})

test('tick: a due one-shot fires once, consumes nextRunAt, and archives on settle', async () => {
  const store = freshStore()
  const now = Date.now()
  await store.mutate(jobs => ({ jobs: [...jobs, createJob({ title: 'once', prompt: 'p', runAt: now - MIN }, now, 'o1')], result: true }))
  await tick(store, quietProfile, now)
  let jobs = await store.load()
  assert.equal(jobs[0].schedule.nextRunAt, undefined, 'shot consumed when the run opened')
  assert.equal(jobs[0].schedule.lastTriggeredAt, now - MIN)
  // Second tick does not re-fire (the instant is gone).
  await tick(store, quietProfile, now + 1000)
  await untilSettled(store, current => (current[0]?.executions[0]?.endedAt ?? 0) > 0)
  jobs = await store.load()
  assert.equal(jobs[0].executions.length, 1)
  assert.equal(jobs[0].status, 'archived', 'settled one-shot archives')
})

test('tick: a manual run spends a still-armed one-shot too', async () => {
  const store = freshStore()
  const now = Date.now()
  // Armed for the future; the manual run consumes the shot instead.
  await store.mutate(jobs => ({ jobs: [...jobs, createJob({ title: 'once', prompt: 'p', runAt: now + 60 * MIN }, now, 'o1')], result: true }))
  await store.mutate(jobs => ({ jobs: jobs.map(j => j.id === 'o1' ? { ...j, runRequestedAt: now } : j), result: true }))
  await tick(store, quietProfile, now)
  const jobs = await store.load()
  assert.equal(jobs[0].executions.length, 1, 'manual run opened')
  assert.equal(jobs[0].schedule.nextRunAt, undefined, 'shot consumed by the manual run')
})

test('tick: a running one-shot keeps its shot armed for the next tick', async () => {
  const store = freshStore()
  const now = Date.now()
  const job = { ...createJob({ title: 'busy', prompt: 'p', runAt: now - MIN }, now, 'o2'), status: 'running' as const, executions: [{ id: 'e0', startedAt: now - 30_000, endedAt: undefined, result: undefined, error: undefined, trigger: 'scheduled' as const }] }
  await store.mutate(jobs => ({ jobs: [...jobs, job], result: true }))
  await tick(store, quietProfile, now)
  const jobs = await store.load()
  assert.equal(jobs[0].executions.length, 1, 'no second execution while running')
  assert.equal(jobs[0].schedule.nextRunAt, now - MIN, 'shot stays armed')
})

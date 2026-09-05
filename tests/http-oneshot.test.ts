/**
 * HTTP-layer smoke: one-shot create via runAt, pause/resume keeping the
 * instant, hand-pinned nextRunAt, skip refusal. Temp ledger, real server.
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
process.env.TIMER_AGENT_HOME = mkdtempSync(join(tmpdir(), 'ta-http-'))
process.env.TIMER_AGENT_NO_LOCK = '1'
import { JobStore } from '../dist/server/store.js'
import { startHttpServer } from '../dist/server/http.js'
import { tick } from '../dist/server/scheduler.js'
import { DEFAULT_PROFILE } from '../dist/server/runner.js'

const store = new JobStore(join(mkdtempSync(join(tmpdir(), 'ta-http-')), 'jobs.json'))
const quietProfile = { ...DEFAULT_PROFILE, command: 'node', args: '-e "process.exit(0)"' }
const server = await startHttpServer({ store, tick: () => tick(store, quietProfile) })
// The listener would otherwise keep the node --test child alive forever.
after(() => {
  server.closeAllConnections()
  server.close()
})
const base = `http://127.0.0.1:${(server.address()).port}`
const api = async (method, path, body) => {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: await res.json() }
}

test('HTTP: create via runAt (ISO), pause keeps the instant, resume fires it past', async () => {
  const runAt = new Date(Date.now() - 60_000).toISOString()
  const created = await api('POST', '/v1/jobs', { title: 'once', prompt: 'p', runAt })
  assert.equal(created.status, 201)
  const job = created.body.job
  assert.equal(job.schedule.cron, '')
  assert.equal(job.schedule.enabled, true)
  assert.equal(new Date(job.schedule.nextRunAt).toISOString(), runAt)

  // pause: nextRunAt survives
  const paused = await api('POST', `/v1/jobs/${job.id}/actions/pause`)
  assert.equal(paused.status, 200)
  assert.equal(paused.body.job.schedule.enabled, false)
  assert.equal(paused.body.job.schedule.nextRunAt, job.schedule.nextRunAt)

  // resume: one-shot instant passes through (even though past — deliberate)
  const resumed = await api('POST', `/v1/jobs/${job.id}/actions/resume`)
  assert.equal(resumed.body.job.schedule.enabled, true)
  assert.equal(resumed.body.job.schedule.nextRunAt, job.schedule.nextRunAt)

  // skip is refused for a one-shot
  const skipped = await api('PATCH', `/v1/jobs/${job.id}`, { skipNext: true })
  assert.equal(skipped.status, 400)
})

test('HTTP: patch nextRunAt pins one-shot/interval; cron and schedule-less refuse', async () => {
  const future = Date.now() + 2 * 60 * 60_000
  const once = await api('POST', '/v1/jobs', { title: 'once2', prompt: 'p', runAt: Date.now() + 60 * 60_000 })
  const pinned = await api('PATCH', `/v1/jobs/${once.body.job.id}`, { nextRunAt: future })
  assert.equal(pinned.status, 200)
  assert.equal(pinned.body.job.schedule.nextRunAt, future)

  const cronJob = await api('POST', '/v1/jobs', { title: 'crony', prompt: 'p', cron: '0 9 * * *' })
  const refused = await api('PATCH', `/v1/jobs/${cronJob.body.job.id}`, { nextRunAt: future })
  assert.equal(refused.status, 400)

  const bare = await api('POST', '/v1/jobs', { title: 'bare', prompt: 'p', inbox: true })
  const refused2 = await api('PATCH', `/v1/jobs/${bare.body.job.id}`, { nextRunAt: future })
  assert.equal(refused2.status, 400)

  const bad = await api('POST', '/v1/jobs', { title: 'bad', prompt: 'p', runAt: 'not-a-date' })
  assert.equal(bad.status, 400)
})

test('HTTP: switching an interval job to one-shot via patch (intervalMinutes:0 + nextRunAt)', async () => {
  const made = await api('POST', '/v1/jobs', { title: 'every5', prompt: 'p', intervalMinutes: 5 })
  assert.equal(made.body.job.schedule.intervalMinutes, 5)
  const switched = await api('PATCH', `/v1/jobs/${made.body.job.id}`, { intervalMinutes: 0, nextRunAt: Date.now() + 30 * 60_000 })
  assert.equal(switched.status, 200)
  assert.equal(switched.body.job.schedule.intervalMinutes, undefined)
  assert.equal(switched.body.job.schedule.cron, '')
  assert.equal(switched.body.job.schedule.nextRunAt > Date.now(), true)
})

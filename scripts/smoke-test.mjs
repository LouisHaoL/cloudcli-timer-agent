#!/usr/bin/env node
/**
 * Loopback smoke test for the timer-agent plugin server.
 *
 * Spawns `dist/server.js` against a throwaway TIMER_AGENT_HOME, waits for the
 * `{"ready":true,"port":N}` handshake, then exercises the routes the inbox
 * dispatch feature depends on:
 *   GET  /health
 *   POST /v1/jobs            (inbox task with priority/difficulty/targetProject)
 *   GET  /v1/dispatch        (default policy + queued/next preview)
 *   PUT  /v1/dispatch        (persist policy) -> GET /v1/dispatch (read back)
 *
 * It deliberately avoids routes that call the scheduler tick (GET /v1/jobs,
 * run-now), so the created inbox task stays idle and no CLI is spawned.
 * Exit code is 0 when every assertion passes, 1 otherwise.
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as sleep } from 'node:timers/promises'

// The script lives in scripts/, so '..' from import.meta.url is the plugin root.
const root = fileURLToPath(new URL('..', import.meta.url))
const tempDir = await mkdtemp(join(tmpdir(), 'cloudcli-timer-agent-smoke-'))
// The harness may set FORCE_COLOR/NO_COLOR together, which makes Node warn on
// startup; drop both from the child so the smoke output stays clean.
const childEnv = { ...process.env }
delete childEnv.NO_COLOR
delete childEnv.FORCE_COLOR
childEnv.TIMER_AGENT_HOME = tempDir

let child
let stderr = ''
let failures = 0

function check(condition, label) {
  if (condition) {
    console.log(`  ok - ${label}`)
  } else {
    failures += 1
    console.error(`  FAIL - ${label}`)
  }
}

async function request(url, { method = 'GET', body } = {}) {
  const response = await fetch(url, {
    method,
    ...(body !== undefined
      ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : {}),
  })
  const text = await response.text()
  let parsed
  try {
    parsed = text === '' ? undefined : JSON.parse(text)
  } catch {
    parsed = text
  }
  return { status: response.status, body: parsed }
}

async function pollHealth(base) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await request(`${base}/health`)
      if (response.status === 200 && response.body && response.body.ok === true) {
        return response.body
      }
    } catch {
      // Server may not have bound the port yet; keep polling.
    }
    await sleep(100)
  }
  throw new Error('health endpoint did not report ok in time')
}

function waitForReady(server) {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error(`server did not emit ready line; stderr:\n${stderr}`))
    }, 10_000)
    const cleanup = () => clearTimeout(timer)
    const onData = chunk => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (trimmed === '') continue
        try {
          const parsed = JSON.parse(trimmed)
          if (parsed && parsed.ready === true && Number.isInteger(parsed.port) && parsed.port > 0) {
            cleanup()
            server.stdout.off('data', onData)
            resolve(parsed)
            return
          }
        } catch {
          // Not JSON yet; keep waiting for the handshake line.
        }
      }
    }
    server.stdout.on('data', onData)
    server.on('error', error => {
      cleanup()
      reject(error)
    })
    server.on('exit', code => {
      cleanup()
      reject(new Error(`server exited before ready (code ${code}); stderr:\n${stderr}`))
    })
  })
}

try {
  console.log('Starting scheduler server in isolated TIMER_AGENT_HOME ...')
  child = spawn(process.execPath, ['dist/server.js'], {
    cwd: root,
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  child.stderr.on('data', chunk => { stderr += chunk.toString('utf8') })

  const { ready, port } = await waitForReady(child)
  check(ready === true && port > 0, `ready handshake (port ${port})`)

  const base = `http://127.0.0.1:${port}`

  const health = await pollHealth(base)
  check(health && health.ok === true, 'GET /health -> { ok: true }')

  // Model picker options (host lists when present, catalog fallback otherwise —
  // either way every tool must come back non-empty).
  const modelsResponse = await request(`${base}/v1/models`)
  check(modelsResponse.status === 200, 'GET /v1/models -> 200')
  const toolModels = modelsResponse.body && modelsResponse.body.models
  for (const tool of ['claude', 'codex', 'opencode']) {
    const entry = toolModels && toolModels[tool]
    check(entry !== undefined && Array.isArray(entry.options) && entry.options.length > 0 &&
      typeof entry.options[0].value === 'string', `models.${tool} carries non-empty options`)
  }

  const title = 'Smoke inbox task'
  const prompt = 'Run the smoke assertion and report back.'
  const targetProject = 'D:\\proj'
  const created = await request(`${base}/v1/jobs`, {
    method: 'POST',
    body: { title, kind: 'agent', prompt, inbox: true, priority: 5, difficulty: 2, targetProject },
  })
  check(created.status === 201, 'POST /v1/jobs -> 201')
  const job = created.body && created.body.job
  check(job !== undefined && job.inbox === true, 'created job is inbox')
  check(job !== undefined && job.priority === 5, 'created job priority === 5')
  check(job !== undefined && job.difficulty === 2, 'created job difficulty === 2')
  check(job !== undefined && job.targetProject === targetProject, 'created job targetProject persisted')

  const dispatch = await request(`${base}/v1/dispatch`)
  check(dispatch.status === 200, 'GET /v1/dispatch -> 200')
  const policy = dispatch.body && dispatch.body.policy
  check(policy !== undefined, 'dispatch response carries policy')
  check(policy && policy.enabled === true, 'policy.enabled default true')
  check(policy && policy.priorityWeight === 100, 'policy.priorityWeight default 100')
  check(policy && policy.difficultyWeight === 10, 'policy.difficultyWeight default 10')
  check(policy && policy.difficultyBias === 'easyFirst', 'policy.difficultyBias default easyFirst')
  check(policy && policy.ageWeight === 2, 'policy.ageWeight default 2')
  check(policy && policy.ageCapHours === 48, 'policy.ageCapHours default 48')
  check(policy && policy.maxConcurrent === 1, 'policy.maxConcurrent default 1')
  const status = dispatch.body && dispatch.body.status
  check(status && status.queued === 1, 'status.queued === 1')
  const next = status && status.next
  check(next !== null && next !== undefined, 'status.next is populated')
  if (next !== null && next !== undefined) {
    check(next.id === job.id, 'status.next.id matches created job')
    check(next.title === title, 'status.next.title matches')
    check(next.priority === 5, 'status.next.priority === 5')
    check(next.difficulty === 2, 'status.next.difficulty === 2')
    check(typeof next.score === 'number' && next.score >= 540 && next.score < 541, 'status.next.score is the expected 540')
    check(next.targetProject === targetProject, 'status.next.targetProject matches')
  }

  const putPolicy = { difficultyBias: 'hardFirst', maxConcurrent: 2 }
  const saved = await request(`${base}/v1/dispatch`, { method: 'PUT', body: putPolicy })
  check(saved.status === 200, 'PUT /v1/dispatch -> 200')
  const savedPolicy = saved.body && saved.body.policy
  check(savedPolicy && savedPolicy.difficultyBias === 'hardFirst', 'PUT policy applied hardFirst')
  check(savedPolicy && savedPolicy.maxConcurrent === 2, 'PUT policy applied maxConcurrent 2')

  const reloaded = await request(`${base}/v1/dispatch`)
  const reloadedPolicy = reloaded.body && reloaded.body.policy
  check(reloaded.status === 200, 'GET /v1/dispatch after PUT -> 200')
  check(reloadedPolicy && reloadedPolicy.difficultyBias === 'hardFirst', 'reloaded policy keeps hardFirst')
  check(reloadedPolicy && reloadedPolicy.maxConcurrent === 2, 'reloaded policy keeps maxConcurrent 2')

  const dispatchFile = join(tempDir, 'dispatch.json')
  check((await stat(dispatchFile).then(() => true).catch(() => false)), 'TIMER_AGENT_HOME/dispatch.json generated')
} catch (error) {
  failures += 1
  console.error(`  FAIL - ${error && error.message ? error.message : String(error)}`)
  if (stderr) console.error(`  child stderr:\n${stderr}`)
} finally {
  if (child && child.exitCode === null && typeof child.kill === 'function') {
    child.kill('SIGTERM')
    // Wait for the child to go away, but never hang; clear the timer on exit
    // so the parent drains its event loop without calling process.exit().
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 3000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }
  await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
}

// Set the exit code and let the loop drain instead of process.exit(): the
// latter trips a libuv assertion on Windows while child handles close.
if (failures > 0) {
  console.error(`\n${failures} smoke assertion(s) failed`)
} else {
  console.log('\nall smoke assertions passed')
}
process.exitCode = failures > 0 ? 1 : 0

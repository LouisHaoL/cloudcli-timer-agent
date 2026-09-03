/**
 * Server-side job ledger: one JSON file at ~/.cloudcli-timer-agent/jobs.json
 * (hermes-agent cron ledger shape: the host process reads/writes it any time;
 * ported from dsh-timer-agent's HostJobStore). All mutations serialize
 * through one promise chain; writes are atomic (temp + rename); a corrupted
 * file degrades to dropping invalid rows, never a crashed ticker.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { isValidCron } from '../shared/schedule.js'
import type { CliProfile, ExecutionRecord, JobRecord, JobStatus, ScheduleRule } from '../shared/jobs.js'
import { ALL_STATUSES, isJobStatus, normalizeDifficulty, normalizePriority } from '../shared/jobs.js'

/** Data directory (TIMER_AGENT_HOME overrides, for tests/harnesses). */
export function dataDir(): string {
  return process.env.TIMER_AGENT_HOME ?? join(homedir(), '.cloudcli-timer-agent')
}

/** Default ledger location. */
export function defaultJobsFile(): string {
  return join(dataDir(), 'jobs.json')
}

/** Default CLI execution profile location (agent jobs without a per-job override). */
export function defaultProfileFile(): string {
  return join(dataDir(), 'profile.json')
}

/** Repair one execution record; null when unusable. */
function repairExecution(value: unknown): ExecutionRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || typeof record.startedAt !== 'number') return null
  return {
    id: record.id,
    startedAt: record.startedAt,
    endedAt: typeof record.endedAt === 'number' ? record.endedAt : undefined,
    result: record.result === 'succeeded' || record.result === 'failed' || record.result === 'cancelled'
      ? record.result
      : undefined,
    error: typeof record.error === 'string' ? record.error : undefined,
    trigger: record.trigger === 'manual' || record.trigger === 'retry' ? record.trigger : 'scheduled',
    ...(typeof record.exitCode === 'number' ? { exitCode: record.exitCode } : {}),
    ...(typeof record.output === 'string' ? { output: record.output } : {}),
    ...(typeof record.sessionId === 'string' ? { sessionId: record.sessionId } : {}),
  }
}

/** Repair one job row field by field; null when the row is unusable. */
function repairJob(value: unknown): JobRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null
  if (typeof record.title !== 'string' || typeof record.createdAt !== 'number'
    || typeof record.updatedAt !== 'number') return null
  if (record.kind !== undefined && record.kind !== 'agent' && record.kind !== 'command') return null
  const status: JobStatus = isJobStatus(record.status) ? record.status : 'idle'
  const executions = Array.isArray(record.executions)
    ? record.executions.map(repairExecution).filter((item): item is ExecutionRecord => item !== null)
    : []
  let schedule: ScheduleRule | undefined
  if (typeof record.schedule === 'object' && record.schedule !== null) {
    const rule = record.schedule as Record<string, unknown>
    const cron = typeof rule.cron === 'string' && isValidCron(rule.cron) ? rule.cron : ''
    // Fixed-interval mode: intervalMinutes > 0 replaces cron as the schedulable
    // field (an interval job has cron === '' and must not be force-disabled).
    const intervalMinutes = typeof rule.intervalMinutes === 'number' && rule.intervalMinutes > 0
      ? Math.round(rule.intervalMinutes)
      : undefined
    schedule = {
      enabled: rule.enabled === true && (cron !== '' || intervalMinutes !== undefined),
      cron,
      nextRunAt: typeof rule.nextRunAt === 'number' ? rule.nextRunAt : undefined,
      lastTriggeredAt: typeof rule.lastTriggeredAt === 'number' ? rule.lastTriggeredAt : undefined,
      ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
      ...(typeof rule.skipNextAt === 'number' ? { skipNextAt: rule.skipNextAt } : {}),
    }
  }
  let cli: CliProfile | undefined
  if (typeof record.cli === 'object' && record.cli !== null) {
    const profile = record.cli as Record<string, unknown>
    cli = {
      ...(typeof profile.command === 'string' && profile.command ? { command: profile.command } : {}),
      ...(typeof profile.args === 'string' && profile.args ? { args: profile.args } : {}),
      ...(typeof profile.timeoutMs === 'number' && profile.timeoutMs > 0
        ? { timeoutMs: Math.round(profile.timeoutMs) } : {}),
    }
  }
  return {
    id: record.id,
    title: record.title,
    description: typeof record.description === 'string' ? record.description : '',
    prompt: typeof record.prompt === 'string' ? record.prompt : '',
    ...(record.kind === 'command' ? { kind: 'command' as const } : {}),
    ...(typeof record.command === 'string' ? { command: record.command } : {}),
    ...(typeof record.args === 'string' ? { args: record.args } : {}),
    status,
    ...(typeof record.workdir === 'string' && record.workdir ? { workdir: record.workdir } : {}),
    ...(cli !== undefined ? { cli } : {}),
    ...(typeof record.session === 'string' && record.session ? { session: record.session } : {}),
    ...(typeof record.model === 'string' && record.model.trim() !== '' ? { model: record.model.trim() } : {}),
    ...(typeof record.effort === 'string' && record.effort.trim() !== '' ? { effort: record.effort.trim() } : {}),
    ...(typeof record.priority === 'number' ? { priority: normalizePriority(record.priority) } : {}),
    ...(typeof record.difficulty === 'number' ? { difficulty: normalizeDifficulty(record.difficulty) } : {}),
    ...(record.inbox === true ? { inbox: true } : {}),
    ...(typeof record.targetProject === 'string' && record.targetProject !== '' ? { targetProject: record.targetProject } : {}),
    ...(typeof record.timeoutMs === 'number' && record.timeoutMs > 0
      ? { timeoutMs: Math.round(record.timeoutMs) } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    executions: executions.slice(-200),
    ...(typeof record.runRequestedAt === 'number' ? { runRequestedAt: record.runRequestedAt } : {}),
    ...(schedule !== undefined ? { schedule } : {}),
  }
}

/** Parse a ledger document; invalid rows are dropped (never throws). */
export function parseLedger(raw: string): JobRecord[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map(repairJob).filter((job): job is JobRecord => job !== null)
  } catch {
    return []
  }
}

/** File-backed job ledger. `load()` re-reads so writers stay coherent. */
export class JobStore {
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly file: string = defaultJobsFile(),
    private readonly parse: (raw: string) => JobRecord[] = parseLedger,
  ) {}

  /** Read the ledger (empty on first run / unreadable file). */
  async load(): Promise<JobRecord[]> {
    try {
      return this.parse(await readFile(this.file, 'utf8'))
    } catch {
      return []
    }
  }

  /**
   * Mutate under the serialization chain: load → mutate → atomic save.
   * The mutator returns undefined to abort (no write happens).
   */
  async mutate<T>(mutate: (jobs: JobRecord[]) => { jobs: JobRecord[]; result: T } | undefined): Promise<T | undefined> {
    const run = async (): Promise<T | undefined> => {
      const current = await this.load()
      const outcome = mutate(current)
      if (outcome === undefined) return undefined
      await this.save(outcome.jobs)
      return outcome.result
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => undefined)
    return next
  }

  /** Atomic write: temp file in the same directory, then rename. */
  private async save(jobs: readonly JobRecord[]): Promise<void> {
    const dir = join(this.file, '..')
    await mkdir(dir, { recursive: true })
    const temp = `${this.file}.tmp-${process.pid}-${Date.now()}`
    await writeFile(temp, `${JSON.stringify(jobs, null, 2)}\n`, 'utf8')
    await rename(temp, this.file)
  }
}

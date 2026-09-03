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

/** Job lifecycle status ('archived' freezes the job until restarted). */
export type JobStatus = 'idle' | 'running' | 'done' | 'failed' | 'archived'

/** How a job executes. */
export type JobKind = 'agent' | 'command'

/** Resolve a job's kind; absent/unknown fields degrade to the 'agent' default. */
export function jobKind(job: Pick<JobRecord, 'kind'>): JobKind {
  return job.kind === 'command' ? 'command' : 'agent'
}

/** How one execution was triggered. */
export type TriggerSource = 'scheduled' | 'manual' | 'dispatch' | 'retry'

/**
 * One real execution attempt: outcome, captured output tail (command runs /
 * CLI stdout) and failure reason.
 */
export interface ExecutionRecord {
  id: string
  startedAt: number
  endedAt: number | undefined
  result: 'succeeded' | 'failed' | 'cancelled' | undefined
  error: string | undefined
  trigger: TriggerSource
  /** Process exit code (null-ish when killed / unknown). */
  exitCode?: number
  /** Captured stdout+stderr tail for the detail view. */
  output?: string
  /** Agent runs: the CLI-reported conversation id, when parseable. */
  sessionId?: string
}

/** Scheduled-run rule: 5-field cron (分 时 日 月 周) or fixed interval + bookkeeping. */
export interface ScheduleRule {
  enabled: boolean
  cron: string
  /**
   * Fixed-interval mode (minutes, measured from the last trigger). When set
   * (> 0) it takes precedence over `cron` — use for "every 302 minutes"
   * style cadences a cron grid cannot express.
   */
  intervalMinutes?: number
  nextRunAt: number | undefined
  lastTriggeredAt: number | undefined
  /** Skip-once: one instant (ms epoch) the scheduler explicitly skips. */
  skipNextAt?: number
}

/**
 * Per-job CLI execution profile (agent jobs). Absent fields fall back to the
 * server's default profile. `args` is a template: `{{prompt}}` is replaced
 * with the job's prompt; without the placeholder the prompt goes via stdin.
 */
export interface CliProfile {
  /** Executable (absolute path recommended — the host PATH is incomplete). */
  command?: string
  /** Argument template, quote-aware split, `{{prompt}}` placeholder. */
  args?: string
  /** Timeout override (ms). */
  timeoutMs?: number
}

/** One scheduled job on the board. */
export interface JobRecord {
  id: string
  title: string
  description: string
  /** The prompt an agent run delivers (agent jobs). */
  prompt: string
  kind?: JobKind
  /** Command jobs: the executable to spawn (absolute path recommended). */
  command?: string
  /** Command jobs: argument string (quote-aware split). */
  args?: string
  status: JobStatus
  /** Working directory for the spawned process (blank → server cwd). */
  workdir?: string
  /** Agent jobs: which agent CLI to run (see shared/agents.ts); absent → server profile default. */
  tool?: string
  /** Agent jobs: per-job CLI profile override. */
  cli?: CliProfile
  /** Agent jobs: pin a conversation id to continue across runs. */
  session?: string
  /** Per-job execution timeout (ms); absent/zero → profile default. */
  timeoutMs?: number
  /** Agent jobs: `--model` override (absent → server profile default). */
  model?: string
  /** Agent jobs: `--effort` (thinking level) override; absent → profile default. */
  effort?: string
  /**
   * Inbox / automatic-dispatch marker. A job with `inbox: true` is a queued
   * task that the scheduler picks up when the process is otherwise idle; it
   * does not need a cron/interval schedule. The scheduler scores queued jobs
   * by `priority` + `difficulty` + age and runs the highest score.
   */
  inbox?: boolean
  /** 1 (low) … 5 (high). Weighted heavily in dispatch scoring. */
  priority?: number
  /** 1 (easy) … 5 (hard). Used as a tiebreak / risk factor in dispatch scoring. */
  difficulty?: number
  /**
   * Project workdir chosen at dispatch time. If set, the job is executed in
   * this directory (it overrides `workdir`); the "inbox" task itself can live
   * in one project but be routed to another to actually work.
   */
  targetProject?: string
  createdAt: number
  updatedAt: number
  /** Every execution attempt, most recent last. */
  executions: ExecutionRecord[]
  /** Pending manual-run request stamp (consumed by the ticker). */
  runRequestedAt?: number
  schedule?: ScheduleRule
}

/** Input for creating a job. */
export interface NewJobInput {
  title: string
  description?: string
  prompt?: string
  kind?: JobKind
  command?: string
  args?: string
  workdir?: string
  /** Agent jobs: agent CLI id ('claude' | 'codex' | 'opencode'; blank → server default). */
  tool?: string
  cli?: CliProfile
  session?: string
  timeoutMs?: number
  /** Agent jobs: `--model` override (blank → server profile default). */
  model?: string
  /** Agent jobs: `--effort` thinking-level override (blank → profile default). */
  effort?: string
  /** 5-field cron; required unless the job is created disabled+unscheduled. */
  cron?: string
  /** Fixed-interval alternative to `cron` (minutes from the last trigger). */
  intervalMinutes?: number
  enabled?: boolean
  /** Queue this job for automatic idle dispatch (no cron/interval needed). */
  inbox?: boolean
  /** 1 (low) … 5 (high) dispatch priority. */
  priority?: number
  /** 1 (easy) … 5 (hard) dispatch difficulty. */
  difficulty?: number
  /** Project workdir chosen at dispatch time (overrides `workdir`). */
  targetProject?: string
}

/** Clamp a dispatch priority to 1..5 (default 3). */
export function normalizePriority(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 3
  return Math.max(1, Math.min(5, Math.round(value)))
}

/** Clamp a dispatch difficulty to 1..5 (default 3). */
export function normalizeDifficulty(value: number | undefined | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 3
  return Math.max(1, Math.min(5, Math.round(value)))
}

export const ALL_STATUSES: readonly JobStatus[] = ['idle', 'running', 'done', 'failed', 'archived']

export function isJobStatus(value: unknown): value is JobStatus {
  return typeof value === 'string' && (ALL_STATUSES as readonly string[]).includes(value)
}

/** Create a job from user input. */
export function createJob(input: NewJobInput, now: number, id: string): JobRecord {
  const kind = jobKind(input as Pick<JobRecord, 'kind'>)
  const cron = (input.cron ?? '').trim()
  const interval = input.intervalMinutes !== undefined && input.intervalMinutes > 0
    ? Math.round(input.intervalMinutes)
    : undefined
  const job: JobRecord = {
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
  }
  if (input.workdir?.trim()) job.workdir = input.workdir.trim()
  if (input.tool?.trim()) job.tool = input.tool.trim()
  if (input.model?.trim()) job.model = input.model.trim()
  if (input.effort?.trim()) job.effort = input.effort.trim()
  if (input.cli && (input.cli.command?.trim() || input.cli.args?.trim())) {
    job.cli = {
      ...(input.cli.command?.trim() ? { command: input.cli.command.trim() } : {}),
      ...(input.cli.args?.trim() ? { args: input.cli.args.trim() } : {}),
      ...(input.cli.timeoutMs && input.cli.timeoutMs > 0 ? { timeoutMs: Math.round(input.cli.timeoutMs) } : {}),
    }
  }
  if (input.session?.trim()) job.session = input.session.trim()
  if (input.timeoutMs && input.timeoutMs > 0) job.timeoutMs = Math.round(input.timeoutMs)
  if (input.inbox === true) job.inbox = true
  if (input.priority !== undefined || input.difficulty !== undefined) {
    job.priority = normalizePriority(input.priority)
    job.difficulty = normalizeDifficulty(input.difficulty)
  }
  if (input.targetProject?.trim()) job.targetProject = input.targetProject.trim()
  return job
}

/** A command job's display/exec line (agent jobs → ''). */
export function commandLine(job: Pick<JobRecord, 'kind' | 'command' | 'args'>): string {
  if (jobKind(job) !== 'command') return ''
  return `${job.command ?? ''} ${job.args ?? ''}`.trim()
}

/** Clone a job with an updated status and a fresh updatedAt. */
export function withStatus(job: JobRecord, status: JobStatus, now: number): JobRecord {
  return { ...job, status, updatedAt: now }
}

/** Stamp (or clear) a manual-run request. */
export function withRunRequest(job: JobRecord, requestedAt: number | undefined, now: number): JobRecord {
  const next = { ...job, updatedAt: now }
  if (requestedAt === undefined) delete next.runRequestedAt
  else next.runRequestedAt = requestedAt
  return next
}

/** Merge a schedule patch into a job (creating the rule when absent). */
export function withSchedule(job: JobRecord, patch: Partial<ScheduleRule>, now: number): JobRecord {
  const current = job.schedule
  const schedule: ScheduleRule = {
    enabled: current?.enabled ?? false,
    cron: current?.cron ?? '',
    ...(current?.intervalMinutes !== undefined ? { intervalMinutes: current.intervalMinutes } : {}),
    nextRunAt: current?.nextRunAt,
    lastTriggeredAt: current?.lastTriggeredAt,
    ...(current?.skipNextAt !== undefined ? { skipNextAt: current.skipNextAt } : {}),
  }
  if ('enabled' in patch) schedule.enabled = patch.enabled ?? false
  if ('cron' in patch) schedule.cron = patch.cron ?? ''
  if ('intervalMinutes' in patch) {
    if (patch.intervalMinutes !== undefined && patch.intervalMinutes > 0) {
      schedule.intervalMinutes = Math.round(patch.intervalMinutes)
      schedule.cron = ''
    } else delete schedule.intervalMinutes
  }
  if ('nextRunAt' in patch) schedule.nextRunAt = patch.nextRunAt
  if ('lastTriggeredAt' in patch) schedule.lastTriggeredAt = patch.lastTriggeredAt
  if ('skipNextAt' in patch) {
    if (patch.skipNextAt === undefined) delete schedule.skipNextAt
    else schedule.skipNextAt = patch.skipNextAt
  }
  return { ...job, updatedAt: now, schedule }
}

/** Open a fresh execution on a job: status → 'running', record appended. */
export function startExecution(
  job: JobRecord,
  now: number,
  executionId: string,
  trigger: TriggerSource,
): { job: JobRecord; execution: ExecutionRecord } {
  const execution: ExecutionRecord = {
    id: executionId,
    startedAt: now,
    endedAt: undefined,
    result: undefined,
    error: undefined,
    trigger,
  }
  return {
    job: { ...job, status: 'running', updatedAt: now, executions: [...job.executions, execution] },
    execution,
  }
}

/** Settle a running execution (no-op when already settled or not latest). */
export function settleExecution(
  job: JobRecord,
  executionId: string,
  outcome: 'succeeded' | 'failed' | 'cancelled',
  now: number,
  error: string | undefined,
  extra?: { exitCode?: number; output?: string; sessionId?: string },
): JobRecord {
  const index = job.executions.findIndex(execution => execution.id === executionId)
  if (index === -1) return job
  const execution = job.executions[index]
  if (execution.endedAt !== undefined) return job
  const settled: ExecutionRecord = {
    ...execution,
    endedAt: now,
    result: outcome,
    error,
    ...(extra?.exitCode !== undefined ? { exitCode: extra.exitCode } : {}),
    ...(extra?.output !== undefined ? { output: extra.output } : {}),
    ...(extra?.sessionId !== undefined ? { sessionId: extra.sessionId } : {}),
  }
  const executions = [...job.executions]
  executions[index] = settled
  const status: JobStatus = outcome === 'succeeded' ? 'done'
    : outcome === 'failed' ? 'failed'
      : job.status === 'running' ? 'idle' : job.status
  return { ...job, status, updatedAt: now, executions }
}

/** Cap the per-job execution history (most recent last). */
export const MAX_EXECUTIONS = 200

/** Trim a job's execution history to the cap. */
export function trimExecutions(job: JobRecord): JobRecord {
  if (job.executions.length <= MAX_EXECUTIONS) return job
  return { ...job, executions: job.executions.slice(-MAX_EXECUTIONS) }
}

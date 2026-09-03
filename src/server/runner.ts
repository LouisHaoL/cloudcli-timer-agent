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
import { spawn } from 'node:child_process'
import { appendCapped, splitCommandArgs, truncateOutputTail } from '../shared/command.js'
import type { AgentToolDef } from '../shared/agents.js'
import { resolveAgentTool } from '../shared/agents.js'
import type { CliProfile, JobRecord } from '../shared/jobs.js'
import { jobKind } from '../shared/jobs.js'

/** Default execution timeout (ms) when neither job nor profile sets one. */
export const DEFAULT_TIMEOUT_MS = 10 * 60_000

/** The server's default agent CLI profile (profile.json). */
export interface ServerProfile {
  command: string
  args: string
  timeoutMs?: number
  /** Default `--model` for agent jobs (per-job `model` overrides). */
  model?: string
  /** Default `--effort` thinking level for agent jobs (per-job `effort` overrides). */
  effort?: string
}

/** Default model/thinking level for agent runs (the claude CLI honors both). */
export const DEFAULT_MODEL = 'glm-5.3-flash'
export const DEFAULT_EFFORT = 'medium'

export const DEFAULT_PROFILE: ServerProfile = {
  // Prefer absolute paths: the plugin server's PATH is often incomplete.
  // Unattended runs: skip permission prompts (an approval would just hang
  // until the timeout kills the run).
  command: process.env.TIMER_AGENT_CLI ?? 'claude',
  args: '--print --permission-mode bypassPermissions',
  model: DEFAULT_MODEL,
  effort: DEFAULT_EFFORT,
}

/** Outcome of one execution attempt. */
export interface RunOutcome {
  result: 'succeeded' | 'failed' | 'cancelled'
  error: string | undefined
  exitCode: number | undefined
  output: string
  sessionId: string | undefined
}

/** Template variables available in an agent job's args template. */
export function renderTemplate(
  template: string,
  vars: { prompt: string; job: JobRecord; scheduledFor: number },
): string {
  const replacements: Record<string, string> = {
    prompt: vars.prompt,
    workdir: vars.job.workdir ?? '',
    title: vars.job.title,
    taskId: vars.job.id,
    session: vars.job.session ?? '',
    scheduledFor: new Date(vars.scheduledFor).toISOString(),
  }
  return template.replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, name: string) =>
    name in replacements ? replacements[name]! : whole)
}

/** Resolve the effective CLI profile for an agent job (cli override → tool catalog → server default). */
export function resolveProfile(job: JobRecord, serverProfile: ServerProfile): { command: string; args: string; timeoutMs: number; tool: AgentToolDef | undefined } {
  const override = job.cli
  const tool = resolveAgentTool(job.tool)
  const command = override?.command?.trim() || tool?.command || serverProfile.command
  const args = override?.args?.trim() || tool?.args || serverProfile.args
  const timeoutMs = job.timeoutMs && job.timeoutMs > 0
    ? job.timeoutMs
    : override?.timeoutMs && override.timeoutMs > 0
      ? override.timeoutMs
      : serverProfile.timeoutMs && serverProfile.timeoutMs > 0
        ? serverProfile.timeoutMs
        : DEFAULT_TIMEOUT_MS
  return { command, args, timeoutMs, tool }
}

/** Run one job attempt and settle into a {@link RunOutcome}. */
export function runJob(
  job: JobRecord,
  serverProfile: ServerProfile,
  scheduledFor: number,
): Promise<RunOutcome> {
  if (jobKind(job) === 'command') return runCommand(job, scheduledFor)
  return runAgent(job, serverProfile, scheduledFor)
}

/** Spawn the configured CLI, delivering the prompt via {{prompt}} or stdin. */
function runAgent(job: JobRecord, serverProfile: ServerProfile, scheduledFor: number): Promise<RunOutcome> {
  const prompt = job.prompt
  const profile = resolveProfile(job, serverProfile)
  const template = profile.args
  const usesPlaceholder = /\{\{\s*prompt\s*\}\}/.test(template)
  const argv = splitCommandArgs(renderTemplate(template, { prompt, job, scheduledFor }))
  // Model + thinking level (same mechanism scheduled-prompt uses: plain CLI
  // flags). Skipped when the args template already carries the flag itself;
  // the effort syntax follows the tool (claude flag / codex config / opencode variant).
  // Model precedence: job → tool default → server profile, but only when the
  // tool inherits the server default — codex/opencode read their own configs,
  // so an injected default would override a config the user never asked us to.
  const jobModel = job.model?.trim()
  let model: string | undefined
  if (jobModel !== undefined && jobModel !== '') model = jobModel
  else if (profile.tool?.defaultModel !== undefined) model = profile.tool.defaultModel
  else if (profile.tool?.inheritServerModel !== false) model = serverProfile.model?.trim() || DEFAULT_MODEL
  const effort = job.effort?.trim() || serverProfile.effort?.trim() || DEFAULT_EFFORT
  const modelFlag = profile.tool?.modelFlag ?? '--model'
  if (model !== undefined && !argv.includes(modelFlag)) argv.push(modelFlag, model)
  const effortStyle = profile.tool?.effortStyle ?? 'flag'
  if (effortStyle === 'flag' && !argv.includes('--effort')) argv.push('--effort', effort)
  else if (effortStyle === 'config' && !argv.some(arg => arg.startsWith('model_reasoning_effort='))) {
    argv.push('-c', `model_reasoning_effort=${effort}`)
  } else if (effortStyle === 'variant' && !argv.includes('--variant')) argv.push('--variant', effort)
  // Pinned session continuity, per tool: claude `--resume <id>` /
  // opencode `--session <id>` trailing, codex `exec resume <id>` inserted
  // after the first token. Skipped when the template carries {{session}}.
  const session = job.session?.trim()
  if (session !== undefined && session !== '' && !/\{\{\s*session\s*\}\}/.test(template)) {
    if (profile.tool?.resumeSubcommand !== undefined) argv.splice(1, 0, profile.tool.resumeSubcommand, session)
    else argv.push(profile.tool?.sessionFlag ?? '--resume', session)
  }
  if (profile.command.trim() === '') {
    return Promise.resolve({ result: 'failed', error: 'CLI profile has no command', exitCode: undefined, output: '', sessionId: undefined })
  }
  return spawnProcess({
    command: profile.command,
    argv,
    cwd: job.workdir || undefined,
    timeoutMs: profile.timeoutMs,
    stdin: usesPlaceholder ? undefined : prompt,
    settle: (code, output) => {
      // Best-effort conversation-id pickup so runs can be pinned later.
      const match = output.match(/(?:session[_ -]?id|"sessionId")[:=]\s*"?([0-9a-f-]{8,})/i)
      return {
        result: code === 0 ? 'succeeded' : 'failed',
        error: code === 0 ? undefined : `CLI exited with code ${code}`,
        sessionId: match?.[1],
      }
    },
  })
}

/** Spawn a command job's executable directly (no AI). */
function runCommand(job: JobRecord, scheduledFor: number): Promise<RunOutcome> {
  const executable = (job.command ?? '').trim()
  if (executable === '') {
    return Promise.resolve({ result: 'failed', error: 'command job has no command', exitCode: undefined, output: '', sessionId: undefined })
  }
  let argv: string[]
  try {
    argv = splitCommandArgs(job.args ?? '')
  } catch (error) {
    return Promise.resolve({ result: 'failed', error: String(error), exitCode: undefined, output: '', sessionId: undefined })
  }
  void scheduledFor
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
  })
}

interface SpawnRequest {
  command: string
  argv: string[]
  cwd: string | undefined
  timeoutMs: number
  stdin: string | undefined
  settle: (code: number | undefined, output: string) => { result: RunOutcome['result']; error: string | undefined; sessionId: string | undefined }
}

/** Shared spawn plumbing: capture, timeout (SIGTERM), settle. */
function spawnProcess(request: SpawnRequest): Promise<RunOutcome> {
  return new Promise(resolve => {
    let output = ''
    let settled = false
    const child = spawn(request.command, request.argv, {
      cwd: request.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const timer = setTimeout(() => {
      child.kill('SIGTERM')
    }, request.timeoutMs)
    const finish = (code: number | undefined, killed: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      const outcome = killed
        ? { result: 'cancelled' as const, error: `timed out after ${request.timeoutMs}ms`, sessionId: undefined }
        : request.settle(code, output)
      resolve({ ...outcome, exitCode: code, output: truncateOutputTail(output) })
    }
    child.stdout?.on('data', (chunk: Buffer) => { output = appendCapped(output, chunk.toString('utf8')) })
    child.stderr?.on('data', (chunk: Buffer) => { output = appendCapped(output, chunk.toString('utf8')) })
    child.on('error', error => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ result: 'failed', error: String(error), exitCode: undefined, output: truncateOutputTail(output), sessionId: undefined })
    })
    child.on('close', (code, signal) => finish(code ?? undefined, signal !== null && signal !== undefined))
    if (request.stdin === undefined) child.stdin?.end()
    else child.stdin?.end(request.stdin, 'utf8')
  })
}

/**
 * Inbox dispatch front-end: loads/saves the dispatch policy and picks the
 * next candidate. The scheduler owns the actual "am I busy" check and the
 * spawn (so the in-memory in-flight guard stays in one place); this module
 * stays pure/framework-free apart from policy persistence.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  DEFAULT_DISPATCH_POLICY,
  isInboxCandidate,
  scoreDispatch,
  type DifficultyBias,
  type DispatchPolicy,
} from '../shared/scoring.js'
import type { JobRecord } from '../shared/jobs.js'
import { dataDir } from './store.js'

export type { DispatchPolicy, DifficultyBias }

/** Normalize an arbitrary candidate object into a valid policy. */
export function parseDispatchPolicy(raw: unknown): DispatchPolicy {
  const value = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<DispatchPolicy>
  return {
    enabled: typeof value.enabled === 'boolean' ? value.enabled : DEFAULT_DISPATCH_POLICY.enabled,
    priorityWeight: finitePositive(value.priorityWeight, DEFAULT_DISPATCH_POLICY.priorityWeight),
    difficultyWeight: finitePositive(value.difficultyWeight, DEFAULT_DISPATCH_POLICY.difficultyWeight),
    difficultyBias: value.difficultyBias === 'hardFirst' ? 'hardFirst' : 'easyFirst',
    ageWeight: finitePositive(value.ageWeight, DEFAULT_DISPATCH_POLICY.ageWeight),
    ageCapHours: finitePositive(value.ageCapHours, DEFAULT_DISPATCH_POLICY.ageCapHours),
    maxConcurrent: finitePositive(value.maxConcurrent, DEFAULT_DISPATCH_POLICY.maxConcurrent),
  }
}

/** Default policy file within the data directory. */
export function defaultDispatchFile(): string {
  return join(dataDir(), 'dispatch.json')
}

/** Load the dispatch policy, falling back to defaults on any parse issue. */
export async function loadDispatchPolicy(): Promise<DispatchPolicy> {
  try {
    return parseDispatchPolicy(JSON.parse(await readFile(defaultDispatchFile(), 'utf8')))
  } catch {
    return { ...DEFAULT_DISPATCH_POLICY }
  }
}

/** Persist the dispatch policy. */
export async function saveDispatchPolicy(policy: DispatchPolicy): Promise<void> {
  const file = defaultDispatchFile()
  await mkdir(join(file, '..'), { recursive: true })
  await writeFile(file, `${JSON.stringify(policy, null, 2)}\n`, 'utf8')
}

/** Pick the highest-scoring idle inbox candidate, or undefined when none. */
export function nextInboxCandidate(
  jobs: readonly JobRecord[],
  policy: DispatchPolicy,
  now: number,
): JobRecord | undefined {
  let best: JobRecord | undefined
  let bestScore = Number.NEGATIVE_INFINITY
  for (const job of jobs) {
    if (!isInboxCandidate(job)) continue
    const score = scoreDispatch(job, policy, now)
    if (score > bestScore) {
      bestScore = score
      best = job
    }
  }
  return best
}

/**
 * Resolve the actual execution workdir for a routed job. When a `targetProject`
 * is present it wins at dispatch time (执行时决定放到哪个项目), otherwise the
 * job's own `workdir` (or the server default) is used.
 */
export function routedWorkdir(job: JobRecord): string | undefined {
  return job.targetProject?.trim() || job.workdir?.trim() || undefined
}

function finitePositive(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

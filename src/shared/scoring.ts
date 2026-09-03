/**
 * Pure dispatch scoring for the inbox. The scheduler collects `inbox` jobs
 * that are idle, scores them, and runs the highest. It is framework-free and
 * deterministic so the server policy, the client preview and tests share one
 * rule set.
 */

/**
 * How difficulty is treated when two tasks have the same priority.
 * `easyFirst` clears quick wins; `hardFirst` keeps the hard/tall items from
 * being starved forever.
 */
export type DifficultyBias = 'easyFirst' | 'hardFirst'

/** Dispatch policy (persisted side-by-side with the server profile). */
export interface DispatchPolicy {
  enabled: boolean
  /** Weight of priority (1..5), the dominant term. */
  priorityWeight: number
  /** Weight of the difficulty term (1..5). */
  difficultyWeight: number
  difficultyBias: DifficultyBias
  /** Age boost per elapsed hour (linear, capped). */
  ageWeight: number
  /** Cap the age boost in hours. */
  ageCapHours: number
  /** Only dispatch when the number of running jobs is below this. */
  maxConcurrent: number
}

export const DEFAULT_DISPATCH_POLICY: DispatchPolicy = {
  enabled: true,
  priorityWeight: 100,
  difficultyWeight: 10,
  difficultyBias: 'easyFirst',
  ageWeight: 2,
  ageCapHours: 48,
  maxConcurrent: 1,
}

/** Whether a job is a dispatchable inbox candidate in the given instant. */
export function isInboxCandidate(job: { inbox?: boolean; status: string }): boolean {
  return job.inbox === true && job.status === 'idle'
}

/**
 * Score a dispatch candidate. Higher wins. The policy defaults make priority
 * dominant, use difficulty as a tiebreak (easy-first), and let age slowly
 * raise a long-waiting task so it is not starved forever.
 */
export function scoreDispatch(
  job: { priority?: number; difficulty?: number; createdAt: number },
  policy: DispatchPolicy,
  now: number,
): number {
  const priority = job.priority ?? 3
  const difficulty = job.difficulty ?? 3
  const priorityScore = priority * policy.priorityWeight
  const difficultyScore = policy.difficultyBias === 'easyFirst'
    ? (6 - difficulty) * policy.difficultyWeight
    : difficulty * policy.difficultyWeight
  const ageHours = Math.max(0, (now - job.createdAt) / 3_600_000)
  const ageScore = Math.min(ageHours, Math.max(0, policy.ageCapHours)) * policy.ageWeight
  return priorityScore + difficultyScore + ageScore
}

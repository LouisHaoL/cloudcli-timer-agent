/**
 * Pure dispatch scoring for the inbox. The scheduler collects `inbox` jobs
 * that are idle, scores them, and runs the highest. It is framework-free and
 * deterministic so the server policy, the client preview and tests share one
 * rule set.
 */
export const DEFAULT_DISPATCH_POLICY = {
    enabled: true,
    priorityWeight: 100,
    difficultyWeight: 10,
    difficultyBias: 'easyFirst',
    ageWeight: 2,
    ageCapHours: 48,
    maxConcurrent: 1,
};
/** Whether a job is a dispatchable inbox candidate in the given instant. */
export function isInboxCandidate(job) {
    return job.inbox === true && job.status === 'idle';
}
/**
 * Score a dispatch candidate. Higher wins. The policy defaults make priority
 * dominant, use difficulty as a tiebreak (easy-first), and let age slowly
 * raise a long-waiting task so it is not starved forever.
 */
export function scoreDispatch(job, policy, now) {
    const priority = job.priority ?? 3;
    const difficulty = job.difficulty ?? 3;
    const priorityScore = priority * policy.priorityWeight;
    const difficultyScore = policy.difficultyBias === 'easyFirst'
        ? (6 - difficulty) * policy.difficultyWeight
        : difficulty * policy.difficultyWeight;
    const ageHours = Math.max(0, (now - job.createdAt) / 3_600_000);
    const ageScore = Math.min(ageHours, Math.max(0, policy.ageCapHours)) * policy.ageWeight;
    return priorityScore + difficultyScore + ageScore;
}
//# sourceMappingURL=scoring.js.map
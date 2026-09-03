/**
 * Loopback HTTP API for the plugin tab (the host proxies the client's
 * `api.rpc(method, path, body)` straight onto these routes). Binds
 * 127.0.0.1 only; same trust model as cloudcli-cron: any local process can
 * reach it, so the ledger is effectively local-code-execution for command
 * jobs — keep it that way.
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { intervalNextMs, isIntervalRule, isValidCron, nextRunAtMs, scheduleNextMs } from '../shared/schedule.js';
import { createJob, jobKind, normalizeDifficulty, normalizePriority, withSchedule, withStatus } from '../shared/jobs.js';
import { defaultProfileFile } from './store.js';
import { DEFAULT_PROFILE } from './runner.js';
import { listTargetGroups } from './targets.js';
import { listHostModels } from './models.js';
import { loadDispatchPolicy, nextInboxCandidate, parseDispatchPolicy, saveDispatchPolicy } from './dispatch.js';
import { scoreDispatch } from '../shared/scoring.js';
/** Active app wiring (set once by {@link startHttpServer}). */
let app;
/** Load the server CLI profile (falling back to the default). */
export async function loadProfile() {
    try {
        const raw = JSON.parse(await readFile(defaultProfileFile(), 'utf8'));
        if (typeof raw.command !== 'string' || raw.command === '')
            return { ...DEFAULT_PROFILE };
        return {
            command: raw.command,
            args: typeof raw.args === 'string' ? raw.args : DEFAULT_PROFILE.args,
            ...(typeof raw.timeoutMs === 'number' && raw.timeoutMs > 0 ? { timeoutMs: Math.round(raw.timeoutMs) } : {}),
            model: typeof raw.model === 'string' && raw.model.trim() !== '' ? raw.model.trim() : DEFAULT_PROFILE.model,
            effort: typeof raw.effort === 'string' && raw.effort.trim() !== '' ? raw.effort.trim() : DEFAULT_PROFILE.effort,
        };
    }
    catch {
        return { ...DEFAULT_PROFILE };
    }
}
/** Persist the server CLI profile. */
async function saveProfile(profile) {
    const file = defaultProfileFile();
    await mkdir(join(file, '..'), { recursive: true });
    await writeFile(file, `${JSON.stringify(profile, null, 2)}\n`, 'utf8');
}
/** Validate a create/patch cron value ('' = clear). */
function checkCron(cron) {
    if (cron === undefined)
        return undefined;
    if (typeof cron !== 'string')
        throw new ApiError(400, 'cron must be a string');
    const value = cron.trim();
    if (value !== '' && !isValidCron(value))
        throw new ApiError(400, `invalid cron expression: ${value}`);
    return value;
}
class ApiError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
    }
}
function readBody(request) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        request.on('data', chunk => chunks.push(chunk));
        request.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            if (text === '')
                return resolve(undefined);
            try {
                resolve(JSON.parse(text));
            }
            catch {
                reject(new ApiError(400, 'invalid JSON body'));
            }
        });
        request.on('error', reject);
    });
}
function send(response, status, body) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    response.end(payload === '' ? undefined : payload);
}
/** Summarize a job row for transport (identical to the ledger row here). */
const publicJob = (job) => job;
/** Build and start the loopback HTTP server (random port; host handshake). */
export function startHttpServer(options) {
    app = options;
    const { store, tick } = options;
    // Dev-only CORS for browser harnesses (TIMER_AGENT_DEV_CORS=1).
    const devCors = process.env.TIMER_AGENT_DEV_CORS === '1';
    const server = createServer((request, response) => {
        if (devCors) {
            response.setHeader('access-control-allow-origin', '*');
            response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
            response.setHeader('access-control-allow-headers', 'content-type');
        }
        if (request.method === 'OPTIONS') {
            response.writeHead(204);
            response.end();
            return;
        }
        void handle(request, response).catch(error => {
            const status = error instanceof ApiError ? error.status : 500;
            send(response, status, { error: error instanceof Error ? error.message : String(error) });
        });
    });
    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}
async function handle(request, response) {
    const { store, tick } = app;
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const path = url.pathname;
    const method = request.method ?? 'GET';
    if (method === 'GET' && path === '/health')
        return send(response, 200, { ok: true });
    const jobsMatch = path.match(/^\/v1\/jobs(?:\/([^/]+))?(?:\/actions\/([a-z-]+))?$/);
    if (jobsMatch !== null) {
        const id = decodeURIComponent(jobsMatch[1] ?? '');
        const action = jobsMatch[2];
        if (method === 'GET' && id === '') {
            await tick();
            return send(response, 200, { jobs: (await store.load()).map(publicJob) });
        }
        if (method === 'POST' && id === '' && action === undefined) {
            const body = (await readBody(request));
            return create(response, store, body);
        }
        if (method === 'PATCH' && id !== '' && action === undefined) {
            const body = (await readBody(request));
            return patch(response, store, id, body);
        }
        if (method === 'DELETE' && id !== '' && action === undefined) {
            const removed = await store.mutate(jobs => {
                if (!jobs.some(job => job.id === id))
                    return undefined;
                return { jobs: jobs.filter(job => job.id !== id), result: true };
            });
            // 200+body instead of 204: the host rpc proxy unconditionally calls
            // response.json(), which throws on an empty body.
            if (removed === undefined)
                return send(response, 404, { error: `job not found: ${id}` });
            return send(response, 200, { ok: true });
        }
        if (method === 'POST' && id !== '' && action !== undefined) {
            return runAction(response, store, tick, id, action);
        }
    }
    if (method === 'GET' && path === '/v1/targets') {
        return send(response, 200, { groups: await listTargetGroups() });
    }
    if (method === 'GET' && path === '/v1/models') {
        return send(response, 200, { models: await listHostModels() });
    }
    if (path === '/v1/profile') {
        if (method === 'GET')
            return send(response, 200, { profile: await loadProfile() });
        if (method === 'PUT') {
            const body = (await readBody(request));
            if (typeof body?.command !== 'string' || body.command.trim() === '') {
                throw new ApiError(400, 'profile.command is required');
            }
            const profile = {
                command: body.command.trim(),
                args: typeof body.args === 'string' ? body.args : DEFAULT_PROFILE.args,
                ...(typeof body.timeoutMs === 'number' && body.timeoutMs > 0
                    ? { timeoutMs: Math.round(body.timeoutMs) } : {}),
                model: typeof body.model === 'string' && body.model.trim() !== '' ? body.model.trim() : DEFAULT_PROFILE.model,
                effort: typeof body.effort === 'string' && body.effort.trim() !== '' ? body.effort.trim() : DEFAULT_PROFILE.effort,
            };
            await saveProfile(profile);
            return send(response, 200, { profile });
        }
    }
    if (path === '/v1/dispatch') {
        if (method === 'GET') {
            const policy = await loadDispatchPolicy();
            const jobs = await store.load();
            const running = jobs.filter(job => job.status === 'running').length;
            const next = nextInboxCandidate(jobs, policy, Date.now());
            const nextScore = next === undefined ? undefined : scoreDispatch(next, policy, Date.now());
            return send(response, 200, {
                policy,
                status: {
                    running,
                    queued: jobs.filter(job => job.inbox === true && job.status === 'idle').length,
                    next: next === undefined ? null : {
                        id: next.id,
                        title: next.title,
                        priority: next.priority ?? 3,
                        difficulty: next.difficulty ?? 3,
                        score: Math.round(nextScore),
                        targetProject: next.targetProject,
                    },
                },
            });
        }
        if (method === 'PUT') {
            const body = await readBody(request);
            const policy = parseDispatchPolicy(body);
            await saveDispatchPolicy(policy);
            return send(response, 200, { policy });
        }
    }
    send(response, 404, { error: `no route: ${method} ${path}` });
}
/** Re-anchor a schedule at `now`: an interval grid continues from the last
 *  trigger (stacking whole intervals past the gap); cron follows its grid. */
function reanchorMs(schedule, now) {
    return isIntervalRule(schedule)
        ? intervalNextMs(schedule.lastTriggeredAt, schedule.intervalMinutes, now)
        : scheduleNextMs(schedule, now);
}
async function create(response, store, body) {
    const title = (body?.title ?? '').trim();
    if (title === '')
        throw new ApiError(400, 'title is required');
    const cron = checkCron(body?.cron) ?? '';
    const interval = body?.intervalMinutes !== undefined && body.intervalMinutes > 0
        ? Math.round(body.intervalMinutes)
        : undefined;
    const inbox = body?.inbox === true;
    if (cron === '' && interval === undefined && !inbox)
        throw new ApiError(400, 'cron, intervalMinutes, or inbox is required');
    const kind = body?.kind === 'command' ? 'command' : 'agent';
    if (kind === 'agent' && (body?.prompt ?? '').trim() === '')
        throw new ApiError(400, 'prompt is required for agent jobs');
    if (kind === 'command' && (body?.command ?? '').trim() === '')
        throw new ApiError(400, 'command is required for command jobs');
    const now = Date.now();
    const input = { ...body, kind, cron, title };
    if (!inbox)
        delete input.inbox;
    const job = createJob(input, now, crypto.randomUUID());
    const scheduled = job.schedule !== undefined && job.schedule.enabled
        ? withSchedule(job, {
            nextRunAt: interval !== undefined ? now + interval * 60_000 : nextRunAtMs(job.schedule.cron, now),
        }, now)
        : job;
    await store.mutate(jobs => ({ jobs: [...jobs, scheduled], result: undefined }));
    send(response, 201, { job: publicJob(scheduled) });
}
async function patch(response, store, id, body) {
    if (body === undefined)
        throw new ApiError(400, 'body required');
    const now = Date.now();
    const updated = await store.mutate(jobs => {
        const index = jobs.findIndex(job => job.id === id);
        if (index === -1)
            return undefined;
        let job = jobs[index];
        if (body.skipNext === true) {
            const nextAt = job.schedule?.nextRunAt;
            if (nextAt === undefined)
                throw new ApiError(400, 'job has no upcoming run to skip');
            job = withSchedule(job, { skipNextAt: nextAt }, now);
            return { jobs: jobs.map((item, at) => (at === index ? job : item)), result: job };
        }
        if (typeof body.title === 'string' && body.title.trim() !== '')
            job = { ...job, title: body.title.trim() };
        if (typeof body.description === 'string')
            job = { ...job, description: body.description.trim() };
        if (typeof body.prompt === 'string')
            job = { ...job, prompt: body.prompt.trim() };
        if (typeof body.command === 'string')
            job = { ...job, command: body.command.trim() };
        if (typeof body.args === 'string')
            job = { ...job, args: body.args.trim() };
        if (typeof body.workdir === 'string')
            job = { ...job, workdir: body.workdir.trim() || undefined };
        if (typeof body.tool === 'string') {
            const tool = body.tool.trim() || undefined;
            job = { ...job, tool, ...(tool !== undefined && body.cli === undefined ? { cli: undefined } : {}) };
        }
        if (typeof body.session === 'string')
            job = { ...job, session: body.session.trim() || undefined };
        if (typeof body.timeoutMs === 'number')
            job = { ...job, timeoutMs: body.timeoutMs > 0 ? Math.round(body.timeoutMs) : undefined };
        if (typeof body.model === 'string')
            job = { ...job, model: body.model.trim() || undefined };
        if (typeof body.effort === 'string')
            job = { ...job, effort: body.effort.trim() || undefined };
        if (typeof body.priority === 'number')
            job = { ...job, priority: normalizePriority(body.priority) };
        if (typeof body.difficulty === 'number')
            job = { ...job, difficulty: normalizeDifficulty(body.difficulty) };
        if (typeof body.targetProject === 'string')
            job = { ...job, targetProject: body.targetProject.trim() || undefined };
        if (typeof body.inbox === 'boolean') {
            if (body.inbox)
                job = { ...job, inbox: true };
            else {
                const { inbox: _dropped, ...rest } = job;
                job = rest;
            }
        }
        if (typeof body.intervalMinutes === 'number') {
            // > 0 → fixed-interval mode (cron cleared); <= 0 → back to cron mode.
            job = withSchedule(job, { intervalMinutes: body.intervalMinutes > 0 ? Math.round(body.intervalMinutes) : undefined }, now);
        }
        if (body.kind === 'command' || body.kind === 'agent') {
            if (body.kind === 'command' && (job.command ?? '').trim() === '')
                throw new ApiError(400, 'command is required for command jobs');
            if (body.kind === 'agent' && job.prompt.trim() === '')
                throw new ApiError(400, 'prompt is required for agent jobs');
            job = body.kind === 'command'
                ? { ...job, kind: 'command', session: undefined }
                : { ...job, kind: 'agent', command: undefined, args: undefined };
        }
        if (body.cli !== undefined && typeof body.cli === 'object' && body.cli !== null) {
            const profile = body.cli;
            const command = typeof profile.command === 'string' && profile.command.trim() ? profile.command.trim() : '';
            const args = typeof profile.args === 'string' && profile.args.trim() ? profile.args.trim() : '';
            // An all-empty override clears the field instead of pinning an empty profile.
            job = {
                ...job,
                cli: command === '' && args === ''
                    ? undefined
                    : {
                        ...(command !== '' ? { command } : {}),
                        ...(args !== '' ? { args } : {}),
                    },
            };
        }
        const cron = checkCron(body.cron);
        const intervalPatched = typeof body.intervalMinutes === 'number';
        if (cron !== undefined) {
            // An explicit cron clears interval mode; '' alone clears the cron field.
            job = withSchedule(job, cron !== '' ? { cron, intervalMinutes: undefined } : { cron }, now);
        }
        if (typeof body.enabled === 'boolean') {
            if (job.schedule === undefined && cron === undefined)
                throw new ApiError(400, 'job has no cron schedule');
            job = withSchedule(job, { enabled: body.enabled }, now);
        }
        if (job.schedule?.enabled === true && (cron !== undefined || job.schedule.nextRunAt === undefined)) {
            job = withSchedule(job, { nextRunAt: reanchorMs(job.schedule, now) }, now);
        }
        else if (intervalPatched && job.schedule?.enabled === true &&
            (job.schedule.nextRunAt === undefined || job.schedule.nextRunAt <= now)) {
            // Interval switch: keep a still-future nextRunAt (e.g. a hand-pinned
            // first-run time); otherwise re-anchor on the last trigger.
            job = withSchedule(job, { nextRunAt: reanchorMs(job.schedule, now) }, now);
        }
        job = { ...job, updatedAt: now };
        return { jobs: jobs.map((item, at) => (at === index ? job : item)), result: job };
    });
    if (updated === undefined)
        throw new ApiError(404, `job not found: ${id}`);
    send(response, 200, { job: publicJob(updated) });
}
async function runAction(response, store, tick, id, action) {
    const now = Date.now();
    switch (action) {
        case 'pause':
        case 'resume': {
            const enabled = action === 'resume';
            const updated = await store.mutate(jobs => {
                const index = jobs.findIndex(job => job.id === id);
                if (index === -1)
                    return undefined;
                const job = jobs[index];
                if (job.schedule === undefined)
                    throw new ApiError(400, 'job has no schedule');
                const next = withSchedule(withStatus(job, job.status === 'archived' ? 'idle' : job.status, now), { enabled, ...(enabled ? { nextRunAt: reanchorMs(job.schedule, now) } : {}) }, now);
                return { jobs: jobs.map((item, at) => (at === index ? next : item)), result: next };
            });
            if (updated === undefined)
                throw new ApiError(404, `job not found: ${id}`);
            return send(response, 200, { job: publicJob(updated) });
        }
        case 'archive':
        case 'restart': {
            const status = action === 'archive' ? 'archived' : 'idle';
            const updated = await store.mutate(jobs => {
                const index = jobs.findIndex(job => job.id === id);
                if (index === -1)
                    return undefined;
                const next = withStatus(jobs[index], status, now);
                return { jobs: jobs.map((item, at) => (at === index ? next : item)), result: next };
            });
            if (updated === undefined)
                throw new ApiError(404, `job not found: ${id}`);
            return send(response, 200, { job: publicJob(updated) });
        }
        case 'run-now': {
            const stamped = await store.mutate(jobs => {
                const index = jobs.findIndex(job => job.id === id);
                if (index === -1)
                    return undefined;
                const job = jobs[index];
                if (job.status === 'archived')
                    throw new ApiError(400, 'job is archived; restart it first');
                if (job.kind !== 'command' && job.prompt.trim() === '')
                    throw new ApiError(400, 'job has no prompt');
                return { jobs: jobs.map((item, at) => (at === index ? { ...job, runRequestedAt: now, updatedAt: now } : item)), result: true };
            });
            if (stamped === undefined)
                throw new ApiError(404, `job not found: ${id}`);
            // The ticker picks the stamp up within one interval; nudge it now.
            await tick();
            return send(response, 202, { ok: true });
        }
        default:
            throw new ApiError(400, `unknown action: ${action}`);
    }
}
/** Kind guard re-export so routes stay honest about defaults. */
export const resolveKind = jobKind;
//# sourceMappingURL=http.js.map
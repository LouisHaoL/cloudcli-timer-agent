/** Thin typed wrapper over the host's rpc proxy (server HTTP routes). */
import type { PluginAPI } from '../types.js'
import type { JobRecord, NewJobInput } from '../shared/jobs.js'
import type { ServerProfile } from '../server/runner.js'
import type { TargetGroupRow } from '../server/targets.js'
import type { HostModels } from '../server/models.js'
import type { DispatchPolicy } from '../shared/scoring.js'

/** Dispatch status summary returned by GET /v1/dispatch. */
export interface DispatchStatus {
  running: number
  queued: number
  next: null | {
    id: string
    title: string
    priority: number
    difficulty: number
    score: number
    targetProject?: string
  }
}

export interface JobsApi {
  list(): Promise<JobRecord[]>
  targets(): Promise<TargetGroupRow[]>
  models(): Promise<HostModels>
  create(input: Partial<NewJobInput>): Promise<JobRecord>
  patch(id: string, body: Record<string, unknown>): Promise<JobRecord>
  remove(id: string): Promise<void>
  action(id: string, action: 'pause' | 'resume' | 'run-now' | 'archive' | 'restart'): Promise<JobRecord | { ok: true }>
  profile(): Promise<ServerProfile>
  setProfile(profile: Partial<ServerProfile>): Promise<ServerProfile>
  dispatch(): Promise<{ policy: DispatchPolicy; status: DispatchStatus }>
  setDispatch(policy: Partial<DispatchPolicy>): Promise<DispatchPolicy>
}

export function createApi(api: PluginAPI): JobsApi {
  const call = api.rpc.bind(api)
  return {
    list: () => call<{ jobs: JobRecord[] }>('GET', '/v1/jobs').then(body => body.jobs),
    targets: () => call<{ groups: TargetGroupRow[] }>('GET', '/v1/targets').then(body => body.groups),
    models: () => call<{ models: HostModels }>('GET', '/v1/models').then(body => body.models),
    create: input => call<{ job: JobRecord }>('POST', '/v1/jobs', input).then(body => body.job),
    patch: (id, body) => call<{ job: JobRecord }>('PATCH', `/v1/jobs/${encodeURIComponent(id)}`, body).then(body => body.job),
    remove: id => call<void>('DELETE', `/v1/jobs/${encodeURIComponent(id)}`),
    action: (id, action) =>
      action === 'run-now'
        ? call<{ ok: true }>('POST', `/v1/jobs/${encodeURIComponent(id)}/actions/run-now`)
        : call<{ job: JobRecord }>('POST', `/v1/jobs/${encodeURIComponent(id)}/actions/${action}`).then(body => body.job),
    profile: () => call<{ profile: ServerProfile }>('GET', '/v1/profile').then(body => body.profile),
    setProfile: profile => call<{ profile: ServerProfile }>('PUT', '/v1/profile', profile).then(body => body.profile),
    dispatch: () => call<{ policy: DispatchPolicy; status: DispatchStatus }>('GET', '/v1/dispatch'),
    setDispatch: policy => call<{ policy: DispatchPolicy }>('PUT', '/v1/dispatch', policy).then(body => body.policy),
  }
}

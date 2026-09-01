/**
 * The「定时任务」tab board (vanilla DOM, no framework — matches the host's
 * zero-dependency plugin model). Ported from dsh-timer-agent's web panel:
 * job list + create/edit form with cron presets + detail view with execution
 * history, skip-once and run-now.
 */
import type { PluginAPI } from '../types.js'
import type { ExecutionRecord, JobRecord, NewJobInput } from '../shared/jobs.js'
import { commandLine, jobKind } from '../shared/jobs.js'
import { isValidCron, scheduleNextMs } from '../shared/schedule.js'
import type { TargetGroupRow } from '../server/targets.js'
import type { JobsApi } from './api.js'
import { createApi } from './api.js'

/** Cron presets the create/edit form offers (each generates an expression). */
const CRON_PRESETS: Array<{ label: string; cron: string }> = [
  { label: '每天 09:00', cron: '0 9 * * *' },
  { label: '每小时整点', cron: '0 * * * *' },
  { label: '每 10 分钟', cron: '*/10 * * * *' },
  { label: '每周一 09:00', cron: '0 9 * * 1' },
  { label: '工作日 09:00', cron: '0 9 * * 1-5' },
  { label: '每月 1 日 10:00', cron: '0 10 1 * *' },
]

const STATUS_LABEL: Record<JobRecord['status'], string> = {
  idle: '空闲', running: '运行中', done: '已完成', failed: '失败', archived: '已归档',
}
const STATUS_CLASS: Record<JobRecord['status'], string> = {
  idle: 'idle', running: 'running', done: 'done', failed: 'failed', archived: 'archived',
}
const RESULT_LABEL: Record<NonNullable<ExecutionRecord['result']>, string> = {
  succeeded: '成功', failed: '失败', cancelled: '取消',
}
const TRIGGER_LABEL: Record<ExecutionRecord['trigger'], string> = {
  scheduled: '定时', manual: '手动', retry: '重试',
}

function formatTime(ms: number | undefined): string {
  if (ms === undefined) return '—'
  return new Date(ms).toLocaleString()
}

/** Last non-empty path segment (both separators), for short labels. */
function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** Schedule display label: cron expression, or a prettified fixed interval. */
function scheduleLabel(schedule: JobRecord['schedule']): string {
  if (schedule === undefined) return '—'
  const minutes = schedule.intervalMinutes
  if (minutes !== undefined && minutes > 0) {
    if (minutes % 1440 === 0) return `每 ${minutes / 1440} 天`
    if (minutes % 60 === 0) return `每 ${minutes / 60} 小时`
    return `每 ${minutes} 分钟`
  }
  return schedule.cron
}

/** True when the schedule runs on a fixed interval instead of cron. */
function isInterval(schedule: JobRecord['schedule']): boolean {
  return schedule !== undefined && schedule.intervalMinutes !== undefined && schedule.intervalMinutes > 0
}

export class TimerAgentApp {
  private readonly api: JobsApi
  private readonly host: PluginAPI
  private jobs: JobRecord[] = []
  private targets: TargetGroupRow[] = []
  private query = ''
  private statusFilter: 'all' | JobRecord['status'] = 'all'
  private selectedId: string | undefined
  private editing: JobRecord | 'new' | undefined
  /** Form-local kind override (the select must work before anything is saved). */
  private formKind: 'agent' | 'command' | undefined
  /** Text-field values preserved across the kind-toggle re-render. */
  private formDraft: Record<string, string> | undefined
  private pollTimer: number | undefined

  constructor(
    private readonly container: HTMLElement,
    api: PluginAPI,
  ) {
    this.host = api
    this.api = createApi(api)
  }

  async start(): Promise<void> {
    await this.refresh()
    this.pollTimer = window.setInterval(() => {
      void this.refresh()
    }, 10_000)
    this.render()
  }

  stop(): void {
    if (this.pollTimer !== undefined) window.clearInterval(this.pollTimer)
  }

  private async refresh(): Promise<void> {
    try {
      this.jobs = await this.api.list()
    } catch (error) {
      this.jobs = []
      this.container.innerHTML = `<div class="ta-error">调度服务不可达:${escapeHtml(String(error))}</div>`
      return
    }
    // Never re-render under an open form: the 10s poll would wipe typed input.
    if (this.editing === undefined && this.container.dataset.view !== 'none') this.render()
  }

  private render(): void {
    this.container.dataset.view = 'rendered'
    if (this.editing !== undefined) this.renderForm()
    else if (this.selectedId !== undefined) this.renderDetail(this.selectedId)
    else this.renderList()
  }

  /* ---------------- list ---------------- */

  private renderList(): void {
    const query = this.query.trim().toLowerCase()
    const visible = this.jobs
      .filter(job => this.statusFilter === 'all' || job.status === this.statusFilter)
      .filter(job => query === '' ||
        `${job.title} ${job.description} ${commandLine(job)}`.toLowerCase().includes(query))
    const rows = visible.map(job => {
      const kind = jobKind(job)
      const schedule = job.schedule
      return `<tr data-id="${job.id}">
        <td><span class="ta-kind ta-kind-${kind}">${kind === 'command' ? '命令' : 'Agent'}</span>
            <strong>${escapeHtml(job.title)}</strong></td>
        <td><span class="ta-status ta-status-${STATUS_CLASS[job.status]}">${STATUS_LABEL[job.status]}</span></td>
        <td><code>${escapeHtml(scheduleLabel(schedule))}</code>${schedule && !schedule.enabled ? ' <span class="ta-muted">(暂停)</span>' : ''}</td>
        <td>${formatTime(schedule?.nextRunAt)}</td>
        <td class="ta-actions">
          <button class="ta-btn" data-act="run">立即执行</button>
          ${schedule ? `<button class="ta-btn" data-act="${schedule.enabled ? 'pause' : 'resume'}">${schedule.enabled ? '暂停' : '恢复'}</button>` : ''}
          <button class="ta-btn" data-act="edit">编辑</button>
          <button class="ta-btn" data-act="detail">详情</button>
          <button class="ta-btn ta-danger" data-act="delete">删除</button>
        </td>
      </tr>`
    }).join('')
    const filterOptions = Object.entries(STATUS_LABEL)
      .map(([value, label]) => `<option value="${value}" ${this.statusFilter === value ? 'selected' : ''}>${label}</option>`)
      .join('')
    this.container.innerHTML = `
      <div class="ta-header">
        <h2>定时任务</h2>
        <select class="ta-status-filter" title="按状态筛选">
          <option value="all" ${this.statusFilter === 'all' ? 'selected' : ''}>全部状态</option>
          ${filterOptions}
        </select>
        <input class="ta-search" type="search" placeholder="搜索任务…" value="${escapeHtml(this.query)}">
        <button class="ta-btn ta-primary" data-act="new">＋ 新建任务</button>
      </div>
      <table class="ta-table">
        <thead><tr><th>任务</th><th>状态</th><th>调度</th><th>下次运行</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="ta-muted">暂无任务</td></tr>'}</tbody>
      </table>`
    this.bindListEvents()
  }

  private bindListEvents(): void {
    this.container.querySelector<HTMLSelectElement>('.ta-status-filter')?.addEventListener('change', event => {
      this.statusFilter = (event.target as HTMLSelectElement).value as typeof this.statusFilter
      this.renderList()
    })
    const search = this.container.querySelector<HTMLInputElement>('.ta-search')
    search?.addEventListener('input', () => {
      this.query = search.value
      this.renderList()
      this.container.querySelector<HTMLInputElement>('.ta-search')?.focus()
    })
    this.container.querySelector('[data-act="new"]')?.addEventListener('click', () => {
      void this.listAction('', 'new')
    })
    for (const row of Array.from(this.container.querySelectorAll('tr[data-id]'))) {
      const id = (row as HTMLElement).dataset.id!
      for (const button of Array.from(row.querySelectorAll('button[data-act]'))) {
        button.addEventListener('click', event => {
          event.stopPropagation()
          void this.listAction(id, (button as HTMLElement).dataset.act!)
        })
      }
    }
  }

  private async listAction(id: string, act: string): Promise<void> {
    try {
      if (act === 'new' || act === 'edit') {
        await this.loadTargets()
        this.formKind = undefined
        this.formDraft = undefined
        this.editing = act === 'new' ? 'new' : this.jobs.find(job => job.id === id) ?? undefined
      }
      else if (act === 'detail') this.selectedId = id
      else if (act === 'run') await this.api.action(id, 'run-now')
      else if (act === 'skip') await this.api.patch(id, { skipNext: true })
      else if (act === 'pause') await this.api.action(id, 'pause')
      else if (act === 'resume') await this.api.action(id, 'resume')
      else if (act === 'delete') {
        if (!window.confirm('确定删除该任务?')) return
        await this.api.remove(id)
      }
      await this.refresh()
      this.render()
    } catch (error) {
      window.alert(String(error))
    }
  }

  /* ---------------- create / edit form ---------------- */

  /** Fetch workspace/session groups (degrading to the last good set). */
  private async loadTargets(): Promise<TargetGroupRow[]> {
    try {
      this.targets = await this.api.targets()
    } catch {
      // keep the previous list
    }
    return this.targets
  }

  /** Normalize a path for group matching (same rules as the server). */
  private static normPath(path: string): string {
    let p = path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
    if (p.length >= 2 && p[1] === ':') p = p[0]!.toUpperCase() + p.slice(1)
    return p
  }

  /** Workspace options: 默认 / 当前项目 / scanned groups / 手动. */
  private workspaceOptions(job: JobRecord | undefined): string {
    const project = this.host.context.project
    const jobDir = job?.workdir ?? ''
    const groups: TargetGroupRow[] = [...this.targets]
    if (project !== null && !groups.some(group => TimerAgentApp.normPath(group.workdir) === TimerAgentApp.normPath(project.path))) {
      groups.unshift({ name: `${project.name}(当前)`, workdir: project.path, sessions: [] })
    }
    const matched = jobDir !== '' &&
      groups.some(group => TimerAgentApp.normPath(group.workdir) === TimerAgentApp.normPath(jobDir))
    const rows = [`<option value="">默认(不指定工作目录)</option>`]
    for (const [index, group] of groups.entries()) {
      const selected = jobDir !== '' && TimerAgentApp.normPath(group.workdir) === TimerAgentApp.normPath(jobDir)
      rows.push(`<option value="g${index}" data-workdir="${escapeHtml(group.workdir)}" ${selected ? 'selected' : ''}>${escapeHtml(group.name)}</option>`)
    }
    if (jobDir !== '' && !matched) {
      rows.push(`<option value="g-custom" data-workdir="${escapeHtml(jobDir)}" selected>${escapeHtml(pathBasename(jobDir))}(手动)</option>`)
    }
    rows.push(`<option value="custom">其他(手动输入路径)…</option>`)
    return rows.join('')
  }

  /** Session options for one workdir: 新会话打开 first, pinned sessions after. */
  private sessionOptions(workdir: string, job: JobRecord | undefined): string {
    const key = workdir === '' ? '' : TimerAgentApp.normPath(workdir)
    const project = this.host.context.project
    const group = this.targets.find(candidate =>
      TimerAgentApp.normPath(candidate.workdir) === key) ??
      (project !== null && key !== '' && TimerAgentApp.normPath(project.path) === key
        ? { name: project.name, workdir: project.path, sessions: [] }
        : undefined)
    const pinned = job?.session ?? ''
    const rows = [`<option value="">新会话打开</option>`]
    for (const session of group?.sessions ?? []) {
      const selected = pinned !== '' && session.id === pinned ? ' selected' : ''
      rows.push(`<option value="${escapeHtml(session.id)}" title="${escapeHtml(session.id)}"${selected}>${escapeHtml(session.title)}(${formatTime(session.updatedAt)})</option>`)
    }
    if (pinned !== '' && !(group?.sessions ?? []).some(session => session.id === pinned)) {
      rows.push(`<option value="${escapeHtml(pinned)}" selected title="${escapeHtml(pinned)}">当前会话:${escapeHtml(pinned)}</option>`)
    }
    return rows.join('')
  }

  private renderForm(): void {
    const job = this.editing === 'new' ? undefined : this.editing
    const kind = this.formKind ?? (job ? jobKind(job) : 'agent')
    const draft = this.formDraft
    const val = (name: string, fallback: string): string => draft?.[name] ?? fallback
    const cron = val('cron', job?.schedule?.cron ?? '')
    // 调度开关 + 固定间隔的数值/单位(单位随 kind 切换的草稿一起保留)。
    const schedEnabled = draft !== undefined ? draft.enabled === 'on' : job?.schedule?.enabled !== false
    const iv = job?.schedule?.intervalMinutes
    const intervalUnit = val('intervalUnit', iv === undefined ? '1' : iv % 1440 === 0 ? '1440' : iv % 60 === 0 ? '60' : '1')
    const intervalValue = val('intervalMin', iv === undefined ? ''
      : String(intervalUnit === '1440' ? iv / 1440 : intervalUnit === '60' ? iv / 60 : iv))
    const presetOptions = CRON_PRESETS.map(preset =>
      `<option value="${preset.cron}" ${preset.cron === cron ? 'selected' : ''}>${preset.label}</option>`).join('')
    this.container.innerHTML = `
      <div class="ta-header"><h2>${job ? '编辑任务' : '新建任务'}</h2>
        <button class="ta-btn" data-act="cancel">返回</button></div>
      <form class="ta-form">
        <label>标题<input name="title" required value="${escapeHtml(val('title', job?.title ?? ''))}"></label>
        <label>类型<select name="kind">
          <option value="agent" ${kind === 'agent' ? 'selected' : ''}>AI Agent 任务(执行 prompt)</option>
          <option value="command" ${kind === 'command' ? 'selected' : ''}>普通任务(直接运行命令)</option>
        </select></label>
        <label class="ta-field-prompt" ${kind === 'command' ? 'hidden' : ''}>Prompt(无人在场,必须自包含)<textarea name="prompt" rows="5">${escapeHtml(val('prompt', job?.prompt ?? ''))}</textarea></label>
        <div class="ta-field-command" ${kind === 'command' ? '' : 'hidden'}>
          <label>命令(建议绝对路径)<input name="command" value="${escapeHtml(val('command', job?.command ?? ''))}"></label>
          <label>参数(支持引号)<input name="args" value="${escapeHtml(val('args', job?.args ?? ''))}"></label>
        </div>
        <label>描述<input name="description" value="${escapeHtml(val('description', job?.description ?? ''))}"></label>
        <div class="ta-field-target" ${kind === 'command' ? 'hidden' : ''}>
          <label>工作空间<select name="targetWs">${this.workspaceOptions(job)}</select></label>
          <label>会话<select name="targetSession">${this.sessionOptions(job?.workdir ?? '', job)}</select></label>
          <label class="ta-field-custom-ws" hidden>工作目录<input name="customWorkdir" value="${escapeHtml(val('customWorkdir', ''))}"></label>
        </div>
        <label class="ta-field-workdir" ${kind === 'agent' ? 'hidden' : ''}>工作目录(留空 = 服务默认)<input name="workdir" value="${escapeHtml(val('workdir', job?.workdir ?? ''))}"></label>
        <div class="ta-field-model" ${kind === 'agent' ? '' : 'hidden'}>
          <label>模型(留空 = 默认 glm-5.3-flash)<input name="model" value="${escapeHtml(val('model', job?.model ?? ''))}" placeholder="glm-5.3-flash"></label>
          <label>思考等级(留空 = 默认 medium)<input name="effort" value="${escapeHtml(val('effort', job?.effort ?? ''))}" placeholder="medium"></label>
        </div>
        <label class="ta-inline"><input name="enabled" type="checkbox" ${schedEnabled ? 'checked' : ''}> 启用调度(关闭后任务只保留手动执行)</label>
        <div class="ta-field-sched${schedEnabled ? '' : ' ta-disabled'}">
          <label>调度(cron 预设)<select name="preset">
            <option value="">— 自定义 —</option>${presetOptions}</select></label>
          <label>5 段 cron(分 时 日 月 周)<input name="cron" value="${escapeHtml(cron)}" placeholder="0 9 * * *"></label>
          <label>固定间隔(填了则优先于 cron)
            <span class="ta-interval-row">
              <input name="intervalMin" type="number" min="0" step="1" value="${escapeHtml(intervalValue)}" placeholder="如 302">
              <select name="intervalUnit" title="时间单位">
                <option value="1" ${intervalUnit === '1' ? 'selected' : ''}>分钟</option>
                <option value="60" ${intervalUnit === '60' ? 'selected' : ''}>小时</option>
                <option value="1440" ${intervalUnit === '1440' ? 'selected' : ''}>天</option>
              </select>
            </span>
          </label>
        </div>
        <label>超时(分钟,留空 = 默认 10)<input name="timeoutMin" type="number" min="0" step="1"
          value="${val('timeoutMin', job?.timeoutMs ? String(Math.round(job.timeoutMs / 60_000)) : '')}"></label>
        <div class="ta-form-actions">
          <button class="ta-btn ta-primary" type="submit">保存</button>
        </div>
      </form>`
    const form = this.container.querySelector<HTMLFormElement>('.ta-form')!
    // 启用调度开关:未勾选时把整块定时设置置灰(仅视觉,不动值,保存仍带上)。
    const schedBox = this.container.querySelector<HTMLElement>('.ta-field-sched')
    const enabledBox = form.querySelector<HTMLInputElement>('[name="enabled"]')
    if (schedBox !== null && enabledBox !== null) {
      const syncSched = (): void => { schedBox.classList.toggle('ta-disabled', !enabledBox.checked) }
      enabledBox.addEventListener('change', syncSched)
    }
    form.querySelector('[name="kind"]')!.addEventListener('change', event => {
      // Keep everything already typed; only the visible field set changes.
      const data = new FormData(form)
      const preserve = ['title', 'description', 'prompt', 'command', 'args', 'workdir', 'customWorkdir', 'cron', 'intervalMin', 'intervalUnit', 'timeoutMin', 'model', 'effort', 'enabled']
      this.formDraft = Object.fromEntries(preserve.map(name => [name, String(data.get(name) ?? '')]))
      this.formKind = (event.target as HTMLSelectElement).value === 'command' ? 'command' : 'agent'
      this.renderForm()
    })
    form.querySelector('[name="preset"]')!.addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value
      if (value !== '') {
        const cronInput = form.querySelector<HTMLInputElement>('[name="cron"]')!
        cronInput.value = value
      }
    })
    // Workspace pick drives the session list (and the manual-path input).
    form.querySelector('[name="targetWs"]')?.addEventListener('change', event => {
      const select = event.target as HTMLSelectElement
      const workdir = select.value === '' || select.value === 'custom'
        ? ''
        : select.selectedOptions[0]?.dataset.workdir ?? ''
      const sessionSelect = form.querySelector<HTMLSelectElement>('[name="targetSession"]')
      if (sessionSelect !== null) sessionSelect.innerHTML = this.sessionOptions(workdir, job)
      const custom = form.querySelector<HTMLElement>('.ta-field-custom-ws')
      if (custom !== null) custom.hidden = select.value !== 'custom'
    })
    form.addEventListener('submit', event => {
      event.preventDefault()
      void this.submitForm(new FormData(form), job?.id)
    })
    this.container.querySelector('[data-act="cancel"]')?.addEventListener('click', () => {
      this.editing = undefined
      this.formKind = undefined
      this.formDraft = undefined
      this.render()
    })
  }

  private async submitForm(data: FormData, id: string | undefined): Promise<void> {
    const kind = data.get('kind') === 'command' ? 'command' : 'agent'
    const cron = String(data.get('cron') ?? '').trim()
    const enabled = data.get('enabled') === 'on'
    const intervalMin = Number(data.get('intervalMin'))
    const unitMin = Number(data.get('intervalUnit') ?? 1) || 1
    const intervalMinutes = Number.isFinite(intervalMin) && intervalMin > 0 && unitMin > 0
      ? Math.round(intervalMin * unitMin)
      : undefined
    if (intervalMinutes === undefined && !isValidCron(cron)) {
      window.alert('需要填写有效的 cron 表达式,或固定间隔数值')
      return
    }
    const timeoutMin = Number(data.get('timeoutMin'))
    // Agent jobs: workdir/session come from the pickers; commands keep the text input.
    let workdir = String(data.get('workdir') ?? '')
    let session = ''
    if (kind === 'agent') {
      const select = this.container.querySelector<HTMLSelectElement>('[name="targetWs"]')
      const value = select?.value ?? ''
      workdir = value === ''
        ? ''
        : value === 'custom'
          ? String(data.get('customWorkdir') ?? '')
          : select?.selectedOptions[0]?.dataset.workdir ?? ''
      session = String(data.get('targetSession') ?? '')
    }
    const body: Partial<NewJobInput> & { enabled?: boolean } = {
      title: String(data.get('title') ?? ''),
      description: String(data.get('description') ?? ''),
      kind,
      workdir,
      cron: intervalMinutes !== undefined ? '' : cron,
      enabled,
      ...(kind === 'agent' ? {
        prompt: String(data.get('prompt') ?? ''),
        session,
        model: String(data.get('model') ?? '').trim(),
        effort: String(data.get('effort') ?? '').trim(),
      } : {}),
      ...(kind === 'command' ? { command: String(data.get('command') ?? ''), args: String(data.get('args') ?? '') } : {}),
      ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
      ...(Number.isFinite(timeoutMin) && timeoutMin > 0 ? { timeoutMs: Math.round(timeoutMin * 60_000) } : {}),
    }
    try {
      if (id === undefined) await this.api.create(body)
      else await this.api.patch(id, body as Record<string, unknown>)
      this.editing = undefined
      this.formKind = undefined
      this.formDraft = undefined
      await this.refresh()
      this.render()
    } catch (error) {
      window.alert(String(error))
    }
  }

  /* ---------------- detail ---------------- */

  private renderDetail(id: string): void {
    const job = this.jobs.find(item => item.id === id)
    if (job === undefined) {
      this.selectedId = undefined
      this.renderList()
      return
    }
    const schedule = job.schedule
    const kind = jobKind(job)
    const executions = [...job.executions].reverse()
      .map(execution => this.executionRow(job.id, execution)).join('')
    this.container.innerHTML = `
      <div class="ta-header"><h2>${escapeHtml(job.title)}</h2>
        <button class="ta-btn" data-act="back">返回列表</button></div>
      <div class="ta-detail">
        <p class="ta-muted">${escapeHtml(job.description || commandLine(job) || job.prompt.slice(0, 120))}</p>
        <div class="ta-meta">
          <span class="ta-status ta-status-${STATUS_CLASS[job.status]}">${STATUS_LABEL[job.status]}</span>
          ${schedule ? `<code>${escapeHtml(scheduleLabel(schedule))}</code>${isInterval(schedule) ? ' <span class="ta-muted">(固定间隔)</span>' : ''}${schedule.enabled ? '' : ' (暂停)'}
            ${schedule.lastTriggeredAt !== undefined ? `<span class="ta-muted">上次:</span>${formatTime(schedule.lastTriggeredAt)} · ` : ''}下次:<strong>${formatTime(schedule.nextRunAt)}</strong>` : '未配置调度'}
          ${job.workdir ? ` · 目录:<code>${escapeHtml(job.workdir)}</code>` : ''}
          ${job.session ? ` · 会话:<code>${escapeHtml(job.session)}</code>` : ''}
          ${kind === 'agent' ? ` · 模型:<code>${escapeHtml(job.model || 'glm-5.3-flash(默认)')}</code>/<code>${escapeHtml(job.effort || 'medium(默认)')}</code>` : ''}
        </div>
        <div class="ta-actions ta-row">
          <button class="ta-btn ta-primary" data-act="run">立即执行</button>
          <button class="ta-btn" data-act="edit">编辑</button>
          ${schedule && schedule.nextRunAt !== undefined
            ? `<button class="ta-btn" data-act="skip" title="跳过这一次,下次运行改为 ${formatTime(scheduleNextMs(schedule, schedule.nextRunAt) ?? undefined)}">跳过一次</button>` : ''}
          ${schedule ? `<button class="ta-btn" data-act="${schedule.enabled ? 'pause' : 'resume'}">${schedule.enabled ? '暂停调度' : '恢复调度'}</button>` : ''}
          <button class="ta-btn" data-act="${job.status === 'archived' ? 'restart' : 'archive'}">${job.status === 'archived' ? '恢复归档' : '归档'}</button>
          <button class="ta-btn ta-danger" data-act="delete">删除</button>
        </div>
        <h3>执行历史</h3>
        <table class="ta-table"><thead><tr><th>开始</th><th>触发</th><th>结果</th><th>耗时</th><th>输出</th></tr></thead>
          <tbody>${executions || '<tr><td colspan="5" class="ta-muted">尚未执行</td></tr>'}</tbody></table>
      </div>`
    this.container.querySelector('[data-act="back"]')?.addEventListener('click', () => {
      this.selectedId = undefined
      this.render()
    })
    for (const button of Array.from(this.container.querySelectorAll('.ta-actions button[data-act]'))) {
      button.addEventListener('click', () => void this.listAction(id, (button as HTMLElement).dataset.act!))
    }
    for (const button of Array.from(this.container.querySelectorAll('button[data-run-id]'))) {
      button.addEventListener('click', () => {
        const output = button.getAttribute('data-output') ?? ''
        window.alert(output === '' ? '(无输出)' : output)
      })
    }
  }

  private executionRow(jobId: string, execution: ExecutionRecord): string {
    const duration = execution.endedAt === undefined ? '…'
      : `${Math.max(1, Math.round((execution.endedAt - execution.startedAt) / 1000))}s`
    const label = execution.result === undefined ? '运行中' : RESULT_LABEL[execution.result]
    const cls = execution.result === undefined ? 'running' : execution.result
    return `<tr data-id="${jobId}">
      <td>${formatTime(execution.startedAt)}</td>
      <td>${TRIGGER_LABEL[execution.trigger]}</td>
      <td><span class="ta-status ta-status-${cls}">${label}</span>${execution.error ? ` <span class="ta-muted">${escapeHtml(execution.error.slice(0, 80))}</span>` : ''}</td>
      <td>${duration}</td>
      <td>${execution.output ? `<button class="ta-btn" data-run-id="${execution.id}" data-output="${escapeHtml(execution.output)}">查看</button>` : '—'}</td>
    </tr>`
  }
}

/**
 * The「定时任务」tab board (vanilla DOM, no framework — matches the host's
 * zero-dependency plugin model). Ported from dsh-timer-agent's web panel:
 * job list + create/edit form with cron presets + detail view with execution
 * history, skip-once and run-now.
 */
import type { PluginAPI } from '../types.js'
import type { ExecutionRecord, JobRecord, NewJobInput } from '../shared/jobs.js'
import { commandLine, jobKind } from '../shared/jobs.js'
import { AGENT_TOOLS, resolveAgentTool } from '../shared/agents.js'
import { isIntervalRule, isOneShotRule, isValidCron, scheduleNextMs } from '../shared/schedule.js'
import type { TargetGroupRow } from '../server/targets.js'
import type { HostModelOption, HostModels } from '../server/models.js'
import type { DispatchPolicy } from '../shared/scoring.js'
import type { DispatchStatus, JobsApi } from './api.js'
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
  scheduled: '定时', manual: '手动', dispatch: '派发', retry: '重试',
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

/** One filterable combobox row (CloudUI-style picker: menu + free input). */
interface ComboOption {
  value: string
  label: string
  /** Secondary text shown on the right (time / tool badge). */
  hint?: string
  /** Group header this row renders under (tool label, …). */
  group?: string
}

/** Local `datetime-local` input value for `date`, at minute precision. */
function localInputValue(date: Date): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** Schedule display label: cron expression, a prettified fixed interval, or the one-shot instant. */
function scheduleLabel(schedule: JobRecord['schedule']): string {
  if (schedule === undefined) return '—'
  // One-shot: the persisted nextRunAt is the whole schedule — show it inline.
  if (isOneShotRule(schedule)) {
    return schedule.nextRunAt !== undefined
      ? `一次性 · ${new Date(schedule.nextRunAt).toLocaleString()}`
      : '一次性'
  }
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

/** True when the rule is a one-shot (no cron, no interval — see isOneShotRule). */
function isOnce(schedule: JobRecord['schedule']): boolean {
  return isOneShotRule(schedule)
}

export class TimerAgentApp {
  private readonly api: JobsApi
  private readonly host: PluginAPI
  private jobs: JobRecord[] = []
  private targets: TargetGroupRow[] = []
  private toolModels: HostModels | undefined
  private dispatch: { policy: DispatchPolicy; status: DispatchStatus } | undefined
  private query = ''
  private statusFilter: 'all' | JobRecord['status'] = 'all'
  private selectedId: string | undefined
  private editing: JobRecord | 'new' | undefined
  /** Form-local kind override (the select must work before anything is saved). */
  private formKind: 'agent' | 'command' | undefined
  /** Text-field values preserved across the kind-toggle re-render. */
  private formDraft: Record<string, string> | undefined

  /** Snapshot the fields that must survive a form re-render. */
  private captureFormDraft(form: HTMLFormElement): Record<string, string> {
    const data = new FormData(form)
    const preserve = ['title', 'description', 'prompt', 'command', 'args', 'workdir', 'customWorkdir', 'cron', 'intervalMin', 'intervalUnit', 'scheduleMode', 'onceValue', 'timeoutMin', 'model', 'effort', 'tool', 'cliCommand', 'cliArgs', 'enabled', 'inbox', 'priority', 'difficulty', 'targetWs2', 'targetProject']
    return Object.fromEntries(preserve.map(name => [name, String(data.get(name) ?? '')]))
  }
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
      const [jobs, dispatch] = await Promise.all([this.api.list(), this.api.dispatch()])
      this.jobs = jobs
      this.dispatch = dispatch
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
            ${job.inbox ? `<span class="ta-kind ta-kind-inbox">收件箱</span><span class="ta-muted">P${escapeHtml(String(job.priority ?? 3))}·D${escapeHtml(String(job.difficulty ?? 3))}</span>` : ''}
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
    const dispatch = this.dispatch
    this.container.innerHTML = `
      ${dispatch ? `<div class="ta-dispatch">
        <span class="ta-dispatch-title">自动派发</span>
        <span class="ta-status ${dispatch.policy.enabled ? 'ta-status-running' : 'ta-status-idle'}">${dispatch.policy.enabled ? '已开启' : '已暂停'}</span>
        <span class="ta-muted">运行中 ${dispatch.status.running} · 队列 ${dispatch.status.queued}</span>
        ${dispatch.status.next === null ? '' : `<span class="ta-muted">下一个:${escapeHtml(dispatch.status.next.title)}(${dispatch.status.next.score}分)</span>`}
      </div>` : ''}
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

  private async listAction(id: string, act: string, nextRunAt?: number): Promise<void> {
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
      else if (act === 'save-next') await this.api.patch(id, { nextRunAt })
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

  /** Fetch workspace/session groups + host model lists (degrading to the last good set). */
  private async loadTargets(): Promise<TargetGroupRow[]> {
    try {
      this.targets = await this.api.targets()
    } catch {
      // keep the previous list
    }
    try {
      this.toolModels = await this.api.models()
    } catch {
      // keep the previous list (undefined → picker uses the built-in catalog)
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

  /** Session options for one workdir: newest first, searchable via the combo. */
  private sessionOptions(workdir: string, job: JobRecord | undefined): ComboOption[] {
    const key = workdir === '' ? '' : TimerAgentApp.normPath(workdir)
    const project = this.host.context.project
    const group = this.targets.find(candidate =>
      TimerAgentApp.normPath(candidate.workdir) === key) ??
      (project !== null && key !== '' && TimerAgentApp.normPath(project.path) === key
        ? { name: project.name, workdir: project.path, sessions: [] }
        : undefined)
    const pinned = job?.session ?? ''
    const rows: ComboOption[] = (group?.sessions ?? []).map(session => ({
      value: session.id,
      label: session.title,
      hint: formatTime(session.updatedAt),
    }))
    if (pinned !== '' && !rows.some(row => row.value === pinned)) {
      rows.push({ value: pinned, label: `当前会话:${pinned}` })
    }
    return rows
  }

  /**
   * Model options: the host's predefined lists (same source the host's own
   * selector renders; the default is badged), falling back to the built-in
   * catalog per tool. Grouped by tool so a pick links the tool select.
   */
  private modelOptions(): ComboOption[] {
    return AGENT_TOOLS.flatMap(tool => {
      const entry = this.toolModels?.[tool.id]
      const options: HostModelOption[] = entry?.options ?? tool.models.map(model => ({ value: model, label: model }))
      return options.map(option => ({
        value: option.value,
        label: option.label,
        hint: `${tool.label}${option.value === entry?.default ? ' · 默认' : ''}${option.custom === true ? ' · 自定义' : ''}`,
        group: tool.id,
      }))
    })
  }

  /**
   * Mount a filterable combobox into `host` (a .ta-combo placeholder):
   * text input filters the menu, picking an option pins the hidden field,
   * and free-typed text is taken as the value as-is (custom model / raw
   * session id).
   */
  private mountCombo(
    host: HTMLElement,
    name: string,
    options: readonly ComboOption[],
    current: string,
    placeholder: string,
    onPick: ((option: ComboOption) => void) | undefined,
  ): void {
    const display = current !== '' ? options.find(option => option.value === current)?.label ?? current : ''
    host.innerHTML = `
      <input class="ta-combo-display" type="text" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(display)}" autocomplete="off">
      <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(current)}">
      <div class="ta-combo-menu" hidden></div>`
    const input = host.querySelector<HTMLInputElement>('.ta-combo-display')!
    const hidden = host.querySelector<HTMLInputElement>('input[type="hidden"]')!
    const menu = host.querySelector<HTMLElement>('.ta-combo-menu')!

    const openMenu = (): void => {
      const query = input.value.trim().toLowerCase()
      const visible = query === ''
        ? options
        : options.filter(option =>
            `${option.label} ${option.value} ${option.hint ?? ''}`.toLowerCase().includes(query))
      const rows: string[] = []
      let lastGroup: string | undefined
      for (const option of visible) {
        if (option.group !== undefined && option.group !== lastGroup) {
          rows.push(`<div class="ta-combo-group">${escapeHtml(option.group)}</div>`)
          lastGroup = option.group
        }
        rows.push(`<div class="ta-combo-item" data-value="${escapeHtml(option.value)}" title="${escapeHtml(option.value)}">
          <span>${escapeHtml(option.label)}</span>${option.hint ? `<span class="ta-combo-hint">${escapeHtml(option.hint)}</span>` : ''}
        </div>`)
      }
      menu.innerHTML = rows.join('') || '<div class="ta-combo-empty">无匹配,回车/保存即用输入值</div>'
      menu.hidden = false
    }
    const closeMenu = (): void => { menu.hidden = true }

    input.addEventListener('focus', openMenu)
    input.addEventListener('input', () => {
      hidden.value = input.value
      openMenu()
    })
    // mousedown (not click) so the pick lands before the input's blur.
    menu.addEventListener('mousedown', event => {
      event.preventDefault()
      const item = (event.target as HTMLElement).closest<HTMLElement>('.ta-combo-item')
      if (item === null) return
      const option = options.find(candidate => candidate.value === item.dataset.value)
      if (option === undefined) return
      input.value = option.label
      hidden.value = option.value
      closeMenu()
      onPick?.(option)
    })
    input.addEventListener('blur', closeMenu)
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') closeMenu()
    })
  }

  /** Target-project options for inbox dispatch routing (matches `targetProject`). */
  private targetProjectOptions(job: JobRecord | undefined): string {
    const project = this.host.context.project
    const target = job?.targetProject ?? ''
    const groups: TargetGroupRow[] = [...this.targets]
    if (project !== null && !groups.some(group => TimerAgentApp.normPath(group.workdir) === TimerAgentApp.normPath(project.path))) {
      groups.unshift({ name: `${project.name}(当前)`, workdir: project.path, sessions: [] })
    }
    const matched = target !== '' &&
      groups.some(group => TimerAgentApp.normPath(group.workdir) === TimerAgentApp.normPath(target))
    const rows = [`<option value="">默认(任务自身项目)</option>`]
    for (const [index, group] of groups.entries()) {
      const selected = target !== '' && TimerAgentApp.normPath(group.workdir) === TimerAgentApp.normPath(target)
      rows.push(`<option value="g${index}" data-workdir="${escapeHtml(group.workdir)}" ${selected ? 'selected' : ''}>${escapeHtml(group.name)}</option>`)
    }
    if (target !== '' && !matched) {
      rows.push(`<option value="g-custom" data-workdir="${escapeHtml(target)}" selected>${escapeHtml(pathBasename(target))}(手动)</option>`)
    }
    rows.push(`<option value="custom">其他(手动输入路径)…</option>`)
    return rows.join('')
  }

  private renderForm(): void {
    const job = this.editing === 'new' ? undefined : this.editing
    const kind = this.formKind ?? (job ? jobKind(job) : 'agent')
    const draft = this.formDraft
    const val = (name: string, fallback: string): string => draft?.[name] ?? fallback
    const cron = val('cron', '') || (job?.schedule?.cron ?? '')
    // 调度开关 + 固定间隔的数值/单位(单位随 kind 切换的草稿一起保留)。
    const schedEnabled = draft !== undefined ? draft.enabled === 'on' : job?.schedule?.enabled !== false
    const iv = job?.schedule?.intervalMinutes
    const intervalUnit = val('intervalUnit', '') || (iv === undefined ? '1' : iv % 1440 === 0 ? '1440' : iv % 60 === 0 ? '60' : '1')
    const intervalValue = val('intervalMin', '') || (iv === undefined ? ''
      : String(intervalUnit === '1440' ? iv / 1440 : intervalUnit === '60' ? iv / 60 : iv))
    // 执行模式(新建页下拉):一次性任务的草稿默认当前 +1h —— 一个"快到但
    // 不立刻"的合理起点,用户从它微调,而不是面对空输入框。
    const scheduleMode = (val('scheduleMode', '') || (job === undefined
      ? 'cron'
      : isOnce(job.schedule) ? 'once' : isInterval(job.schedule) ? 'interval' : 'cron')) as 'cron' | 'interval' | 'once'
    const onceDefault = job !== undefined && job.schedule !== undefined && isOnce(job.schedule)
      && (job.schedule.nextRunAt ?? 0) > Date.now()
      ? localInputValue(new Date(job.schedule.nextRunAt!))
      : localInputValue(new Date(Date.now() + 60 * 60_000))
    // 切换模式时 FormData 会把未渲染字段的空字符串存进草稿,这里回落到默认值。
    const onceValue = val('onceValue', '') || onceDefault
    const presetOptions = CRON_PRESETS.map(preset =>
      `<option value="${preset.cron}" ${preset.cron === cron ? 'selected' : ''}>${preset.label}</option>`).join('')
    const inboxOn = draft !== undefined ? draft.inbox === 'on' : job?.inbox === true
    const toolVal = val('tool', job?.tool ?? 'claude')
    const priority = Number(val('priority', String(job?.priority ?? 3)))
    const difficulty = Number(val('difficulty', String(job?.difficulty ?? 3)))
    const priorityOptions = [1, 2, 3, 4, 5]
      .map(value => `<option value="${value}" ${priority === value ? 'selected' : ''}>${value}${value === 1 ? '(低)' : value === 5 ? '(高)' : ''}</option>`).join('')
    const difficultyOptions = [1, 2, 3, 4, 5]
      .map(value => `<option value="${value}" ${difficulty === value ? 'selected' : ''}>${value}${value === 1 ? '(易)' : value === 5 ? '(难)' : ''}</option>`).join('')
    const toolOptions = [
      ...AGENT_TOOLS.map(tool =>
        `<option value="${tool.id}" ${toolVal === tool.id ? 'selected' : ''}>${tool.label}</option>`),
      `<option value="custom" ${toolVal === 'custom' ? 'selected' : ''}>自定义 CLI</option>`,
    ].join('')
    this.container.innerHTML = `
      <div class="ta-header"><h2>${job ? '编辑任务' : '新建任务'}</h2>
        <button class="ta-btn" data-act="cancel">返回</button></div>
      <form class="ta-form">
        <label>标题<input name="title" required value="${escapeHtml(val('title', job?.title ?? ''))}"></label>
        <label>类型<select name="kind">
          <option value="agent" ${kind === 'agent' ? 'selected' : ''}>AI Agent 任务(执行 prompt)</option>
          <option value="command" ${kind === 'command' ? 'selected' : ''}>普通任务(直接运行命令)</option>
        </select></label>
        <label class="ta-inline"><input name="inbox" type="checkbox" ${inboxOn ? 'checked' : ''}> 收件箱(空闲时自动派发)</label>
        <div class="ta-field-dispatch${inboxOn ? ' ta-field-dispatch-on' : ''}">
          <label>优先级<select name="priority">${priorityOptions}</select></label>
          <label>难度<select name="difficulty">${difficultyOptions}</select></label>
          <label>执行项目(派发时路由)<select name="targetWs2">${this.targetProjectOptions(job)}</select></label>
          <label class="ta-field-custom-target" hidden>目标项目路径<input name="targetProject" value="${escapeHtml(val('targetProject', job?.targetProject ?? ''))}"></label>
        </div>
        <label class="ta-field-prompt" ${kind === 'command' ? 'hidden' : ''}>Prompt(无人在场,必须自包含)<textarea name="prompt" rows="5">${escapeHtml(val('prompt', job?.prompt ?? ''))}</textarea></label>
        <div class="ta-field-command" ${kind === 'command' ? '' : 'hidden'}>
          <label>命令(建议绝对路径)<input name="command" value="${escapeHtml(val('command', job?.command ?? ''))}"></label>
          <label>参数(支持引号)<input name="args" value="${escapeHtml(val('args', job?.args ?? ''))}"></label>
        </div>
        <label>描述<input name="description" value="${escapeHtml(val('description', job?.description ?? ''))}"></label>
        <div class="ta-field-target" ${kind === 'command' ? 'hidden' : ''}>
          <label>工作空间<select name="targetWs">${this.workspaceOptions(job)}</select></label>
          <label>会话(按最近更新排序,可搜索/输入 id)<div class="ta-combo" data-combo="session"></div></label>
          <label class="ta-field-custom-ws" hidden>工作目录<input name="customWorkdir" value="${escapeHtml(val('customWorkdir', ''))}"></label>
        </div>
        <label class="ta-field-workdir" ${kind === 'agent' ? 'hidden' : ''}>工作目录(留空 = 服务默认)<input name="workdir" value="${escapeHtml(val('workdir', job?.workdir ?? ''))}"></label>
        <div class="ta-field-model" ${kind === 'agent' ? '' : 'hidden'}>
          <label>工具<select name="tool">${toolOptions}</select></label>
          <div class="ta-field-custom-cli" ${toolVal === 'custom' ? '' : 'hidden'}>
            <label>CLI 命令(建议绝对路径)<input name="cliCommand" value="${escapeHtml(val('cliCommand', job?.cli?.command ?? ''))}" placeholder="D:\\env\\nodejs\\node.exe"></label>
            <label>CLI 参数(模板,无 {{prompt}} 时走 stdin)<input name="cliArgs" value="${escapeHtml(val('cliArgs', job?.cli?.args ?? ''))}" placeholder="--print"></label>
          </div>
          <label>模型(可搜索/可输入,选中后自动切到对应工具)<div class="ta-combo" data-combo="model"></div></label>
          <label>思考等级(claude=--effort / codex=model_reasoning_effort / opencode=--variant,留空 = 默认 medium)<input name="effort" value="${escapeHtml(val('effort', job?.effort ?? ''))}" placeholder="medium"></label>
        </div>
        <!-- 开关 + 模式下拉同一行:未勾选时下拉禁用(可见但不可选)。 -->
        <div class="ta-sched-row">
          <label class="ta-inline"><input name="enabled" type="checkbox" ${schedEnabled ? 'checked' : ''}> 启用调度(关闭后任务只保留手动执行)</label>
          <select name="scheduleMode" title="执行模式" aria-label="执行模式" ${schedEnabled ? '' : 'disabled'}>
            <option value="cron" ${scheduleMode === 'cron' ? 'selected' : ''}>Cron 表达式</option>
            <option value="interval" ${scheduleMode === 'interval' ? 'selected' : ''}>固定间隔</option>
            <option value="once" ${scheduleMode === 'once' ? 'selected' : ''}>一次性</option>
          </select>
        </div>
        <div class="ta-field-sched${schedEnabled ? '' : ' ta-disabled'}">
          ${scheduleMode === 'once' ? `
          <label>执行时间<input name="onceValue" type="datetime-local" value="${escapeHtml(onceValue)}"></label>
          <span class="ta-muted">到点执行一次后任务自动归档(成功/失败/手动执行都消耗这次机会)</span>
          ` : scheduleMode === 'cron' ? `
          <label>调度(cron 预设)<select name="preset">
            <option value="">— 自定义 —</option>${presetOptions}</select></label>
          <label>5 段 cron(分 时 日 月 周)<input name="cron" value="${escapeHtml(cron)}" placeholder="0 9 * * *"></label>
          ` : `
          <label>固定间隔(每 N 分钟/小时/天,锚定上次触发时刻)
            <span class="ta-interval-row">
              <input name="intervalMin" type="number" min="0" step="1" value="${escapeHtml(intervalValue)}" placeholder="如 302">
              <select name="intervalUnit" title="时间单位">
                <option value="1" ${intervalUnit === '1' ? 'selected' : ''}>分钟</option>
                <option value="60" ${intervalUnit === '60' ? 'selected' : ''}>小时</option>
                <option value="1440" ${intervalUnit === '1440' ? 'selected' : ''}>天</option>
              </select>
            </span>
          </label>
          `}
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
      const syncSched = (): void => {
        schedBox.classList.toggle('ta-disabled', !enabledBox.checked)
        // 未勾选时模式下拉一并禁用(可见,不可选)。
        const modeSelect = form.querySelector<HTMLSelectElement>('[name="scheduleMode"]')
        if (modeSelect !== null) modeSelect.disabled = !enabledBox.checked
      }
      enabledBox.addEventListener('change', syncSched)
    }
    // 收件箱开关:勾选时才显示优先级/难度/执行项目选择。
    const dispatchBox = this.container.querySelector<HTMLElement>('.ta-field-dispatch')
    const inboxBox = form.querySelector<HTMLInputElement>('[name="inbox"]')
    if (dispatchBox !== null && inboxBox !== null) {
      const syncInbox = (): void => {
        dispatchBox.classList.toggle('ta-field-dispatch-on', inboxBox.checked)
        dispatchBox.classList.toggle('ta-disabled', !inboxBox.checked)
      }
      inboxBox.addEventListener('change', syncInbox)
    }
    form.querySelector('[name="kind"]')!.addEventListener('change', event => {
      // Keep everything already typed; only the visible field set changes.
      this.formDraft = this.captureFormDraft(form)
      this.formKind = (event.target as HTMLSelectElement).value === 'command' ? 'command' : 'agent'
      this.renderForm()
    })
    // 执行模式下拉:切换时保留已输入的值,只换可见的定时字段集合。
    form.querySelector('[name="scheduleMode"]')?.addEventListener('change', () => {
      this.formDraft = this.captureFormDraft(form)
      this.renderForm()
    })
    // 预设下拉仅 cron 模式渲染(一次性/固定间隔没有该字段)。
    form.querySelector('[name="preset"]')?.addEventListener('change', event => {
      const value = (event.target as HTMLSelectElement).value
      if (value !== '') {
        const cronInput = form.querySelector<HTMLInputElement>('[name="cron"]')!
        cronInput.value = value
      }
    })
    // 工具选择:custom 时才显示手动 CLI 命令/参数。
    const toolSelect = form.querySelector<HTMLSelectElement>('[name="tool"]')
    const syncCustomCli = (): void => {
      const cliBox = this.container.querySelector<HTMLElement>('.ta-field-custom-cli')
      if (cliBox !== null) cliBox.hidden = toolSelect?.value !== 'custom'
    }
    toolSelect?.addEventListener('change', syncCustomCli)
    // 模型 combobox:选中目录里的模型时联动切到对应工具。
    const modelHost = this.container.querySelector<HTMLElement>('.ta-combo[data-combo="model"]')
    if (modelHost !== null) {
      this.mountCombo(modelHost, 'model', this.modelOptions(), val('model', job?.model ?? ''),
        '留空 = CLI 自身默认(claude 走服务端配置)', option => {
          if (option.group !== undefined && toolSelect !== null) {
            toolSelect.value = option.group
            syncCustomCli()
          }
        })
    }
    // 会话 combobox:跟随工作空间选择重建(保留已输入的值)。
    const mountSessionCombo = (): void => {
      const select = form.querySelector<HTMLSelectElement>('[name="targetWs"]')
      const workdir = select === null || select.value === '' || select.value === 'custom'
        ? ''
        : select.selectedOptions[0]?.dataset.workdir ?? ''
      const sessionHost = this.container.querySelector<HTMLElement>('.ta-combo[data-combo="session"]')
      if (sessionHost !== null) {
        this.mountCombo(sessionHost, 'targetSession', this.sessionOptions(workdir, job),
          val('targetSession', job?.session ?? ''), '新会话打开(留空),或搜索/输入会话 id', undefined)
      }
    }
    mountSessionCombo()
    // Workspace pick drives the session list (and the manual-path input).
    form.querySelector('[name="targetWs"]')?.addEventListener('change', event => {
      const select = event.target as HTMLSelectElement
      mountSessionCombo()
      const custom = form.querySelector<HTMLElement>('.ta-field-custom-ws')
      if (custom !== null) custom.hidden = select.value !== 'custom'
    })
    // 执行项目选择:custom 时显示手填目标项目路径。
    form.querySelector('[name="targetWs2"]')?.addEventListener('change', event => {
      const select = event.target as HTMLSelectElement
      const custom = form.querySelector<HTMLElement>('.ta-field-custom-target')
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
    const enabled = data.get('enabled') === 'on'
    const scheduleMode = String(data.get('scheduleMode') ?? 'cron') as 'cron' | 'interval' | 'once'
    const cron = String(data.get('cron') ?? '').trim()
    const inbox = data.get('inbox') === 'on'
    const intervalMin = Number(data.get('intervalMin'))
    const unitMin = Number(data.get('intervalUnit') ?? 1) || 1
    const intervalMinutes = scheduleMode === 'interval' && Number.isFinite(intervalMin) && intervalMin > 0 && unitMin > 0
      ? Math.round(intervalMin * unitMin)
      : undefined
    // One-shot mode: the datetime-local draft becomes the run's ms epoch
    // (sent as `runAt`; the server arms nextRunAt from it). Unparseable → block.
    const onceRunAt = scheduleMode === 'once' ? new Date(String(data.get('onceValue') ?? '')).getTime() : undefined
    if (scheduleMode === 'once' && !Number.isFinite(onceRunAt)) {
      window.alert('请选择一次性任务的执行时间')
      return
    }
    if (!inbox && intervalMinutes === undefined && onceRunAt === undefined && !isValidCron(cron)) {
      window.alert('需要填写有效的 cron 表达式、固定间隔数值,或选择一次性执行时间')
      return
    }
    const timeoutMin = Number(data.get('timeoutMin'))
    const priority = Number(data.get('priority'))
    const difficulty = Number(data.get('difficulty'))
    const targetWs2 = this.container.querySelector<HTMLSelectElement>('[name="targetWs2"]')
    const targetValue = targetWs2?.value ?? ''
    const targetProject = targetValue === ''
      ? ''
      : targetValue === 'custom'
        ? String(data.get('targetProject') ?? '')
        : targetWs2?.selectedOptions[0]?.dataset.workdir ?? ''
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
      cron: scheduleMode === 'once' ? '' : intervalMinutes !== undefined ? '' : cron,
      enabled,
      inbox,
      ...(inbox ? {
        priority: Number.isFinite(priority) ? priority : 3,
        difficulty: Number.isFinite(difficulty) ? difficulty : 3,
        targetProject,
      } : {}),
      ...(kind === 'agent' ? {
        prompt: String(data.get('prompt') ?? ''),
        session,
        // 'custom' → 手动 CLI 档(tool 留空,走 cli 覆盖);其余为目录里的工具 id。
        tool: ((): string | undefined => {
          const raw = String(data.get('tool') ?? '')
          return raw === 'custom' ? undefined : raw
        })(),
        cli: data.get('tool') === 'custom'
          ? { command: String(data.get('cliCommand') ?? ''), args: String(data.get('cliArgs') ?? '') }
          : undefined,
        model: String(data.get('model') ?? '').trim(),
        effort: String(data.get('effort') ?? '').trim(),
      } : {}),
      ...(kind === 'command' ? { command: String(data.get('command') ?? ''), args: String(data.get('args') ?? '') } : {}),
      ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
      // 编辑时切回 cron 模式:清掉遗留的固定间隔(intervalMinutes: 0 → 清除)。
      ...(id !== undefined && scheduleMode === 'cron' && intervalMinutes === undefined ? { intervalMinutes: 0 } : {}),
      // One-shot: create sends runAt (server arms nextRunAt from it); patch
      // pins nextRunAt directly and clears a leftover interval so the edit
      // can switch a recurring job over to one-shot mode.
      ...(onceRunAt !== undefined && Number.isFinite(onceRunAt)
        ? id === undefined
          ? { runAt: onceRunAt }
          : { intervalMinutes: 0, nextRunAt: onceRunAt }
        : {}),
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
          ${kind === 'agent' ? ` · 工具:<code>${escapeHtml(resolveAgentTool(job.tool)?.label ?? (job.cli?.command ? '自定义' : 'Claude(服务端默认)'))}</code> · 模型:<code>${escapeHtml(job.model || 'glm-5.3-flash(默认)')}</code>/<code>${escapeHtml(job.effort || 'medium(默认)')}</code>` : ''}
        </div>
        ${job.inbox ? `<div class="ta-dispatch-meta">
          <span class="ta-kind ta-kind-inbox">收件箱</span>
          <span>优先级:<strong>${job.priority ?? 3}</strong>/5</span>
          <span>难度:<strong>${job.difficulty ?? 3}</strong>/5</span>
          ${job.targetProject ? `<span>派发目录:<code>${escapeHtml(job.targetProject)}</code></span>` : ''}
          <span class="ta-muted">空闲时按最高分自动派发</span>
        </div>` : ''}
        <div class="ta-actions ta-row">
          <button class="ta-btn ta-primary" data-act="run">立即执行</button>
          <button class="ta-btn" data-act="edit">编辑</button>
          ${schedule && schedule.nextRunAt !== undefined && !isOnce(schedule)
            ? `<button class="ta-btn" data-act="skip" title="跳过这一次,下次运行改为 ${formatTime(scheduleNextMs(schedule, schedule.nextRunAt) ?? undefined)}">跳过一次</button>` : ''}
          ${schedule ? `<button class="ta-btn" data-act="${schedule.enabled ? 'pause' : 'resume'}">${schedule.enabled ? '暂停调度' : '恢复调度'}</button>` : ''}
          <button class="ta-btn" data-act="${job.status === 'archived' ? 'restart' : 'archive'}">${job.status === 'archived' ? '恢复归档' : '归档'}</button>
          <button class="ta-btn ta-danger" data-act="delete">删除</button>
        </div>
        ${schedule !== undefined && schedule.enabled && (isInterval(schedule) || isOnce(schedule)) ? `
        <div class="ta-nextrun-row">
          <span class="ta-muted">修改下次执行时间</span>
          <input type="datetime-local" data-nextrun
            value="${schedule.nextRunAt !== undefined ? localInputValue(new Date(schedule.nextRunAt)) : ''}"
            aria-label="下次运行">
          <button class="ta-btn" data-act="save-next">保存</button>
          <span class="ta-muted">${isOnce(schedule) ? '一次性任务的执行时间可在这里手改' : '固定间隔任务会以此为锚点滚动'}</span>
        </div>` : ''}
        <h3>执行历史</h3>
        <table class="ta-table"><thead><tr><th>开始</th><th>触发</th><th>结果</th><th>耗时</th><th>输出</th></tr></thead>
          <tbody>${executions || '<tr><td colspan="5" class="ta-muted">尚未执行</td></tr>'}</tbody></table>
      </div>`
    this.container.querySelector('[data-act="back"]')?.addEventListener('click', () => {
      this.selectedId = undefined
      this.render()
    })
    // 保存手改的下次执行时间(仅固定间隔/一次性;cron 的时刻由表达式决定)。
    this.container.querySelector('.ta-nextrun-row button[data-act="save-next"]')?.addEventListener('click', () => {
      const input = this.container.querySelector<HTMLInputElement>('.ta-nextrun-row input[data-nextrun]')
      const ms = input === null ? NaN : new Date(input.value).getTime()
      if (!Number.isFinite(ms)) {
        window.alert('请选择有效的日期时间')
        return
      }
      void this.listAction(id, 'save-next', ms)
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

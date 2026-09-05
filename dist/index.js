// src/shared/schedule.ts
var FIELD_RANGES = [
  [0, 59],
  // minutes
  [0, 23],
  // hours
  [1, 31],
  // days
  [1, 12],
  // months
  [0, 7]
  // weekdays (7 = Sunday, normalized below)
];
function parseCron(expr) {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return null;
  const sets = [];
  for (let index = 0; index < 5; index++) {
    const [min, max] = FIELD_RANGES[index];
    const set = /* @__PURE__ */ new Set();
    if (!parseField(fields[index], min, max, set)) return null;
    sets.push(set);
  }
  const weekdays = /* @__PURE__ */ new Set();
  for (const day of sets[4]) weekdays.add(day === 7 ? 0 : day);
  return {
    minutes: sets[0],
    hours: sets[1],
    days: sets[2],
    months: sets[3],
    weekdays,
    dayWildcard: fields[2] === "*",
    weekdayWildcard: fields[4] === "*"
  };
}
function isValidCron(expr) {
  return parseCron(expr) !== null;
}
function isIntervalRule(rule) {
  return rule !== null && rule !== void 0 && typeof rule.intervalMinutes === "number" && rule.intervalMinutes > 0;
}
function isOneShotRule(rule) {
  return !isIntervalRule(rule) && (rule?.cron ?? "") === "";
}
function scheduleNextMs(rule, fromMs) {
  if (isIntervalRule(rule)) return fromMs + rule.intervalMinutes * 6e4;
  return nextRunAtMs(rule.cron, fromMs);
}
function nextRunAtMs(expr, fromMs) {
  const schedule = parseCron(expr);
  if (schedule === null) return void 0;
  const from = new Date(fromMs);
  const scan = new Date(from.getFullYear(), from.getMonth(), from.getDate(), from.getHours(), from.getMinutes() + 1, 0, 0);
  const limitMs = fromMs + 366 * 24 * 60 * 60 * 1e3;
  while (scan.getTime() <= limitMs) {
    if (matches(schedule, scan)) return scan.getTime();
    scan.setMinutes(scan.getMinutes() + 1);
  }
  return void 0;
}
function parseField(field, min, max, out) {
  if (field === "*") {
    for (let value = min; value <= max; value++) out.add(value);
    return true;
  }
  for (const part of field.split(",")) {
    if (part === "") return false;
    const [range, stepRaw] = part.split("/");
    let low;
    let high;
    if (range === "*") {
      low = min;
      high = max;
    } else if (range.includes("-")) {
      const [a, b] = range.split("-");
      if (a === "" || b === "" || !isDigits(a) || !isDigits(b)) return false;
      low = Number(a);
      high = Number(b);
    } else if (isDigits(range)) {
      low = Number(range);
      high = Number(range);
    } else {
      return false;
    }
    if (low < min || high > max || low > high) return false;
    const step = stepRaw === void 0 ? 1 : isDigits(stepRaw) ? Number(stepRaw) : NaN;
    if (!Number.isInteger(step) || step < 1) return false;
    for (let value = low; value <= high; value += step) out.add(value);
  }
  return true;
}
function matches(schedule, date) {
  if (!schedule.minutes.has(date.getMinutes())) return false;
  if (!schedule.hours.has(date.getHours())) return false;
  if (!schedule.months.has(date.getMonth() + 1)) return false;
  const dayMatches = schedule.days.has(date.getDate());
  const weekdayMatches = schedule.weekdays.has(date.getDay());
  if (schedule.dayWildcard) return weekdayMatches;
  if (schedule.weekdayWildcard) return dayMatches;
  return dayMatches || weekdayMatches;
}
function isDigits(value) {
  return /^\d+$/.test(value);
}

// src/shared/jobs.ts
function jobKind(job) {
  return job.kind === "command" ? "command" : "agent";
}
function commandLine(job) {
  if (jobKind(job) !== "command") return "";
  return `${job.command ?? ""} ${job.args ?? ""}`.trim();
}

// src/shared/agents.ts
var AGENT_TOOLS = [
  {
    id: "claude",
    label: "Claude",
    command: "claude",
    args: "--print --permission-mode bypassPermissions",
    modelFlag: "--model",
    effortStyle: "flag",
    sessionFlag: "--resume",
    inheritServerModel: true,
    models: [
      "glm-5.3-flash",
      "glm-5.3",
      "glm-4.7",
      "glm-4.6",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-haiku-4-5"
    ]
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    args: "exec --skip-git-repo-check --dangerously-bypass-approvals-and-sandbox",
    modelFlag: "--model",
    effortStyle: "config",
    resumeSubcommand: "resume",
    models: ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna", "gpt-5.5", "gpt-5.4"]
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    args: "run --auto",
    modelFlag: "--model",
    effortStyle: "variant",
    sessionFlag: "--session",
    models: ["anthropic/claude-sonnet-4-5", "openai/gpt-5.4"]
  }
];
function resolveAgentTool(id) {
  const key = id?.trim();
  if (key === void 0 || key === "") return void 0;
  return AGENT_TOOLS.find((tool) => tool.id === key);
}

// src/client/api.ts
function createApi(api) {
  const call = api.rpc.bind(api);
  return {
    list: () => call("GET", "/v1/jobs").then((body) => body.jobs),
    targets: () => call("GET", "/v1/targets").then((body) => body.groups),
    models: () => call("GET", "/v1/models").then((body) => body.models),
    create: (input) => call("POST", "/v1/jobs", input).then((body) => body.job),
    patch: (id, body) => call("PATCH", `/v1/jobs/${encodeURIComponent(id)}`, body).then((body2) => body2.job),
    remove: (id) => call("DELETE", `/v1/jobs/${encodeURIComponent(id)}`),
    action: (id, action) => action === "run-now" ? call("POST", `/v1/jobs/${encodeURIComponent(id)}/actions/run-now`) : call("POST", `/v1/jobs/${encodeURIComponent(id)}/actions/${action}`).then((body) => body.job),
    profile: () => call("GET", "/v1/profile").then((body) => body.profile),
    setProfile: (profile) => call("PUT", "/v1/profile", profile).then((body) => body.profile),
    dispatch: () => call("GET", "/v1/dispatch"),
    setDispatch: (policy) => call("PUT", "/v1/dispatch", policy).then((body) => body.policy)
  };
}

// src/client/app.ts
var CRON_PRESETS = [
  { label: "\u6BCF\u5929 09:00", cron: "0 9 * * *" },
  { label: "\u6BCF\u5C0F\u65F6\u6574\u70B9", cron: "0 * * * *" },
  { label: "\u6BCF 10 \u5206\u949F", cron: "*/10 * * * *" },
  { label: "\u6BCF\u5468\u4E00 09:00", cron: "0 9 * * 1" },
  { label: "\u5DE5\u4F5C\u65E5 09:00", cron: "0 9 * * 1-5" },
  { label: "\u6BCF\u6708 1 \u65E5 10:00", cron: "0 10 1 * *" }
];
var STATUS_LABEL = {
  idle: "\u7A7A\u95F2",
  running: "\u8FD0\u884C\u4E2D",
  done: "\u5DF2\u5B8C\u6210",
  failed: "\u5931\u8D25",
  archived: "\u5DF2\u5F52\u6863"
};
var STATUS_CLASS = {
  idle: "idle",
  running: "running",
  done: "done",
  failed: "failed",
  archived: "archived"
};
var RESULT_LABEL = {
  succeeded: "\u6210\u529F",
  failed: "\u5931\u8D25",
  cancelled: "\u53D6\u6D88"
};
var TRIGGER_LABEL = {
  scheduled: "\u5B9A\u65F6",
  manual: "\u624B\u52A8",
  dispatch: "\u6D3E\u53D1",
  retry: "\u91CD\u8BD5"
};
function formatTime(ms) {
  if (ms === void 0) return "\u2014";
  return new Date(ms).toLocaleString();
}
function pathBasename(path) {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function localInputValue(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function scheduleLabel(schedule) {
  if (schedule === void 0) return "\u2014";
  if (isOneShotRule(schedule)) {
    return schedule.nextRunAt !== void 0 ? `\u4E00\u6B21\u6027 \xB7 ${new Date(schedule.nextRunAt).toLocaleString()}` : "\u4E00\u6B21\u6027";
  }
  const minutes = schedule.intervalMinutes;
  if (minutes !== void 0 && minutes > 0) {
    if (minutes % 1440 === 0) return `\u6BCF ${minutes / 1440} \u5929`;
    if (minutes % 60 === 0) return `\u6BCF ${minutes / 60} \u5C0F\u65F6`;
    return `\u6BCF ${minutes} \u5206\u949F`;
  }
  return schedule.cron;
}
function isInterval(schedule) {
  return schedule !== void 0 && schedule.intervalMinutes !== void 0 && schedule.intervalMinutes > 0;
}
function isOnce(schedule) {
  return isOneShotRule(schedule);
}
var TimerAgentApp = class _TimerAgentApp {
  constructor(container, api) {
    this.container = container;
    this.host = api;
    this.api = createApi(api);
  }
  api;
  host;
  jobs = [];
  targets = [];
  toolModels;
  dispatch;
  query = "";
  statusFilter = "all";
  selectedId;
  editing;
  /** Form-local kind override (the select must work before anything is saved). */
  formKind;
  /** Text-field values preserved across the kind-toggle re-render. */
  formDraft;
  /** Snapshot the fields that must survive a form re-render. */
  captureFormDraft(form) {
    const data = new FormData(form);
    const preserve = ["title", "description", "prompt", "command", "args", "workdir", "customWorkdir", "cron", "intervalMin", "intervalUnit", "scheduleMode", "onceValue", "timeoutMin", "model", "effort", "tool", "cliCommand", "cliArgs", "enabled", "inbox", "priority", "difficulty", "targetWs2", "targetProject"];
    return Object.fromEntries(preserve.map((name) => [name, String(data.get(name) ?? "")]));
  }
  pollTimer;
  async start() {
    await this.refresh();
    this.pollTimer = window.setInterval(() => {
      void this.refresh();
    }, 1e4);
    this.render();
  }
  stop() {
    if (this.pollTimer !== void 0) window.clearInterval(this.pollTimer);
  }
  async refresh() {
    try {
      const [jobs, dispatch] = await Promise.all([this.api.list(), this.api.dispatch()]);
      this.jobs = jobs;
      this.dispatch = dispatch;
    } catch (error) {
      this.jobs = [];
      this.container.innerHTML = `<div class="ta-error">\u8C03\u5EA6\u670D\u52A1\u4E0D\u53EF\u8FBE:${escapeHtml(String(error))}</div>`;
      return;
    }
    if (this.editing === void 0 && this.container.dataset.view !== "none") this.render();
  }
  render() {
    this.container.dataset.view = "rendered";
    if (this.editing !== void 0) this.renderForm();
    else if (this.selectedId !== void 0) this.renderDetail(this.selectedId);
    else this.renderList();
  }
  /* ---------------- list ---------------- */
  renderList() {
    const query = this.query.trim().toLowerCase();
    const visible = this.jobs.filter((job) => this.statusFilter === "all" || job.status === this.statusFilter).filter((job) => query === "" || `${job.title} ${job.description} ${commandLine(job)}`.toLowerCase().includes(query));
    const rows = visible.map((job) => {
      const kind = jobKind(job);
      const schedule = job.schedule;
      return `<tr data-id="${job.id}">
        <td><span class="ta-kind ta-kind-${kind}">${kind === "command" ? "\u547D\u4EE4" : "Agent"}</span>
            ${job.inbox ? `<span class="ta-kind ta-kind-inbox">\u6536\u4EF6\u7BB1</span><span class="ta-muted">P${escapeHtml(String(job.priority ?? 3))}\xB7D${escapeHtml(String(job.difficulty ?? 3))}</span>` : ""}
            <strong>${escapeHtml(job.title)}</strong></td>
        <td><span class="ta-status ta-status-${STATUS_CLASS[job.status]}">${STATUS_LABEL[job.status]}</span></td>
        <td><code>${escapeHtml(scheduleLabel(schedule))}</code>${schedule && !schedule.enabled ? ' <span class="ta-muted">(\u6682\u505C)</span>' : ""}</td>
        <td>${formatTime(schedule?.nextRunAt)}</td>
        <td class="ta-actions">
          <button class="ta-btn" data-act="run">\u7ACB\u5373\u6267\u884C</button>
          ${schedule ? `<button class="ta-btn" data-act="${schedule.enabled ? "pause" : "resume"}">${schedule.enabled ? "\u6682\u505C" : "\u6062\u590D"}</button>` : ""}
          <button class="ta-btn" data-act="edit">\u7F16\u8F91</button>
          <button class="ta-btn" data-act="detail">\u8BE6\u60C5</button>
          <button class="ta-btn ta-danger" data-act="delete">\u5220\u9664</button>
        </td>
      </tr>`;
    }).join("");
    const filterOptions = Object.entries(STATUS_LABEL).map(([value, label]) => `<option value="${value}" ${this.statusFilter === value ? "selected" : ""}>${label}</option>`).join("");
    const dispatch = this.dispatch;
    this.container.innerHTML = `
      ${dispatch ? `<div class="ta-dispatch">
        <span class="ta-dispatch-title">\u81EA\u52A8\u6D3E\u53D1</span>
        <span class="ta-status ${dispatch.policy.enabled ? "ta-status-running" : "ta-status-idle"}">${dispatch.policy.enabled ? "\u5DF2\u5F00\u542F" : "\u5DF2\u6682\u505C"}</span>
        <span class="ta-muted">\u8FD0\u884C\u4E2D ${dispatch.status.running} \xB7 \u961F\u5217 ${dispatch.status.queued}</span>
        ${dispatch.status.next === null ? "" : `<span class="ta-muted">\u4E0B\u4E00\u4E2A:${escapeHtml(dispatch.status.next.title)}(${dispatch.status.next.score}\u5206)</span>`}
      </div>` : ""}
      <div class="ta-header">
        <h2>\u5B9A\u65F6\u4EFB\u52A1</h2>
        <select class="ta-status-filter" title="\u6309\u72B6\u6001\u7B5B\u9009">
          <option value="all" ${this.statusFilter === "all" ? "selected" : ""}>\u5168\u90E8\u72B6\u6001</option>
          ${filterOptions}
        </select>
        <input class="ta-search" type="search" placeholder="\u641C\u7D22\u4EFB\u52A1\u2026" value="${escapeHtml(this.query)}">
        <button class="ta-btn ta-primary" data-act="new">\uFF0B \u65B0\u5EFA\u4EFB\u52A1</button>
      </div>
      <table class="ta-table">
        <thead><tr><th>\u4EFB\u52A1</th><th>\u72B6\u6001</th><th>\u8C03\u5EA6</th><th>\u4E0B\u6B21\u8FD0\u884C</th><th></th></tr></thead>
        <tbody>${rows || '<tr><td colspan="5" class="ta-muted">\u6682\u65E0\u4EFB\u52A1</td></tr>'}</tbody>
      </table>`;
    this.bindListEvents();
  }
  bindListEvents() {
    this.container.querySelector(".ta-status-filter")?.addEventListener("change", (event) => {
      this.statusFilter = event.target.value;
      this.renderList();
    });
    const search = this.container.querySelector(".ta-search");
    search?.addEventListener("input", () => {
      this.query = search.value;
      this.renderList();
      this.container.querySelector(".ta-search")?.focus();
    });
    this.container.querySelector('[data-act="new"]')?.addEventListener("click", () => {
      void this.listAction("", "new");
    });
    for (const row of Array.from(this.container.querySelectorAll("tr[data-id]"))) {
      const id = row.dataset.id;
      for (const button of Array.from(row.querySelectorAll("button[data-act]"))) {
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          void this.listAction(id, button.dataset.act);
        });
      }
    }
  }
  async listAction(id, act, nextRunAt) {
    try {
      if (act === "new" || act === "edit") {
        await this.loadTargets();
        this.formKind = void 0;
        this.formDraft = void 0;
        this.editing = act === "new" ? "new" : this.jobs.find((job) => job.id === id) ?? void 0;
      } else if (act === "detail") this.selectedId = id;
      else if (act === "run") await this.api.action(id, "run-now");
      else if (act === "skip") await this.api.patch(id, { skipNext: true });
      else if (act === "save-next") await this.api.patch(id, { nextRunAt });
      else if (act === "pause") await this.api.action(id, "pause");
      else if (act === "resume") await this.api.action(id, "resume");
      else if (act === "delete") {
        if (!window.confirm("\u786E\u5B9A\u5220\u9664\u8BE5\u4EFB\u52A1?")) return;
        await this.api.remove(id);
      }
      await this.refresh();
      this.render();
    } catch (error) {
      window.alert(String(error));
    }
  }
  /* ---------------- create / edit form ---------------- */
  /** Fetch workspace/session groups + host model lists (degrading to the last good set). */
  async loadTargets() {
    try {
      this.targets = await this.api.targets();
    } catch {
    }
    try {
      this.toolModels = await this.api.models();
    } catch {
    }
    return this.targets;
  }
  /** Normalize a path for group matching (same rules as the server). */
  static normPath(path) {
    let p = path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();
    if (p.length >= 2 && p[1] === ":") p = p[0].toUpperCase() + p.slice(1);
    return p;
  }
  /** Workspace options: 默认 / 当前项目 / scanned groups / 手动. */
  workspaceOptions(job) {
    const project = this.host.context.project;
    const jobDir = job?.workdir ?? "";
    const groups = [...this.targets];
    if (project !== null && !groups.some((group) => _TimerAgentApp.normPath(group.workdir) === _TimerAgentApp.normPath(project.path))) {
      groups.unshift({ name: `${project.name}(\u5F53\u524D)`, workdir: project.path, sessions: [] });
    }
    const matched = jobDir !== "" && groups.some((group) => _TimerAgentApp.normPath(group.workdir) === _TimerAgentApp.normPath(jobDir));
    const rows = [`<option value="">\u9ED8\u8BA4(\u4E0D\u6307\u5B9A\u5DE5\u4F5C\u76EE\u5F55)</option>`];
    for (const [index, group] of groups.entries()) {
      const selected = jobDir !== "" && _TimerAgentApp.normPath(group.workdir) === _TimerAgentApp.normPath(jobDir);
      rows.push(`<option value="g${index}" data-workdir="${escapeHtml(group.workdir)}" ${selected ? "selected" : ""}>${escapeHtml(group.name)}</option>`);
    }
    if (jobDir !== "" && !matched) {
      rows.push(`<option value="g-custom" data-workdir="${escapeHtml(jobDir)}" selected>${escapeHtml(pathBasename(jobDir))}(\u624B\u52A8)</option>`);
    }
    rows.push(`<option value="custom">\u5176\u4ED6(\u624B\u52A8\u8F93\u5165\u8DEF\u5F84)\u2026</option>`);
    return rows.join("");
  }
  /** Session options for one workdir: newest first, searchable via the combo. */
  sessionOptions(workdir, job) {
    const key = workdir === "" ? "" : _TimerAgentApp.normPath(workdir);
    const project = this.host.context.project;
    const group = this.targets.find((candidate) => _TimerAgentApp.normPath(candidate.workdir) === key) ?? (project !== null && key !== "" && _TimerAgentApp.normPath(project.path) === key ? { name: project.name, workdir: project.path, sessions: [] } : void 0);
    const pinned = job?.session ?? "";
    const rows = (group?.sessions ?? []).map((session) => ({
      value: session.id,
      label: session.title,
      hint: formatTime(session.updatedAt)
    }));
    if (pinned !== "" && !rows.some((row) => row.value === pinned)) {
      rows.push({ value: pinned, label: `\u5F53\u524D\u4F1A\u8BDD:${pinned}` });
    }
    return rows;
  }
  /**
   * Model options: the host's predefined lists (same source the host's own
   * selector renders; the default is badged), falling back to the built-in
   * catalog per tool. Grouped by tool so a pick links the tool select.
   */
  modelOptions() {
    return AGENT_TOOLS.flatMap((tool) => {
      const entry = this.toolModels?.[tool.id];
      const options = entry?.options ?? tool.models.map((model) => ({ value: model, label: model }));
      return options.map((option) => ({
        value: option.value,
        label: option.label,
        hint: `${tool.label}${option.value === entry?.default ? " \xB7 \u9ED8\u8BA4" : ""}${option.custom === true ? " \xB7 \u81EA\u5B9A\u4E49" : ""}`,
        group: tool.id
      }));
    });
  }
  /**
   * Mount a filterable combobox into `host` (a .ta-combo placeholder):
   * text input filters the menu, picking an option pins the hidden field,
   * and free-typed text is taken as the value as-is (custom model / raw
   * session id).
   */
  mountCombo(host, name, options, current, placeholder, onPick) {
    const display = current !== "" ? options.find((option) => option.value === current)?.label ?? current : "";
    host.innerHTML = `
      <input class="ta-combo-display" type="text" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(display)}" autocomplete="off">
      <input type="hidden" name="${escapeHtml(name)}" value="${escapeHtml(current)}">
      <div class="ta-combo-menu" hidden></div>`;
    const input = host.querySelector(".ta-combo-display");
    const hidden = host.querySelector('input[type="hidden"]');
    const menu = host.querySelector(".ta-combo-menu");
    const openMenu = () => {
      const query = input.value.trim().toLowerCase();
      const visible = query === "" ? options : options.filter((option) => `${option.label} ${option.value} ${option.hint ?? ""}`.toLowerCase().includes(query));
      const rows = [];
      let lastGroup;
      for (const option of visible) {
        if (option.group !== void 0 && option.group !== lastGroup) {
          rows.push(`<div class="ta-combo-group">${escapeHtml(option.group)}</div>`);
          lastGroup = option.group;
        }
        rows.push(`<div class="ta-combo-item" data-value="${escapeHtml(option.value)}" title="${escapeHtml(option.value)}">
          <span>${escapeHtml(option.label)}</span>${option.hint ? `<span class="ta-combo-hint">${escapeHtml(option.hint)}</span>` : ""}
        </div>`);
      }
      menu.innerHTML = rows.join("") || '<div class="ta-combo-empty">\u65E0\u5339\u914D,\u56DE\u8F66/\u4FDD\u5B58\u5373\u7528\u8F93\u5165\u503C</div>';
      menu.hidden = false;
    };
    const closeMenu = () => {
      menu.hidden = true;
    };
    input.addEventListener("focus", openMenu);
    input.addEventListener("input", () => {
      hidden.value = input.value;
      openMenu();
    });
    menu.addEventListener("mousedown", (event) => {
      event.preventDefault();
      const item = event.target.closest(".ta-combo-item");
      if (item === null) return;
      const option = options.find((candidate) => candidate.value === item.dataset.value);
      if (option === void 0) return;
      input.value = option.label;
      hidden.value = option.value;
      closeMenu();
      onPick?.(option);
    });
    input.addEventListener("blur", closeMenu);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeMenu();
    });
  }
  /** Target-project options for inbox dispatch routing (matches `targetProject`). */
  targetProjectOptions(job) {
    const project = this.host.context.project;
    const target = job?.targetProject ?? "";
    const groups = [...this.targets];
    if (project !== null && !groups.some((group) => _TimerAgentApp.normPath(group.workdir) === _TimerAgentApp.normPath(project.path))) {
      groups.unshift({ name: `${project.name}(\u5F53\u524D)`, workdir: project.path, sessions: [] });
    }
    const matched = target !== "" && groups.some((group) => _TimerAgentApp.normPath(group.workdir) === _TimerAgentApp.normPath(target));
    const rows = [`<option value="">\u9ED8\u8BA4(\u4EFB\u52A1\u81EA\u8EAB\u9879\u76EE)</option>`];
    for (const [index, group] of groups.entries()) {
      const selected = target !== "" && _TimerAgentApp.normPath(group.workdir) === _TimerAgentApp.normPath(target);
      rows.push(`<option value="g${index}" data-workdir="${escapeHtml(group.workdir)}" ${selected ? "selected" : ""}>${escapeHtml(group.name)}</option>`);
    }
    if (target !== "" && !matched) {
      rows.push(`<option value="g-custom" data-workdir="${escapeHtml(target)}" selected>${escapeHtml(pathBasename(target))}(\u624B\u52A8)</option>`);
    }
    rows.push(`<option value="custom">\u5176\u4ED6(\u624B\u52A8\u8F93\u5165\u8DEF\u5F84)\u2026</option>`);
    return rows.join("");
  }
  renderForm() {
    const job = this.editing === "new" ? void 0 : this.editing;
    const kind = this.formKind ?? (job ? jobKind(job) : "agent");
    const draft = this.formDraft;
    const val = (name, fallback) => draft?.[name] ?? fallback;
    const cron = val("cron", "") || (job?.schedule?.cron ?? "");
    const schedEnabled = draft !== void 0 ? draft.enabled === "on" : job?.schedule?.enabled !== false;
    const iv = job?.schedule?.intervalMinutes;
    const intervalUnit = val("intervalUnit", "") || (iv === void 0 ? "1" : iv % 1440 === 0 ? "1440" : iv % 60 === 0 ? "60" : "1");
    const intervalValue = val("intervalMin", "") || (iv === void 0 ? "" : String(intervalUnit === "1440" ? iv / 1440 : intervalUnit === "60" ? iv / 60 : iv));
    const scheduleMode = val("scheduleMode", "") || (job === void 0 ? "cron" : isOnce(job.schedule) ? "once" : isInterval(job.schedule) ? "interval" : "cron");
    const onceDefault = job !== void 0 && job.schedule !== void 0 && isOnce(job.schedule) && (job.schedule.nextRunAt ?? 0) > Date.now() ? localInputValue(new Date(job.schedule.nextRunAt)) : localInputValue(new Date(Date.now() + 60 * 6e4));
    const onceValue = val("onceValue", "") || onceDefault;
    const presetOptions = CRON_PRESETS.map((preset) => `<option value="${preset.cron}" ${preset.cron === cron ? "selected" : ""}>${preset.label}</option>`).join("");
    const inboxOn = draft !== void 0 ? draft.inbox === "on" : job?.inbox === true;
    const toolVal = val("tool", job?.tool ?? "claude");
    const priority = Number(val("priority", String(job?.priority ?? 3)));
    const difficulty = Number(val("difficulty", String(job?.difficulty ?? 3)));
    const priorityOptions = [1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${priority === value ? "selected" : ""}>${value}${value === 1 ? "(\u4F4E)" : value === 5 ? "(\u9AD8)" : ""}</option>`).join("");
    const difficultyOptions = [1, 2, 3, 4, 5].map((value) => `<option value="${value}" ${difficulty === value ? "selected" : ""}>${value}${value === 1 ? "(\u6613)" : value === 5 ? "(\u96BE)" : ""}</option>`).join("");
    const toolOptions = [
      ...AGENT_TOOLS.map((tool) => `<option value="${tool.id}" ${toolVal === tool.id ? "selected" : ""}>${tool.label}</option>`),
      `<option value="custom" ${toolVal === "custom" ? "selected" : ""}>\u81EA\u5B9A\u4E49 CLI</option>`
    ].join("");
    this.container.innerHTML = `
      <div class="ta-header"><h2>${job ? "\u7F16\u8F91\u4EFB\u52A1" : "\u65B0\u5EFA\u4EFB\u52A1"}</h2>
        <button class="ta-btn" data-act="cancel">\u8FD4\u56DE</button></div>
      <form class="ta-form">
        <label>\u6807\u9898<input name="title" required value="${escapeHtml(val("title", job?.title ?? ""))}"></label>
        <label>\u7C7B\u578B<select name="kind">
          <option value="agent" ${kind === "agent" ? "selected" : ""}>AI Agent \u4EFB\u52A1(\u6267\u884C prompt)</option>
          <option value="command" ${kind === "command" ? "selected" : ""}>\u666E\u901A\u4EFB\u52A1(\u76F4\u63A5\u8FD0\u884C\u547D\u4EE4)</option>
        </select></label>
        <label class="ta-inline"><input name="inbox" type="checkbox" ${inboxOn ? "checked" : ""}> \u6536\u4EF6\u7BB1(\u7A7A\u95F2\u65F6\u81EA\u52A8\u6D3E\u53D1)</label>
        <div class="ta-field-dispatch${inboxOn ? " ta-field-dispatch-on" : ""}">
          <label>\u4F18\u5148\u7EA7<select name="priority">${priorityOptions}</select></label>
          <label>\u96BE\u5EA6<select name="difficulty">${difficultyOptions}</select></label>
          <label>\u6267\u884C\u9879\u76EE(\u6D3E\u53D1\u65F6\u8DEF\u7531)<select name="targetWs2">${this.targetProjectOptions(job)}</select></label>
          <label class="ta-field-custom-target" hidden>\u76EE\u6807\u9879\u76EE\u8DEF\u5F84<input name="targetProject" value="${escapeHtml(val("targetProject", job?.targetProject ?? ""))}"></label>
        </div>
        <label class="ta-field-prompt" ${kind === "command" ? "hidden" : ""}>Prompt(\u65E0\u4EBA\u5728\u573A,\u5FC5\u987B\u81EA\u5305\u542B)<textarea name="prompt" rows="5">${escapeHtml(val("prompt", job?.prompt ?? ""))}</textarea></label>
        <div class="ta-field-command" ${kind === "command" ? "" : "hidden"}>
          <label>\u547D\u4EE4(\u5EFA\u8BAE\u7EDD\u5BF9\u8DEF\u5F84)<input name="command" value="${escapeHtml(val("command", job?.command ?? ""))}"></label>
          <label>\u53C2\u6570(\u652F\u6301\u5F15\u53F7)<input name="args" value="${escapeHtml(val("args", job?.args ?? ""))}"></label>
        </div>
        <label>\u63CF\u8FF0<input name="description" value="${escapeHtml(val("description", job?.description ?? ""))}"></label>
        <div class="ta-field-target" ${kind === "command" ? "hidden" : ""}>
          <label>\u5DE5\u4F5C\u7A7A\u95F4<select name="targetWs">${this.workspaceOptions(job)}</select></label>
          <label>\u4F1A\u8BDD(\u6309\u6700\u8FD1\u66F4\u65B0\u6392\u5E8F,\u53EF\u641C\u7D22/\u8F93\u5165 id)<div class="ta-combo" data-combo="session"></div></label>
          <label class="ta-field-custom-ws" hidden>\u5DE5\u4F5C\u76EE\u5F55<input name="customWorkdir" value="${escapeHtml(val("customWorkdir", ""))}"></label>
        </div>
        <label class="ta-field-workdir" ${kind === "agent" ? "hidden" : ""}>\u5DE5\u4F5C\u76EE\u5F55(\u7559\u7A7A = \u670D\u52A1\u9ED8\u8BA4)<input name="workdir" value="${escapeHtml(val("workdir", job?.workdir ?? ""))}"></label>
        <div class="ta-field-model" ${kind === "agent" ? "" : "hidden"}>
          <label>\u5DE5\u5177<select name="tool">${toolOptions}</select></label>
          <div class="ta-field-custom-cli" ${toolVal === "custom" ? "" : "hidden"}>
            <label>CLI \u547D\u4EE4(\u5EFA\u8BAE\u7EDD\u5BF9\u8DEF\u5F84)<input name="cliCommand" value="${escapeHtml(val("cliCommand", job?.cli?.command ?? ""))}" placeholder="D:\\env\\nodejs\\node.exe"></label>
            <label>CLI \u53C2\u6570(\u6A21\u677F,\u65E0 {{prompt}} \u65F6\u8D70 stdin)<input name="cliArgs" value="${escapeHtml(val("cliArgs", job?.cli?.args ?? ""))}" placeholder="--print"></label>
          </div>
          <label>\u6A21\u578B(\u53EF\u641C\u7D22/\u53EF\u8F93\u5165,\u9009\u4E2D\u540E\u81EA\u52A8\u5207\u5230\u5BF9\u5E94\u5DE5\u5177)<div class="ta-combo" data-combo="model"></div></label>
          <label>\u601D\u8003\u7B49\u7EA7(claude=--effort / codex=model_reasoning_effort / opencode=--variant,\u7559\u7A7A = \u9ED8\u8BA4 medium)<input name="effort" value="${escapeHtml(val("effort", job?.effort ?? ""))}" placeholder="medium"></label>
        </div>
        <!-- \u5F00\u5173 + \u6A21\u5F0F\u4E0B\u62C9\u540C\u4E00\u884C:\u672A\u52FE\u9009\u65F6\u4E0B\u62C9\u7981\u7528(\u53EF\u89C1\u4F46\u4E0D\u53EF\u9009)\u3002 -->
        <div class="ta-sched-row">
          <label class="ta-inline"><input name="enabled" type="checkbox" ${schedEnabled ? "checked" : ""}> \u542F\u7528\u8C03\u5EA6(\u5173\u95ED\u540E\u4EFB\u52A1\u53EA\u4FDD\u7559\u624B\u52A8\u6267\u884C)</label>
          <select name="scheduleMode" title="\u6267\u884C\u6A21\u5F0F" aria-label="\u6267\u884C\u6A21\u5F0F" ${schedEnabled ? "" : "disabled"}>
            <option value="cron" ${scheduleMode === "cron" ? "selected" : ""}>Cron \u8868\u8FBE\u5F0F</option>
            <option value="interval" ${scheduleMode === "interval" ? "selected" : ""}>\u56FA\u5B9A\u95F4\u9694</option>
            <option value="once" ${scheduleMode === "once" ? "selected" : ""}>\u4E00\u6B21\u6027</option>
          </select>
        </div>
        <div class="ta-field-sched${schedEnabled ? "" : " ta-disabled"}">
          ${scheduleMode === "once" ? `
          <label>\u6267\u884C\u65F6\u95F4<input name="onceValue" type="datetime-local" value="${escapeHtml(onceValue)}"></label>
          <span class="ta-muted">\u5230\u70B9\u6267\u884C\u4E00\u6B21\u540E\u4EFB\u52A1\u81EA\u52A8\u5F52\u6863(\u6210\u529F/\u5931\u8D25/\u624B\u52A8\u6267\u884C\u90FD\u6D88\u8017\u8FD9\u6B21\u673A\u4F1A)</span>
          ` : scheduleMode === "cron" ? `
          <label>\u8C03\u5EA6(cron \u9884\u8BBE)<select name="preset">
            <option value="">\u2014 \u81EA\u5B9A\u4E49 \u2014</option>${presetOptions}</select></label>
          <label>5 \u6BB5 cron(\u5206 \u65F6 \u65E5 \u6708 \u5468)<input name="cron" value="${escapeHtml(cron)}" placeholder="0 9 * * *"></label>
          ` : `
          <label>\u56FA\u5B9A\u95F4\u9694(\u6BCF N \u5206\u949F/\u5C0F\u65F6/\u5929,\u951A\u5B9A\u4E0A\u6B21\u89E6\u53D1\u65F6\u523B)
            <span class="ta-interval-row">
              <input name="intervalMin" type="number" min="0" step="1" value="${escapeHtml(intervalValue)}" placeholder="\u5982 302">
              <select name="intervalUnit" title="\u65F6\u95F4\u5355\u4F4D">
                <option value="1" ${intervalUnit === "1" ? "selected" : ""}>\u5206\u949F</option>
                <option value="60" ${intervalUnit === "60" ? "selected" : ""}>\u5C0F\u65F6</option>
                <option value="1440" ${intervalUnit === "1440" ? "selected" : ""}>\u5929</option>
              </select>
            </span>
          </label>
          `}
        </div>
        <label>\u8D85\u65F6(\u5206\u949F,\u7559\u7A7A = \u9ED8\u8BA4 10)<input name="timeoutMin" type="number" min="0" step="1"
          value="${val("timeoutMin", job?.timeoutMs ? String(Math.round(job.timeoutMs / 6e4)) : "")}"></label>
        <div class="ta-form-actions">
          <button class="ta-btn ta-primary" type="submit">\u4FDD\u5B58</button>
        </div>
      </form>`;
    const form = this.container.querySelector(".ta-form");
    const schedBox = this.container.querySelector(".ta-field-sched");
    const enabledBox = form.querySelector('[name="enabled"]');
    if (schedBox !== null && enabledBox !== null) {
      const syncSched = () => {
        schedBox.classList.toggle("ta-disabled", !enabledBox.checked);
        const modeSelect = form.querySelector('[name="scheduleMode"]');
        if (modeSelect !== null) modeSelect.disabled = !enabledBox.checked;
      };
      enabledBox.addEventListener("change", syncSched);
    }
    const dispatchBox = this.container.querySelector(".ta-field-dispatch");
    const inboxBox = form.querySelector('[name="inbox"]');
    if (dispatchBox !== null && inboxBox !== null) {
      const syncInbox = () => {
        dispatchBox.classList.toggle("ta-field-dispatch-on", inboxBox.checked);
        dispatchBox.classList.toggle("ta-disabled", !inboxBox.checked);
      };
      inboxBox.addEventListener("change", syncInbox);
    }
    form.querySelector('[name="kind"]').addEventListener("change", (event) => {
      this.formDraft = this.captureFormDraft(form);
      this.formKind = event.target.value === "command" ? "command" : "agent";
      this.renderForm();
    });
    form.querySelector('[name="scheduleMode"]')?.addEventListener("change", () => {
      this.formDraft = this.captureFormDraft(form);
      this.renderForm();
    });
    form.querySelector('[name="preset"]')?.addEventListener("change", (event) => {
      const value = event.target.value;
      if (value !== "") {
        const cronInput = form.querySelector('[name="cron"]');
        cronInput.value = value;
      }
    });
    const toolSelect = form.querySelector('[name="tool"]');
    const syncCustomCli = () => {
      const cliBox = this.container.querySelector(".ta-field-custom-cli");
      if (cliBox !== null) cliBox.hidden = toolSelect?.value !== "custom";
    };
    toolSelect?.addEventListener("change", syncCustomCli);
    const modelHost = this.container.querySelector('.ta-combo[data-combo="model"]');
    if (modelHost !== null) {
      this.mountCombo(
        modelHost,
        "model",
        this.modelOptions(),
        val("model", job?.model ?? ""),
        "\u7559\u7A7A = CLI \u81EA\u8EAB\u9ED8\u8BA4(claude \u8D70\u670D\u52A1\u7AEF\u914D\u7F6E)",
        (option) => {
          if (option.group !== void 0 && toolSelect !== null) {
            toolSelect.value = option.group;
            syncCustomCli();
          }
        }
      );
    }
    const mountSessionCombo = () => {
      const select = form.querySelector('[name="targetWs"]');
      const workdir = select === null || select.value === "" || select.value === "custom" ? "" : select.selectedOptions[0]?.dataset.workdir ?? "";
      const sessionHost = this.container.querySelector('.ta-combo[data-combo="session"]');
      if (sessionHost !== null) {
        this.mountCombo(
          sessionHost,
          "targetSession",
          this.sessionOptions(workdir, job),
          val("targetSession", job?.session ?? ""),
          "\u65B0\u4F1A\u8BDD\u6253\u5F00(\u7559\u7A7A),\u6216\u641C\u7D22/\u8F93\u5165\u4F1A\u8BDD id",
          void 0
        );
      }
    };
    mountSessionCombo();
    form.querySelector('[name="targetWs"]')?.addEventListener("change", (event) => {
      const select = event.target;
      mountSessionCombo();
      const custom = form.querySelector(".ta-field-custom-ws");
      if (custom !== null) custom.hidden = select.value !== "custom";
    });
    form.querySelector('[name="targetWs2"]')?.addEventListener("change", (event) => {
      const select = event.target;
      const custom = form.querySelector(".ta-field-custom-target");
      if (custom !== null) custom.hidden = select.value !== "custom";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void this.submitForm(new FormData(form), job?.id);
    });
    this.container.querySelector('[data-act="cancel"]')?.addEventListener("click", () => {
      this.editing = void 0;
      this.formKind = void 0;
      this.formDraft = void 0;
      this.render();
    });
  }
  async submitForm(data, id) {
    const kind = data.get("kind") === "command" ? "command" : "agent";
    const enabled = data.get("enabled") === "on";
    const scheduleMode = String(data.get("scheduleMode") ?? "cron");
    const cron = String(data.get("cron") ?? "").trim();
    const inbox = data.get("inbox") === "on";
    const intervalMin = Number(data.get("intervalMin"));
    const unitMin = Number(data.get("intervalUnit") ?? 1) || 1;
    const intervalMinutes = scheduleMode === "interval" && Number.isFinite(intervalMin) && intervalMin > 0 && unitMin > 0 ? Math.round(intervalMin * unitMin) : void 0;
    const onceRunAt = scheduleMode === "once" ? new Date(String(data.get("onceValue") ?? "")).getTime() : void 0;
    if (scheduleMode === "once" && !Number.isFinite(onceRunAt)) {
      window.alert("\u8BF7\u9009\u62E9\u4E00\u6B21\u6027\u4EFB\u52A1\u7684\u6267\u884C\u65F6\u95F4");
      return;
    }
    if (!inbox && intervalMinutes === void 0 && onceRunAt === void 0 && !isValidCron(cron)) {
      window.alert("\u9700\u8981\u586B\u5199\u6709\u6548\u7684 cron \u8868\u8FBE\u5F0F\u3001\u56FA\u5B9A\u95F4\u9694\u6570\u503C,\u6216\u9009\u62E9\u4E00\u6B21\u6027\u6267\u884C\u65F6\u95F4");
      return;
    }
    const timeoutMin = Number(data.get("timeoutMin"));
    const priority = Number(data.get("priority"));
    const difficulty = Number(data.get("difficulty"));
    const targetWs2 = this.container.querySelector('[name="targetWs2"]');
    const targetValue = targetWs2?.value ?? "";
    const targetProject = targetValue === "" ? "" : targetValue === "custom" ? String(data.get("targetProject") ?? "") : targetWs2?.selectedOptions[0]?.dataset.workdir ?? "";
    let workdir = String(data.get("workdir") ?? "");
    let session = "";
    if (kind === "agent") {
      const select = this.container.querySelector('[name="targetWs"]');
      const value = select?.value ?? "";
      workdir = value === "" ? "" : value === "custom" ? String(data.get("customWorkdir") ?? "") : select?.selectedOptions[0]?.dataset.workdir ?? "";
      session = String(data.get("targetSession") ?? "");
    }
    const body = {
      title: String(data.get("title") ?? ""),
      description: String(data.get("description") ?? ""),
      kind,
      workdir,
      cron: scheduleMode === "once" ? "" : intervalMinutes !== void 0 ? "" : cron,
      enabled,
      inbox,
      ...inbox ? {
        priority: Number.isFinite(priority) ? priority : 3,
        difficulty: Number.isFinite(difficulty) ? difficulty : 3,
        targetProject
      } : {},
      ...kind === "agent" ? {
        prompt: String(data.get("prompt") ?? ""),
        session,
        // 'custom' → 手动 CLI 档(tool 留空,走 cli 覆盖);其余为目录里的工具 id。
        tool: (() => {
          const raw = String(data.get("tool") ?? "");
          return raw === "custom" ? void 0 : raw;
        })(),
        cli: data.get("tool") === "custom" ? { command: String(data.get("cliCommand") ?? ""), args: String(data.get("cliArgs") ?? "") } : void 0,
        model: String(data.get("model") ?? "").trim(),
        effort: String(data.get("effort") ?? "").trim()
      } : {},
      ...kind === "command" ? { command: String(data.get("command") ?? ""), args: String(data.get("args") ?? "") } : {},
      ...intervalMinutes !== void 0 ? { intervalMinutes } : {},
      // 编辑时切回 cron 模式:清掉遗留的固定间隔(intervalMinutes: 0 → 清除)。
      ...id !== void 0 && scheduleMode === "cron" && intervalMinutes === void 0 ? { intervalMinutes: 0 } : {},
      // One-shot: create sends runAt (server arms nextRunAt from it); patch
      // pins nextRunAt directly and clears a leftover interval so the edit
      // can switch a recurring job over to one-shot mode.
      ...onceRunAt !== void 0 && Number.isFinite(onceRunAt) ? id === void 0 ? { runAt: onceRunAt } : { intervalMinutes: 0, nextRunAt: onceRunAt } : {},
      ...Number.isFinite(timeoutMin) && timeoutMin > 0 ? { timeoutMs: Math.round(timeoutMin * 6e4) } : {}
    };
    try {
      if (id === void 0) await this.api.create(body);
      else await this.api.patch(id, body);
      this.editing = void 0;
      this.formKind = void 0;
      this.formDraft = void 0;
      await this.refresh();
      this.render();
    } catch (error) {
      window.alert(String(error));
    }
  }
  /* ---------------- detail ---------------- */
  renderDetail(id) {
    const job = this.jobs.find((item) => item.id === id);
    if (job === void 0) {
      this.selectedId = void 0;
      this.renderList();
      return;
    }
    const schedule = job.schedule;
    const kind = jobKind(job);
    const executions = [...job.executions].reverse().map((execution) => this.executionRow(job.id, execution)).join("");
    this.container.innerHTML = `
      <div class="ta-header"><h2>${escapeHtml(job.title)}</h2>
        <button class="ta-btn" data-act="back">\u8FD4\u56DE\u5217\u8868</button></div>
      <div class="ta-detail">
        <p class="ta-muted">${escapeHtml(job.description || commandLine(job) || job.prompt.slice(0, 120))}</p>
        <div class="ta-meta">
          <span class="ta-status ta-status-${STATUS_CLASS[job.status]}">${STATUS_LABEL[job.status]}</span>
          ${schedule ? `<code>${escapeHtml(scheduleLabel(schedule))}</code>${isInterval(schedule) ? ' <span class="ta-muted">(\u56FA\u5B9A\u95F4\u9694)</span>' : ""}${schedule.enabled ? "" : " (\u6682\u505C)"}
            ${schedule.lastTriggeredAt !== void 0 ? `<span class="ta-muted">\u4E0A\u6B21:</span>${formatTime(schedule.lastTriggeredAt)} \xB7 ` : ""}\u4E0B\u6B21:<strong>${formatTime(schedule.nextRunAt)}</strong>` : "\u672A\u914D\u7F6E\u8C03\u5EA6"}
          ${job.workdir ? ` \xB7 \u76EE\u5F55:<code>${escapeHtml(job.workdir)}</code>` : ""}
          ${job.session ? ` \xB7 \u4F1A\u8BDD:<code>${escapeHtml(job.session)}</code>` : ""}
          ${kind === "agent" ? ` \xB7 \u5DE5\u5177:<code>${escapeHtml(resolveAgentTool(job.tool)?.label ?? (job.cli?.command ? "\u81EA\u5B9A\u4E49" : "Claude(\u670D\u52A1\u7AEF\u9ED8\u8BA4)"))}</code> \xB7 \u6A21\u578B:<code>${escapeHtml(job.model || "glm-5.3-flash(\u9ED8\u8BA4)")}</code>/<code>${escapeHtml(job.effort || "medium(\u9ED8\u8BA4)")}</code>` : ""}
        </div>
        ${job.inbox ? `<div class="ta-dispatch-meta">
          <span class="ta-kind ta-kind-inbox">\u6536\u4EF6\u7BB1</span>
          <span>\u4F18\u5148\u7EA7:<strong>${job.priority ?? 3}</strong>/5</span>
          <span>\u96BE\u5EA6:<strong>${job.difficulty ?? 3}</strong>/5</span>
          ${job.targetProject ? `<span>\u6D3E\u53D1\u76EE\u5F55:<code>${escapeHtml(job.targetProject)}</code></span>` : ""}
          <span class="ta-muted">\u7A7A\u95F2\u65F6\u6309\u6700\u9AD8\u5206\u81EA\u52A8\u6D3E\u53D1</span>
        </div>` : ""}
        <div class="ta-actions ta-row">
          <button class="ta-btn ta-primary" data-act="run">\u7ACB\u5373\u6267\u884C</button>
          <button class="ta-btn" data-act="edit">\u7F16\u8F91</button>
          ${schedule && schedule.nextRunAt !== void 0 && !isOnce(schedule) ? `<button class="ta-btn" data-act="skip" title="\u8DF3\u8FC7\u8FD9\u4E00\u6B21,\u4E0B\u6B21\u8FD0\u884C\u6539\u4E3A ${formatTime(scheduleNextMs(schedule, schedule.nextRunAt) ?? void 0)}">\u8DF3\u8FC7\u4E00\u6B21</button>` : ""}
          ${schedule ? `<button class="ta-btn" data-act="${schedule.enabled ? "pause" : "resume"}">${schedule.enabled ? "\u6682\u505C\u8C03\u5EA6" : "\u6062\u590D\u8C03\u5EA6"}</button>` : ""}
          <button class="ta-btn" data-act="${job.status === "archived" ? "restart" : "archive"}">${job.status === "archived" ? "\u6062\u590D\u5F52\u6863" : "\u5F52\u6863"}</button>
          <button class="ta-btn ta-danger" data-act="delete">\u5220\u9664</button>
        </div>
        ${schedule !== void 0 && schedule.enabled && (isInterval(schedule) || isOnce(schedule)) ? `
        <div class="ta-nextrun-row">
          <span class="ta-muted">\u4FEE\u6539\u4E0B\u6B21\u6267\u884C\u65F6\u95F4</span>
          <input type="datetime-local" data-nextrun
            value="${schedule.nextRunAt !== void 0 ? localInputValue(new Date(schedule.nextRunAt)) : ""}"
            aria-label="\u4E0B\u6B21\u8FD0\u884C">
          <button class="ta-btn" data-act="save-next">\u4FDD\u5B58</button>
          <span class="ta-muted">${isOnce(schedule) ? "\u4E00\u6B21\u6027\u4EFB\u52A1\u7684\u6267\u884C\u65F6\u95F4\u53EF\u5728\u8FD9\u91CC\u624B\u6539" : "\u56FA\u5B9A\u95F4\u9694\u4EFB\u52A1\u4F1A\u4EE5\u6B64\u4E3A\u951A\u70B9\u6EDA\u52A8"}</span>
        </div>` : ""}
        <h3>\u6267\u884C\u5386\u53F2</h3>
        <table class="ta-table"><thead><tr><th>\u5F00\u59CB</th><th>\u89E6\u53D1</th><th>\u7ED3\u679C</th><th>\u8017\u65F6</th><th>\u8F93\u51FA</th></tr></thead>
          <tbody>${executions || '<tr><td colspan="5" class="ta-muted">\u5C1A\u672A\u6267\u884C</td></tr>'}</tbody></table>
      </div>`;
    this.container.querySelector('[data-act="back"]')?.addEventListener("click", () => {
      this.selectedId = void 0;
      this.render();
    });
    this.container.querySelector('.ta-nextrun-row button[data-act="save-next"]')?.addEventListener("click", () => {
      const input = this.container.querySelector(".ta-nextrun-row input[data-nextrun]");
      const ms = input === null ? NaN : new Date(input.value).getTime();
      if (!Number.isFinite(ms)) {
        window.alert("\u8BF7\u9009\u62E9\u6709\u6548\u7684\u65E5\u671F\u65F6\u95F4");
        return;
      }
      void this.listAction(id, "save-next", ms);
    });
    for (const button of Array.from(this.container.querySelectorAll(".ta-actions button[data-act]"))) {
      button.addEventListener("click", () => void this.listAction(id, button.dataset.act));
    }
    for (const button of Array.from(this.container.querySelectorAll("button[data-run-id]"))) {
      button.addEventListener("click", () => {
        const output = button.getAttribute("data-output") ?? "";
        window.alert(output === "" ? "(\u65E0\u8F93\u51FA)" : output);
      });
    }
  }
  executionRow(jobId, execution) {
    const duration = execution.endedAt === void 0 ? "\u2026" : `${Math.max(1, Math.round((execution.endedAt - execution.startedAt) / 1e3))}s`;
    const label = execution.result === void 0 ? "\u8FD0\u884C\u4E2D" : RESULT_LABEL[execution.result];
    const cls = execution.result === void 0 ? "running" : execution.result;
    return `<tr data-id="${jobId}">
      <td>${formatTime(execution.startedAt)}</td>
      <td>${TRIGGER_LABEL[execution.trigger]}</td>
      <td><span class="ta-status ta-status-${cls}">${label}</span>${execution.error ? ` <span class="ta-muted">${escapeHtml(execution.error.slice(0, 80))}</span>` : ""}</td>
      <td>${duration}</td>
      <td>${execution.output ? `<button class="ta-btn" data-run-id="${execution.id}" data-output="${escapeHtml(execution.output)}">\u67E5\u770B</button>` : "\u2014"}</td>
    </tr>`;
  }
};

// src/client/styles.ts
var CSS = `
.ta-root { font-family: inherit; padding: 16px; color: var(--ta-fg, #d4d4d4); }
.ta-theme-dark { --ta-fg: #d4d4d4; --ta-muted: #8a8a8a; --ta-border: #333; --ta-hover: #2a2a2a; --ta-primary: #2563eb; }
.ta-theme-light { --ta-fg: #1a1a1a; --ta-muted: #777; --ta-border: #ddd; --ta-hover: #f2f2f2; --ta-primary: #2563eb; }
.ta-root h2 { margin: 0; font-size: 18px; }
.ta-root h3 { margin: 16px 0 8px; font-size: 14px; }
.ta-header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.ta-header h2 { flex: 1; }
.ta-muted { color: var(--ta-muted); font-size: 12px; }
.ta-error { color: #f87171; padding: 16px; }
.ta-search { flex: 1; max-width: 260px; padding: 6px 10px; border: 1px solid var(--ta-border);
  border-radius: 6px; background: transparent; color: inherit; }
.ta-status-filter { padding: 6px 10px; border: 1px solid var(--ta-border); border-radius: 6px;
  background: transparent; color: inherit; font-size: 12px; max-width: 140px; }
.ta-btn { padding: 5px 10px; border: 1px solid var(--ta-border); border-radius: 6px;
  background: transparent; color: inherit; cursor: pointer; font-size: 12px; }
.ta-btn:hover { background: var(--ta-hover); }
.ta-btn.ta-primary { background: var(--ta-primary); border-color: var(--ta-primary); color: #fff; }
.ta-btn.ta-danger { color: #f87171; }
.ta-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ta-table th, .ta-table td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--ta-border); }
.ta-table tbody tr:hover { background: var(--ta-hover); }
.ta-table code { font-size: 12px; }
.ta-actions { display: flex; gap: 6px; flex-wrap: wrap; }
.ta-row { margin: 12px 0; }
.ta-kind { display: inline-block; font-size: 11px; border-radius: 4px; padding: 1px 6px;
  margin-right: 8px; border: 1px solid var(--ta-border); }
.ta-kind-agent { color: #93c5fd; }
.ta-kind-command { color: #fcd34d; }
.ta-kind-inbox { color: #a78bfa; border-color: #a78bfa; }
.ta-status { display: inline-block; font-size: 11px; border-radius: 999px; padding: 1px 8px; border: 1px solid var(--ta-border); }
.ta-status-idle { color: var(--ta-muted); }
.ta-status-running { color: #93c5fd; border-color: #93c5fd; }
.ta-status-done, .ta-status-succeeded { color: #4ade80; border-color: #4ade80; }
.ta-status-failed { color: #f87171; border-color: #f87171; }
.ta-status-cancelled { color: var(--ta-muted); }
.ta-status-archived { color: var(--ta-muted); text-decoration: line-through; }
.ta-form { display: flex; flex-direction: column; gap: 10px; max-width: 560px; }
.ta-form label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--ta-muted); }
.ta-form input, .ta-form textarea, .ta-form select { padding: 7px 10px; border: 1px solid var(--ta-border);
  border-radius: 6px; background: transparent; color: inherit; font-size: 13px; font-family: inherit; }
.ta-form textarea { resize: vertical; }
.ta-form-actions { display: flex; align-items: center; gap: 12px; margin-top: 6px; }
.ta-inline { flex-direction: row !important; align-items: center; gap: 6px !important; }
.ta-interval-row { display: flex; gap: 6px; }
.ta-interval-row input { flex: 1; }
.ta-interval-row select { width: 76px; }
/* \u8C03\u5EA6\u5F00\u5173 + \u6267\u884C\u6A21\u5F0F\u4E0B\u62C9\u540C\u4E00\u884C(\u672A\u52FE\u9009\u65F6\u4E0B\u62C9\u7981\u7528,\u53EF\u89C1\u4F46\u4E0D\u53EF\u9009)\u3002 */
.ta-sched-row { display: flex; align-items: center; gap: 12px; }
.ta-sched-row select { width: 160px; }
/* \u8BE6\u60C5\u9875\u624B\u6539\u4E0B\u6B21\u6267\u884C\u65F6\u95F4\u884C\u3002 */
.ta-nextrun-row { display: flex; gap: 6px; align-items: center; margin: 8px 0; }
.ta-nextrun-row input { flex: 0 1 240px; }
.ta-disabled { opacity: .45; pointer-events: none; }
.ta-dispatch { display: flex; align-items: center; gap: 12px; padding: 8px 12px; margin-bottom: 12px;
  border: 1px solid var(--ta-border); border-radius: 8px; font-size: 12px; background: transparent; }
.ta-dispatch-title { font-weight: 600; }
.ta-field-dispatch { margin: 6px 0; padding: 8px 10px; border: 1px dashed var(--ta-border);
  border-radius: 6px; display: grid; grid-template-columns: 110px 110px minmax(0, 1fr); gap: 10px; align-items: end; }
.ta-field-dispatch-on { border-style: solid; border-color: #a78bfa; }
.ta-field-dispatch .ta-field-custom-target { grid-column: 1 / -1; }
.ta-dispatch-meta { display: flex; align-items: center; flex-wrap: wrap; gap: 10px;
  margin: 6px 0 10px; padding: 6px 10px; border: 1px dashed var(--ta-border); border-radius: 6px; font-size: 12px; }
.ta-dispatch-meta strong { color: inherit; }
.ta-detail p { margin: 0 0 8px; }
.ta-meta { font-size: 13px; margin-bottom: 8px; }
.ta-theme-dark { --ta-bg: #1e1e1e; }
.ta-theme-light { --ta-bg: #ffffff; }
.ta-combo { position: relative; }
.ta-combo-display { width: 100%; }
.ta-combo-menu { position: absolute; top: 100%; left: 0; right: 0; z-index: 40; max-height: 240px;
  overflow-y: auto; margin-top: 2px; border: 1px solid var(--ta-border); border-radius: 6px;
  background: var(--ta-bg, #1e1e1e); box-shadow: 0 4px 12px rgba(0, 0, 0, .25); }
.ta-combo-group { padding: 4px 10px; font-size: 11px; color: var(--ta-muted);
  border-bottom: 1px solid var(--ta-border); }
.ta-combo-item { display: flex; align-items: center; justify-content: space-between; gap: 8px;
  padding: 6px 10px; font-size: 12px; cursor: pointer; }
.ta-combo-item:hover { background: var(--ta-hover); }
.ta-combo-hint { color: var(--ta-muted); font-size: 11px; white-space: nowrap; }
.ta-combo-empty { padding: 8px 10px; font-size: 12px; color: var(--ta-muted); }
[hidden] { display: none !important; }
`;
var injected = false;
function injectStyles() {
  if (injected) return;
  injected = true;
  const style = document.createElement("style");
  style.textContent = CSS;
  document.head.appendChild(style);
}

// src/index.ts
var plugin = {
  async mount(container, api) {
    injectStyles();
    container.classList.add("ta-root", `ta-theme-${api.context.theme}`);
    const app = new TimerAgentApp(container, api);
    container.__timerAgentApp = app;
    await app.start();
  },
  unmount(container) {
    container.__timerAgentApp?.stop();
    container.classList.remove("ta-root", "ta-theme-dark", "ta-theme-light");
    container.innerHTML = "";
  }
};
var mount = plugin.mount;
var unmount = plugin.unmount;
export {
  mount,
  unmount
};

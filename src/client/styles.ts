/**
 * Inline stylesheet for the tab board (injected once; scoped under .ta-root
 * so it never leaks into the host UI). Follows the host theme via a class.
 */

const CSS = `
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
/* 调度开关 + 执行模式下拉同一行(未勾选时下拉禁用,可见但不可选)。 */
.ta-sched-row { display: flex; align-items: center; gap: 12px; }
.ta-sched-row select { width: 160px; }
/* 详情页手改下次执行时间行。 */
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
`

let injected = false

/** Inject the stylesheet once per document. */
export function injectStyles(): void {
  if (injected) return
  injected = true
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
}

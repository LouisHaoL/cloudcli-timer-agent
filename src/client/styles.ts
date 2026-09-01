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
.ta-disabled { opacity: .45; pointer-events: none; }
.ta-detail p { margin: 0 0 8px; }
.ta-meta { font-size: 13px; margin-bottom: 8px; }
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

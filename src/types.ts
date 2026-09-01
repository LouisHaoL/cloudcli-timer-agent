/**
 * CloudCLI plugin host contract (mirrors cloudcli-cron's PluginAPI — the
 * host loads `mount`/`unmount` from the manifest `entry` bundle and proxies
 * `rpc` calls to the manifest `server` process over loopback HTTP).
 */

export interface PluginContext {
  theme: 'dark' | 'light'
  project: { name: string; path: string } | null
  session: { id: string; title: string } | null
}

export interface PluginAPI {
  context: PluginContext
  onContextChange(listener: (context: PluginContext) => void): () => void
  rpc<TResponse>(method: string, path: string, body?: unknown): Promise<TResponse>
}

export interface PluginModule {
  mount(container: HTMLElement, api: PluginAPI): void | Promise<void>
  unmount(container: HTMLElement): void | Promise<void>
}

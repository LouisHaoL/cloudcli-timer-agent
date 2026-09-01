/**
 * Plugin entry (manifest `entry` field): mounts the「定时任务」tab board.
 * Exports exactly the host lifecycle contract (`mount`/`unmount`).
 */
import type { PluginModule } from './types.js'
import { TimerAgentApp } from './client/app.js'
import { injectStyles } from './client/styles.js'

const plugin: PluginModule = {
  async mount(container: HTMLElement, api): Promise<void> {
    injectStyles()
    container.classList.add('ta-root', `ta-theme-${api.context.theme}`)
    const app = new TimerAgentApp(container, api)
    ;(container as HTMLElement & { __timerAgentApp?: TimerAgentApp }).__timerAgentApp = app
    await app.start()
  },
  unmount(container: HTMLElement): void {
    (container as HTMLElement & { __timerAgentApp?: TimerAgentApp }).__timerAgentApp?.stop()
    container.classList.remove('ta-root', 'ta-theme-dark', 'ta-theme-light')
    container.innerHTML = ''
  },
}

export const mount = plugin.mount
export const unmount = plugin.unmount

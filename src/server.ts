/**
 * Server entry (manifest `server` field): the resident scheduler process.
 * The host spawns it; it binds a random loopback port and reports readiness
 * with one stdout JSON line `{"ready":true,"port":N}` (cloudcli-cron
 * handshake). Also runnable standalone (`node dist/server.js`) for
 * development / CLI-side management — the host instance and a standalone
 * instance share the same ledger file, so run at most one to avoid
 * double-firing.
 */
import { startHttpServer, loadProfile } from './server/http.js'
import { tick } from './server/scheduler.js'
import { JobStore } from './server/store.js'

/** Ticker cadence (ms); cron is minute-granular so 30s never misses a point. */
const TICK_INTERVAL_MS = 30_000

async function main(): Promise<void> {
  const store = new JobStore()
  const profile = await loadProfile()
  const server = await startHttpServer({ store, tick: () => tick(store, profile) })
  const interval = setInterval(() => {
    void tick(store, profile)
  }, TICK_INTERVAL_MS)
  interval.unref()
  // Random-port + handshake: this script is always spawned (host or shell),
  // so the port goes to stdout for whichever parent started it.
  const port = (server.address() as { port: number }).port
  process.stdout.write(`${JSON.stringify({ ready: true, port })}\n`)
}

main().catch(error => {
  process.stderr.write(`[timer-agent] server failed: ${String(error)}\n`)
  process.exit(1)
})

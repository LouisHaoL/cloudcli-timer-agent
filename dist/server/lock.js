/**
 * Single-instance guard for the resident scheduler process. The host instance
 * and any standalone instance share one ledger file; two live tickers racing
 * on load→mutate→save clobber each other (lost executions, dropped schedule
 * fields), so a second instance must refuse to start. One lock file per data
 * directory: `server.lock` holds the owner pid; a stale file (owner died
 * without cleanup) is detected via the pid and reclaimed.
 */
import { open, readFile, unlink, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from './store.js';
/** Try to become the one scheduler instance; false when another is live. */
export async function acquireInstanceLock() {
    const file = join(dataDir(), 'server.lock');
    await mkdir(join(file, '..'), { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            // Exclusive create: exactly one contender wins, including the
            // stale-reclaim race (two starters both saw a dead owner).
            const handle = await open(file, 'wx');
            await handle.write(`${JSON.stringify({ pid: process.pid, startedAt: Date.now() })}\n`);
            await handle.close();
            process.on('exit', () => {
                void unlink(file).catch(() => undefined);
            });
            return true;
        }
        catch (error) {
            if (error.code !== 'EEXIST')
                throw error;
            const owner = await readOwnerPid(file);
            if (owner !== undefined && (await pidAlive(owner)))
                return false;
            // Owner gone (or no readable pid): remove the stale file and retry 'wx'.
            await unlink(file).catch(() => undefined);
        }
    }
    return false;
}
/**
 * Whether `pid` names a live process. `kill(pid, 0)` is the signal-only
 * probe: ESRCH → gone; EPERM → alive but unsignalable (different user) —
 * count it alive so two instances never share a ledger.
 */
async function pidAlive(pid) {
    try {
        process.kill(pid, 0);
        return true;
    }
    catch (error) {
        return error.code === 'EPERM';
    }
}
/** The recorded owner pid, or undefined when unreadable/corrupt. */
async function readOwnerPid(file) {
    try {
        const parsed = JSON.parse(await readFile(file, 'utf8'));
        if (typeof parsed === 'object' && parsed !== null && typeof parsed.pid === 'number') {
            return parsed.pid;
        }
    }
    catch {
        return undefined;
    }
    return undefined;
}
//# sourceMappingURL=lock.js.map
/**
 * Target options for the job form's workspace/session pickers (ported from
 * dsh-timer-agent's target-options tree, re-sourced for the plugin host:
 * there is no workspace registry or client sessions face here, so both are
 * recovered from the CLI's own history — each transcript under
 * ~/.claude/projects (a per-project .jsonl whose first line carries
 * sessionId, cwd and the opening user message).
 *
 * Groups = distinct cwds (most recent first); each group's sessions follow
 * the original semantics: the form adds a "new session" leaf per group and
 * the listed sessions pin that conversation ({{session}} → --resume).
 */
import { open, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
/** Cap the scan: recent files only, recent sessions per group only. */
const MAX_FILES = 300;
const SESSIONS_PER_GROUP = 20;
/** Last non-empty path segment (both separators), for short labels. */
function pathBasename(path) {
    return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}
/** Normalize a path for grouping (case/fold, forward slashes, no trailing). */
function normPath(path) {
    let p = path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase();
    if (p.length >= 2 && p[1] === ':')
        p = p[0].toUpperCase() + p.slice(1);
    return p;
}
/** First user-visible text of a transcript line (best effort, capped). */
function firstUserText(line) {
    const message = line.message;
    if (message?.role !== 'user')
        return '';
    const content = message.content;
    const text = typeof content === 'string'
        ? content
        : Array.isArray(content)
            ? content.find(part => part?.type === 'text')?.text ?? ''
            : '';
    const clean = text.replace(/\s+/g, ' ').trim();
    return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean;
}
/** Extract {id, title, cwd} from a transcript's first line (null = skip). */
function parseFirstLine(raw, fallbackId) {
    try {
        const line = JSON.parse(raw.slice(0, raw.indexOf('\n') === -1 ? raw.length : raw.indexOf('\n')));
        if (line.isSidechain === true)
            return null;
        const cwd = typeof line.cwd === 'string' && line.cwd.trim() !== '' ? line.cwd.trim() : null;
        if (cwd === null)
            return null;
        const id = typeof line.sessionId === 'string' && line.sessionId !== '' ? line.sessionId : fallbackId;
        return { id, title: firstUserText(line) || id, cwd };
    }
    catch {
        return null;
    }
}
/** Enumerate workspace groups with their pinnable sessions. */
export async function listTargetGroups() {
    const root = join(homedir(), '.claude', 'projects');
    const candidates = [];
    let dirs;
    try {
        dirs = await readdir(root);
    }
    catch {
        return [];
    }
    for (const dir of dirs) {
        let files;
        try {
            files = await readdir(join(root, dir));
        }
        catch {
            continue;
        }
        for (const file of files) {
            if (!file.endsWith('.jsonl'))
                continue;
            const full = join(root, dir, file);
            try {
                const info = await stat(full);
                candidates.push({ file: full, mtime: info.mtimeMs });
            }
            catch {
                continue;
            }
        }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const buckets = new Map();
    for (const candidate of candidates.slice(0, MAX_FILES)) {
        let raw;
        try {
            const handle = await open(candidate.file, 'r');
            try {
                const buffer = Buffer.alloc(16_384);
                const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
                raw = buffer.subarray(0, bytesRead).toString('utf8');
            }
            finally {
                await handle.close();
            }
        }
        catch {
            continue;
        }
        const parsed = parseFirstLine(raw, pathBasename(candidate.file).replace(/\.jsonl$/, ''));
        if (parsed === null)
            continue;
        const key = normPath(parsed.cwd);
        const bucket = buckets.get(key) ?? { workdir: parsed.cwd, sessions: [] };
        if (bucket.sessions.length >= SESSIONS_PER_GROUP)
            continue;
        if (bucket.sessions.some(session => session.id === parsed.id))
            continue;
        bucket.sessions.push({ id: parsed.id, title: parsed.title, updatedAt: candidate.mtime });
        buckets.set(key, bucket);
    }
    return Array.from(buckets.values())
        .map(bucket => ({
        name: pathBasename(bucket.workdir),
        workdir: bucket.workdir,
        sessions: bucket.sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    }))
        .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0));
}
//# sourceMappingURL=targets.js.map
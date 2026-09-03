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
import { open, readdir, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** One pinnable session row. */
export interface TargetSessionRow {
  id: string
  title: string
  updatedAt: number
}

/** One workspace group = one distinct cwd. */
export interface TargetGroupRow {
  name: string
  workdir: string
  sessions: TargetSessionRow[]
}

/** Cap the scan: recent files only, recent sessions per group only. */
const MAX_FILES = 600
const SESSIONS_PER_GROUP = 50
/** Head-scan budget: meta lines can precede the first real transcript record. */
const HEAD_LINES = 8
const HEAD_LIMIT = 262_144

/** Last non-empty path segment (both separators), for short labels. */
function pathBasename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** Normalize a path for grouping (case/fold, forward slashes, no trailing). */
function normPath(path: string): string {
  let p = path.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
  if (p.length >= 2 && p[1] === ':') p = p[0]!.toUpperCase() + p.slice(1)
  return p
}

/** First user-visible text of a transcript line (best effort, capped). */
function firstUserText(line: unknown): string {
  const message = (line as { message?: { role?: string; content?: unknown } }).message
  if (message?.role !== 'user') return ''
  const content = message.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? (content.find(part => (part as { type?: string })?.type === 'text') as { text?: string } | undefined)?.text ?? ''
      : ''
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > 80 ? `${clean.slice(0, 80)}…` : clean
}

/**
 * Extract {id, title, cwd} from a transcript head (null = skip). Newer
 * transcripts open with meta lines (`queue-operation`, …) that carry no cwd,
 * so scan the head line-by-line and take cwd / title / sessionId from the
 * first line that has each; a transcript that stays sidechain-only is skipped.
 */
function parseHead(raw: string, fallbackId: string): { id: string; title: string; cwd: string } | null {
  let cwd: string | null = null
  let id: string | null = null
  let title = ''
  for (const lineText of raw.split('\n')) {
    if (lineText.trim() === '') continue
    let line: { sessionId?: string; cwd?: string; isSidechain?: boolean; message?: unknown }
    try {
      line = JSON.parse(lineText) as typeof line
    } catch {
      continue
    }
    if (cwd === null && typeof line.cwd === 'string' && line.cwd.trim() !== '') cwd = line.cwd.trim()
    if (id === null && typeof line.sessionId === 'string' && line.sessionId !== '') id = line.sessionId
    if (title === '' && line.isSidechain !== true) title = firstUserText(line)
    if (cwd !== null && id !== null && title !== '') break
  }
  if (cwd === null) return null
  return { id: id ?? fallbackId, title: title || id || fallbackId, cwd }
}

/** Enumerate workspace groups with their pinnable sessions. */
export async function listTargetGroups(): Promise<TargetGroupRow[]> {
  const root = join(homedir(), '.claude', 'projects')
  const candidates: Array<{ file: string; mtime: number }> = []
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return []
  }
  for (const dir of dirs) {
    let files: string[]
    try {
      files = await readdir(join(root, dir))
    } catch {
      continue
    }
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue
      const full = join(root, dir, file)
      try {
        const info = await stat(full)
        candidates.push({ file: full, mtime: info.mtimeMs })
      } catch {
        continue
      }
    }
  }
  candidates.sort((a, b) => b.mtime - a.mtime)

  const buckets = new Map<string, { workdir: string; sessions: TargetSessionRow[] }>()
  for (const candidate of candidates.slice(0, MAX_FILES)) {
    let raw: string
    try {
      const handle = await open(candidate.file, 'r')
      try {
        // Read the transcript head (meta lines can precede the first real
        // record). Chunks are copied because `buffer` is reused per read;
        // line boundaries across chunk edges are handled by split('\n').
        const buffer = Buffer.alloc(16_384)
        const chunks: Buffer[] = []
        let offset = 0
        let newlines = 0
        while (offset < HEAD_LIMIT && newlines < HEAD_LINES) {
          const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, HEAD_LIMIT - offset), offset)
          if (bytesRead === 0) break
          const slice = buffer.subarray(0, bytesRead)
          newlines += slice.filter(byte => byte === 10).length
          chunks.push(Buffer.from(slice))
          offset += bytesRead
        }
        raw = Buffer.concat(chunks).toString('utf8')
      } finally {
        await handle.close()
      }
    } catch {
      continue
    }
    const parsed = parseHead(raw, pathBasename(candidate.file).replace(/\.jsonl$/, ''))
    if (parsed === null) continue
    const key = normPath(parsed.cwd)
    const bucket = buckets.get(key) ?? { workdir: parsed.cwd, sessions: [] }
    if (bucket.sessions.length >= SESSIONS_PER_GROUP) continue
    if (bucket.sessions.some(session => session.id === parsed.id)) continue
    bucket.sessions.push({ id: parsed.id, title: parsed.title, updatedAt: candidate.mtime })
    buckets.set(key, bucket)
  }

  return Array.from(buckets.values())
    .map(bucket => ({
      name: pathBasename(bucket.workdir),
      workdir: bucket.workdir,
      sessions: bucket.sessions.sort((a, b) => b.updatedAt - a.updatedAt),
    }))
    .sort((a, b) => (b.sessions[0]?.updatedAt ?? 0) - (a.sessions[0]?.updatedAt ?? 0))
}

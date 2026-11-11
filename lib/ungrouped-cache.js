/**
 * In the repo: this is the on-disk cache behind `diagnoseUngrouped()`, imported
 * directly by lib/index.js. Deleting this file only makes the next boot fall
 * back to a full scan — it loses no data.
 *
 * Responsibility: remember, per project directory, the **header facts** of its
 * session directories, so a boot does not have to read 1.27 GB of zstd logs
 * again (measured: 1771 dirs / 1270.7 MB / 612 ms of full-file reads plus
 * ~225 ms of full-buffer magic scans, inside a 894.9 ms median scan).
 *
 * What is cached: facts only, never the verdict. `subagent` / `blank` /
 * `archived` / `member` decisions are recomputed on every call from the live
 * registry, so archiving or grouping a session takes effect immediately even
 * when its project directory did not move.
 *
 * Every failure path is silent: a cache problem must degrade to a full scan,
 * never to a thrown boot guard, never to a wrong count.
 */

import { statSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** Bump when the shape below changes; mismatches are dropped silently. */
export const UNGROUPED_CACHE_VERSION = 1

/**
 * Hard ceiling on how long a cached project may be trusted untouched.
 *
 * Project-directory mtime catches sessions being created or deleted. It does
 * NOT catch an existing session whose log was rewritten in place — DSH appends
 * to logs and never rewrites the header, so this is a theoretical hole, not an
 * observed one. The TTL is the belt for that suspender: one full rescan a day
 * costs 0.9 s.
 */
export const UNGROUPED_CACHE_TTL_MS = 24 * 60 * 60 * 1000

export function cacheFilePath(stateDir) {
  return join(stateDir, 'ungrouped-cache.json')
}

/**
 * Read the snapshot.
 *
 * @returns {{ projects: Map<string, {mtimeMs: number, facts: object[]}>, reason: string }}
 *   `projects` is empty when nothing trustworthy was found; `reason` says why
 *   (`ok` / `missing` / `unreadable` / `corrupt` / `version` / `root-changed` /
 *   `expired` / `shape`). The caller does not branch on it — it only exists so
 *   the probe suite can assert the fallback actually fired.
 */
export function readSnapshot(file, { sessionsRoot = '', now = Date.now(), ttlMs = UNGROUPED_CACHE_TTL_MS } = {}) {
  const none = (reason) => ({ projects: new Map(), reason })
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    return none(err && err.code === 'ENOENT' ? 'missing' : 'unreadable')
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return none('corrupt')
  }
  if (parsed === null || typeof parsed !== 'object') return none('shape')
  if (parsed.version !== UNGROUPED_CACHE_VERSION) return none('version')
  if (typeof parsed.sessionsRoot !== 'string' || parsed.sessionsRoot !== sessionsRoot) return none('root-changed')
  if (!Number.isFinite(parsed.savedAt) || now - parsed.savedAt > ttlMs) return none('expired')
  const raw = parsed.projects
  if (raw === null || typeof raw !== 'object') return none('shape')
  const projects = new Map()
  for (const [key, entry] of Object.entries(raw)) {
    if (entry === null || typeof entry !== 'object') continue
    if (!Number.isFinite(entry.mtimeMs)) continue
    if (!Array.isArray(entry.facts)) continue
    projects.set(key, { mtimeMs: entry.mtimeMs, facts: entry.facts })
  }
  if (projects.size === 0) return none('shape')
  return { projects, reason: 'ok' }
}

/**
 * Write the snapshot. Best effort by design: a read-only home, a full disk or a
 * locked file must not fail the boot guard, so every error is swallowed.
 *
 * @returns {boolean} true when the file was replaced.
 */
export function writeSnapshot(file, { sessionsRoot = '', projects, now = Date.now() } = {}) {
  const payload = { version: UNGROUPED_CACHE_VERSION, sessionsRoot, savedAt: now, projects: {} }
  for (const [key, entry] of projects ?? []) payload.projects[key] = { mtimeMs: entry.mtimeMs, facts: entry.facts }
  const tmp = `${file}.tmp-${process.pid}`
  try {
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(tmp, JSON.stringify(payload), 'utf8')
    renameSync(tmp, file)
    return true
  } catch {
    try { writeFileSync(tmp, '', 'utf8') } catch { /* nothing left to do */ }
    return false
  }
}

/** mtime of a directory, or null when it cannot be stat'ed right now. */
export function dirMtimeMs(dir) {
  try {
    return statSync(dir).mtimeMs
  } catch {
    return null
  }
}

/** Drop cache entries whose project no longer exists. */
export function pruneProjects(projects, liveNames) {
  const live = new Set(liveNames)
  for (const key of [...projects.keys()]) if (!live.has(key)) projects.delete(key)
  return projects
}

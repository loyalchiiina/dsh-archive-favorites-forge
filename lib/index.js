// dsh-archive-favorites-forge — host half.
//
// WHAT THIS PLUGIN IS
// -------------------
// DSH ships an archive feature (the Workspace registry keeps a global
// `archivedSessionIds` set and `@deepseek-ai/dsh-client-ui-workspace` renders
// the sidebar rows and the "archived only" filter). That shipped feature has no
// favorites, no batch delete, and no copy-id/copy-path affordance.
//
// This plugin adds those three things WITHOUT touching a single official file.
// The client half attaches to documented official slot points; the host half
// (this file) owns only what a browser cannot own: a durable favorites set, the
// transcript-path resolver, and a small JSON HTTP surface.
//
// 0.25.0 — SESSION MANAGER FOLDED IN
// ----------------------------------
// The three features of the standalone `dsh-session-manager` plugin now live
// here as well, so one install covers both halves of "session housekeeping":
//
//   ① permanent delete of one conversation      (already here, unchanged)
//   ② EDIT AND RESEND a user message, and
//      UNDO a turn                              -> `injectTurnActions` (client)
//   ③ FILE SNAPSHOTS so ② can also restore the
//      files that the undone turns had edited    -> this file
//
// ③ is the reason the host half grew: a browser cannot read or write a file on
// disk, so every snapshot and every restore has to happen here. ② is pure
// client work EXCEPT for the two questions only the host can answer —
// "what did this turn say, and where does it start?" (`/session-turn-info`)
// and "put the files back to that moment" (`/session-files-restore`).
//
// 🔴 ONE DELETE IMPLEMENTATION, NOT TWO. The upstream session-manager shipped
// its own six-step `/api/session-delete`; that is NOT copied here. `handleDelete`
// below is strictly better (six guards, symlink check, EBUSY retry, favourite
// protection) and is the only code that removes a session directory. The
// edit/undo flow's final step therefore calls the SAME handler through the
// SAME `/delete` route, with one explicit option (`replace`) described at its
// definition. Two deletion code paths on one machine is how a "guarded" delete
// becomes an unguarded one by accident.
//
// WHY THE HOST OWNS THE FAVORITES SET
// -----------------------------------
// Renderer `localStorage` is origin-scoped, so the desktop shell and a remote
// browser view do not share it. A file under `~/.dsh/data/` survives a profile
// switch, a reinstall, and both ends.
//
// WHAT IT DELIBERATELY DOES NOT DO
// --------------------------------
//  * It never writes the Workspace registry, never writes a session transcript,
//    and never mutates another plugin's internals. A favorite whose session no
//    longer exists is simply ignored at read time.
//  * It does not delete anything unless `POST /delete` is called explicitly,
//    and that route is guarded (see `handleDelete`). Nothing runs on boot.
//
// HOST HALF IS RESTART-ONLY: `lib/index.js` has no watcher in this harness, so
// a change here needs a DSH restart. The client bundle reloads on HMR.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  readdirSync,
  statSync,
  rmSync,
  appendFileSync,
  copyFileSync,
} from 'node:fs'
import { readFile, readdir, stat, lstat, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, basename, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
// `zstdDecompressSync` is the ONLY reason this module needs zlib. A session log
// is a MULTI-FRAME zstd stream and there is no pure-JS decoder in this harness,
// so without it "edit and resend" could not read a turn's own text at all.
// It exists from Node 22.15; `engines` allows ^22.19.0 and >=24, so every
// supported runtime has it. `readSessionEvents` still guards the call, so an
// older runtime degrades to "no log" instead of throwing at import time.
import zlib from 'node:zlib'
// The ungrouped-bucket guard lives in its own module so that "why does the
// sidebar show 未分组" has exactly one place to look. It is self-contained: it
// imports nothing from `@deepseek-ai/*` and takes every service off `ctx`, so
// pulling it in here adds no dependency and cannot create a cycle.
import {
  diagnoseUngrouped,
  cleanupUngrouped,
  diagnoseGhostCache,
  cleanupGhostCache,
  explainUngrouped,
  UNGROUPED_GUARD_VERSION,
} from './ungrouped-guard.js'
import { scanSnapshotUsage, cleanupSnapshotUsage, SNAPSHOT_USAGE_VERSION } from './snapshot-usage.js'

export const name = 'dsh-archive-favorites-forge'
// ONLY `webServer` is a hard dependency. `sessionPersistence`,
// `workspaceRegistry`, `sessionController` and `sessions` are all reached
// through `ctx.get(...)` because they are optional: a deployment that mounts
// this plugin without, say, the registry should still serve favourites and copy
// paths rather than failing to activate entirely.
export const inject = ['webServer']

// NO `Config` export on purpose.
//
// Cordis resolves a plugin's config through `resolveConfig`, which calls
// `.validate()` on whatever the module exports as `Config`. A plain object
// therefore throws
//
//     TypeError: Cannot read properties of undefined (reading 'validate')
//
// and the WHOLE plugin fails to activate — silently, from the user's point of
// view, because the only trace is one warning line in the host log. That is
// exactly what happened on this plugin's first install: the routes never
// registered, so "copy path" answered 404 while "copy id" (purely client-side)
// kept working. The fix is to export no schema at all and read `config`
// defensively, which is what every other working local plugin does.
//
// (`dsh-chat-image-lightbox`, `dsh-model-fold` and `dsh-todo-float-ball` all
// follow this same shape: export `name` + `inject` + `apply` only.)

const ROUTE_PREFIX = '/plugins/dsh-archive-favorites-forge'

const PKG_VERSION = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

/** Accept only requests from this machine. */
function isLoopback(req) {
  const address = String(req.socket?.remoteAddress ?? '').toLowerCase()
  if (address === '::1') return true
  if (address.startsWith('::ffff:')) return address.slice(7).startsWith('127.')
  return address.startsWith('127.')
}

// ---------------------------------------------------------------------------
// Durable favorites: { version, favorites: { [sessionId]: { at, title, cwd } } }
// Stored at ~/.dsh/data/<plugin>/favorites.json — outside node_modules, so a
// package reinstall does not take the user's stars with it.
// ---------------------------------------------------------------------------

const STATE_VERSION = 1

// `DSH_AFF_STATE_ROOT` exists so the probe suite can isolate the store instead
// of reading and writing the developer's real one. It is not a user-facing
// setting: production always resolves to the home directory.
const stateRootDir = () => process.env.DSH_AFF_STATE_ROOT || join(homedir(), '.dsh', 'data', name)
const stateDir = () => stateRootDir()
const statePath = () => join(stateDir(), 'favorites.json')
const emptyState = () => ({ version: STATE_VERSION, favorites: {} })

function readState() {
  try {
    const parsed = JSON.parse(readFileSync(statePath(), 'utf8'))
    const favorites = parsed?.favorites
    if (favorites === null || typeof favorites !== 'object' || Array.isArray(favorites)) return emptyState()
    // Rebuild rather than trust: a hand-edited file must not be able to plant
    // arbitrary keys in the object we hand back to the renderer.
    const clean = {}
    for (const [key, value] of Object.entries(favorites)) {
      if (typeof key !== 'string' || key.length === 0) continue
      if (value === null || typeof value !== 'object') continue
      clean[key] = {
        at: typeof value.at === 'string' ? value.at : new Date(0).toISOString(),
        title: typeof value.title === 'string' ? value.title : '',
        cwd: typeof value.cwd === 'string' ? value.cwd : '',
      }
    }
    return { version: STATE_VERSION, favorites: clean }
  } catch {
    // Missing, unreadable, or corrupt: an empty set is the only safe answer,
    // because the alternative is failing the caller's list render.
    return emptyState()
  }
}

function writeState(next) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  // Write then rename, so a crash mid-write cannot leave a truncated file that
  // would read back as "the user has no favorites".
  const tmp = join(dir, `.favorites.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8')
  renameSync(tmp, statePath())
}

// ---------------------------------------------------------------------------
// Session catalogue (host side).
//
// A session id in the client is `session-<uuid>`; on disk the directory is the
// bare `<uuid>` under `--<normalized-cwd>--/`, and the log file is named after
// the format generation it stores. We probe the known names instead of guessing
// one, so a harness bump that changes the generation keeps working.
// ---------------------------------------------------------------------------

const LOG_BASENAMES = [
  'session.v4.jsonl.zstd',
  'session.v4.jsonl',
  'session.v3.jsonl.zstd',
  'session.v3.jsonl',
  'session.jsonl.zstd',
  'session.jsonl',
]

const sessionsRoot = () => process.env.DSH_AFF_SESSIONS_ROOT || join(homedir(), '.dsh', 'sessions')

/**
 * Where the harness keeps per-session projection caches.
 *
 * 🔴 THIS IS THE OTHER HALF OF A SESSION. Deleting the artifact directory is not
 * enough: the projection cache under `storages/session_projcache/sessions/<id>.json`
 * survives, and on the next boot the running instance still holds a title, a
 * token count and a turn outline for a conversation whose directory is gone. Those
 * orphan records render under 未分组, and no directory scan can see them — which is
 * exactly why "delete a conversation, restart, the bucket comes back" kept
 * happening. Measured on this machine: 984 cache files vs 657 session directories,
 * i.e. 364 orphans totalling 9.77 MB.
 */
const projCacheRoot = () => process.env.DSH_AFF_PROJCACHE_ROOT
  || join(homedir(), '.dsh', 'storages', 'session_projcache', 'sessions')

/**
 * Best-effort removal of one session's projection cache file.
 *
 * Tries both spellings (bare uuid and `session-<uuid>`), because a machine that
 * has been upgraded across harness generations carries both. Never throws: a
 * leftover cache file costs one phantom row, not a failed delete.
 */
function dropProjectionCache(sessionId) {
  const root = projCacheRoot()
  const bare = bareId(sessionId)
  const candidates = [join(root, `${bare}.json`), join(root, `${sessionId}.json`)]
  const removed = []
  for (const file of candidates) {
    try {
      if (existsSync(file)) {
        rmSync(file, { force: true })
        removed.push(file)
      }
    } catch {
      // Ignored on purpose — see the note above.
    }
  }
  return removed
}

/**
 * The session's directory name: the API id without its `session-` prefix.
 *
 * NOTE: this is NOT the only form found on disk. Older materialisations used the
 * full `session-<uuid>` directory name, and both forms coexist on a machine that
 * has been upgraded across harness generations (measured: 96 prefixed and 92
 * bare on this one). `sessionDirNames` yields both, and callers try each.
 */
function bareId(sessionId) {
  const text = String(sessionId ?? '')
  return text.startsWith('session-') ? text.slice('session-'.length) : text
}

/** Every directory name a session's artifact may live under, best guess first. */
function sessionDirNames(sessionId) {
  const text = String(sessionId ?? '')
  const bare = bareId(text)
  const names = []
  if (bare.length > 0) names.push(bare)
  if (text.length > 0 && text !== bare) names.push(text)
  return names
}

/**
 * Reproduce the jsonl backend's readable project directory name for a cwd.
 *
 * The rule (verified against the real directory names on disk):
 *   * a run of one or more separators (`\`, `/`, `:`) collapses to a SINGLE
 *     dash — `C:\Users` becomes `C-Users`, NOT `C--Users`;
 *   * ASCII printable characters pass through except the space, which is
 *     escaped like any other non-printable;
 *   * every other code point (space included) is escape-t `~XXXX` in upper-case
 *     hex with at least four digits, so a CJK path stays readable.
 *
 * Getting this wrong is silent and expensive: the computed path simply does not
 * exist, and "copy file path" hands the user a dead link.
 */
function projectDirName(cwd) {
  if (typeof cwd !== 'string' || cwd.length === 0) return '_no-cwd'
  let out = ''
  let lastWasDash = false
  for (const ch of cwd) {
    const code = ch.codePointAt(0)
    if (ch === '\\' || ch === '/' || ch === ':') {
      if (lastWasDash) continue
      out += '-'
      lastWasDash = true
      continue
    }
    lastWasDash = false
    if (code >= 0x21 && code < 0x7f) out += ch
    else out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
  }
  return `--${out}--`
}

/** Read the workspace registry (read-only) to map a session to its owning cwd. */
async function readWorkspaceRecords() {
  const file = process.env.DSH_AFF_WORKSPACE_FILE || join(homedir(), '.dsh', 'storages', 'workspace.json')
  const parsed = JSON.parse(await readFile(file, 'utf8'))
  const table = parsed?.tables?.workspaces
  if (table === null || typeof table !== 'object') return []
  return Object.entries(table).map(([workspaceId, record]) => ({
    workspaceId,
    path: typeof record?.path === 'string' ? record.path : '',
    title: typeof record?.title === 'string' ? record.title : '',
    sessionIds: Array.isArray(record?.sessionIds) ? record.sessionIds.map(String) : [],
  }))
}

/** Look for the log file of a session inside a specific project directory. */
async function probeLog(projectDir, sessionId) {
  if (typeof projectDir !== 'string' || projectDir.length === 0) return null
  for (const dirName of sessionDirNames(sessionId)) {
    const sessionDir = join(projectDir, dirName)
    for (const logBase of LOG_BASENAMES) {
      const candidate = join(sessionDir, logBase)
      try {
        if ((await stat(candidate)).isFile()) return candidate
      } catch {}
    }
  }
  return null
}

/**
 * Best-effort absolute transcript path for one session, or null.
 *
 * Order: the live header's cwd (authoritative), then the owning workspace path,
 * then a scan of every project directory. Only the last one is slow, and it is
 * reached only when the cwd is genuinely unknown. The caller renders "unknown"
 * rather than a wrong path when this returns null.
 */
async function transcriptPathFor(sessionId, ctx) {
  if (String(sessionId ?? '').length === 0) return null

  let cwd = null
  try {
    cwd = ctx?.get?.('sessions')?.get?.(String(sessionId))?.header?.cwd ?? null
  } catch {}
  if (typeof cwd !== 'string' || cwd.length === 0) {
    cwd = null
    try {
      for (const record of await readWorkspaceRecords()) {
        if (record.sessionIds.includes(String(sessionId))) {
          cwd = record.path
          break
        }
      }
    } catch {}
  }
  if (cwd !== null) {
    const hit = await probeLog(join(sessionsRoot(), projectDirName(cwd)), sessionId)
    if (hit !== null) return hit
  }

  // Fallback: scan every project directory. This is the path a session takes
  // when it is archived-and-forgotten (the registry may no longer list it) and
  // it is why "copy path" still works for old conversations.
  try {
    const root = sessionsRoot()
    if (!existsSync(root)) return null
    const entries = await readdir(root, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const hit = await probeLog(join(root, entry.name), sessionId)
      if (hit !== null) return hit
    }
  } catch {}
  return null
}

// ---------------------------------------------------------------------------
// Idle auto-archive ("超时归档").
//
// Archiving is a REGISTRY operation, not a file operation: the shipped feature
// keeps `archivedSessionIds` in the workspace registry and that is what hides a
// conversation from every surface. So we call the registry's own
// `archiveSession()` and never write the state file — a running DSH holds that
// state in memory and would overwrite an external edit.
//
// The idle test uses `max(createdAt, lastPromptAt)` via the session controller
// when it is available, because that is the same number the shipped UI shows
// next to a row. Falling back to a file's mtime would be wrong: the app
// rewrites mtimes during normal operation.
// ---------------------------------------------------------------------------

function toMillis(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

/**
 * Catalogue of sessions with an authoritative activity time, best effort.
 *
 * 🔴 THE RETURN SHAPE IS `{ items: [...] }`, NOT AN ARRAY.
 * `sessionController.list()` is declared `async list(_request, signal)` and
 * returns `{ items: await this.listState.list(signal) }`. An earlier version of
 * this function tested `Array.isArray(result)`, which is false for that object,
 * so the catalogue silently came back EMPTY and the idle preview read "0
 * conversations" no matter what threshold was set — a wrong answer with no
 * error, which is the worst kind. Both shapes are accepted here, and the field
 * names are read defensively because the summary spelling is `sessionId`.
 */
async function activityCatalogue(ctx) {
  const controller = ctx?.get?.('sessionController')
  const out = []
  if (!controller || typeof controller.list !== 'function') return out
  try {
    const result = await controller.list()
    const items = Array.isArray(result)
      ? result
      : (Array.isArray(result?.items) ? result.items : null)
    if (items === null) return out
    for (const item of items) {
      const id = item?.sessionId ?? item?.id
      if (id === undefined || id === null) continue
      const at = toMillis(item?.updatedAt) ?? toMillis(item?.createdAt)
      // The conversation's title, so an exported list reads as a list of
      // conversations rather than a wall of uuids. It is the harness's own
      // `title` session projection (key "title", a string or null); when
      // projections are absent the title stays empty.
      let title = ''
      try {
        const projected = item?.projections?.values?.title
        if (typeof projected === 'string') title = projected
      } catch {}
      // `blank` means "never had a message" — the sidebar renders those as
      // 新会话 rather than 未命名. Carrying the flag lets the export use the
      // SAME words the sidebar does, so a row can be matched by eye.
      const blank = item?.blank === true
      // The working directory identifies which workspace group the row sits
      // under, which is what makes an untitled conversation findable at all.
      const cwd = typeof item?.cwd === 'string' ? item.cwd : ''
      out.push({ id: String(id), updatedAt: at, title, blank, cwd })
    }
  } catch {}
  return out
}

/**
 * Idle sessions older than `hours`, oldest first. Pure, so it is probe-testable.
 *
 * The unit is HOURS, not days. A day-granular control cannot express "archive
 * everything quiet since this morning", and its fractional values (0.5 days)
 * render badly; hours is the unit a person can actually reason about here.
 */
/**
 * The comparison form of a session id: the bare uuid.
 *
 * 🔴 THE ID IS SPELLED TWO WAYS IN THE SAME STORE, AND BOTH MUST COMPARE EQUAL.
 * Measured on this machine: `workspace.json` holds 105 archived ids of which
 * **22 are bare uuids and 83 carry the `session-` prefix**. A plain `Set.has()`
 * on the full id therefore fails to recognise the 22 bare ones, they were
 * treated as "not archived", and the idle preview listed every one of them —
 * the count read 93 instead of 2. Normalising both sides to the bare uuid is
 * the only comparison that is correct for either spelling.
 */
function idKey(sessionId) {
  const text = String(sessionId ?? '')
  return text.startsWith('session-') ? text.slice('session-'.length) : text
}

/**
 * Keys of sessions that have never carried a message ("blank").
 *
 * A blank session is the provisional New Session slot. It has no content to
 * archive or delete, and — decisively — the shipped sidebar hides every blank
 * session except the currently selected one:
 *
 *     if (session.blank && session.id !== current) return false;   // sessionVisible
 *
 * So a blank session in a candidate list is one the user cannot look at, which
 * makes the list unverifiable. Verified against the harness source, not assumed.
 */
async function blankSessionKeys(ctx) {
  const keys = new Set()
  try {
    const catalogue = await activityCatalogue(ctx)
    for (const entry of catalogue) if (entry.blank === true) keys.add(idKey(entry.id))
  } catch {}
  return keys
}

/**
 * Idle sessions older than `hours`, oldest first. Pure, so it is probe-testable.
 *
 * The unit is HOURS: a day-granular control cannot express "quiet since this
 * morning", and its fractional values render badly.
 */
function selectIdleSessions(catalogue, archivedIds, hours, now) {
  const threshold = Number(hours)
  // A non-positive or non-finite threshold would put the cutoff in the future
  // and mark EVERY session idle — a whole-archive accident. Refuse.
  if (!Number.isFinite(threshold) || threshold <= 0) return []
  const cutoff = now - threshold * 3600000
  // Normalise BOTH sides; see `idKey`.
  const archived = new Set((Array.isArray(archivedIds) ? archivedIds : []).map(idKey))
  const picked = []
  for (const entry of catalogue) {
    if (entry.updatedAt === null || !Number.isFinite(entry.updatedAt) || entry.updatedAt <= 0) continue
    if (archived.has(idKey(entry.id))) continue
    // 🔴 A BLANK SESSION IS NOT A CANDIDATE, AND USUALLY NOT EVEN VISIBLE.
    //
    // A blank session has never carried a message — it is the provisional
    // "New Session" slot. The shipped sidebar shows only the CURRENT one:
    //
    //     if (session.blank && session.id !== current) return false;   // sessionVisible
    //
    // Archiving one achieves nothing (there is no content to put away), and
    // every other blank session cannot be seen in the list at all — so a
    // candidate the user cannot look at is a candidate they cannot check. That
    // is exactly how a list containing 新会话 became unverifiable.
    if (entry.blank === true) continue
    if (entry.updatedAt >= cutoff) continue
    picked.push(entry)
  }
  picked.sort((a, b) => a.updatedAt - b.updatedAt)
  return picked
}

// ---------------------------------------------------------------------------
// Delete.
//
// There is NO official session-delete RPC in this harness generation — the
// shipped UI never deletes a session. We therefore remove the session's own
// artifact directory, which is what "delete this conversation" physically
// means, and we do it defensively:
//
//   * a favorited id is refused (the whole point of the feature);
//   * a resolved directory outside the sessions root is refused;
//   * a symlink is refused;
//   * each id is reported separately, so one failure never aborts the batch.
//
// Irreversible — which is why the client asks for confirmation first.
//
// `options.replace` — THE ONE EXPLICIT EXCEPTION TO THE FAVOURITE GUARD.
// ------------------------------------------------------------------------
// "Edit and resend" / "undo this turn" end by removing the ORIGINAL session,
// because its replacement (the forked child, truncated at the turn boundary) is
// now the conversation. The original is dead weight: keeping it would leave two
// copies of the same history in the sidebar, one of them a stale prefix.
//
// The favourite guard has to be skipped for that ONE case, and only that case:
//
//   * A favourite is a "keep this" signal about a CONVERSATION. In the replace
//     flow the user is not asking to delete a favourite — they are editing a
//     message, and the original disappears as a CONSEQUENCE of the operation
//     they explicitly confirmed. Refusing here would make "edit and resend"
//     silently fail on exactly the conversations the user cares most about.
//   * It is not a data-loss loophole. `readState().favorites` keys the id, and
//     the row for a deleted id is simply ignored at read time (documented at the
//     top of this file), so the stale favourite entry costs nothing and is
//     cleaned up the next time the user un-stars.
//
// 🔴 EVERY OTHER GUARD STAYS ON IN REPLACE MODE. This is a parameter, not a
// separate code path, precisely so that cannot drift: the path must still
// resolve inside the sessions root, must still not BE the root, must still not
// be a symlink, must still be a directory, and EBUSY/EPERM still gets its three
// retries. A replace that cannot be performed safely must fail, and the caller
// reports it — never fall back to an unguarded `rm`.
//
// It is threaded as a plain boolean argument rather than a property of
// `payload`, so a client cannot turn the guard off by adding a field to a
// `/delete` body: the route below never forwards anything but `false`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// 🔴 NEVER READ `ctx.config` WITHOUT DECLARING IT.
//
// `ctx.<name>` is a DECLARED-PROPERTY access, not a plain lookup: Cordis throws
//
//     cannot get property "config" without inject
//
// for any property the plugin did not list in its `inject`. That error surfaced
// to the user as "未删除：cannot get property 'config' without inject" on every
// delete attempt — the whole route died before touching a single file.
//
// The fix is structural, not a try/catch: `apply(ctx, config)` receives the
// resolved config as its second argument, so it is threaded through explicitly
// and `ctx.config` is never accessed at all. `ctx.get(...)` remains the way to
// reach OPTIONAL services, because `get` is a real method on every context.
// ---------------------------------------------------------------------------

async function handleDelete(payload, ctx, settings, options = {}) {
  const requested = Array.isArray(payload?.sessionIds) ? payload.sessionIds.map(String) : []
  const favorites = readState().favorites
  const max = Number(settings?.maxDeletePerCall ?? 500)
  // Only ever set by this module's own edit/undo flow; see the note above.
  const replace = options?.replace === true

  if (requested.length === 0) return { deleted: [], skipped: [], failures: [] }
  if (requested.length > max) {
    return { error: `refusing to delete ${requested.length} sessions in one call (max ${max})` }
  }

  const deleted = []
  const skipped = []
  const failures = []
  const root = sessionsRoot().toLowerCase().replace(/[\\/]+$/, '')
  // Normalise the favourite set once; see `idKey`.
  const favoriteKeys = new Set(Object.keys(favorites).map(idKey))

  for (const sessionId of requested) {
    // Guard 1: never delete a favorite. The client filters too, but the host is
    // the last line of defence and must not trust its caller. Compared by
    // normalised id so a favourite stored under either spelling is honoured.
    //
    // Skipped ONLY in replace mode, where the caller is this plugin's own
    // edit/undo flow and the conversation is being superseded by its own fork —
    // see the `options.replace` note above. Every later guard still runs.
    if (!replace && favoriteKeys.has(idKey(sessionId))) {
      skipped.push({ sessionId, reason: 'favorited' })
      continue
    }
    try {
      const path = await transcriptPathFor(sessionId, ctx)
      if (path === null) {
        // "not-found" has two very different causes and the user needs to know
        // which: a conversation that was already deleted (harmless — the row is
        // just stale), versus an id whose transcript lives somewhere we could
        // not resolve (a real fault). Reporting the bare token made the first
        // case look like a failure.
        skipped.push({ sessionId, reason: 'not-found', detail: 'transcript already gone or unresolvable' })
        ctx?.logger?.info?.(`${name}: delete ${sessionId}: no transcript found (already deleted?)`)
        continue
      }
      const sessionDir = dirname(path)
      const normalized = sessionDir.toLowerCase().replace(/[\\/]+$/, '')
      // Guard 2: the thing we are about to remove must sit strictly inside the
      // sessions root and be a real directory. A resolved path outside the root
      // means our own resolution went wrong — refuse rather than act.
      if (normalized !== root && !normalized.startsWith(root + '\\') && !normalized.startsWith(root + '/')) {
        failures.push({ sessionId, reason: 'outside-sessions-root' })
        continue
      }
      if (normalized === root) {
        failures.push({ sessionId, reason: 'refused-sessions-root' })
        continue
      }
      const info = await lstat(sessionDir)
      if (info.isSymbolicLink()) {
        failures.push({ sessionId, reason: 'refused-symlink' })
        continue
      }
      if (!info.isDirectory()) {
        failures.push({ sessionId, reason: 'not-a-directory' })
        continue
      }
      // A session the running process still holds open cannot be removed on
      // Windows (the directory has an open handle). Retry briefly — the handle
      // is usually released once the session falls idle — and report the real
      // OS error when it is not, instead of a generic failure the UI cannot
      // explain.
      let lastError = null
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await rm(sessionDir, { recursive: true, force: true })
          lastError = null
          break
        } catch (error) {
          lastError = error
          await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)))
        }
      }
      if (lastError !== null) {
        const code = lastError?.code ?? 'unknown'
        const hint = code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
          ? ' (the session is still open in the running app — close the conversation and retry)'
          : ''
        failures.push({ sessionId, reason: `${code}${hint}` })
        ctx?.logger?.warn?.(`${name}: delete ${sessionId} failed: ${String(lastError?.message ?? lastError)}`)
        continue
      }
      deleted.push(sessionId)
      ctx?.logger?.info?.(`${name}: deleted ${sessionId}`)

      // 🔴 KILL THE PROJECTION CACHE TOO, OR THE ROW COMES BACK.
      //
      // The artifact directory is only one half of a session. The other half is
      // `storages/session_projcache/sessions/<id>.json`, which holds the title,
      // token usage and turn outline. Delete only the directory and the next boot
      // still knows this conversation existed, so it renders under 未分组 as a row
      // nobody can open — and no directory scan can find it, because there is no
      // directory. Every delete used to manufacture one of those. Drop it here so
      // deleting a conversation actually finishes the job.
      try {
        const dropped = dropProjectionCache(sessionId)
        if (dropped.length > 0) {
          ctx?.logger?.info?.(`${name}: dropped projection cache for ${sessionId} (${dropped.length} file(s))`)
        }
      } catch (error) {
        ctx?.logger?.warn?.(`${name}: could not drop projection cache for ${sessionId}: ${String(error?.message ?? error)}`)
      }

      // 🔴 TELL THE CLIENT, OR THE ROW STAYS ON SCREEN.
      //
      // Removing the artifact directory is a FILESYSTEM operation; the running
      // app holds the session in memory and the browser holds the list it last
      // received. Nothing about deleting files invalidates either, which is why
      // a successful delete left the row visible until the next reload.
      //
      // The shipped UI drops a row on `api-session/removed` — its own session
      // controller emits exactly this from `session/disposed`, and the client
      // listens through `ctx.remote.$on` → `sessions.handleSessionRemoved`. So
      // we emit the same event ourselves. This is the documented client
      // contract, not a private shortcut.
      try {
        ctx?.emit?.('api-session/removed', sessionId)
        ctx?.logger?.info?.(`${name}: emitted api-session/removed for ${sessionId}`)
      } catch (error) {
        ctx?.logger?.warn?.(`${name}: could not emit api-session/removed: ${String(error?.message ?? error)}`)
      }

      // Drop the id from its workspace record too. The registry keeps a
      // `sessionIds` slot for every member, and leaving a slot that points at a
      // deleted log would re-materialise a broken row after a reload.
      try {
        const registry = ctx?.get?.('workspaceRegistry')
        const entities = registry && typeof registry.list === 'function' ? registry.list() : null
        if (Array.isArray(entities)) {
          for (const entity of entities) {
            const record = entity?.record ?? entity
            const ids = record?.sessionIds
            const key = idKey(sessionId)
            if (!Array.isArray(ids) || !ids.some((id) => idKey(id) === key)) continue
            const next = ids.filter((id) => idKey(id) !== key)
            // Go through the entity's own write path when it exposes one, so the
            // durable record and every cache stay consistent.
            if (typeof entity?.mutate === 'function') {
              await entity.mutate((current) => ({ ...current, sessionIds: next }))
            } else if (typeof registry.rewriteSessionIds === 'function') {
              await registry.rewriteSessionIds(record.workspaceId ?? record.id, next)
            }
            break
          }
        }
      } catch (error) {
        // Best effort: the row is already gone from the client, and a stale
        // registry slot only costs one unopenable entry.
        ctx?.logger?.warn?.(`${name}: could not drop ${sessionId} from its workspace record: ${String(error?.message ?? error)}`)
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      failures.push({ sessionId, reason: message })
      ctx?.logger?.warn?.(`${name}: delete ${sessionId} threw: ${message}`)
    }
  }
  return { deleted, skipped, failures }
}

// ---------------------------------------------------------------------------
// 🔴 THE ARCHIVE SET IS NOT A LIST OF CONVERSATIONS THE USER CAN SEE.
//
// Measured on this machine, all of these are true at once:
//
//     archivedSessionIds (official registry)   106
//     conversations the sidebar lists           83
//     archived ∩ sidebar-visible                78
//     archived but NOT sidebar-visible          28   <- orphans
//     sidebar-visible ∩ not archived             5   <- the real idle pool
//
// The 28 orphans are archived sessions with no `cwd`, and
// `sessionController.list()` skips exactly those (`if (record.header.cwd ===
// void 0) continue`), so the sidebar never renders them. Offering them as delete
// candidates produced "归档共 105 条 … 未收藏 105 条（可删除）" against a sidebar
// showing 83 conversations — a number the user could see was impossible.
//
// So every candidate list is the INTERSECTION of the archive set and the
// sessions the sidebar actually lists. The archive set alone decides what is
// archived; the visible set alone decides what may be acted on.
// ---------------------------------------------------------------------------

/**
 * A coarse, human-readable age such as "26 天 3 小时".
 *
 * Coarse on purpose: an exported list is read by a person deciding what to
 * archive, and "26 天 3 小时" answers that far better than an ISO timestamp or a
 * count of milliseconds. Only the two largest units are printed.
 */
function humanDuration(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return ''
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return '不到 1 分钟'
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    const restMin = minutes % 60
    return restMin === 0 ? `${hours} 小时` : `${hours} 小时 ${restMin} 分钟`
  }
  const days = Math.floor(hours / 24)
  const restHours = hours % 24
  return restHours === 0 ? `${days} 天` : `${days} 天 ${restHours} 小时`
}

// ---------------------------------------------------------------------------
// 🔴 "WHAT THE SIDEBAR LISTS" IS NOT `sessionController.list()`.
//
// Measured on this machine:
//
//     workspace records' sessionIds (the sidebar's own membership)   83
//     sessionController.list()  (every stored session with a cwd)   167
//     archivedSessionIds                                            169
//
// Using the controller list as "visible" still produced a batch-delete
// candidate count larger than the number of conversations the sidebar shows —
// the symptom the user kept reporting. The sidebar renders
// `workspace.sessionIds` (plus ungrouped strays), so THAT is the membership
// set, and it comes from the same registry service as the archive set.
// ---------------------------------------------------------------------------

/** Session keys the sidebar actually lists, from the workspace registry. */
function sidebarSessionKeys(ctx) {
  const keys = new Set()
  try {
    const registry = ctx?.get?.('workspaceRegistry')
    const entities = registry && typeof registry.list === 'function' ? registry.list() : null
    if (Array.isArray(entities)) {
      for (const entity of entities) {
        const record = entity?.record ?? entity
        const ids = record?.sessionIds
        if (!Array.isArray(ids)) continue
        for (const id of ids) keys.add(idKey(id))
      }
    }
  } catch {
    // A not-yet-started registry reports itself through `readArchivedSet`; here
    // an empty set means "cannot confirm", and callers treat that as "nothing to
    // act on" rather than over-reporting.
  }
  return keys
}

// ---------------------------------------------------------------------------
// The ONE authoritative archive set — OFFICIAL SOURCE ONLY.
//
// 🔴 THE FILE IS NOT THE ARCHIVE. `workspace.json` is a historical
// sidebar listed 82 conversations and the live registry held 83. Using it
// produced nonsense — a batch-delete candidate list larger than the number of
// conversations that exist, and an idle preview offering 93 sessions when 2
// were genuinely idle.
//
// The user's ruling: the harness's own view is the truth. Anything only the
// local file remembers is a leftover, and leftovers must not influence what we
// show or delete. Other machines have their own leftovers, so there is nothing
// to "repair" here — just stop reading the file.
//
// Therefore: read `ctx.workspaceRegistry.archivedSessionIds` — the same live set
// the shipped sidebar renders from — and if it is unavailable, return `null`
// rather than a plausible-but-wrong substitute. Callers must distinguish
// "unavailable" from "empty", because treating unavailable as empty would make
// every archived conversation look idle.
// ---------------------------------------------------------------------------

/** Keys derived from a catalogue — used only to sanity-check counts. */
function visibleKeysOf(catalogue) {
  const keys = new Set()
  for (const entry of catalogue) keys.add(idKey(entry.id))
  return keys
}

async function readArchivedSet(ctx) {
  let registry = null
  try {
    registry = ctx?.get?.('workspaceRegistry') ?? null
  } catch (error) {
    ctx?.logger?.warn?.(`${name}: workspaceRegistry lookup threw: ${String(error?.message ?? error)}`)
    return { ids: null, source: 'unavailable', reason: 'lookup-threw' }
  }
  if (registry === null) {
    ctx?.logger?.warn?.(`${name}: workspaceRegistry is not resolvable via ctx.get`)
    return { ids: null, source: 'unavailable', reason: 'service-missing' }
  }

  // The service EXISTS long before it is USABLE. `archivedSessionIds` is a
  // getter over `requireState()`, which throws
  //     "workspace registry is not started yet"
  // until the service's async `init()` has opened its storage domain. Collapsing
  // that transient state into "unavailable" is what left the UI permanently
  // stuck on "归档来源：读取中…", because every poll took the error path and the
  // client had nothing to render. The two cases are now distinct.
  try {
    const ids = registry.archivedSessionIds
    if (!Array.isArray(ids)) {
      return { ids: null, source: 'unavailable', reason: 'not-an-array' }
    }
    return { ids: ids.map(String), source: 'registry' }
  } catch (error) {
    const message = String(error?.message ?? error)
    const starting = message.includes('not started yet')
    // A not-yet-started registry is expected during boot, so it is not logged as
    // a warning; anything else is a real fault worth a log line.
    if (!starting) {
      ctx?.logger?.warn?.(`${name}: reading archivedSessionIds threw: ${message}`)
    }
    return { ids: null, source: starting ? 'starting' : 'unavailable', reason: message }
  }
}

// ---------------------------------------------------------------------------
// FILE HISTORY — git-like snapshots, so "undo a turn" can also undo the files.
//
// WHY THE HOST MUST OWN THIS
// --------------------------
// The client can fork a conversation back to an earlier turn on its own (that
// is the harness's own branch mechanism). What it CANNOT do is put a file on
// disk back the way it was: a browser bundle has no filesystem access. So the
// file half of "edit and resend" / "undo this turn" lives here.
//
// HOW THE SNAPSHOT IS TAKEN
// -------------------------
// The host publishes `session/event` for every session event, and `tool/call`
// is published BEFORE the tool runs. The payload is
// `{ turn, step, callId, name, arguments }` with `arguments` a JSON string. For
// the three tools that write files we snapshot the target file's PRE-EDIT
// content at that instant, then let the call proceed:
//
//     <session dir>/history-file/manifest.jsonl   one line per snapshot:
//                                                 { seq, turn, time, tool, path, blob }
//     <session dir>/history-file/blobs/<sha256>   the pre-edit bytes, deduped
//                                                 by content hash
//
// 🔴 THE SNAPSHOT LIVES INSIDE THE SESSION DIRECTORY, ON PURPOSE. That makes it
// disappear with the conversation it belongs to — deleting a session (the whole
// point of the other half of this plugin) leaves no orphan snapshots to sweep
// up later. An earlier generation kept them under `~/.dsh/file-history/<id>`,
// which needed its own garbage collector and never got one.
//
// `blob: null` means the file did not exist at snapshot time (a `create`), so
// restoring means DELETING the file rather than writing bytes back.
//
// ROLLBACK SEMANTICS
// ------------------
// "Restore to keepSeq" means: for every path, take the EARLIEST record whose
// seq is greater than keepSeq — that is the state just before the first edit
// after the rollback point — and put it back. Then consume the ledger entries
// past keepSeq and any blob only they referenced, so `history-file/` keeps only
// the versions that are still ahead of the user.
//
// KNOWN LIMITS (v1, documented in README):
//   * a file edited by a terminal command (pwsh/bash) cannot be located
//     statically, so it is not snapshotted at all;
//   * a file the user edited BY HAND during the conversation WILL be
//     overwritten by a rollback — this is git-like semantics, not a merge;
//   * only ABSOLUTE paths are snapshotted. A relative path resolves against the
//     host process's cwd, so "snapshot" and "restore" would touch a file nobody
//     was talking about. Refusing is the only safe behaviour.
//   * a single file above 8 MB is skipped with a warning rather than copied —
//     the ledger would otherwise grow by hundreds of megabytes for a video.
// ---------------------------------------------------------------------------

const FILE_HISTORY_BLOB_LIMIT = 8 * 1024 * 1024

/**
 * Per-tool "which paths does this call touch" extractors.
 *
 * Only these three tools are listed because only these three are the harness's
 * file-writing surface, and each one spells its target differently:
 *
 *   str_replace_editor  `path` + `command` — but `view` READS, so it is not a
 *                       write and must not produce a snapshot (a snapshot per
 *                       read would bloat the ledger for no benefit);
 *   write               `file_path`, always a full overwrite;
 *   edit                `file_path`, a substring replacement.
 *
 * A tool that is not listed is silently ignored: an unknown tool's arguments
 * cannot be interpreted safely, and guessing would risk snapshotting (or worse,
 * restoring) the wrong file.
 */
const FILE_TOOL_PATHS = {
  str_replace_editor: (args) =>
    args.command !== 'view' && typeof args.path === 'string' && args.path !== '' ? [args.path] : [],
  write: (args) => (typeof args.file_path === 'string' && args.file_path !== '' ? [args.file_path] : []),
  edit: (args) => (typeof args.file_path === 'string' && args.file_path !== '' ? [args.file_path] : []),
}

/**
 * The session's own directory, or null.
 *
 * 🔴 THERE IS ALREADY A RESOLVER IN THIS FILE, AND IT IS THE ONE TO USE.
 * An earlier draft ported session-manager's `findSessionDir`, which builds the
 * directory name with `encodeSegment(sessionId)` and then scans every project
 * directory for it. That is a second, weaker implementation of what
 * `transcriptPathFor` already does: it only ever looks for the
 * `session-<uuid>` spelling (measured on this machine: 96 prefixed and 92 bare
 * directories coexist), and it ignores the authoritative cwd from the live
 * session header. `transcriptPathFor` tries the header's cwd first, then the
 * owning workspace, then falls back to the same full scan — so it is both
 * faster on the common path and correct for BOTH spellings. Everything below
 * therefore resolves through it and takes `dirname()`.
 *
 * Cost note: the cwd path is two `stat` calls; the full scan is only reached
 * for a session whose cwd is genuinely unknown. `recordToolCall` runs on every
 * tool call, so the fast path is the one that matters.
 */
async function sessionDirOf(sessionId, ctx) {
  const log = await transcriptPathFor(sessionId, ctx)
  return log === null ? null : dirname(log)
}

/** Where one session's snapshot ledger lives, or null when the session is gone. */
async function fileHistoryDir(sessionId, ctx) {
  const dir = await sessionDirOf(sessionId, ctx)
  return dir === null ? null : join(dir, 'history-file')
}

/**
 * Snapshot the pre-edit content of every file this tool call is about to touch.
 *
 * Called from the `session/event` listener on `tool/call`, i.e. BEFORE the tool
 * executes — which is the entire trick. Afterwards the original bytes are gone.
 *
 * Async only because resolving the session directory is async; the listener
 * fires it without awaiting and reports failures through the log, because a
 * failed snapshot must never break the conversation that triggered it.
 */
async function recordToolCall(sessionId, event, ctx) {
  if (!sessionId || !event || event.type !== 'tool/call') return
  const data = event.data ?? {}
  const extractor = FILE_TOOL_PATHS[data.name]
  if (!extractor) return
  let args = data.arguments
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args)
    } catch {
      return
    }
  }
  if (args === null || typeof args !== 'object') return
  const paths = extractor(args)
  if (paths.length === 0) return
  // Relative paths would resolve against the host process's cwd; see the
  // "KNOWN LIMITS" note above.
  const absolute = paths.filter((p) => isAbsolute(p))
  if (absolute.length === 0) return
  const dir = await fileHistoryDir(sessionId, ctx)
  if (dir === null) {
    // Normal for a session whose log has not been flushed yet; not an error.
    ctx?.logger?.warn?.(`${name}: no session dir for ${sessionId}, skipping file snapshot`)
    return
  }
  try {
    mkdirSync(join(dir, 'blobs'), { recursive: true })
  } catch (error) {
    ctx?.logger?.warn?.(`${name}: cannot create ${dir}: ${String(error?.message ?? error)}`)
    return
  }
  for (const target of absolute) {
    let blob = null
    try {
      if (existsSync(target) && statSync(target).isFile()) {
        const content = readFileSync(target)
        if (content.length > FILE_HISTORY_BLOB_LIMIT) {
          ctx?.logger?.warn?.(
            `${name}: skipping snapshot of ${target} (${content.length} bytes > ${FILE_HISTORY_BLOB_LIMIT})`,
          )
          continue
        }
        blob = createHash('sha256').update(content).digest('hex')
        const blobPath = join(dir, 'blobs', blob)
        // Content-addressed: the same bytes stored twice cost one blob, which
        // is what makes a long editing session affordable.
        if (!existsSync(blobPath)) writeFileSync(blobPath, content)
      }
      const entry = {
        seq: event.seq,
        turn: data.turn,
        time: event.time,
        tool: data.name,
        path: target,
        blob,
      }
      appendFileSync(join(dir, 'manifest.jsonl'), JSON.stringify(entry) + '\n')
    } catch (error) {
      ctx?.logger?.warn?.(`${name}: snapshot of ${target} failed: ${String(error?.message ?? error)}`)
    }
  }
}

/**
 * Read a session's event stream out of its zstd log, oldest first.
 *
 * 🔴 THE FILE IS A MULTI-FRAME ZSTD STREAM, NOT ONE FRAME. It is written as a
 * header frame followed by event frames, each starting with the magic
 * `28 B5 2F FD`. Decompressing the whole buffer at once fails; so does
 * `zstdDecompressSync` on the concatenation. The only reliable read is to find
 * every magic offset, decompress each slice separately and concatenate the
 * text. Verified against real logs on this machine, not assumed.
 *
 * The FIRST line of the decompressed text is the log header (session metadata),
 * not an event, so it is dropped. Every later line is one JSON event.
 *
 * Highest version wins: a format upgrade leaves `session.v3.jsonl.zstd` and
 * `session.v4.jsonl.zstd` side by side and only the newest holds the truth.
 *
 * @returns {Array<object>|null} null when there is no log at all.
 */
function readSessionEvents(sessionId, ctx) {
  return sessionDirOf(sessionId, ctx).then((dir) => {
    if (dir === null) return null
    if (typeof zlib.zstdDecompressSync !== 'function') {
      ctx?.logger?.warn?.(`${name}: zlib.zstdDecompressSync unavailable (Node too old) — cannot read turn text`)
      return null
    }
    let newest = null
    let newestVersion = -1
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      return null
    }
    for (const fileName of names) {
      const match = /^session(?:\.v(\d+))?\.jsonl\.zstd$/.exec(fileName)
      if (!match) continue
      const version = Number(match[1] ?? 0)
      if (version >= newestVersion) {
        newestVersion = version
        newest = fileName
      }
    }
    if (newest === null) return null
    const buf = readFileSync(join(dir, newest))
    const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
    let text = ''
    let start = buf.indexOf(magic)
    while (start !== -1) {
      const next = buf.indexOf(magic, start + 4)
      const frame = buf.subarray(start, next === -1 ? undefined : next)
      text += zlib.zstdDecompressSync(frame).toString('utf8')
      start = next
    }
    return text
      .split('\n')
      .filter((line) => line.trim())
      // First line is the log header, not an event.
      .slice(1)
      .map((line) => {
        try {
          return JSON.parse(line)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  })
}

/**
 * Every file-modifying tool call in the log, oldest first.
 *
 * 🔴 THE LOG, NOT THE LEDGER, IS THE SOURCE OF TRUTH FOR "WHICH FILES CHANGED".
 * A forked child session is rebuilt from its parent's events through
 * `Session.fromRestore`, which REPLAYS them without publishing `session/event`
 * — so none of the inherited edits were ever snapshotted. The log, however,
 * still contains every one of those `tool/call` records, inherited or not.
 * Anything that needs the complete set (the rollback preview, the log-based
 * reconstruction fallback) must read it from here.
 *
 * @returns {Promise<Array<{seq:number,path:string,tool:string,args:object}>>}
 */
async function collectLogChanges(sessionId, ctx) {
  const events = await readSessionEvents(sessionId, ctx)
  if (events === null) return []
  const out = []
  for (const event of events) {
    if (event.type !== 'tool/call') continue
    const data = event.data ?? {}
    const extractor = FILE_TOOL_PATHS[data.name]
    if (!extractor) continue
    let args = data.arguments
    if (typeof args === 'string') {
      try {
        args = JSON.parse(args)
      } catch {
        continue
      }
    }
    if (args === null || typeof args !== 'object') continue
    for (const target of extractor(args)) {
      if (!isAbsolute(target)) continue
      out.push({ seq: event.seq, path: target, tool: data.name, args })
    }
  }
  return out
}

/**
 * Rebuild a file's earlier content by REVERSING the logged edits, newest first.
 *
 * This is the fallback for a session with no ledger — in practice a forked
 * child, whose inherited history never triggered the snapshot listener (see
 * `collectLogChanges`). Each tool's arguments are invertible in a different
 * way, so each gets its own branch:
 *
 *   edit                       swap new_string back to old_string (all
 *                              occurrences when replace_all was set)
 *   str_replace_editor create  the file did not exist before -> delete it
 *   str_replace_editor replace swap new_str back to old_str
 *   str_replace_editor insert  remove the inserted new_str
 *   write                      a FULL OVERWRITE: the previous content is
 *                              nowhere in the log, so it cannot be reversed —
 *                              warn and leave the file alone rather than
 *                              writing a plausible-but-wrong version.
 *
 * The walk starts from the CURRENT disk content and moves backwards, which is
 * what makes it land exactly on "the file as it was at the rollback point".
 */
async function reverseApplyFromLog(sessionId, keepSeq, ctx) {
  const changes = (await collectLogChanges(sessionId, ctx)).filter((c) => c.seq > keepSeq)
  if (changes.length === 0) return { restored: [], warnings: [] }
  const byPath = new Map()
  for (const change of changes) {
    if (!byPath.has(change.path)) byPath.set(change.path, [])
    byPath.get(change.path).push(change)
  }
  const restored = []
  const warnings = []
  for (const [target, list] of byPath) {
    // Newest first: undo the most recent edit before the one before it.
    list.sort((a, b) => b.seq - a.seq)
    try {
      let existedBefore = true
      let content = existsSync(target) && statSync(target).isFile() ? readFileSync(target, 'utf8') : null
      for (const change of list) {
        const args = change.args
        if (change.tool === 'write') {
          warnings.push(`cannot reconstruct (full overwrite by write, no snapshot): ${target}`)
          content = null
          break
        }
        if (change.tool === 'edit') {
          if (content === null) break
          const oldStr = args.old_string ?? ''
          const newStr = args.new_string ?? ''
          if (args.replace_all === true) content = content.split(newStr).join(oldStr)
          else content = content.replace(newStr, oldStr)
          continue
        }
        // str_replace_editor
        const command = args.command
        if (command === 'create') {
          existedBefore = false
          break
        }
        if (content === null) break
        if (command === 'str_replace') {
          const oldStr = args.old_str ?? ''
          const newStr = args.new_str ?? ''
          content = content.replace(newStr, oldStr)
        } else if (command === 'insert') {
          const inserted = args.new_str ?? ''
          if (inserted !== '') content = content.replace(inserted, '')
        }
      }
      if (content === null && existedBefore) continue // already warned
      if (!existedBefore) {
        if (existsSync(target)) rmSync(target, { force: true })
        restored.push({ path: target, action: 'deleted' })
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, content, 'utf8')
      restored.push({ path: target, action: 'restored' })
    } catch (error) {
      warnings.push(`log-based reconstruction failed (${target}): ${String(error?.message ?? error)}`)
    }
  }
  return { restored, warnings }
}

/**
 * Undo every file modification after `keepSeq`.
 *
 * Ledger first (exact bytes, deduped, cheap); the log-reverse path only for
 * files the ledger has nothing for. Mixing the two per-file rather than
 * choosing one globally matters: a forked session can have a ledger for the
 * turns it ran itself AND inherited edits with no ledger at all.
 *
 * After a successful restore the consumed entries are dropped from the ledger
 * and any blob nobody references is deleted, so a session that has been
 * rolled back five times does not carry five generations of dead snapshots.
 */
async function restoreFilesBefore(sessionId, keepSeq, ctx) {
  const dir = await fileHistoryDir(sessionId, ctx)
  const manifestPath = dir === null ? null : join(dir, 'manifest.jsonl')
  const hasManifest = manifestPath !== null && existsSync(manifestPath)
  if (!hasManifest) {
    const rebuilt = await reverseApplyFromLog(sessionId, keepSeq, ctx)
    return { ...rebuilt, source: 'log' }
  }
  const entries = []
  for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      entries.push(JSON.parse(line))
    } catch {
      continue
    }
  }
  // One entry per path: the EARLIEST past the rollback point = state just
  // before that path was first touched.
  const earliest = new Map()
  for (const entry of entries) {
    if (typeof entry.seq !== 'number' || typeof entry.path !== 'string') continue
    if (entry.seq <= keepSeq) continue
    const known = earliest.get(entry.path)
    if (known === undefined || entry.seq < known.seq) earliest.set(entry.path, entry)
  }
  const restored = []
  const warnings = []
  const missing = new Set()
  for (const [target, entry] of earliest) {
    try {
      if (entry.blob === null) {
        // Did not exist before: restoring means removing what was created.
        if (existsSync(target)) rmSync(target, { force: true })
        restored.push({ path: target, action: 'deleted' })
        continue
      }
      const blobPath = join(dir, 'blobs', entry.blob)
      if (!existsSync(blobPath)) {
        // Ledger says there is a blob but the file is gone — fall through to
        // the log-based path for this one path instead of failing the batch.
        missing.add(target)
        continue
      }
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(blobPath, target)
      restored.push({ path: target, action: 'restored' })
    } catch (error) {
      warnings.push(`restore failed (${target}): ${String(error?.message ?? error)}`)
    }
  }
  if (missing.size > 0) {
    const rebuilt = await reverseApplyFromLog(sessionId, keepSeq, ctx)
    for (const item of rebuilt.restored) {
      if (!missing.has(item.path)) continue
      restored.push(item)
      missing.delete(item.path)
    }
    warnings.push(...rebuilt.warnings.filter((w) => [...missing].some((p) => w.includes(p))))
  }
  // Consume what was just rolled back.
  const keepEntries = entries.filter((e) => typeof e.seq === 'number' && e.seq <= keepSeq)
  try {
    writeFileSync(
      manifestPath,
      keepEntries.map((e) => JSON.stringify(e)).join('\n') + (keepEntries.length > 0 ? '\n' : ''),
    )
    const referenced = new Set(keepEntries.map((e) => e.blob).filter(Boolean))
    const blobsDir = join(dir, 'blobs')
    if (existsSync(blobsDir)) {
      for (const blobName of readdirSync(blobsDir)) {
        if (!referenced.has(blobName)) rmSync(join(blobsDir, blobName), { force: true })
      }
    }
  } catch (error) {
    warnings.push(`cleaning consumed snapshots failed: ${String(error?.message ?? error)}`)
  }
  return { restored, warnings, source: 'snapshot' }
}

/**
 * The files a rollback to `keepSeq` would touch — for the confirmation dialog.
 *
 * Union of the log and the ledger, deliberately: the log is complete but may
 * lag the last flush, the ledger is exact but blind to inherited edits. A list
 * the user checks before an irreversible action must be the union, not either
 * half.
 */
async function affectedFiles(sessionId, keepSeq, ctx) {
  const paths = new Set()
  for (const change of await collectLogChanges(sessionId, ctx)) {
    if (typeof change.seq === 'number' && change.seq > keepSeq) paths.add(change.path)
  }
  const dir = await fileHistoryDir(sessionId, ctx)
  if (dir !== null) {
    const manifestPath = join(dir, 'manifest.jsonl')
    if (existsSync(manifestPath)) {
      for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
        if (!line.trim()) continue
        try {
          const entry = JSON.parse(line)
          if (typeof entry.seq === 'number' && typeof entry.path === 'string' && entry.seq > keepSeq) {
            paths.add(entry.path)
          }
        } catch { /* skip a torn line */ }
      }
    }
  }
  return [...paths]
}

/**
 * What one turn said, and where it begins.
 *
 * Turns are delimited by `turn/start {turn}`; a `user/message` carries no turn
 * number of its own, so it can only be attributed by walking forward from a
 * `turn/start` until the next one.
 *
 * 🔴 THE ROLLBACK BOUNDARY IS THE EVENT *BEFORE* `turn/start`, NOT `turn/start`
 * ITSELF. Between `turn/start` and the user message there can be other events;
 * forking at a boundary inside that gap leaves the child holding an unclosed
 * `turn/start`, and the fork's "close the tail" mechanism then synthesises a
 * completed-turn line that the user never sent. Taking the previous event's seq
 * puts the cut strictly before the turn begins, which is the only boundary that
 * produces a clean prefix.
 *
 * `beforeSeq: null` means "this is the first turn" — there is no prefix to keep,
 * so the caller must start a fresh session instead of forking.
 */
async function turnInfo(sessionId, turn, ctx) {
  const events = await readSessionEvents(sessionId, ctx)
  if (events === null) return null
  for (let index = 0; index < events.length; index++) {
    const event = events[index]
    if (event.type !== 'turn/start' || event.data?.turn !== turn) continue
    const prev = index > 0 ? events[index - 1] : undefined
    const beforeSeq = prev && typeof prev.seq === 'number' ? prev.seq : null
    // The turn's first REAL user message: steering injections are also
    // `user/message`, so the source kind has to be checked or the prefill text
    // could be an internal note instead of what the user typed.
    let userSeq = null
    let userText = ''
    for (let j = index + 1; j < events.length; j++) {
      const inner = events[j]
      if (inner.type === 'turn/start') break
      if (inner.type !== 'user/message') continue
      if (inner.data?.source?.kind !== 'user') continue
      userSeq = inner.seq
      userText = (inner.data.content ?? [])
        .filter((block) => block?.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n')
      break
    }
    const files = await affectedFiles(sessionId, typeof beforeSeq === 'number' ? beforeSeq : -1, ctx)
    return { turn, userSeq, userText, beforeSeq, files }
  }
  return null
}

// ---------------------------------------------------------------------------
// Continuation brief ("一键新窗口继续对话", 0.28.0).
//
// WHY THIS LIVES ON THE HOST: the brief has to be built from the EVENT LOG
// (user messages, todo/write, team/task, assistant replies), and a browser
// plugin cannot read files. The client only knows the list snapshot, which
// carries no message bodies at all.
//
// WHAT IT IS FOR: a long conversation eventually becomes too big to continue —
// every further turn re-sends a giant history. Starting a fresh window with a
// distilled brief keeps the user's REQUIREMENT TIMELINE and the TASK PROGRESS
// intact while dropping the 800 tool calls that produced them.
//
// WHAT IS DELIBERATELY DROPPED: tool call arguments and results, reasoning
// blocks, step/turn bookkeeping, job frames, subagent chatter. Those are the
// bulk of a long log and none of them are needed to continue the work.
// ---------------------------------------------------------------------------

/** Per-message clip. Long pastes stay recognisable without eating the budget. */
const DIGEST_MESSAGE_CLIP = 600
/** Hard ceiling for the composed brief, so a huge log cannot explode a prompt. */
const DIGEST_PROMPT_BUDGET = 24000
/** How many user messages to keep when the timeline has to be thinned. */
const DIGEST_TIMELINE_HEAD = 8
const DIGEST_TIMELINE_TAIL = 24

function clipText(value, limit) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim()
  if (text.length <= limit) return text
  return `${text.slice(0, Math.max(0, limit - 1)).trimEnd()}…`
}

function textBlocksOf(content) {
  if (!Array.isArray(content)) return ''
  return content
    .filter((block) => block?.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

const DIGEST_STATUS_MARK = {
  completed: '[x]',
  in_progress: '[~]',
  pending: '[ ]',
}

/**
 * Everything worth carrying into a new window, extracted from one session log.
 *
 * @returns {Promise<object|null>} null when the session has no readable log.
 */
async function sessionDigest(sessionId, ctx) {
  const events = await readSessionEvents(sessionId, ctx)
  if (events === null) return null

  let title = ''
  let lastTurn = 0
  let currentTurn = 0
  let toolCalls = 0
  const userMessages = []
  let todos = []
  let todoSeq = -1
  const teamTasks = new Map()
  const teamMembers = new Map()
  let lastAssistant = ''
  let lastAssistantSeq = -1

  for (const event of events) {
    const seq = typeof event.seq === 'number' ? event.seq : 0
    const data = event.data ?? {}
    const type = event.type

    if (type === 'turn/start') {
      if (typeof data.turn === 'number') {
        currentTurn = data.turn
        if (data.turn > lastTurn) lastTurn = data.turn
      }
      continue
    }
    if (type === 'session/title') {
      if (typeof data.title === 'string' && data.title.trim().length > 0) title = data.title.trim()
      continue
    }
    if (type === 'user/message') {
      // Steering injections are also `user/message`; only a real user turn
      // belongs on the requirement timeline.
      if (data.source?.kind !== 'user') continue
      const text = textBlocksOf(data.content)
      if (text.trim().length === 0) continue
      userMessages.push({ seq, turn: currentTurn, text })
      continue
    }
    if (type === 'tool/call') {
      toolCalls += 1
      continue
    }
    if (type === 'todo/write') {
      if (seq >= todoSeq && Array.isArray(data.todos)) {
        todoSeq = seq
        todos = data.todos.map((item) => ({
          content: String(item?.content ?? ''),
          status: String(item?.status ?? 'pending'),
        }))
      }
      continue
    }
    if (type === 'team/task') {
      const task = data.task
      if (task && typeof task.id === 'string') {
        const revision = Number(task.revision ?? 0)
        const previous = teamTasks.get(task.id)
        if (previous === undefined || revision >= previous.revision) {
          teamTasks.set(task.id, {
            id: task.id,
            revision,
            subject: String(task.subject ?? ''),
            status: String(task.status ?? ''),
            ownerName: String(task.ownerName ?? ''),
          })
        }
      }
      continue
    }
    if (type === 'team/member') {
      const member = data.member
      if (member && typeof member.name === 'string') {
        teamMembers.set(member.name, {
          name: member.name,
          description: String(member.description ?? ''),
          phase: String(member.phase ?? ''),
        })
      }
      continue
    }
    if (type === 'assistant/message') {
      if (seq < lastAssistantSeq) continue
      const text = textBlocksOf(data.message?.content)
      if (text.trim().length > 0) {
        lastAssistant = text
        lastAssistantSeq = seq
      }
    }
  }

  // The timeline keeps EVERY requirement by default; only a log that would
  // blow the prompt budget gets thinned, and the thinning is announced in the
  // brief so the reader knows a gap exists.
  let timeline = userMessages.map((item) => ({
    turn: item.turn,
    seq: item.seq,
    text: clipText(item.text, DIGEST_MESSAGE_CLIP),
  }))
  let timelineNote = ''
  const rawTimelineSize = timeline.reduce((sum, item) => sum + item.text.length, 0)
  if (rawTimelineSize > DIGEST_PROMPT_BUDGET / 2 && timeline.length > DIGEST_TIMELINE_HEAD + DIGEST_TIMELINE_TAIL) {
    const head = timeline.slice(0, DIGEST_TIMELINE_HEAD)
    const tail = timeline.slice(timeline.length - DIGEST_TIMELINE_TAIL)
    const dropped = timeline.length - head.length - tail.length
    timeline = head.concat(tail)
    timelineNote = `（时间线过长，已省略中间 ${dropped} 条用户消息，仅保留最早 ${head.length} 条与最近 ${tail.length} 条；原始全文见转录文件。）`
  }

  const inProgress = todos.find((item) => item.status === 'in_progress')
  const doneCount = todos.filter((item) => item.status === 'completed').length
  const pendingCount = todos.filter((item) => item.status === 'pending').length
  const tasksInProgress = [...teamTasks.values()].filter((task) => task.status === 'in_progress')
  const tasksDone = [...teamTasks.values()].filter((task) => task.status === 'completed')

  let cwd = ''
  let agentPreset = ''
  try {
    const live = ctx?.get?.('sessions')?.get?.(String(sessionId))
    cwd = typeof live?.header?.cwd === 'string' ? live.header.cwd : ''
    agentPreset = typeof live?.header?.agentPreset === 'string' ? live.header.agentPreset : ''
  } catch {}
  // The live session may not be resident (a cold conversation, or a caller with
  // no context at all), so fall back to the registry record that claims this
  // session. Without the cwd the brief cannot tell the new window where to work.
  if (cwd.length === 0) {
    try {
      const records = await readWorkspaceRecords()
      for (const record of records) {
        if (record.sessionIds.some((id) => idKey(id) === idKey(sessionId)) && record.path.length > 0) {
          cwd = record.path
          break
        }
      }
    } catch {}
  }
  const transcriptPath = await transcriptPathFor(sessionId, ctx)

  const lines = []
  lines.push(`# 继续对话：${title.length > 0 ? title : '(未命名)'}`)
  lines.push('')
  lines.push('你正在接管一段已经进行到一半的对话。原对话的上下文太长，用户在新窗口里继续。')
  lines.push('下面是原对话的交接资料 —— 这是你的全部历史，请当作自己的记忆。')
  lines.push('')
  lines.push('## 原对话')
  lines.push(`- 会话 ID：${sessionId}`)
  if (typeof transcriptPath === 'string' && transcriptPath.length > 0) {
    lines.push(`- 转录文件：${transcriptPath}`)
  }
  if (cwd.length > 0) lines.push(`- 工作目录：${cwd}`)
  lines.push(`- 进度：第 ${lastTurn} 轮 · 共 ${userMessages.length} 条用户消息 · ${toolCalls} 次工具调用`)
  lines.push('')
  lines.push('## 用户要求时间线（按发生顺序）')
  if (timeline.length === 0) {
    lines.push('（原对话没有留下用户消息文本。）')
  } else {
    if (timelineNote.length > 0) {
      lines.push(timelineNote)
      lines.push('')
    }
    timeline.forEach((item, index) => {
      lines.push(`${index + 1}. [第 ${item.turn} 轮] ${item.text.replace(/\n/g, '\n   ')}`)
    })
  }
  lines.push('')
  lines.push('## 任务进度清单（最近一次 todo 快照）')
  if (todos.length === 0) {
    lines.push('（原对话没有写过 todo 清单，请从上面的时间线自行归纳。）')
  } else {
    lines.push(`已完成 ${doneCount} / 进行中 ${pendingCount === 0 && inProgress === undefined ? 0 : (inProgress === undefined ? 0 : 1)} / 待办 ${pendingCount}，共 ${todos.length} 项：`)
    for (const item of todos) {
      const mark = DIGEST_STATUS_MARK[item.status] ?? '[ ]'
      lines.push(`- ${mark} ${clipText(item.content, 300)}`)
    }
  }
  if (teamTasks.size > 0) {
    lines.push('')
    lines.push('## 团队任务')
    for (const task of teamTasks.values()) {
      const owner = task.ownerName.length > 0 ? ` · 负责人 ${task.ownerName}` : ''
      lines.push(`- ${task.id} [${task.status}]${owner} ${clipText(task.subject, 200)}`)
    }
    if (teamMembers.size > 0) {
      lines.push(`- 成员：${[...teamMembers.values()].map((member) => member.name).join('、')}`)
    }
  }
  lines.push('')
  lines.push('## 最近进展（原对话最后一段回复）')
  lines.push(lastAssistant.length > 0 ? clipText(lastAssistant, 2000) : '（原对话最后没有留下助手文本。）')
  lines.push('')
  lines.push('## 你现在要做的')
  lines.push('1. 先用一两句话复述你理解的任务进度与下一步。')
  if (inProgress !== undefined) {
    lines.push(`2. 直接从进行中的那一项接着做：${clipText(inProgress.content, 200)}`)
  } else if (tasksInProgress.length > 0) {
    lines.push(`2. 直接从进行中的团队任务接着做：${clipText(tasksInProgress[0].subject, 200)}`)
  } else {
    lines.push('2. 接着推进剩下的部分。')
  }
  lines.push('3. 不要从头重做已经完成的工作 —— 上面的清单里已经划掉的就是做过的。')
  lines.push('4. 需要用户拍板的关键决策先问，其余自行判断。')
  lines.push('5. 不要复述这份交接资料，直接干活。')

  let prompt = lines.join('\n')
  if (prompt.length > DIGEST_PROMPT_BUDGET) {
    prompt = `${prompt.slice(0, DIGEST_PROMPT_BUDGET).trimEnd()}\n\n（交接资料过长已截断，完整内容见上面的转录文件。）`
  }

  return {
    sessionId,
    title,
    cwd,
    agentPreset,
    transcriptPath: typeof transcriptPath === 'string' ? transcriptPath : '',
    turns: lastTurn,
    userMessageCount: userMessages.length,
    toolCallCount: toolCalls,
    eventCount: events.length,
    todos,
    todoSummary: {
      total: todos.length,
      completed: doneCount,
      inProgress: inProgress === undefined ? 0 : 1,
      pending: pendingCount,
      current: inProgress === undefined ? '' : clipText(inProgress.content, 300),
    },
    teamTasks: [...teamTasks.values()],
    teamMembers: [...teamMembers.values()],
    teamSummary: {
      total: teamTasks.size,
      completed: tasksDone.length,
      inProgress: tasksInProgress.length,
      current: tasksInProgress.length > 0 ? clipText(tasksInProgress[0].subject, 300) : '',
    },
    lastAssistant: clipText(lastAssistant, 2000),
    timelineTruncated: timelineNote.length > 0,
    timeline,
    prompt,
  }
}

// ---------------------------------------------------------------------------
// HTTP surface (JSON). The client reads favorites and session info here because
// a browser plugin cannot read files. Only `POST /favorite` and `POST /delete`
// mutate anything, and `POST /delete` is always explicitly invoked.
// ---------------------------------------------------------------------------

function sendJson(res, status, value) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(value))
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > 1_000_000) throw new Error('request body too large')
    chunks.push(chunk)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

function installRoutes(ctx, settings) {
  return ctx.webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req, res) => {
      try {
        if (!isLoopback(req)) return sendJson(res, 403, { ok: false, error: 'loopback only' })
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        const route = url.pathname.slice(ROUTE_PREFIX.length) || '/'
        const method = (req.method ?? 'GET').toUpperCase()

        if (method === 'GET' && route === '/status') {
          const favorites = readState().favorites
          return sendJson(res, 200, {
            ok: true,
            plugin: name,
            version: PKG_VERSION,
            // `settings` is the config object passed to `apply`, never
            // `ctx.config` — see the note above `handleDelete`.
            enabled: settings?.enabled !== false,
            favoriteCount: Object.keys(favorites).length,
          })
        }

        if (method === 'GET' && route === '/favorites') {
          return sendJson(res, 200, { ok: true, favorites: readState().favorites })
        }

        // The archived set lives in the Workspace registry. The client could
        // read it from its own service, but a settings page can be opened
        // before the sidebar entry that owns that store has ever mounted. The
        // LIVE registry is the authority; the file is only a fallback, because
        // reading the file while the app runs returns a stale, over-counting
        // answer.
        if (method === 'GET' && route === '/archived') {
          const info = await readArchivedSet(ctx)
          if (info.ids === null) {
            // Say so instead of returning an empty list: the client renders an
            // explicit unavailable state, and an empty list would read as
            // "nothing is archived" — the opposite of the truth. `source` and
            // `reason` are passed through so the UI can name the real cause
            // instead of sitting on a spinner forever.
            return sendJson(res, 200, {
              ok: false,
              source: info.source,
              reason: info.reason ?? '',
              error: 'workspaceRegistry.archivedSessionIds is unavailable',
            })
          }
          // Intersect with what the sidebar lists; see the note above. The raw
          // total is reported separately so the difference is visible rather
          // than silently swallowed.
          const visible = sidebarSessionKeys(ctx)
          // Blank sessions are excluded here for the same reason they are
          // excluded from the idle pool: the sidebar shows only the CURRENT
          // blank row (`if (session.blank && session.id !== current) return
          // false`), so an archived blank session cannot be located and
          // reviewed. Offering it for deletion would be offering an action the
          // user cannot verify.
          const blanks = await blankSessionKeys(ctx)
          const actionable = info.ids.filter((id) => visible.has(idKey(id)) && !blanks.has(idKey(id)))
          return sendJson(res, 200, {
            ok: true,
            // The actionable set: archived, listed by the sidebar, and holding
            // real content. Every count and every bulk action builds on this.
            archivedSessionIds: actionable,
            source: info.source,
            count: actionable.length,
            rawArchivedCount: info.ids.length,
            visibleCount: visible.size,
            orphanCount: info.ids.length - actionable.length,
            blankCount: info.ids.length - info.ids.filter((id) => !blanks.has(idKey(id))).length,
          })
        }

        // --- idle auto-archive -------------------------------------------
        //
        // GET returns the current idle preview; POST performs the archive. Both
        // share one selector so the preview can never disagree with the action.
        if ((method === 'GET' || method === 'POST') && route === '/idle-archive') {
          let hours = 24
          if (method === 'GET') hours = Number(url.searchParams.get('hours') ?? 24)
          else {
            const body = await readJsonBody(req)
            hours = Number(body.hours ?? 24)
          }

          // The archived set comes from the live registry ONLY; see
          // readArchivedSet. A null set means we cannot tell what is archived,
          // and archiving with an unknown exclusion set would sweep up
          // conversations the user already filed away.
          const archiveInfo = await readArchivedSet(ctx)
          if (archiveInfo.ids === null) {
            return sendJson(res, 503, {
              ok: false,
              error: 'cannot determine the archived set (workspaceRegistry unavailable) — refusing to guess',
              source: archiveInfo.source,
            })
          }
          const archivedIds = archiveInfo.ids
          // The candidate pool is the sessions the sidebar lists. Using
          // `activityCatalogue` here (every stored session with a cwd) offered
          // 73 "idle" sessions on a machine whose sidebar shows 83 rows, all but
          // a handful of them archived — because the controller list is a
          // superset of the sidebar's membership.
          const catalogue = await activityCatalogue(ctx)
          const listedKeys = sidebarSessionKeys(ctx)
          const listed = catalogue.filter((entry) => listedKeys.has(idKey(entry.id)))
          const idle = selectIdleSessions(listed, archivedIds, hours, Date.now())

          if (method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              hours,
              idleCount: idle.length,
              total: catalogue.length,
              archivedTotal: archivedIds.length,
              archiveSource: archiveInfo.source,
              sample: idle.slice(0, 50).map((e) => ({ id: e.id, updatedAt: e.updatedAt, title: e.title || '', blank: e.blank === true, cwd: e.cwd || '' })),
              // The full list, so "export the list" can be exact rather than
              // capped at the preview size. Titles, the blank flag and the
              // workspace travel with it: an exported list is for a human to
              // read and to match against the sidebar.
              all: idle.map((e) => ({ id: e.id, updatedAt: e.updatedAt, title: e.title || '', blank: e.blank === true, cwd: e.cwd || '' })),
            })
          }

          if (idle.length === 0) {
            return sendJson(res, 200, { ok: true, hours, archived: [], failed: [], skipped: [] })
          }

          const registry = ctx?.get?.('workspaceRegistry')
          if (!registry || typeof registry.archiveSession !== 'function') {
            return sendJson(res, 503, { ok: false, error: 'workspaceRegistry.archiveSession is unavailable' })
          }

          const archived = []
          const failed = []
          for (const entry of idle) {
            try {
              await registry.archiveSession(entry.id)
              archived.push(entry.id)
            } catch (error) {
              // A session with running work refuses without `stopActivity`; that
              // is a legitimate skip, not a batch failure.
              failed.push({ id: entry.id, reason: String(error?.message ?? error) })
            }
          }
          return sendJson(res, 200, {
            ok: true,
            hours,
            archived,
            failed,
            // The client offers a one-step undo of this exact list.
            undoable: archived,
          })
        }

        if (method === 'POST' && route === '/unarchive') {
          const body = await readJsonBody(req)
          const ids = Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : []
          const registry = ctx?.get?.('workspaceRegistry')
          if (!registry || typeof registry.unarchiveSession !== 'function') {
            return sendJson(res, 503, { ok: false, error: 'workspaceRegistry.unarchiveSession is unavailable' })
          }
          const restored = []
          const failed = []
          for (const id of ids) {
            try { await registry.unarchiveSession(id); restored.push(id) } catch (error) {
              failed.push({ id, reason: String(error?.message ?? error) })
            }
          }
          return sendJson(res, 200, { ok: true, restored, failed })
        }

        // Write the candidate list to a file next to the plugin's own data and
        // report the path. A list can be hundreds of rows; a settings card is
        // the wrong place for it, and a plain file can be searched, sorted and
        // diffed — which is what verifying a bulk action actually needs.
        //
        // The file is TAB-separated with a header row, so it stays readable as
        // text AND pastes straight into a spreadsheet. Each row carries the
        // conversation NAME, its ID, and how long it has been idle: an export
        // whose rows are bare uuids cannot be checked by a human, which defeats
        // the purpose of exporting it.
        if (method === 'POST' && route === '/export-list') {
          const body = await readJsonBody(req)
          const ids = Array.isArray(body.sessionIds) ? body.sessionIds.map(String) : []
          const label = typeof body.label === 'string' && body.label.length > 0 ? body.label : 'list'
          const entries = Array.isArray(body.entries) ? body.entries : []
          const title = typeof body.title === 'string' && body.title.length > 0 ? body.title : label
          const outDir = stateDir()
          mkdirSync(outDir, { recursive: true })
          const stamp = new Date().toISOString().replace(/[:.]/g, '-')
          const safeLabel = label.replace(/[^A-Za-z0-9_-]+/g, '_').slice(0, 40)
          const file = join(outDir, `${safeLabel}-${stamp}.txt`)
          const now = Date.now()
          const rows = entries.length > 0
            ? entries
            : ids.map((id) => ({ id, updatedAt: null, title: '' }))
          // The group label per cwd, so a row can be matched against the
          // sidebar's workspace headings.
          const workDir = new Map()
          try {
            const registry = ctx?.get?.('workspaceRegistry')
            const entities = registry && typeof registry.list === 'function' ? registry.list() : null
            if (Array.isArray(entities)) {
              for (const entity of entities) {
                const record = entity?.record ?? entity
                const dir = record?.cwd ?? record?.path ?? record?.rootPath
                const label = record?.title ?? record?.name
                if (typeof dir === 'string' && typeof label === 'string') workDir.set(dir.toLowerCase(), label)
              }
            }
          } catch {}
          const lines = [
            `# dsh-archive-favorites-forge — ${title}`,
            `# 生成时间: ${new Date(now).toISOString()}`,
            `# 条数: ${rows.length}`,
            '#',
            '# 对话名称\t对话ID\t所属工作区\t闲置时长\t最后活动时间',
          ]
          for (const entry of rows) {
            // 🔴 NAME THE ROW THE WAY THE SIDEBAR NAMES IT.
            //
            // The shipped sidebar renders `node.blank ? "新会话" : title ||
            // "未命名"`. An export that said "(未命名)" for a blank row could not
            // be matched to the sidebar row labelled 新会话 — the user went
            // looking for a conversation that is displayed under a different
            // word. Same words here, and the workspace column says which
            // heading to look under.
            const rawTitle = typeof entry?.title === 'string' ? entry.title.trim() : ''
            const name = rawTitle.length > 0
              ? rawTitle.replace(/[\t\r\n]+/g, ' ')
              : (entry?.blank === true ? '新会话' : '未命名')
            const dir = typeof entry?.cwd === 'string' ? entry.cwd : ''
            const group = dir.length > 0
              ? (workDir.get(dir.toLowerCase()) ?? (dir.split(/[\\/]/).filter((p) => p.length > 0).pop() ?? ''))
              : '未分组'
            const at = typeof entry?.updatedAt === 'number' && Number.isFinite(entry.updatedAt)
              ? entry.updatedAt
              : null
            lines.push([
              name,
              String(entry?.id ?? ''),
              group,
              at === null ? '' : humanDuration(now - at),
              at === null ? '' : new Date(at).toISOString(),
            ].join('\t'))
          }
          writeFileSync(file, lines.join('\n') + '\n', 'utf8')
          return sendJson(res, 200, {
            ok: true,
            path: file,
            count: rows.length,
            dir: outDir,
          })
        }

        // Reveal a file this plugin produced, in the OS file manager. The path
        // is NOT taken from the request: only the plugin's own export directory
        // can be revealed, so this cannot become a "open anything on disk" hole.
        if (method === 'POST' && route === '/reveal') {
          const body = await readJsonBody(req)
          const requested = String(body.path ?? '')
          const dir = stateDir()
          const normalizedDir = dir.toLowerCase().replace(/[\\/]+$/, '')
          const normalizedTarget = requested.toLowerCase().replace(/[\\/]+$/, '')
          if (normalizedTarget === '' ||
              (normalizedTarget !== normalizedDir &&
               !normalizedTarget.startsWith(normalizedDir + '\\') &&
               !normalizedTarget.startsWith(normalizedDir + '/'))) {
            return sendJson(res, 403, { ok: false, error: 'only this plugin\'s own export folder can be revealed' })
          }
          if (!existsSync(requested)) {
            // Fall back to the folder itself when the file is already gone.
            if (!existsSync(dir)) return sendJson(res, 404, { ok: false, error: 'folder does not exist' })
          }
          try {
            const { spawn } = await import('node:child_process')
            if (process.platform === 'win32') {
              // `/select,<path>` highlights the file; a missing file still opens
              // its folder. Detached + unref so the child never holds us open.
              const target = existsSync(requested) ? `/select,${requested}` : dir
              const child = spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' })
              child.unref()
            } else if (process.platform === 'darwin') {
              const args = existsSync(requested) ? ['-R', requested] : [dir]
              const child = spawn('open', args, { detached: true, stdio: 'ignore' })
              child.unref()
            } else {
              const child = spawn('xdg-open', [existsSync(requested) ? dirname(requested) : dir], { detached: true, stdio: 'ignore' })
              child.unref()
            }
            return sendJson(res, 200, { ok: true, opened: existsSync(requested) ? requested : dir })
          } catch (error) {
            return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          }
        }

        if (method === 'POST' && route === '/favorite') {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (sessionId.length === 0) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          const current = readState()
          if (body.value === false) delete current.favorites[sessionId]
          else {
            current.favorites[sessionId] = {
              at: new Date().toISOString(),
              title: typeof body.title === 'string' ? body.title : '',
              cwd: typeof body.cwd === 'string' ? body.cwd : '',
            }
          }
          writeState(current)
          return sendJson(res, 200, { ok: true, favorites: current.favorites })
        }

        if (method === 'POST' && route === '/session-info') {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '')
          if (sessionId.length === 0) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          const path = await transcriptPathFor(sessionId, ctx)
          return sendJson(res, 200, { ok: true, sessionId, id: bareId(sessionId), path })
        }

        if (method === 'POST' && route === '/delete') {
          const body = await readJsonBody(req)
          return sendJson(res, 200, { ok: true, ...(await handleDelete(body, ctx, settings)) })
        }

        // --- edit-and-resend / undo-turn support (0.25.0) -----------------
        //
        // Both routes are read-only over the session log; neither touches a
        // session directory. They exist because a browser cannot read a zstd
        // log, and the two questions the edit/undo flow needs answered are
        // "what did this turn say" and "where does it start".
        //
        // The id check accepts BOTH spellings (`session-<uuid>` and the bare
        // `<uuid>`) because this machine really does hold both — see `idKey`.
        // The character class is the conservative one: a session id is never
        // anything but alphanumerics, dashes and underscores, so anything else
        // is a caller bug or an injection attempt and is refused before it can
        // reach a filesystem lookup.
        if (method === 'POST' && route === '/session-turn-info') {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '').trim()
          const turn = Number(body.turn)
          if (!/^(?:session-)?[A-Za-z0-9_-]+$/.test(sessionId)) {
            return sendJson(res, 400, { ok: false, error: `invalid sessionId: ${sessionId}` })
          }
          if (!Number.isSafeInteger(turn) || turn < 1) {
            return sendJson(res, 400, { ok: false, error: `invalid turn: ${body.turn}` })
          }
          const info = await turnInfo(sessionId, turn, ctx)
          if (info === null) {
            // A 404 here is information, not a fault: either the log is gone
            // (the conversation was deleted) or that turn has no user message
            // (a synthetic turn). The client shows it verbatim.
            return sendJson(res, 404, {
              ok: false,
              error: `no session log, or no user message in turn ${turn}`,
            })
          }
          return sendJson(res, 200, { ok: true, ...info })
        }

        if (method === 'POST' && route === '/session-files-restore') {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '').trim()
          const keepSeq = Number(body.keepSeq)
          if (!/^(?:session-)?[A-Za-z0-9_-]+$/.test(sessionId)) {
            return sendJson(res, 400, { ok: false, error: `invalid sessionId: ${sessionId}` })
          }
          // `-1` is the "before anything" boundary used for the first turn; it
          // is legitimate, so the floor is -1 rather than 0.
          if (!Number.isSafeInteger(keepSeq) || keepSeq < -1) {
            return sendJson(res, 400, { ok: false, error: `invalid keepSeq: ${body.keepSeq}` })
          }
          const result = await restoreFilesBefore(sessionId, keepSeq, ctx)
          ctx?.logger?.info?.(
            `${name}: files restored ${sessionId} keepSeq=${keepSeq}: restored=${result.restored.length} warnings=${(result.warnings ?? []).length} source=${result.source ?? 'snapshot'}`,
          )
          return sendJson(res, 200, { ok: true, sessionId, keepSeq, ...result })
        }

        // 🔴 THE REPLACE-DELETE IS ITS OWN ROUTE, NOT A FIELD ON `/delete`.
        //
        // `handleDelete`'s favourite guard is the plugin's central promise, and
        // a promise that a request body can switch off is not a promise. So
        // `/delete` — the route any caller can reach — never passes anything but
        // the default, and this route is the ONLY place `replace: true` is set.
        // The client reaches it only from the edit/undo flow's final step, where
        // the user has already confirmed an operation that necessarily supersedes
        // the original conversation.
        //
        // It takes exactly ONE id, because a replace is always one conversation
        // being superseded by one fork. A batch form would be a batch delete with
        // the guard off, which is not a thing this plugin offers.
        if (method === 'POST' && route === '/session-replace') {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '').trim()
          if (sessionId.length === 0) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          if (!/^(?:session-)?[A-Za-z0-9_-]+$/.test(sessionId)) {
            return sendJson(res, 400, { ok: false, error: `invalid sessionId: ${sessionId}` })
          }
          const result = await handleDelete({ sessionIds: [sessionId] }, ctx, settings, { replace: true })
          if (result?.error) return sendJson(res, 400, { ok: false, error: result.error })
          return sendJson(res, 200, { ok: true, sessionId, ...result })
        }

        // --- continuation brief (0.28.0) ----------------------------------
        //
        // "One-click continue in a new window": build the distilled brief that
        // the client will send as the first message of a fresh session.
        //
        // READ-ONLY. It never creates the new session — the client owns that,
        // because only the client can open it and inherit the agent preset.
        // The brief is returned whole so the user can read it in the dialog
        // before deciding; the same text is what gets sent on confirm.
        if (method === 'POST' && route === '/session-digest') {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '').trim()
          if (sessionId.length === 0) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          if (!/^(?:session-)?[A-Za-z0-9_-]+$/.test(sessionId)) {
            return sendJson(res, 400, { ok: false, error: `invalid sessionId: ${sessionId}` })
          }
          const digest = await sessionDigest(sessionId, ctx)
          if (digest === null) {
            return sendJson(res, 404, {
              ok: false,
              error: 'no readable transcript for this session yet (nothing has been persisted to disk)',
            })
          }
          ctx?.logger?.info?.(
            `${name}: session digest — ${sessionId} turns=${digest.turns} users=${digest.userMessageCount} tools=${digest.toolCallCount} todos=${digest.todoSummary.total} prompt=${digest.prompt.length}B`,
          )
          return sendJson(res, 200, { ok: true, ...digest })
        }

        // --- ungrouped-bucket guard (0.26.0) ------------------------------
        //
        // The sidebar's 未分组 bucket is not a bug in this plugin, and it is not
        // caused by deleting conversations: it is the official fallback group
        // for sessions that exist on disk but were never registered into any
        // `workspace.sessionIds`. These three routes exist so the user can SEE
        // that, and fix it, without a terminal.
        //
        // All three are READ-ONLY except `/ungrouped-cleanup`, which refuses to
        // write anything unless the body carries `confirm: true` — the same
        // rule the settings page enforces with a second click.
        if (route === '/ungrouped-diagnose' && (method === 'GET' || method === 'POST')) {
          // The host has no cheap "which session is on screen" accessor — the
          // client knows it from `list.byId[..].retainedBy.mainView` and passes
          // it in. Falling back to the guard's own env lookup (DSH_SESSION_ID)
          // is the safe default: a wrong current-session id can only make the
          // guard MORE conservative, because the current session is skipped.
          const body = method === 'POST' ? await readJsonBody(req).catch(() => ({})) : {}
          const currentSessionId = typeof body.currentSessionId === 'string' && body.currentSessionId.length > 0
            ? body.currentSessionId
            : undefined
          const report = await diagnoseUngrouped(ctx, { currentSessionId })
          ctx?.logger?.info?.(
            `${name}: ungrouped diagnose — verdict=${report.verdict} ungrouped=${report.summary?.ungroupedCount ?? '?'} dirs=${report.summary?.totalDirs ?? '?'} source=${report.source ?? 'file'}`,
          )
          return sendJson(res, 200, report)
        }

        if (route === '/ungrouped-explain' && (method === 'GET' || method === 'POST')) {
          return sendJson(res, 200, {
            ok: true,
            version: UNGROUPED_GUARD_VERSION,
            paragraphs: explainUngrouped(),
          })
        }

        if (method === 'POST' && route === '/ungrouped-cleanup') {
          const body = await readJsonBody(req)
          const currentSessionId = typeof body.currentSessionId === 'string' && body.currentSessionId.length > 0
            ? body.currentSessionId
            : undefined
          // Re-diagnose on the host rather than trusting a client-supplied plan:
          // a stale page could otherwise ask us to remove a session that has
          // since been attached, and we would delete a perfectly healthy one.
          const report = await diagnoseUngrouped(ctx, { currentSessionId })
          if (report.ok !== true) {
            return sendJson(res, 503, { ok: false, error: report.detail ?? 'diagnose failed' })
          }
          const requested = Array.isArray(body.sessionIds) ? body.sessionIds.map((id) => String(id)) : null
          const wanted = requested === null
            ? report.ungrouped
            : report.ungrouped.filter((entry) => requested.includes(String(entry.sessionId)))
          if (requested !== null && wanted.length !== requested.length) {
            // Report the discrepancy instead of silently acting on a subset.
            const found = new Set(wanted.map((entry) => String(entry.sessionId)))
            const missing = requested.filter((id) => !found.has(id))
            ctx?.logger?.warn?.(`${name}: ungrouped cleanup — ${missing.length} requested id(s) are no longer ungrouped: ${missing.join(', ')}`)
          }
          // `dryRun` defaults to TRUE. Turning it off requires `confirm: true`,
          // so a malformed or forgotten flag can never delete anything.
          const dryRun = body.confirm === true ? body.dryRun === true : true
          const result = await cleanupUngrouped(ctx, wanted, {
            dryRun,
            currentSessionId,
            actions: Array.isArray(body.actions) ? body.actions : undefined,
            maxItems: Number.isFinite(Number(body.maxItems)) ? Number(body.maxItems) : undefined,
          })
          ctx?.logger?.info?.(
            `${name}: ungrouped cleanup dryRun=${result.dryRun} deleted=${result.deleted.length} archived=${result.archived.length} attached=${result.attached.length} skipped=${result.skipped.length} failures=${result.failures.length}`,
          )
          return sendJson(res, 200, { ok: true, ...result })
        }

        // --- projection-cache ghosts (0.28.5) -----------------------------
        //
        // A second, nastier way for the 未分组 bucket to fill up: records that
        // live ONLY in `storages/session_projcache/sessions/<id>.json` while the
        // session directory is long gone. The four-step exclusion test above
        // scans directories, and the boot gate reads the registry, so both of
        // them call this clean — yet the running instance still renders those
        // records (title, token count, turn outline all come from the cache) and
        // they are in nobody's `sessionIds`, so the sidebar files them under
        // 未分组. On this machine that was 984 cache files vs 438 directories.
        //
        // Deleting a cache file deletes no conversation: there is no directory
        // left to hold one. Pinned and archived ghosts are listed but kept by
        // default — those two flags mean the user once deliberately touched them.
        if (route === '/ghost-cache-diagnose' && (method === 'GET' || method === 'POST')) {
          const body = method === 'POST' ? await readJsonBody(req).catch(() => ({})) : {}
          const currentSessionId = typeof body.currentSessionId === 'string' && body.currentSessionId.length > 0
            ? body.currentSessionId
            : undefined
          const report = await diagnoseGhostCache(ctx, { currentSessionId })
          ctx?.logger?.info?.(
            `${name}: ghost-cache diagnose — verdict=${report.verdict} ghosts=${report.summary?.ghostCount ?? '?'} cache=${report.summary?.cacheFiles ?? '?'} disk=${report.summary?.diskSessions ?? '?'} bytes=${report.summary?.bytes ?? '?'}`,
          )
          return sendJson(res, 200, report)
        }

        if (method === 'POST' && route === '/ghost-cache-clean') {
          const body = await readJsonBody(req)
          // Re-diagnose rather than trusting the page: a session may have been
          // restored (or re-created) since the client rendered its list, and a
          // stale plan would then delete the cache of a live conversation.
          const report = await diagnoseGhostCache(ctx, {})
          if (report.ok !== true) {
            return sendJson(res, 503, { ok: false, error: report.detail ?? 'diagnose failed' })
          }
          const requested = Array.isArray(body.sessionIds) ? body.sessionIds.map((id) => String(id)) : null
          const wanted = requested === null
            ? report.ghosts
            : report.ghosts.filter((entry) => requested.includes(String(entry.sessionId)))
          if (requested !== null && wanted.length !== requested.length) {
            const found = new Set(wanted.map((entry) => String(entry.sessionId)))
            const missing = requested.filter((id) => !found.has(id))
            ctx?.logger?.warn?.(`${name}: ghost-cache cleanup — ${missing.length} requested id(s) are no longer ghosts: ${missing.join(', ')}`)
          }
          // Same two-step rule as every other destructive route here: dry run
          // unless the body explicitly says `confirm: true` AND `dryRun: false`.
          const dryRun = body.confirm === true ? body.dryRun === true : true
          const result = await cleanupGhostCache(ctx, wanted, {
            dryRun,
            includePinned: body.includePinned === true,
            // Archived ghosts are skipped by default, matching the `keep` advice the
            // diagnosis shows: archiving already hides a session, so its leftover
            // cache is not what puts anything under 未分组.
            includeArchived: body.includeArchived === true,
            maxItems: Number.isFinite(Number(body.maxItems)) ? Number(body.maxItems) : undefined,
          })
          ctx?.logger?.info?.(
            `${name}: ghost-cache cleanup dryRun=${result.dryRun} deleted=${result.deleted.length} skipped=${result.skipped.length} failures=${result.failures.length} bytes=${result.bytesFreed}`,
          )
          return sendJson(res, 200, { ok: true, ...result })
        }

        // Snapshot ledger usage: READ-ONLY report. See lib/snapshot-usage.js.
        //
        // The ledger under <session>/history-file/ is what makes an old
        // conversation rollbackable, so this endpoint only ever measures.
        // There is no timer, no size ceiling and no age policy behind it —
        // automatic pruning was removed from this plugin on purpose and is
        // not coming back. The only way a ledger disappears is the user
        // pressing the delete button on the settings page.
        if (route === '/snapshot-usage' && (method === 'GET' || method === 'POST')) {
          const report = await scanSnapshotUsage({})
          ctx?.logger?.info?.(
            // `elapsedMs` is logged on purpose: this route is the only place
            // in the plugin that walks the whole sessions tree, and if a future
            // change makes it synchronous or unbounded the number here is what
            // will show it first.
            `${name}: snapshot usage — ledgers=${report.summary?.sessions ?? '?'} bytes=${report.summary?.totalBytes ?? '?'} blobs=${report.summary?.totalBlobs ?? '?'} elapsed=${report.elapsedMs ?? '?'}ms`,
          )
          return sendJson(res, 200, report)
        }

        if (method === 'POST' && route === '/snapshot-cleanup') {
          const body = await readJsonBody(req)
          // Re-scan rather than trusting the page: a session can be deleted
          // or re-created between render and click, and a stale entry would
          // then point at a path that no longer means what it did.
          const report = await scanSnapshotUsage({})
          if (report.ok !== true) {
            return sendJson(res, 503, { ok: false, error: report.detail ?? 'scan failed' })
          }
          const requested = Array.isArray(body.sessionIds) ? body.sessionIds.map((id) => String(id)) : null
          const wanted = requested === null
            ? report.entries
            : report.entries.filter((entry) => requested.includes(String(entry.sessionId)))
          if (requested !== null && wanted.length !== requested.length) {
            const found = new Set(wanted.map((entry) => String(entry.sessionId)))
            const missing = requested.filter((id) => !found.has(id))
            ctx?.logger?.warn?.(`${name}: snapshot cleanup — ${missing.length} requested id(s) have no ledger: ${missing.join(', ')}`)
          }
          // Same two-step rule as every other destructive route here: dry run
          // unless the body says `confirm: true` AND `dryRun: false`.
          const dryRun = body.confirm === true ? body.dryRun === true : true
          const result = await cleanupSnapshotUsage(wanted, {
            dryRun,
            maxItems: Number.isFinite(Number(body.maxItems)) ? Number(body.maxItems) : undefined,
          })
          ctx?.logger?.info?.(
            `${name}: snapshot cleanup dryRun=${result.dryRun} deleted=${result.deleted.length} skipped=${result.skipped.length} failures=${result.failures.length} bytes=${result.bytesFreed}`,
          )
          return sendJson(res, 200, { ok: true, ...result })
        }

        return sendJson(res, 404, { ok: false, error: `no route for ${method} ${route}` })
      } catch (error) {
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
}

export function apply(ctx, config) {
  // `config` may legitimately be undefined on an install that carries no config
  // row, so every read is defensive and the defaults are permissive.
  const settings = config ?? {}
  const disabled = settings.enabled === false

  if (disabled) {
    ctx.logger?.info?.(`${name}: disabled by config`)
    return
  }

  ctx.effect(() => {
    const dispose = installRoutes(ctx, settings)
    return () => dispose()
  }, `${name}: routes`)

  // ---------------------------------------------------------------------
  // File-history recorder: snapshot every file a tool is about to write.
  //
  // 🔴 `tool/call` IS PUBLISHED BEFORE THE TOOL RUNS. That ordering is the
  // whole mechanism: by the time the tool returns, the previous bytes are gone,
  // so a listener that fired afterwards could only ever record the NEW content.
  //
  // The listener is deliberately thin and never awaited by the harness: it
  // resolves the session directory asynchronously, so it returns immediately and
  // reports any failure through the log. A snapshot that cannot be taken must
  // degrade to "this file is not restorable", never to "the tool call failed".
  //
  // The listener lives inside `ctx.effect`, so it is removed with the plugin —
  // no manual unsubscribe, no leak across a hot reload.
  // ---------------------------------------------------------------------
  ctx.effect(() => ctx.on('session/event', (session, event) => {
    const sessionId = session?.id
    if (!sessionId) return
    Promise.resolve()
      .then(() => recordToolCall(sessionId, event, ctx))
      .catch((error) => {
        ctx.logger?.warn?.(`${name}: file-history listener threw: ${String(error?.message ?? error)}`)
      })
  }), `${name}: file-history`)

  // One-time cleanup of the PRE-0.25 location. Snapshots used to live in
  // `~/.dsh/file-history/<sessionId>`, which nothing ever garbage-collected;
  // they now live inside each session's own directory (see the FILE HISTORY
  // note above), so the old tree is dead weight. Removing it is safe and
  // idempotent — if it is not there, nothing happens.
  try {
    const legacy = join(homedir(), '.dsh', 'file-history')
    if (existsSync(legacy)) rmSync(legacy, { recursive: true, force: true })
  } catch (error) {
    ctx.logger?.warn?.(`${name}: could not remove legacy file-history dir: ${String(error?.message ?? error)}`)
  }

  // Self-report the resolved store paths at startup. Without this, a
  // misresolved path shows up much later as "copy path silently does nothing",
  // with no way to tell which of the many failure modes it was.
  ctx.logger?.info?.(
    `${name}: started v${PKG_VERSION} (favorites="${statePath()}", sessions="${sessionsRoot()}")`,
  )

  // ---------------------------------------------------------------------
  // Ungrouped guard — the "hard gate" the user asked for.
  //
  // It cannot PREVENT the bucket from existing (only the official create path
  // decides what gets registered), so it does the two things that are actually
  // possible from a plugin:
  //
  //   1. WARN LOUDLY, ONCE PER BOOT, if the bucket is not empty. A silent
  //      regression is how this problem survived a previous "fix".
  //   2. Expose the diagnose/cleanup routes so it can be fixed in one click.
  //
  // Deliberately delayed and never awaited: the registry's async init() is not
  // finished at apply() time, and a diagnostic that blocks plugin activation
  // would turn a cosmetic sidebar wart into a startup failure.
  // ---------------------------------------------------------------------
  const bootGuardEnabled = settings.ungroupedCheck !== false
  const bootGuardDelay = Number.isFinite(Number(settings.ungroupedCheckDelayMs))
    ? Math.max(0, Number(settings.ungroupedCheckDelayMs))
    : 8000
  const bootGuardTimer = bootGuardEnabled ? setTimeout(() => {
    diagnoseUngrouped(ctx, {})
      .then((report) => {
        if (report?.ok !== true) {
          ctx.logger?.warn?.(`${name}: ungrouped guard could not run: ${report?.detail ?? 'unknown'}`)
          return
        }
        const count = report.summary?.ungroupedCount ?? 0
        if (count > 0) {
          const ids = report.ungrouped.slice(0, 10).map((entry) => entry.sessionId).join(', ')
          ctx.logger?.warn?.(
            `${name}: ⚠ ${count} session(s) will appear under 未分组 in the sidebar (${ids}${count > 10 ? ', …' : ''}). `
            + `Open Settings → 归档收藏 → 未分组体检 to inspect and clean them.`,
          )
        } else {
          ctx.logger?.info?.(`${name}: ungrouped guard — clean (${report.summary?.totalDirs ?? 0} session dirs scanned, source=${report.source ?? 'file'})`)
        }
        // The directory scan above cannot see projection-cache ghosts, and those
        // are the ones that keep coming back: the directory is gone, the cache
        // entry is not, so the running instance keeps rendering it under 未分组.
        // This second pass is the only place that notices them.
        return diagnoseGhostCache(ctx, {}).then((ghosts) => {
          if (ghosts?.ok !== true) return
          // Only the actionable ones are worth a warning: pinned and archived
          // ghosts are kept by design (the cleanup refuses them), so counting
          // them here would nag on every boot with a number nobody can act on.
          const all = Array.isArray(ghosts.ghosts) ? ghosts.ghosts : []
          const actionable = all.filter((entry) => entry?.advise === 'delete')
          const actionableBytes = actionable.reduce((sum, entry) => sum + (Number(entry?.bytes) || 0), 0)
          const keptCount = all.length - actionable.length
          if (actionable.length > 0) {
            ctx.logger?.warn?.(
              `${name}: ⚠ ${actionable.length} projection-cache ghost(s) with no session directory (${actionableBytes} bytes). `
              + `These render under 未分组 and the directory scan cannot see them. `
              + `Open Settings → 归档收藏 → 未分组体检 → 缓存幽灵 to inspect and clean.`,
            )
          } else {
            ctx.logger?.info?.(
              `${name}: ghost-cache guard — clean (${ghosts.summary?.cacheFiles ?? 0} cache files vs ${ghosts.summary?.diskSessions ?? 0} session dirs`
              + (keptCount > 0 ? `, ${keptCount} kept as pinned/archived` : '')
              + ')',
            )
          }
        })
      })
      .catch((error) => {
        ctx.logger?.warn?.(`${name}: ungrouped guard threw: ${String(error?.message ?? error)}`)
      })
  }, bootGuardDelay) : null
  if (typeof bootGuardTimer?.unref === 'function') bootGuardTimer.unref()
  ctx.effect(() => () => clearTimeout(bootGuardTimer), `${name}: ungrouped-boot-check`)
}

// Exported for the probe suite; not part of the plugin contract.
export const __internals = {
  readState,
  writeState,
  projectDirName,
  bareId,
  idKey,
  visibleKeysOf,
  sidebarSessionKeys,
  humanDuration,
  sessionDirNames,
  handleDelete,
  probeLog,
  transcriptPath: transcriptPathFor,
  selectIdleSessions,
  activityCatalogue,
  LOG_BASENAMES,
  // 0.25.0 — file history / log parsing (probe-visible, same as the rest).
  sessionDirOf,
  fileHistoryDir,
  recordToolCall,
  reverseApplyFromLog,
  restoreFilesBefore,
  affectedFiles,
  readSessionEvents,
  collectLogChanges,
  turnInfo,
  FILE_HISTORY_BLOB_LIMIT,
  FILE_TOOL_PATHS,
  // 0.26.0 — ungrouped guard (probe-visible, same as the rest).
  diagnoseUngrouped,
  cleanupUngrouped,
  explainUngrouped,
  UNGROUPED_GUARD_VERSION,
  // 0.28.0 — continuation brief (probe-visible, same as the rest).
  sessionDigest,
  clipText,
  textBlocksOf,
  DIGEST_MESSAGE_CLIP,
  DIGEST_PROMPT_BUDGET,
  // 0.28.5 — projection-cache ghosts (probe-visible, same as the rest).
  diagnoseGhostCache,
  cleanupGhostCache,
  // 0.28.7 — deleting a session now also drops its projection cache.
  projCacheRoot,
  dropProjectionCache,
  // 0.29.0 — snapshot ledger usage + manual cleanup (probe-visible, same as the rest).
  scanSnapshotUsage,
  cleanupSnapshotUsage,
  SNAPSHOT_USAGE_VERSION,
}

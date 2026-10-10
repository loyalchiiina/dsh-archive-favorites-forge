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

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync } from 'node:fs'
import { readFile, readdir, stat, lstat, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

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

async function handleDelete(payload, ctx, settings) {
  const requested = Array.isArray(payload?.sessionIds) ? payload.sessionIds.map(String) : []
  const favorites = readState().favorites
  const max = Number(settings?.maxDeletePerCall ?? 500)

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
    if (favoriteKeys.has(idKey(sessionId))) {
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

  // Self-report the resolved store paths at startup. Without this, a
  // misresolved path shows up much later as "copy path silently does nothing",
  // with no way to tell which of the many failure modes it was.
  ctx.logger?.info?.(
    `${name}: started v${PKG_VERSION} (favorites="${statePath()}", sessions="${sessionsRoot()}")`,
  )
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
}

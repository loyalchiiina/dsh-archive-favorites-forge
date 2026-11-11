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
// protection) and is the only code that removes a session directory. Every
// delete in this plugin — the sidebar row, the batch cards, the archive sweep —
// reaches it through the SAME `/delete` route. Two deletion code paths on one
// machine is how a "guarded" delete becomes an unguarded one by accident.
//
// 0.39.0 removed the last exception to that rule. Edit/undo no longer deletes
// anything at all (it rewinds the session in place, see `/session-rewind`), so
// the `replace` option that used to switch the favourite guard off — and the
// `/session-replace` route that set it — are gone.
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
  sendToRecycleBin,
} from './ungrouped-guard.js'
import { scanSnapshotUsage, cleanupSnapshotUsage, measureLedger, SNAPSHOT_USAGE_VERSION, metaFromCache } from './snapshot-usage.js'

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

// 0.40.0 — the ★ Star button must open the project's REAL repository, so the
// URL is read out of package.json (`repository.url`, falling back to
// `homepage`) instead of being hard-coded in the client bundle: a hard-coded
// address silently keeps pointing at an old fork after a repo is renamed.
// `git+https://…​.git` and a trailing `#readme` are normalised away because
// both forms open the GitHub page badly (or 404) in a browser.
const PKG_REPOSITORY_URL = (() => {
  try {
    const here = dirname(fileURLToPath(import.meta.url))
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
    const raw = typeof pkg.repository === 'string'
      ? pkg.repository
      : (pkg?.repository?.url ?? pkg?.homepage ?? '')
    const cleaned = String(raw)
      .replace(/^git\+/i, '')
      .replace(/#readme$/i, '')
      .replace(/\.git$/i, '')
      .replace(/\/+$/, '')
    return /^https?:\/\//i.test(cleaned) ? cleaned : ''
  } catch {
    return ''
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
// Snapshot policy: { version, autoSelect, hours }
//
// 🔴 `autoSelect` IS NOT AN AUTO-DELETE SWITCH, AND MUST NEVER BECOME ONE.
// All it does is pre-tick rows in the snapshot table when the user presses the
// measure button — the delete still needs a dry run plus a second confirm. A
// timer that removes ledgers on its own was shipped once, was pulled for
// destroying rollback, and is not coming back. Persisting `autoSelect` is what
// makes the tick survive a reload; it grants no destructive power on its own.
//
// Kept in its own file rather than inside favorites.json so that wiping one
// never takes the other with it, and so a hand-edited policy cannot corrupt the
// star list.
// ---------------------------------------------------------------------------

const SNAPSHOT_POLICY_VERSION = 1
/**
 * 720 hours = 30 days.
 *
 * Hours, not days, for the same reason the idle-archive control uses hours: the
 * threshold has to line up with that control's unit, or the two cards would
 * disagree about what "超时" means on the same page.
 */
const SNAPSHOT_POLICY_DEFAULT_HOURS = 720

const snapshotPolicyPath = () => join(stateDir(), 'snapshot-policy.json')

function clampHours(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return SNAPSHOT_POLICY_DEFAULT_HOURS
  // One hour floor / ten years ceiling: outside that a threshold is either a
  // typo or meaningless, and either way it would tick every row or none.
  return Math.min(Math.max(Math.round(n), 1), 24 * 365 * 10)
}

/** Same clamp for any policy: one hour floor, ten year ceiling. */
function clampPolicyHours(value, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(Math.max(Math.round(n), 1), 24 * 365 * 10)
}

function readSnapshotPolicy() {
  try {
    const parsed = JSON.parse(readFileSync(snapshotPolicyPath(), 'utf8'))
    return {
      version: SNAPSHOT_POLICY_VERSION,
      // Anything other than a literal `true` reads as off. The switch guards a
      // pre-selection, so the safe direction is "off" when the file is odd.
      autoSelect: parsed?.autoSelect === true,
      hours: clampHours(parsed?.hours),
    }
  } catch {
    return { version: SNAPSHOT_POLICY_VERSION, autoSelect: false, hours: SNAPSHOT_POLICY_DEFAULT_HOURS }
  }
}

function writeSnapshotPolicy(next) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const payload = {
    version: SNAPSHOT_POLICY_VERSION,
    autoSelect: next?.autoSelect === true,
    hours: clampHours(next?.hours),
  }
  const tmp = join(dir, `.snapshot-policy.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, snapshotPolicyPath())
  return payload
}
// ---------------------------------------------------------------------------
// Archive-delete policy: { version, autoSelect, hours }
//
// Same shape and the same meaning as the snapshot policy above, kept in its own
// file for a reason that is not symmetry: the two thresholds guard actions with
// very different blast radii. Dropping a snapshot ledger costs "undo an old
// turn"; deleting an archived conversation destroys the conversation. Sharing
// one threshold would mean tuning the cheap one silently widens the expensive
// one, so they are independent by construction.
//
// 🔴 SAME RULE AS THE SNAPSHOT POLICY: `autoSelect` is NOT an auto-delete
// switch. It only pre-ticks rows when the user presses a button, and the
// delete still costs a dry run plus a second confirmation.
// ---------------------------------------------------------------------------

const ARCHIVE_DELETE_POLICY_VERSION = 1
/** 720 hours = 30 days, matching the snapshot policy default. */
const ARCHIVE_DELETE_POLICY_DEFAULT_HOURS = 720

const archiveDeletePolicyPath = () => join(stateDir(), 'archive-delete-policy.json')

function readArchiveDeletePolicy() {
  try {
    const parsed = JSON.parse(readFileSync(archiveDeletePolicyPath(), 'utf8'))
    return {
      version: ARCHIVE_DELETE_POLICY_VERSION,
      autoSelect: parsed?.autoSelect === true,
      hours: clampPolicyHours(parsed?.hours, ARCHIVE_DELETE_POLICY_DEFAULT_HOURS),
    }
  } catch {
    return {
      version: ARCHIVE_DELETE_POLICY_VERSION,
      autoSelect: false,
      hours: ARCHIVE_DELETE_POLICY_DEFAULT_HOURS,
    }
  }
}

function writeArchiveDeletePolicy(next) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  const payload = {
    version: ARCHIVE_DELETE_POLICY_VERSION,
    autoSelect: next?.autoSelect === true,
    hours: clampPolicyHours(next?.hours, ARCHIVE_DELETE_POLICY_DEFAULT_HOURS),
  }
  const tmp = join(dir, `.archive-delete-policy.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, archiveDeletePolicyPath())
  return payload
}

// ---------------------------------------------------------------------------
// Archive-purge policy: { version, enabled }
//
// 🔴 THIS IS THE ONE PLACE IN THIS PLUGIN WHERE A DESTRUCTIVE ACTION HAPPENS
// WITHOUT THE USER PRESSING A DELETE BUTTON, AND IT EXISTS BECAUSE THE OWNER
// ASKED FOR IT ON 2026-11-01 — reversing the "no automatic clean-up, ever"
// decision recorded in the 0.29.0 notes.
//
// Three limits keep it from becoming the timer that was pulled once:
//   * It fires ONLY as part of an archive the user just asked for. No clock,
//     no size ceiling, no age sweep — archiving is the trigger and the only
//     trigger, and only for the sessions this very request archived.
//   * It defaults to OFF. A missing or unreadable file reads as OFF; anything
//     other than a literal `true` reads as OFF.
//   * Deletion still goes to the Windows recycle bin via
//     `cleanupSnapshotUsage` → `sendToRecycleBin`, with the same
//     "must be a history-file directory strictly inside the sessions root"
//     guards as the manual button. Nothing here can rm -rf anything.
//
// SIDEBAR ARCHIVING IS COVERED TOO — but by a different mechanism, because
// `@deepseek-ai/dsh-workspace`'s `archiveSession()` emits no event of its own.
// The archive set lives in the storage-domain `workspace` global record, and
// every write to it emits `domain/changed`; the watch further down observes
// exactly that signal, so 归档 from the harness sidebar triggers this same
// switch. See the SIDEBAR ARCHIVE WATCH block.
// ---------------------------------------------------------------------------

const ARCHIVE_PURGE_POLICY_VERSION = 1

const archivePurgePolicyPath = () => join(stateDir(), 'archive-purge-policy.json')

// DEFAULT: ON.
//
// Up to 0.34.1 an absent file meant OFF, and that default was wrong for the
// way this feature is actually used: archiving a conversation is the point at
// which its undo history stops being worth its bytes, so the useful setting is
// the one that already does the cleanup. A missing file therefore reads as
// enabled, and only an explicit `enabled: false` (written when the user unticks
// the box) keeps the ledger. 2026-11-01, user decision.
//
// The blast radius is unchanged: this still only fires from an archive the user
// just performed, never from a timer, a size ceiling or an age policy.
// The blast radius of `enabled` is unchanged: it only governs the purge that
// runs because the user just archived something — never from a size ceiling.
// The opt-in BACKGROUND block below is a separate key (`background`) for
// exactly that reason: archiving something is consent, a clock is not.
function readArchivePurgePolicy() {
  try {
    const parsed = JSON.parse(readFileSync(archivePurgePolicyPath(), 'utf8'))
    return {
      version: ARCHIVE_PURGE_POLICY_VERSION,
      enabled: parsed?.enabled !== false,
      background: normalizeBackgroundCleanup(parsed?.background),
    }
  } catch {
    return {
      version: ARCHIVE_PURGE_POLICY_VERSION,
      enabled: true,
      background: normalizeBackgroundCleanup(null),
    }
  }
}

function writeArchivePurgePolicy(next) {
  const dir = stateDir()
  mkdirSync(dir, { recursive: true })
  // `background` is persisted in the SAME file as `enabled` on purpose: the
  // settings page already owns this JSON, and a second store would be a second
  // answer to "is cleanup on". An absent `background` key is normalised, not
  // rejected, so a file written by 0.39.x keeps working untouched.
  const current = readArchivePurgePolicy()
  const payload = {
    version: ARCHIVE_PURGE_POLICY_VERSION,
    enabled: next?.enabled === undefined ? current.enabled : next.enabled === true,
    background: next?.background === undefined ? current.background : normalizeBackgroundCleanup(next.background),
  }
  const tmp = join(dir, `.archive-purge-policy.${process.pid}.tmp`)
  writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(tmp, archivePurgePolicyPath())
  return payload
}

// ---------------------------------------------------------------------------
// BACKGROUND CLEANUP — "make it work without opening the settings page".
//
// WHAT WAS ACTUALLY BROKEN (2026-11-10)
// -------------------------------------
// Deleting a ledger on archive DID work: `domain/changed` → the sidebar watch →
// `purgeSnapshotFor` → `cleanupSnapshotUsage` → recycle bin. The host log proves
// it (`sidebar archive purge — sessions=1 deleted=1`, no settings page open).
// What did not exist was any CLOCK. Both triggers are events: an archive this
// plugin performs, or an archive the sidebar performs. A user who archives
// nothing — or who archives and then keeps chatting — sees the ledger grow and
// concludes the switch is dead, because nothing in this file ever asked "how
// old is this ledger". The card's 超时 1 小时 was only a filter for a list that
// rendered when the settings page was open.
//
// WHAT THIS BLOCK ADDS
// --------------------
// A host-side tick that, without any UI attached, re-reads the SAME policy file
// the settings page writes, scans the ledgers, and moves the ones that are over
// the saved threshold to the recycle bin. It runs on a 60 s tick and decides
// from the persisted `lastRun.at` + `scheduleMinutes` whether a real scan is
// due, so a config change takes effect without a restart.
//
// WHY THE DEFAULT IS OFF, AND MUST STAY OFF
// -----------------------------------------
// README.md, "Automatic pruning" section — the pruner is promised OFF by
// default, and settings-card item ⑰ promises a separate optional timer.
// Both promises are quoted by title, not by line number: line numbers in that
// file move every release and this comment already rotted once.
// Shipping an enabled timer would make that sentence a lie, so the tick is a
// no-op until `background.enabled: true` exists in archive-purge-policy.json.
//
// HARD LIMITS (identical to the event-driven path, not weaker):
//   • favourites are never touched — same `readState().favorites` + `idKey`
//     comparison the settings card uses to keep them off the delete list;
//   • only `<session>/history-file` is moved — `cleanupSnapshotUsage` re-checks
//     `basename(dir)` and `isPathInside(sessionsRoot, dir)` per entry;
//   • one run is capped at `maxItems` (default 50, hard ceiling 500);
//   • nothing whose age is unknown (`idleMs === null`) is ever deleted;
//   • every move goes to the recycle bin, so it is recoverable by hand.
// ---------------------------------------------------------------------------
const BACKGROUND_CLEANUP_VERSION = 1
const BACKGROUND_CLEANUP_DEFAULT = Object.freeze({
  enabled: false,
  scheduleMinutes: 60,
  hours: 1,
  maxItems: 50,
})
const BACKGROUND_CLEANUP_HOURS_MAX = 24 * 30
const BACKGROUND_SCHEDULE_MIN_MINUTES = 15
const BACKGROUND_SCHEDULE_MAX_MINUTES = 24 * 60
const BACKGROUND_MAX_ITEMS_CEILING = 500
/** How often the cheap "is a scan due?" check runs. */
const BACKGROUND_TICK_MS = 60 * 1000
/** Startup delay: let the host finish booting before the first disk walk. */
const BACKGROUND_FIRST_DELAY_MS = 90 * 1000

const backgroundCleanupLastPath = () => join(stateDir(), 'background-cleanup-last.json')

function clampScheduleMinutes(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return BACKGROUND_CLEANUP_DEFAULT.scheduleMinutes
  return Math.min(BACKGROUND_SCHEDULE_MAX_MINUTES, Math.max(BACKGROUND_SCHEDULE_MIN_MINUTES, Math.round(n)))
}

function clampBackgroundHours(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) return BACKGROUND_CLEANUP_DEFAULT.hours
  return Math.min(BACKGROUND_CLEANUP_HOURS_MAX, n)
}

function clampBackgroundMaxItems(value) {
  const n = Number(value)
  if (!Number.isFinite(n) || n < 1) return BACKGROUND_CLEANUP_DEFAULT.maxItems
  return Math.min(BACKGROUND_MAX_ITEMS_CEILING, Math.floor(n))
}

function normalizeBackgroundCleanup(input) {
  const raw = input !== null && typeof input === 'object' ? input : {}
  return {
    // Anything other than a literal `true` is OFF. A string "true" or a 1 from a
    // hand-edited file must not arm a timer that deletes files.
    enabled: raw.enabled === true,
    scheduleMinutes: clampScheduleMinutes(raw.scheduleMinutes),
    // `null` means "inherit the 超时 threshold the settings card already
    // shows" (snapshot-policy.json). Storing a copy here would let the two
    // numbers drift, and the user would tune one and watch the other act.
    hours: raw.hours === undefined || raw.hours === null ? null : clampBackgroundHours(raw.hours),
    maxItems: clampBackgroundMaxItems(raw.maxItems),
  }
}

/**
 * The age threshold a background run should actually use.
 *
 * Priority: explicit per-call override → explicit background setting → the
 * snapshot policy's 超时 hours (the number the card renders and the user set to
 * 1) → the built-in default. This is the "共用同一份持久化存储" requirement: no
 * second copy of the threshold is invented when one already exists.
 */
function resolveBackgroundHours(config, options) {
  const given = Number(options?.hours)
  if (Number.isFinite(given) && given > 0) return clampBackgroundHours(given)
  const saved = Number(config?.hours)
  if (config?.hours !== null && config?.hours !== undefined && Number.isFinite(saved) && saved > 0) {
    return clampBackgroundHours(saved)
  }
  try {
    return clampBackgroundHours(readSnapshotPolicy().hours)
  } catch {
    return BACKGROUND_CLEANUP_DEFAULT.hours
  }
}

/**
 * Last completed background run, for the settings card to render.
 *
 * Shape: `{ version, at, mode, scanned, candidates, deleted, bytes, files,
 * skipped, failures, hours, maxItems, toRecycleBin, elapsedMs, ok }`.
 * A missing/corrupt file reads as null — "never ran" is a legitimate state and
 * must not crash the tick that is about to write it.
 */
function readBackgroundCleanupLast() {
  try {
    const parsed = JSON.parse(readFileSync(backgroundCleanupLastPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return null
    return {
      version: Number(parsed.version ?? BACKGROUND_CLEANUP_VERSION),
      at: typeof parsed.at === 'string' ? parsed.at : null,
      mode: typeof parsed.mode === 'string' ? parsed.mode : 'scheduled',
      scanned: Number(parsed.scanned ?? 0),
      candidates: Number(parsed.candidates ?? 0),
      deleted: Number(parsed.deleted ?? 0),
      bytes: Number(parsed.bytes ?? 0),
      files: Number(parsed.files ?? 0),
      skipped: Number(parsed.skipped ?? 0),
      failures: Number(parsed.failures ?? 0),
      hours: Number(parsed.hours ?? BACKGROUND_CLEANUP_DEFAULT.hours),
      maxItems: Number(parsed.maxItems ?? BACKGROUND_CLEANUP_DEFAULT.maxItems),
      toRecycleBin: parsed.toRecycleBin !== false,
      elapsedMs: Number(parsed.elapsedMs ?? 0),
      ok: parsed.ok !== false,
    }
  } catch {
    return null
  }
}

function writeBackgroundCleanupLast(record) {
  try {
    const dir = stateDir()
    mkdirSync(dir, { recursive: true })
    const payload = { version: BACKGROUND_CLEANUP_VERSION, ...record }
    const tmp = join(dir, `.background-cleanup-last.${process.pid}.tmp`)
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, backgroundCleanupLastPath())
    return payload
  } catch (error) {
    // A missing status file only costs the card one line of text; it must never
    // turn a successful cleanup into a reported failure.
    return null
  }
}

/**
 * Scan, filter, delete, record. Never throws — the caller is a timer, and a
 * timer that throws takes the host's unhandled-rejection path with it.
 *
 * Options: `{ reason: 'scheduled' | 'manual' | 'force', dryRun: boolean,
 * hours, maxItems }`. `reason: 'force'` runs even when the switch is off, which
 * is what a "run now" button needs; `dryRun` plans without moving anything.
 */
async function runBackgroundCleanup(ctx, options = {}) {
  const startedAt = Date.now()
  const dryRun = options?.dryRun === true
  const force = options?.reason === 'force'
  let config
  try {
    config = readArchivePurgePolicy().background ?? normalizeBackgroundCleanup(null)
  } catch (error) {
    return { ok: false, skipped: 'policy-unreadable', error: String(error?.message ?? error) }
  }
  if (config.enabled !== true && !force) {
    return { ok: true, skipped: 'disabled', config }
  }
  const hours = resolveBackgroundHours(config, options)
  const maxItems = Number.isFinite(Number(options?.maxItems)) ? clampBackgroundMaxItems(options.maxItems) : config.maxItems

  let scan = null
  try {
    scan = await scanSnapshotUsage({})
  } catch (error) {
    const record = {
      at: new Date().toISOString(),
      mode: dryRun ? 'dry-run' : 'scheduled',
      scanned: 0,
      candidates: 0,
      deleted: 0,
      bytes: 0,
      files: 0,
      skipped: 0,
      failures: 1,
      hours,
      maxItems,
      toRecycleBin: true,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      error: `scan-failed:${String(error?.message ?? error)}`,
    }
    if (!dryRun) writeBackgroundCleanupLast(record)
    ctx?.logger?.warn?.(`${name}: background cleanup scan failed: ${record.error}`)
    return record
  }
  if (scan?.ok !== true) {
    const record = {
      at: new Date().toISOString(),
      mode: dryRun ? 'dry-run' : 'scheduled',
      scanned: 0,
      candidates: 0,
      deleted: 0,
      bytes: 0,
      files: 0,
      skipped: 0,
      failures: 0,
      hours,
      maxItems,
      toRecycleBin: true,
      elapsedMs: Date.now() - startedAt,
      ok: false,
      error: String(scan?.detail ?? 'scan-not-ok'),
    }
    if (!dryRun) writeBackgroundCleanupLast(record)
    ctx?.logger?.warn?.(`${name}: background cleanup skipped: ${record.error}`)
    return record
  }

  const favourites = readState().favorites
  const favouriteKeys = new Set(Object.keys(favourites).map(idKey))
  const minIdleMs = hours * 60 * 60 * 1000
  const entries = Array.isArray(scan.entries) ? scan.entries : []
  const candidates = entries.filter((entry) => {
    if (entry === null || typeof entry !== 'object') return false
    if (typeof entry.dir !== 'string' || entry.dir.length === 0) return false
    if (Number(entry.bytes ?? 0) <= 0) return false
    // Unknown age is not old age. A ledger whose activity stamp the cache could
    // not supply is left alone; guessing would delete a live conversation's undo.
    if (entry.idleMs === null || entry.idleMs === undefined || !Number.isFinite(Number(entry.idleMs))) return false
    if (Number(entry.idleMs) < minIdleMs) return false
    if (favouriteKeys.has(idKey(entry.sessionId))) return false
    return true
  })
  const plan = candidates.slice(0, maxItems).map((entry) => ({
    sessionId: String(entry.sessionId),
    dir: String(entry.dir),
    bytes: Number(entry.bytes ?? 0),
    files: Number(entry.blobCount ?? 0) + (Number(entry.manifestBytes ?? 0) > 0 ? 1 : 0),
  }))

  let outcome = { deleted: [], skipped: [], failures: [], bytesFreed: 0 }
  if (plan.length > 0) {
    try {
      outcome = await cleanupSnapshotUsage(plan, { dryRun, maxItems })
    } catch (error) {
      const record = {
        at: new Date().toISOString(),
        mode: dryRun ? 'dry-run' : 'scheduled',
        scanned: entries.length,
        candidates: candidates.length,
        deleted: 0,
        bytes: 0,
        files: 0,
        skipped: 0,
        failures: 1,
        hours,
        maxItems,
        toRecycleBin: true,
        elapsedMs: Date.now() - startedAt,
        ok: false,
        error: `cleanup-failed:${String(error?.message ?? error)}`,
      }
      if (!dryRun) writeBackgroundCleanupLast(record)
      ctx?.logger?.warn?.(`${name}: background cleanup failed: ${record.error}`)
      return record
    }
  }

  const deletedIds = new Set((outcome.deleted ?? []).map(String))
  let filesMoved = 0
  for (const one of plan) {
    if (!deletedIds.has(one.sessionId)) continue
    filesMoved += one.files
    ctx?.logger?.info?.(
      `${name}: background purged session=${one.sessionId} bytes=${one.bytes} files=${one.files} toRecycleBin=${dryRun ? 'planned' : 'true'}`,
    )
  }
  const problems = (outcome.failures ?? []).length + (outcome.skipped ?? []).length
  const record = {
    at: new Date().toISOString(),
    mode: dryRun ? 'dry-run' : 'scheduled',
    scanned: entries.length,
    candidates: candidates.length,
    deleted: (outcome.deleted ?? []).length,
    bytes: Number(outcome.bytesFreed ?? 0),
    files: filesMoved,
    skipped: (outcome.skipped ?? []).length,
    failures: (outcome.failures ?? []).length,
    hours,
    maxItems,
    toRecycleBin: true,
    elapsedMs: Date.now() - startedAt,
    ok: true,
  }
  if (!dryRun) writeBackgroundCleanupLast(record)
  ctx?.logger?.info?.(
    `${name}: background cleanup${dryRun ? ' (dry-run)' : ''} — scanned=${record.scanned} candidates=${record.candidates} deleted=${record.deleted} bytes=${record.bytes} files=${record.files} hours=${hours} problems=${problems}`,
  )
  if (record.deleted > 0 && !dryRun) {
    ctx?.logger?.info?.(
      `${name}: ${record.bytes} bytes (${record.files} files) moved to the Windows recycle bin — disk space is released only after the bin is emptied`,
    )
  }
  return record
}

/**
 * Arm the tick. Returns a disposer so `ctx.effect` removes the timer with the
 * plugin; a plugin reload must never leave two schedulers racing one directory.
 *
 * The interval is deliberately fixed (60 s) rather than re-armed per config
 * change: the tick is one small JSON read when nothing is due, and re-arming
 * would need the settings page to tell the host that the policy file changed —
 * a coupling this design avoids entirely.
 */
function installBackgroundCleanup(ctx) {
  let disposed = false
  let running = false
  let timer = null
  let firstTimer = null

  /** Persisted-then-in-memory "when did we last actually try", so a crash storm
   *  cannot turn into a scan storm on restart. */
  const lastAttempt = () => {
    const persisted = readBackgroundCleanupLast()
    const at = persisted?.at ? Date.parse(persisted.at) : NaN
    return Number.isFinite(at) ? at : 0
  }

  const tick = async () => {
    if (disposed || running) return
    let config
    try {
      config = readArchivePurgePolicy().background ?? normalizeBackgroundCleanup(null)
    } catch {
      return
    }
    if (config.enabled !== true) return
    const intervalMs = clampScheduleMinutes(config.scheduleMinutes) * 60 * 1000
    const baseline = lastAttempt()
    if (baseline > 0 && Date.now() - baseline < intervalMs) return
    running = true
    try {
      await runBackgroundCleanup(ctx, { reason: 'scheduled' })
    } catch (error) {
      // Belt and braces: runBackgroundCleanup is already total, but a bug in the
      // logger must not become an unhandled rejection on a timer.
      ctx?.logger?.warn?.(`${name}: background cleanup tick threw: ${String(error?.message ?? error)}`)
    } finally {
      running = false
    }
  }

  timer = setInterval(() => { void tick() }, BACKGROUND_TICK_MS)
  timer.unref?.()
  firstTimer = setTimeout(() => { void tick() }, BACKGROUND_FIRST_DELAY_MS)
  firstTimer.unref?.()

  let initial = null
  try {
    initial = readArchivePurgePolicy().background
  } catch {
    initial = null
  }
  const cfg = initial ?? normalizeBackgroundCleanup(null)
  ctx?.logger?.info?.(
    `${name}: background snapshot cleanup ${cfg.enabled === true ? `ARMED every ${cfg.scheduleMinutes}m (hours=${resolveBackgroundHours(cfg, null)}, maxItems=${cfg.maxItems})` : 'idle (OFF by default — enable it in the settings card)'}`,
  )

  return () => {
    disposed = true
    if (timer !== null) clearInterval(timer)
    if (firstTimer !== null) clearTimeout(firstTimer)
    timer = null
    firstTimer = null
  }
}

// ---------------------------------------------------------------------------
// SIDEBAR ARCHIVE WATCH — the second trigger for the same switch.
//
// The `/idle-archive` route described above can only see the archives IT
// performs. The harness's own sidebar right-click → 归档 goes straight to
// `@deepseek-ai/dsh-workspace`'s `archiveSession()`, which (verified against the
// shipped asar) emits NO event of its own. For a long time that made the switch
// look broken to anyone who archived the normal way.
//
// THERE IS AN EVENT AFTER ALL — one layer down. `archiveSession()` persists
// through the storage-domain facility, whose global handle emits
//
//     domain/changed  { domain: 'workspace', table: '', key: '', operation: 'put',
//                       value: { initialized, workspaceIds, archivedSessionIds,
//                                pinnedSessionIds } }
//
// and `@deepseek-ai/dsh-api-workspace-controller` observes exactly that signal
// in production. `ctx.on('domain/changed')` is a plain bus subscription — it is
// not scoped to the emitting fiber — so this plugin can observe it too.
//
// WHY THE DIFF AND NOT THE PAYLOAD: every put carries the COMPLETE archive set,
// so the newly-archived ids are (current − previous). Remembering the previous
// set is also what makes the first event safe: without a baseline the first put
// would look like "the entire archive was just archived" and the plugin would
// purge every ledger on the machine. The first observed put therefore only
// seeds the baseline and never deletes.
//
// WHAT THIS DELIBERATELY DOES NOT DO:
//   * it never un-archives, never deletes a conversation, never touches a file
//     outside `<sessionDir>/history-file`;
//   * it does nothing at all unless `archive-purge-policy.json` says
//     `enabled: true` (default OFF, same file the settings switch writes);
//   * it dedupes against this plugin's own `/idle-archive` so one archive
//     action can never race two purges of the same directory.
// ---------------------------------------------------------------------------

/** The archive set as of the last observed put; `null` until the first one. */
let archiveWatchSeed = null

/**
 * Ids this plugin archived itself, mapped to an expiry timestamp.
 *
 * `/idle-archive` already purges the sessions it archived. Without this the
 * watch would purge the same directory a second time — harmless in effect
 * (the ledger is already gone) but it races two recycle-bin moves of one path
 * and logs a spurious failure, so the duplicate is suppressed instead.
 */
const selfArchivedUntil = new Map()

function noteSelfArchived(sessionId) {
  const key = idKey(sessionId)
  selfArchivedUntil.set(key, Date.now() + 30000)
  const timer = setTimeout(() => selfArchivedUntil.delete(key), 30000)
  if (typeof timer.unref === 'function') timer.unref()
}

function wasSelfArchived(sessionId) {
  const key = idKey(sessionId)
  const until = selfArchivedUntil.get(key)
  if (until === undefined) return false
  if (Date.now() >= until) {
    selfArchivedUntil.delete(key)
    return false
  }
  return true
}

/**
 * Pull the complete archive set out of one `domain/changed` payload.
 *
 * Returns `null` for every change this watch does not care about (other
 * domains, table rows, deletions) so the caller can bail without inspecting
 * the payload shape again.
 */
function archivedIdsFromChange(change) {
  if (change === null || typeof change !== 'object') return null
  if (change.domain !== 'workspace') return null
  // `''` is the global record; every `workspaces` table row is a workspace,
  // not an archive decision.
  if (change.table !== '') return null
  if (change.operation !== 'put') return null
  const value = change.value
  const ids = value !== null && typeof value === 'object' ? value.archivedSessionIds : null
  if (!Array.isArray(ids)) return []
  return ids.map(String)
}

/**
 * Drop one session's snapshot ledger, returning the cleanup outcome.
 *
 * 🔴 THE SIZE IS MEASURED BEFORE THE MOVE, NOT AFTER. `cleanupSnapshotUsage`
 * charges `entry.bytes` to `bytesFreed`, and it can only charge what the caller
 * tells it. This function used to pass `{ sessionId, dir }` alone, so every
 * sidebar-archive purge logged `deleted=1 bytes=0` even when it really moved a
 * 10 MB ledger — and `bytes=0` reads to a human as "nothing happened". That log
 * line, not a broken switch, is why the owner reported the feature as dead on
 * 2026-11-10.
 *
 * `measureLedger` is the same measurement the settings card shows, so the log
 * and the table can never disagree. It runs before the recycle-bin move
 * because once the directory is in the bin there is nothing left to weigh.
 *
 * @param {object} [options] `dir` — resolve the ledger to this path instead of
 *        asking the host. The production callers pass nothing; the probe passes
 *        a fixture directory, because `fileHistoryDir` needs live host services
 *        (`transcriptPathFor`) that a test context does not have, and "could not
 *        resolve" used to look identical to "nothing to delete".
 */
async function purgeSnapshotFor(sessionId, ctx, options = {}) {
  let dir = typeof options?.dir === 'string' && options.dir.length > 0 ? options.dir : null
  if (dir === null) {
    try {
      dir = await fileHistoryDir(sessionId, ctx)
    } catch (error) {
      return { sessionId, deleted: false, bytesFreed: 0, files: 0, failures: [{ sessionId, reason: `resolve-failed:${String(error?.message ?? error)}` }] }
    }
  }
  if (dir === null) {
    return { sessionId, deleted: false, bytesFreed: 0, files: 0, failures: [{ sessionId, reason: 'session-directory-missing' }] }
  }
  let measured = null
  try {
    measured = await measureLedger(dir)
  } catch {
    // An unmeasurable ledger is still a deletable one; the byte count degrades
    // to 0 (and the log says nothing about size) rather than blocking the purge.
    measured = null
  }
  const ledgerBytes = Number.isFinite(Number(measured?.bytes)) ? Number(measured.bytes) : 0
  const ledgerFiles = Number(measured?.blobCount ?? 0) + (Number(measured?.manifestBytes ?? 0) > 0 ? 1 : 0)
  try {
    const outcome = await cleanupSnapshotUsage(
      [{ sessionId, dir, bytes: ledgerBytes, files: ledgerFiles }],
      { dryRun: false },
    )
    const deleted = Array.isArray(outcome.deleted) && outcome.deleted.length > 0
    return {
      sessionId,
      deleted,
      bytesFreed: Number(outcome.bytesFreed ?? 0),
      files: ledgerFiles,
      // Not a claim that the space is already free: the move is to the recycle
      // bin (quarantine only as a fallback), so the bytes stay on the volume
      // until the bin is emptied. Stated here so the caller's log can say it.
      toRecycleBin: true,
      failures: [].concat(outcome.failures ?? [], outcome.skipped ?? []),
    }
  } catch (error) {
    return { sessionId, deleted: false, bytesFreed: 0, files: ledgerFiles, toRecycleBin: true, failures: [{ sessionId, reason: `purge-failed:${String(error?.message ?? error)}` }] }
  }
}

/**
 * Handle one `domain/changed` notification.
 *
 * Exported through `__internals` so the host probe can drive it with a
 * synthetic payload instead of booting a workspace registry.
 */
async function handleWorkspaceArchiveChange(change, ctx) {
  const ids = archivedIdsFromChange(change)
  if (ids === null) return { action: 'ignored' }

  const next = new Set(ids.map(idKey))
  if (archiveWatchSeed === null) {
    // Baseline only. Purging here would wipe the ledgers of every session that
    // was already archived before this process started.
    archiveWatchSeed = next
    ctx?.logger?.info?.(`${name}: sidebar archive watch seeded a baseline of ${next.size} archived session(s)`)
    return { action: 'seeded', size: next.size }
  }
  const fresh = ids.filter((id) => !archiveWatchSeed.has(idKey(id)))
  archiveWatchSeed = next
  if (fresh.length === 0) return { action: 'no-change' }

  const policy = readArchivePurgePolicy()
  if (policy.enabled !== true) {
    ctx?.logger?.info?.(`${name}: sidebar archive seen for ${fresh.length} session(s); purge switch is OFF`)
    return { action: 'disabled', fresh }
  }

  const results = []
  for (const id of fresh) {
    if (wasSelfArchived(id)) {
      results.push({ sessionId: id, deleted: false, bytesFreed: 0, files: 0, failures: [], skipped: 'archived-by-this-plugin' })
      continue
    }
    const one = await purgeSnapshotFor(id, ctx)
    results.push(one)
    // One line per session. The aggregate alone was unreadable: it could not
    // tell "one 10 MB ledger" from "one empty directory", and `bytes=0` sent
    // the owner looking for a bug that was in this line, not in the deletion.
    if (one.deleted === true) {
      ctx?.logger?.info?.(
        `${name}: purged session=${id} bytes=${one.bytesFreed} files=${one.files ?? 0} toRecycleBin=true`,
      )
    } else if ((one.failures?.length ?? 0) > 0) {
      ctx?.logger?.warn?.(
        `${name}: purge not done session=${id} reason=${String(one.failures?.[0]?.reason ?? 'unknown')}`,
      )
    }
  }
  const deleted = results.filter((entry) => entry.deleted === true).length
  const bytesFreed = results.reduce((sum, entry) => sum + Number(entry.bytesFreed ?? 0), 0)
  const filesFreed = results.reduce((sum, entry) => sum + Number(entry.files ?? 0), 0)
  const problems = results.reduce((sum, entry) => sum + (entry.failures?.length ?? 0), 0)
  ctx?.logger?.info?.(
    `${name}: sidebar archive purge — sessions=${fresh.length} deleted=${deleted} bytes=${bytesFreed} files=${filesFreed} toRecycleBin=true problems=${problems}`,
  )
  // 🔴 SAY WHERE THE SPACE WENT. A recycle-bin move does not shrink the volume,
  // so "C 盘没变小" is expected, not evidence of failure. Without this line the
  // user re-reports the same bug every time they look at free space.
  if (deleted > 0) {
    ctx?.logger?.info?.(
      `${name}: ${bytesFreed} bytes (${filesFreed} files) moved to the Windows recycle bin — disk space is released only after the bin is emptied`,
    )
  }
  return { action: 'purged', fresh, results, deleted, bytesFreed, filesFreed }
}

/** Subscribe the watch. The listener is removed with the plugin fiber. */
function installArchiveWatch(ctx) {
  return ctx.on('domain/changed', (change) => {
    Promise.resolve()
      .then(() => handleWorkspaceArchiveChange(change, ctx))
      .catch((error) => {
        ctx?.logger?.warn?.(`${name}: sidebar archive watch threw: ${String(error?.message ?? error)}`)
      })
  })
}


/**
 * Arm the baseline at load time instead of waiting for the first event.
 *
 * Seeding on the first event is safe but lossy: that event is then treated as
 * the baseline, so the archive that produced it is never examined. A user who
 * flips the switch on and immediately archives one conversation hits exactly
 * that hole. Reading the live set at load time closes it.
 *
 * The registry service exists well before it is usable (`archivedSessionIds`
 * throws "not started yet" until its async init opens the storage domain), so
 * this retries briefly. If it never becomes readable the baseline stays null
 * and the first-event path still applies — degraded, never unsafe.
 */
async function seedArchiveWatch(ctx, attempts = 40, delayMs = 250) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const registry = ctx?.get?.('workspaceRegistry')
      const ids = registry?.archivedSessionIds
      if (Array.isArray(ids)) {
        archiveWatchSeed = new Set(ids.map(String).map(idKey))
        ctx?.logger?.info?.(`${name}: sidebar archive watch armed — baseline of ${archiveWatchSeed.size} archived session(s)`)
        return archiveWatchSeed.size
      }
    } catch (error) {
      const message = String(error?.message ?? error)
      if (!message.includes('not started yet')) {
        ctx?.logger?.warn?.(`${name}: sidebar archive watch could not arm: ${message}`)
        return null
      }
    }
    // Deliberately NOT unref'd. An unref'd timer does not keep the event
    // loop alive, so awaiting one as the only outstanding work lets node exit
    // mid-await. The loop is bounded, so a referenced timer is safe and cheap.
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  return null
}
/** Test seam: forget the baseline so a probe can replay a first-event scenario. */
function resetArchiveWatchSeed() {
  archiveWatchSeed = null
  selfArchivedUntil.clear()
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
// 🔴 THERE IS NO EXCEPTION TO THE FAVOURITE GUARD. Not one.
//
// 0.38.x had a single documented exception: `options.replace`, set only by the
// plugin's own edit/undo flow, which skipped the guard so the original
// conversation could be retired after its fork took over. 0.39.0 rewinds in
// place and deletes nothing, so that flag and its route (`/session-replace`)
// were removed rather than left dormant — a public route that permanently
// deletes a favourited conversation with the guard off is exactly the kind of
// thing that should not exist once nothing needs it.
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
    //
    // Unconditional since 0.39.0: the only historical exception (retiring the
    // original after a fork) no longer exists, because undo rewinds in place.
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
 * Snapshot-ledger facts for a batch of sessions — bytes and blob count.
 *
 * 0.37.0: every list in the settings page shows the same six columns, and two
 * of those columns are "文件大小" and "文件数量". Only the snapshot scan used
 * to know them; the archive and idle lists knew just a title and a timestamp,
 * so the same conversation read as a different record in each panel.
 *
 * Cost policy — this NEVER runs on its own:
 *   · it is only called from /archived and /idle-archive, i.e. after the user
 *     opened that panel or pressed its button;
 *   · at most MAX_LEDGER_ROWS rows are measured per request (the page renders
 *     60, so the cap is invisible), the rest print a dash;
 *   · the fan-out is bounded, because measuring a ledger stats every blob.
 * A row whose ledger is missing or unreadable simply gets no facts.
 */
const MAX_LEDGER_ROWS = 120
const LEDGER_FANOUT = 8

/**
 * Size and file count of the WHOLE session directory (transcript + ledger).
 *
 * 0.37.1 — the archived/deletion list used the ledger for its size columns,
 * which is honest but nearly always blank: 9 of 212 archived sessions on this
 * machine ever wrote a snapshot. The number a user actually needs on a
 * deletion list is "how much does deleting this free", and that is the whole
 * session directory. Bounded the same way as measureLedgersFor: only ever
 * called from a route the user just opened, never on a timer.
 */
async function measureSessionDirsFor(ids, ctx) {
  const wanted = Array.isArray(ids) ? ids.slice(0, MAX_LEDGER_ROWS) : []
  const result = new Map()
  if (wanted.length === 0) return result
  let cursor = 0
  const walk = async (dir) => {
    let bytes = 0
    let files = 0
    // 0.40.0 — `latest` is the newest mtime seen under this session directory.
    // The 收藏清单 needs a 时长 cell and the only honest source is "how long
    // has nothing in here changed" — a star stores {at,title,cwd} and nothing
    // else, so without this the column would have to show a dash on every row.
    let latest = 0
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return { bytes: 0, files: 0, latest: 0 }
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        const inner = await walk(full)
        bytes += inner.bytes
        files += inner.files
        if (inner.latest > latest) latest = inner.latest
        continue
      }
      if (!entry.isFile()) continue
      try {
        const info = await stat(full)
        if (!info.isFile() || info.size <= 0) continue
        bytes += info.size
        files += 1
        const touched = Number(info.mtimeMs) || 0
        if (touched > latest) latest = touched
      } catch {
        // A file that vanished mid-walk is not an error here.
      }
    }
    return { bytes, files, latest }
  }
  const worker = async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= wanted.length) return
      const id = wanted[index]
      try {
        const transcript = await transcriptPathFor(String(id), ctx)
        if (transcript === null) continue
        const measured = await walk(dirname(transcript))
        result.set(String(id), {
          bytes: measured.bytes,
          fileCount: measured.files,
          // Additive (0.40.0): newest mtime under the session dir, 0 when the
          // directory could not be read. Existing readers ignore it.
          modifiedAt: measured.latest > 0 ? new Date(measured.latest).toISOString() : null,
        })
      } catch {
        // Same reasoning: a missing directory is not an error in a list.
      }
    }
  }
  await Promise.all(new Array(Math.min(LEDGER_FANOUT, wanted.length)).fill(null).map(worker))
  return result
}

async function measureLedgersFor(ids, ctx) {
  const wanted = Array.isArray(ids) ? ids.slice(0, MAX_LEDGER_ROWS) : []
  const result = new Map()
  if (wanted.length === 0) return result
  let cursor = 0
  const worker = async () => {
    while (true) {
      const index = cursor
      cursor += 1
      if (index >= wanted.length) return
      const id = wanted[index]
      try {
        const dir = await fileHistoryDir(id, ctx)
        if (dir === null) continue
        const facts = await measureLedger(dir)
        if (facts === null || typeof facts !== 'object') continue
        result.set(String(id), {
          bytes: Number(facts.bytes) || 0,
          blobCount: Number(facts.blobCount) || 0,
          lastSnapshotAt: Number.isFinite(facts.lastSnapshotAt) ? facts.lastSnapshotAt : null,
        })
      } catch {
        // A session whose directory vanished mid-list is not an error here.
      }
    }
  }
  await Promise.all(new Array(Math.min(LEDGER_FANOUT, wanted.length)).fill(null).map(worker))
  return result
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
 * 0.39.0 — ONE LOG READ PER REQUEST, NOT THREE.
 *
 * Undoing a turn used to walk the same zstd log three times: `turnInfo` read it
 * to find the boundary, `affectedFiles` read it again to list the files, and
 * `sessions.fork` read it a third time inside the controller. On this machine's
 * biggest conversations that is 531 ms per pass (15 MB compressed -> 54 MB of
 * text -> 17,344 events), so the same bytes were decoded twice over.
 *
 * The cache is a plain Map owned by ONE request and thrown away with it. It is
 * never module-level state: a stale event list would be worse than a slow one,
 * and the log grows on every turn.
 *
 * @param {Map<string, Promise<Array<object>|null>>} [cache]
 */
function readSessionEventsCached(sessionId, ctx, cache) {
  if (!(cache instanceof Map)) return readSessionEvents(sessionId, ctx)
  const key = String(sessionId)
  if (!cache.has(key)) cache.set(key, readSessionEvents(sessionId, ctx))
  return cache.get(key)
}

/**
 * Parse a `history-file/manifest.jsonl`, once per request.
 *
 * Same reasoning as {@link readSessionEventsCached}: the rollback preview and
 * the rollback itself both need the ledger, and both need it inside the SAME
 * request only when the client asks ("what would this touch?") and then acts.
 * A torn last line is skipped, never fatal — a half-flushed ledger must still
 * let the user see the rest.
 *
 * @param {Map<string, unknown>} [cache]
 * @returns {Array<object>}
 */
function readManifestEntries(dir, cache) {
  const manifestPath = join(dir, 'manifest.jsonl')
  const key = 'manifest:' + manifestPath
  if (cache instanceof Map && cache.has(key)) return cache.get(key)
  const entries = []
  if (existsSync(manifestPath)) {
    for (const line of readFileSync(manifestPath, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line))
      } catch {
        continue
      }
    }
  }
  if (cache instanceof Map) cache.set(key, entries)
  return entries
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
async function collectLogChanges(sessionId, ctx, cache) {
  const events = await readSessionEventsCached(sessionId, ctx, cache)
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
async function reverseApplyFromLog(sessionId, keepSeq, ctx, cache) {
  const changes = (await collectLogChanges(sessionId, ctx, cache)).filter((c) => c.seq > keepSeq)
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
async function restoreFilesBefore(sessionId, keepSeq, ctx, cache) {
  const dir = await fileHistoryDir(sessionId, ctx)
  const manifestPath = dir === null ? null : join(dir, 'manifest.jsonl')
  const hasManifest = manifestPath !== null && existsSync(manifestPath)
  if (!hasManifest) {
    const rebuilt = await reverseApplyFromLog(sessionId, keepSeq, ctx, cache)
    return { ...rebuilt, source: 'log' }
  }
  const entries = readManifestEntries(dir, cache)
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
    const rebuilt = await reverseApplyFromLog(sessionId, keepSeq, ctx, cache)
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
    // The ledger on disk just changed under the cache — drop the stale copy so
    // anything later in this same request re-reads the truth.
    if (cache instanceof Map) cache.delete('manifest:' + manifestPath)
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
async function affectedFiles(sessionId, keepSeq, ctx, cache) {
  const paths = new Set()
  for (const change of await collectLogChanges(sessionId, ctx, cache)) {
    if (typeof change.seq === 'number' && change.seq > keepSeq) paths.add(change.path)
  }
  const dir = await fileHistoryDir(sessionId, ctx)
  if (dir !== null) {
    for (const entry of readManifestEntries(dir, cache)) {
      if (typeof entry.seq === 'number' && typeof entry.path === 'string' && entry.seq > keepSeq) {
        paths.add(entry.path)
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
async function turnInfo(sessionId, turn, ctx, cache) {
  const events = await readSessionEventsCached(sessionId, ctx, cache)
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
    const files = await affectedFiles(sessionId, typeof beforeSeq === 'number' ? beforeSeq : -1, ctx, cache)
    return { turn, userSeq, userText, beforeSeq, files }
  }
  return null
}

// ---------------------------------------------------------------------------
// In-session rewind ("撤销此轮" without forking, 0.39.0).
//
// WHY THIS EXISTS: the 0.25.0 undo/edit flow forked a truncated child session
// and then deleted the original. Measured cost of that: a fork rewrites the
// session id, which invalidates the whole prompt cache — the first request of
// the child re-sent 260K tokens cold and took 14.5 s to first byte, against
// 5.7 s for a warm request. The harness itself offers a cheaper primitive:
// `Session.append(type, data, { surfaceOp: { op: "replace", startSeq, endSeq },
// sourceEventSeqs })` shadows a contiguous tail of the surface, and
// `session.deriveMessages()` — which is what the model request is built from —
// then no longer contains it. The log is append-only, the session id never
// changes, and the prefix that survived is still a prefix.
//
// 🔴 THE MARKER IS AN EMPTY system/message ON PURPOSE.
// `assertMessageEventShape` demands `message.id`, a role matching the event
// type, a non-empty `source.kind`, and — for system/message specifically —
// `source.kind === "system-prompt"`. `deriveEventMessage` returns null for an
// empty-content system message, so the marker itself never reaches the model;
// it exists only to carry the replace op.
//
// 🔴 NODE 0 IS OFF LIMITS. `assertSystemHeadRewrite` lets the head system prompt
// be rewritten only by a single-node system/message, so a rewind that would
// start at surface index 0 starts at index 1 instead: the system prompt stays,
// everything after it goes. That is also exactly the right semantics for
// "undo the first turn".
//
// WHAT IT DOES NOT DO: it does not touch files (the caller runs
// `/session-files-restore` first), it does not delete anything, and it does not
// re-send the message. It only moves the model-visible boundary.
//
// RESIDUAL COST, stated honestly: a replace bumps `surface.contentGeneration`,
// so the NEXT request takes the `startsSeries` path and the system prompt node
// gets rewritten — the cache is partially invalidated. That is still an order
// of magnitude cheaper than a fork, but it is not free.
// ---------------------------------------------------------------------------

/**
 * True for the marker this feature appends to hide a tail.
 *
 * Used to make a repeated rewind idempotent: the previous marker sits AFTER the
 * boundary, so without this check every extra click would shadow the previous
 * marker and append a fresh one.
 *
 * 0.39.3 moved the marker from `system/message` to `user/message`; both shapes
 * are recognised so logs written by 0.39.0-0.39.2 keep behaving the same way.
 */
function isRewindMarker(event) {
  const kind = event?.type
  const message = kind === 'user/message' ? event?.data : event?.data?.message
  if (typeof message?.id !== 'string' || !message.id.startsWith('rewind-')) return false
  return Array.isArray(message.content)
}

/** The turn number of the newest `turn/start`, or 0 for a session with none. */
function lastTurnNumber(session) {
  const log = Array.isArray(session?.log) ? session.log : []
  for (let index = log.length - 1; index >= 0; index--) {
    const event = log[index]
    if (event?.type === 'turn/start' && Number.isSafeInteger(event.data?.turn)) return event.data.turn
  }
  return 0
}

/**
 * Shadow every surface node after `beforeSeq`. Returns a plain result object;
 * the caller turns `ok: false` into the matching HTTP status.
 */
async function rewindSession(sessionId, beforeSeq, ctx) {
  const id = String(sessionId ?? '')
  // The session must be resident: `append` lives on the live Session object and
  // there is no persistence-layer entry point that can write an event without
  // one. A cold conversation therefore has to be opened first — the client
  // always is, because the button lives on a message row of an open chat.
  const live = ctx?.get?.('sessions')?.get?.(id)
  if (!live || typeof live.append !== 'function' || !live.surface) {
    return { ok: false, status: 409, code: 'not-resident', error: '会话未驻留，请先打开这条对话再撤销' }
  }
  // Appending while a turn is publishing would race the agent loop.
  let running = false
  try {
    running = ctx?.get?.('agents')?.get?.(id)?.status === 'running'
  } catch { running = false }
  if (running) {
    return { ok: false, status: 409, code: 'running', error: '会话正在运行，请等当前回合结束' }
  }

  const nodes = Array.isArray(live.surface.nodes) ? [...live.surface.nodes] : []
  if (nodes.length === 0) return { ok: true, changed: false, shadowed: 0, reason: 'empty-surface' }

  // `-1` means "before the very first event", the boundary `turnInfo` reports
  // for turn 1. Everything above it is shadowed except the system prompt.
  const cut = Number.isSafeInteger(beforeSeq) ? beforeSeq : -1
  let firstIndex = nodes.findIndex((seq) => seq > cut)
  if (firstIndex === -1) return { ok: true, changed: false, shadowed: 0, reason: 'nothing-after-boundary' }

  // A stale boundary. With a real boundary seq (>= 0) at least one surface node
  // must sit at or before it. If every node is after it, the seq the client holds
  // belongs to a log that has since changed — typically because an earlier undo
  // already rewrote the tail — and shadowing the whole conversation is never what
  // the user asked for. Refuse instead of wiping the view.
  if (cut >= 0 && !nodes.some((seq) => seq <= cut)) {
    return { ok: false, status: 409, code: 'stale-boundary', error: '这一轮的位置已经变了，请刷新页面后再试' }
  }

  if (firstIndex === 0) {
    let headType = null
    try { headType = live.eventAt?.(nodes[0])?.type ?? null } catch { headType = null }
    if (headType === 'system/message') firstIndex = 1
  }
  if (firstIndex >= nodes.length) {
    return { ok: true, changed: false, shadowed: 0, reason: 'only-the-system-prompt-remains' }
  }

  const shadowed = nodes.slice(firstIndex)

  // A second click on the same boundary would otherwise shadow the marker the
  // first click left behind and append another. If everything after the
  // boundary is already just rewind markers, the tail is already hidden.
  let alreadyRewound = true
  for (const seq of shadowed) {
    let event = null
    try { event = live.eventAt?.(seq) ?? null } catch { event = null }
    if (!isRewindMarker(event)) { alreadyRewound = false; break }
  }
  if (alreadyRewound) return { ok: true, changed: false, shadowed: 0, reason: 'already-rewound' }

  const startSeq = shadowed[0]
  const endSeq = shadowed[shadowed.length - 1]
  const markerSeq = Array.isArray(live.log) ? live.log.length : null
  // WHY `user/message` AND NOT `system/message` (0.39.3 — a real data-loss bug):
  // the v4 session validator (dsh-session-persistence-jsonl worker.cjs,
  // `Relationships.accept` -> `requireStep`) only accepts system/message,
  // developer/message and assistant/attempt while a turn AND a step are open;
  // assistant/message and tool/result are turn-bound as well. An undo is appended
  // AFTER `turn/end`, so the only surface type that may carry
  // `surfaceOp: { op: 'replace' }` outside an open turn/step is `user/message`.
  // 0.39.0-0.39.2 used system/message here: the write succeeded, but the log no
  // longer LOADED ("system/message does not match an open turn and step"), and a
  // user lost access to a whole conversation until it was repaired by hand.
  const marker = {
    role: 'user',
    content: [{ type: 'text', text: '（以上内容已撤回，模型不再看到这部分对话）' }],
    source: { kind: 'user' },
    id: `rewind-${bareId(id)}-${startSeq}-${markerSeq === null ? 0 : markerSeq}`,
  }
  try {
    live.append('user/message', marker, {
      surfaceOp: { op: 'replace', startSeq, endSeq },
      sourceEventSeqs: shadowed,
    })
  } catch (error) {
    return { ok: false, status: 500, code: 'append-failed', error: `撤销失败：${String(error?.message ?? error)}` }
  }
  // Best effort: the persistence layer normally writes on its own schedule,
  // but an undo is a moment the user may immediately close the window.
  try { await ctx?.get?.('sessions')?.flush?.(live) } catch {}
  return { ok: true, changed: true, shadowed: shadowed.length, startSeq, endSeq, markerSeq }
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

// ---------------------------------------------------------------------------
// ★ Star / 「打开仓库」 (0.40.0)
//
// WHY THIS LIVES ON THE HOST: the desktop shell renders the plugin page inside
// its own window. A renderer `window.open()` is not a reliable way to hand a
// URL to the OS — depending on the shell it is swallowed, opens an in-app
// window, or is blocked outright by CSP — so the click asks the host instead,
// and the HOST asks Electron (`shell.openExternal`) or the platform opener.
//
// SCOPE: this is NOT a general-purpose "open any URL" endpoint. Only
// https URLs on the repository host this plugin actually lives on are accepted,
// so a compromised page cannot use the plugin as an arbitrary-URL launcher.
// ---------------------------------------------------------------------------

const OPEN_EXTERNAL_HOSTS = new Set(['github.com', 'www.github.com'])

function safeExternalUrl(raw) {
  try {
    const url = new URL(String(raw))
    if (url.protocol !== 'https:') return null
    if (!OPEN_EXTERNAL_HOSTS.has(url.hostname.toLowerCase())) return null
    return url.href
  } catch {
    return null
  }
}

async function openExternalUrl(raw) {
  const url = safeExternalUrl(raw)
  if (url === null) return { ok: false, error: 'only https://github.com/… links can be opened' }
  // ① The desktop shell: Electron's own shell API, which is what the DSH main
  // process uses for every external link it opens itself.
  try {
    const electron = await import('electron')
    const shell = electron?.shell ?? electron?.default?.shell
    if (shell && typeof shell.openExternal === 'function') {
      await shell.openExternal(url)
      return { ok: true, url, via: 'electron-shell' }
    }
  } catch {
    // Not running under Electron (plain `dsh web`, or a stripped build).
  }
  // ② Fall back to the platform opener, same approach as POST /reveal.
  try {
    const { spawn } = await import('node:child_process')
    if (process.platform === 'win32') {
      const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
      child.on('error', () => {})
      child.unref()
    } else if (process.platform === 'darwin') {
      const child = spawn('open', [url], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    } else {
      const child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
      child.on('error', () => {})
      child.unref()
    }
    return { ok: true, url, via: 'spawn' }
  } catch (error) {
    return { ok: false, url, error: String(error?.message ?? error) }
  }
}

// ---------------------------------------------------------------------------
// Snapshot-cleanup progress jobs (0.38.0).
//
// 契约（宿主 ↔ 客户端，两处都必须照这份写）：
//   POST /snapshot-cleanup  body: { sessionIds, dryRun, confirm, stream, jobId }
//     普通响应：一个 JSON（老页面兼容，行为不变）
//     stream:true → `content-type: application/x-ndjson`，逐行一个 JSON：
//       { type:'start'|'progress'|'done', jobId, phase, done, total,
//         bytesFreed, bytesTotal, current, at }
//       最后一行 type:'done' 额外带 `result`（与普通响应同一形状）
//     `phase` ∈ start | scan | delete | dryRun | done；`current` 是刚处理完的
//     sessionId；`done` 含跳过的条目（已处理数），`bytesFreed` 只累计成功项。
//   GET /snapshot-cleanup-progress?jobId=… → { ok, found, job }
//     流被中间层缓冲/浏览器 reader 断掉时的兜底：同一 jobId 的快照，状态
//     ∈ running | done | error。job 10 分钟过期，最多留 8 条。
// ---------------------------------------------------------------------------
const SNAPSHOT_CLEANUP_JOBS = new Map()
const SNAPSHOT_CLEANUP_JOB_TTL_MS = 10 * 60 * 1000
// 🔴 O5（2026-11-11）：running 条目用更长的过期窗口，**不能**跟着 10 分钟一起删。
// 理由：这条 TTL 判据看的是 updatedAt（最后一次写快照），而执行体里有长静默
// 阶段（逐条测量体积 / 逐条搬目录 / 回收站落盘），可能十几分钟不写一帧进度。
// 按 10 分钟盲删就会把一个**还在跑**的 job 从表里抹掉 —— 前端立刻报「未找到该
// 清理任务（可能已结束或宿主已重启）」，而任务其实还在删东西，用户看到的是
// 「删了一半说没任务了」。running 用 30 分钟：既保住长静默任务，又不让真正卡死
// 的僵尸条目永久占表（最终仍会被下面按 cap 的淘汰循环挤出去）。
// 只能由 putCleanupJob 触发清理，所以把窗口做成独立常量便于单测/探针注入。
const SNAPSHOT_CLEANUP_RUNNING_JOB_TTL_MS = 30 * 60 * 1000
const SNAPSHOT_CLEANUP_JOB_MAX = 8

function putCleanupJob(jobId, patch) {
  if (typeof jobId !== 'string' || jobId.length === 0) return null
  const previous = SNAPSHOT_CLEANUP_JOBS.get(jobId) ?? {
    jobId,
    state: 'running',
    phase: 'start',
    done: 0,
    total: 0,
    bytesFreed: 0,
    bytesTotal: 0,
    current: '',
    startedAt: Date.now(),
  }
  const next = { ...previous, ...patch, jobId, updatedAt: Date.now() }
  SNAPSHOT_CLEANUP_JOBS.set(jobId, next)
  // Drop expired entries, then the oldest ones beyond the cap. Both loops are
  // bounded by the cap, so this stays cheap on the request path.
  const now = Date.now()
  for (const [key, value] of SNAPSHOT_CLEANUP_JOBS) {
    // 🔴 O5（2026-11-11）：running 走更长的窗口，见
    // SNAPSHOT_CLEANUP_RUNNING_JOB_TTL_MS 上方的理由。判定必须用 state 而不是
    // phase：试算帧的 phase 是 'dryRun'，任务同样在跑。
    const ttl = value?.state === 'running' ? SNAPSHOT_CLEANUP_RUNNING_JOB_TTL_MS : SNAPSHOT_CLEANUP_JOB_TTL_MS
    if (now - (value?.updatedAt ?? 0) > ttl) SNAPSHOT_CLEANUP_JOBS.delete(key)
  }
  while (SNAPSHOT_CLEANUP_JOBS.size > SNAPSHOT_CLEANUP_JOB_MAX) {
    let oldestKey = null
    let oldestAt = Number.POSITIVE_INFINITY
    // 🔴 淘汰顺序：先淘汰**非 running**（已 done / 已 error）的最旧条目，只有在
    // 全是 running 时才退回到按 updatedAt 盲删。
    //
    // 这一条是 2026-11-11 引入「409 也登记 error 快照」之后必须配套的防护：
    // 被拒绝的请求每次都会往同一张表写一条 error 快照（前端要按 jobId 去读，
    // 否则只会超时报错），而被拒条目的 updatedAt 比正在跑的 job 新。若仍按
    // updatedAt 盲删最旧，连续几次并发被拒就能把**正在跑的 job** 挤出表，
    // 前端随即报「宿主未提供进度接口」——恰好是这条登记本来要避免的故障。
    for (const [key, value] of SNAPSHOT_CLEANUP_JOBS) {
      if (value?.state === 'running') continue
      const at = Number(value?.updatedAt ?? 0)
      if (at < oldestAt) {
        oldestAt = at
        oldestKey = key
      }
    }
    if (oldestKey === null) {
      for (const [key, value] of SNAPSHOT_CLEANUP_JOBS) {
        const at = Number(value?.updatedAt ?? 0)
        if (at < oldestAt) {
          oldestAt = at
          oldestKey = key
        }
      }
    }
    if (oldestKey === null) break
    SNAPSHOT_CLEANUP_JOBS.delete(oldestKey)
  }
  return next
}

function getCleanupJob(jobId) {
  if (typeof jobId !== 'string' || jobId.length === 0) return null
  const job = SNAPSHOT_CLEANUP_JOBS.get(jobId)
  if (!job) return null
  // 🔴 O5（2026-11-11）：运行中的 job 走 30 分钟窗口再判过期 —— 轮询本身
  // 不能把一个长静默阶段（逐条测量 / 搬目录）的 running 任务删掉。这里若不
  // 同步改，putCleanupJob 的 TTL 修好了也照样会在这里被抹掉（两处同一判据）。
  const ttl = job.state === 'running' ? SNAPSHOT_CLEANUP_RUNNING_JOB_TTL_MS : SNAPSHOT_CLEANUP_JOB_TTL_MS
  if (Date.now() - (job.updatedAt ?? 0) > ttl) {
    SNAPSHOT_CLEANUP_JOBS.delete(jobId)
    return null
  }
  return job
}

// ---------------------------------------------------------------------------
// 快照清理的执行体（0.39.0）：接单即回执 + 后台执行体（job 表 + 进度轮询）。
//
// 为什么不再放在路由 handler 里
// ----------------------------
// 0.38.x 之前，删除是**在 HTTP handler 内部 await 的**：`cleanupSnapshotUsage`
// 夹在 `res.writeHead` 和 `res.end` 之间，执行体与一次请求的生命周期绑死。实测
// 三件事：①关掉页面**并不会**中断删除（流只是没人读了），但这纯属运气——handler
// 一直攥着 `res`，删除的存活全靠 Node 没把它当取消；②客户端想看进度就必须一直
// 连着这条连接；③没有任何东西拦着第二次点击再起一条删除。这一块把三条都解决：
//   · `runCleanupJob()` 完全不碰 `res`，进度只写 job 快照，而
//     `GET /snapshot-cleanup-progress` 早就在读同一份快照；
//   · handler 立刻回执（NDJSON 一帧 `start`，或非流式的 JSON），客户端会自动
//     落到它自己那条轮询兜底上 —— 见 client.js `clean()`：
//     `apiStream(...).then(function () { if (!settled) pollProgress(jobId, ...) })`；
//   · `snapshotCleanupRunning`（模块级，不是每请求一份）让第二次并发请求直接
//     409，而不是叠一条删除流水线。
//
// 🔴 后台定时清理（`runBackgroundCleanup`，60s tick 与 `/background-cleanup` 两个
// 入口）**故意不共用这把锁**：那是另一条独立路径，它有自己的 policy 开关，用户按
// 按钮不该能饿死定时器，定时器也不该能饿死用户的按钮。两条路径因此可能重叠，但
// 这是安全的：各自都会重新 scan 并重新校验目标，而「两个都删同一个目录」的结果是
// 后到者看到 `MISSING`（脚本里 Test-Path 为假直接 continue），不会报错、不会崩。
// 后台路径永不传 `permanent`，所以重叠也绝不会产生「不可恢复的删除」。
// ---------------------------------------------------------------------------
let snapshotCleanupRunning = false

/** 是否已有一次手动快照清理在跑（后台定时清理不计入）。 */
function snapshotCleanupBusy() {
  return snapshotCleanupRunning === true
}

/**
 * 删除执行体，与任何 HTTP 响应无关。
 *
 * `wanted` 是已经过滤好的目标条目（收藏项由调用方剔除）。`opts` 原样转交
 * `cleanupSnapshotUsage`；本函数只额外注入 `onProgress`，而它**只写 job 快照**。
 * 任何异常都落成 `state:'error'`，不会漏到事件循环上。
 */
async function runCleanupJob(jobId, wanted, opts = {}) {
  // 🔴 0.40.x：`/snapshot-cleanup` 现在在 busy 检查通过后**立刻**置位（关掉
  // check→set 窗口，理由见那条路由上的注释），所以走到这里时「已置位」不再
  // 等于「别人在跑」：`opts.lockHeld === true` 表示这把锁是调用方为本 job
  // 提前拿下的，直接复用；只有未声明持有的调用（外部直接调
  // `__internals.runCleanupJob`）才在这里既判定又置位，行为与 0.39.x 一致。
  if (snapshotCleanupRunning && opts.lockHeld !== true) {
    putCleanupJob(jobId, { state: 'error', phase: 'error', error: 'already-running' })
    return
  }
  snapshotCleanupRunning = true
  // 用最后一次进度事件作为「权威计数」：quarantine 兜底会同时进 deleted 和
  // skipped，直接相加会重复计数，进度条就会显示 12/11。
  let lastSeen = null
  const onProgress = (payload) => {
    lastSeen = payload
    putCleanupJob(jobId, {
      state: 'running',
      phase: payload.phase,
      done: payload.done,
      total: payload.total,
      bytesFreed: payload.bytesFreed,
      bytesTotal: payload.bytesTotal,
      current: payload.current,
      dryRun: opts?.dryRun !== false,
      permanent: opts?.permanent === true,
    })
  }
  try {
    const result = await cleanupSnapshotUsage(wanted, { ...opts, onProgress })
    if (Array.isArray(opts?.refusedFavorites)) result.refusedFavorites = opts.refusedFavorites
    // 🔴 收尾日志必须**同时**报成功数与失败数，禁止「全部成功」口径：
    // 一次永久删除里 purged 就是不可恢复的删除数，必须显式打出来，用户
    // 事后对账时唯一能依靠的就是这一行。
    opts?.logger?.info?.(
      `${name}: snapshot cleanup dryRun=${result.dryRun === true} permanent=${result.permanent === true} `
      + `purged=${Number(result.purged) || 0} deleted=${result.deleted.length} skipped=${result.skipped.length} `
      + `failures=${result.failures.length} `
      + `refusedFavorites=${Array.isArray(result.refusedFavorites) ? result.refusedFavorites.length : 0} `
      + `bytes=${result.bytesFreed}`,
    )
    if (result.failures.length > 0) {
      opts?.logger?.warn?.(
        `${name}: snapshot cleanup failed on ${result.failures.length} dir(s): `
        + result.failures.slice(0, 5).map((item) => `${item.sessionId}:${item.reason}@${item.dir}`).join(' | '),
      )
    }
    const finalDone = lastSeen !== null ? Number(lastSeen.done) || 0 : result.deleted.length
    const finalTotal = lastSeen !== null ? Number(lastSeen.total) || finalDone : finalDone
    putCleanupJob(jobId, {
      state: 'done',
      phase: 'done',
      done: finalDone,
      total: finalTotal,
      bytesFreed: result.bytesFreed,
      current: '',
      result,
    })
  } catch (error) {
    putCleanupJob(jobId, { state: 'error', phase: 'error', error: String(error?.message ?? error) })
  } finally {
    snapshotCleanupRunning = false
  }
}

// ---------------------------------------------------------------------------
// 共用破坏性任务锁（2026-11-11）
//
// 🔴 一把锁管四类操作（快照清理 / 删除归档 / 批量归档 / 幽灵缓存）是**故意的**。
// 这四类动作改写的都是同一批会话目录：快照清理删 `<session>/history-file`，
// 批量归档把会话目录挪进归档区、再删同一本账本，删除归档直接删目录，幽灵缓存
// 删的又是这些目录的投影缓存。允许它们并行不是「更快」，而是后到者看到 MISSING
// 并把结果写成「一半成功一半失败」的假失败；更坏的组合是归档与删除交叉 —— 会话
// 先被挪进归档区、随后被删，列表与实际磁盘状态彻底对不上。所以四类操作共用一个
// 模块级布尔：谁进门谁置位，谁跑完谁复位。
// ---------------------------------------------------------------------------

/** 正在跑的那个 job 的 phase（409 的 detail 用；找不到就退化成 'cleanup'）。 */
function activeJobPhase() {
  let phase = ''
  let newest = -1
  for (const [key, job] of SNAPSHOT_CLEANUP_JOBS) {
    if (!job || job.state !== 'running') continue
    const at = Number(job.updatedAt ?? 0)
    if (at > newest) {
      newest = at
      phase = String(job.phase ?? '')
    }
  }
  return phase.length > 0 ? phase : 'cleanup'
}

/**
 * 四类破坏性路由的统一进门检查。
 *
 * 返回 true = 可以继续；false = 已经回过 409，调用方必须立即 return。
 *
 * 🔴 即使被拒绝，也必须把**本次请求的 jobId** 登记成 `state:'error'`：前端收到
 * 409 后仍会拿 jobId 去轮询一次进度，快照里没有这条就会空转到超时，最后报
 * 「宿主未提供进度接口」—— 那是假错误，责任在这里。
 */
function ensureNoActiveJob(jobId, respondError) {
  if (snapshotCleanupRunning !== true) return true
  const message = '已有清理任务在运行，请等待它完成后再试。'
  putCleanupJob(jobId, { state: 'error', phase: 'error', error: message })
  respondError(409, message, 'already-running', activeJobPhase())
  return false
}

/**
 * Job 进度写盘节流：每个处理单位都写一次 job 表会把 Map 的 TTL/上限清理循环
 * 拖成热点，150ms 一次（沿用快照清理的节奏）对前端 400ms 轮询已经足够密。
 */
const DESTRUCTIVE_PROGRESS_THROTTLE_MS = 150

function makeJobProgress(jobId, base = {}) {
  let lastAt = 0
  return (patch = {}) => {
    const now = Date.now()
    if (now - lastAt < DESTRUCTIVE_PROGRESS_THROTTLE_MS) return
    lastAt = now
    putCleanupJob(jobId, { ...base, ...patch })
  }
}

/**
 * 接单回执（三处 job 化共用，契约固定）。
 *
 * stream:true → 一帧 NDJSON `{"type":"start",jobId,accepted:true}` 后立即 res.end()，
 * 连接不留给执行体；否则 202 + jobId，前端拿着它去 /snapshot-cleanup-progress 轮询。
 */
function respondJobAccepted(res, wantsStream, job) {
  if (wantsStream === true) {
    try {
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store, no-transform',
        'x-accel-buffering': 'no',
      })
      res.flushHeaders?.()
      res.write(`${JSON.stringify({
        type: 'start',
        jobId: job.jobId,
        accepted: true,
        phase: job.phase,
        done: 0,
        total: job.total,
        bytesFreed: 0,
        bytesTotal: 0,
        current: '',
        at: Date.now(),
      })}\n`)
    } catch (error) {
      // 客户端已经断开也要让执行体继续跑完，这里只吞掉写帧失败。
    }
    try { res.end() } catch (error) { /* already closed */ }
    return undefined
  }
  return sendJson(res, 202, {
    ok: true,
    accepted: true,
    jobId: job.jobId,
    phase: job.phase,
    total: job.total,
    poll: `/snapshot-cleanup-progress?jobId=${encodeURIComponent(job.jobId)}`,
  })
}

/**
 * 删除归档的执行体（0.42.0）：接单即回执 + 后台执行体（job 表 + 进度轮询）。
 *
 * 逐条调用 handleDelete 而不是一次性传全部 id，是为了「每删完一个就写一次进度」；
 * 护栏（只删未收藏、试算不真删、被拒项上报 refused）全部留在 handleDelete 里，
 * 单条与批量的判定完全一致。
 */
async function runDeleteJob(jobId, ctx, wanted, options = {}) {
  const dryRun = options.dryRun === true
  const settings = options.settings
  const total = wanted.length
  const merged = { deleted: [], skipped: [], failures: [] }
  let done = 0
  let bytesFreed = 0
  let bytesTotal = 0
  try {
    // 🔴 O6（2026-11-11）：进度工厂必须构造在 try 之内。它在 try 之外时，任何
    // 抛错都会绕过下面的 finally，`snapshotCleanupRunning` 永不释放 —— 此后每
    // 一条破坏性路由都被 ensureNoActiveJob 判为「已有任务在跑」，整个插件死锁。
    const progress = makeJobProgress(jobId, { dryRun })
    // 体量只在执行体里测：扫描可能要几秒，绝不能拖慢接单回执。
    let sized = new Map()
    try {
      sized = await measureSessionDirsFor(wanted, ctx)
    } catch (error) {
      sized = new Map()
    }
    for (const id of wanted) {
      const entry = sized.get(String(id))
      bytesTotal += Number(entry?.bytes) || 0
    }
    for (const id of wanted) {
      if (dryRun) {
        merged.skipped.push({ sessionId: String(id), reason: 'dry-run' })
      } else {
        const one = await handleDelete({ sessionIds: [String(id)] }, ctx, settings)
        if (one && one.error) {
          merged.failures.push({ sessionId: String(id), reason: String(one.error) })
        } else if (one) {
          if (Array.isArray(one.deleted)) merged.deleted.push(...one.deleted)
          if (Array.isArray(one.skipped)) merged.skipped.push(...one.skipped)
          if (Array.isArray(one.failures)) merged.failures.push(...one.failures)
          const hit = Array.isArray(one.deleted) && one.deleted.some((item) => String(item) === String(id))
          const entry = sized.get(String(id))
          if (hit) bytesFreed += Number(entry?.bytes) || 0
        }
      }
      done += 1
      progress({
        state: 'running',
        // 🔴 M1（2026-11-11）：试算帧的 phase 必须落 'dryRun'。客户端只在
        // `phase === 'dryRun'` 时显示「试算中（不会删除任何东西）」；写死
        // 'delete' 会让用户看到「正在永久删除会话目录…」而以为真的删了。
        // putCleanupJob 是覆盖语义（{...previous, ...patch}），所以每一帧都要
        // 带上正确的 phase，不能只在第一帧改。
        phase: dryRun ? 'dryRun' : 'delete',
        done,
        total,
        bytesFreed,
        bytesTotal,
        current: String(id),
      })
    }
    const result = {
      ok: true,
      deleted: merged.deleted,
      skipped: merged.skipped,
      failures: merged.failures,
      dryRun,
      wouldDelete: wanted.map((id) => String(id)),
      missing: Array.isArray(options.missing) ? options.missing.map((id) => String(id)) : [],
      refusedFavorites: Array.isArray(options.refusedFavorites) ? options.refusedFavorites : [],
    }
    if (Array.isArray(result.failures) && result.failures.length > 0) {
      ctx?.logger?.warn?.(
        `${name}: archive-delete job ${jobId} failed on ${result.failures.length} id(s): `
        + result.failures.slice(0, 5).map((item) => `${item.sessionId}:${item.reason}`).join(' | '),
      )
    } else {
      ctx?.logger?.info?.(
        `${name}: archive-delete job ${jobId} dryRun=${dryRun} deleted=${result.deleted.length} `
        + `skipped=${result.skipped.length} failures=${result.failures.length}`,
      )
    }
    putCleanupJob(jobId, {
      state: 'done',
      phase: 'done',
      done,
      total,
      bytesFreed,
      bytesTotal,
      current: '',
      result,
    })
  } catch (error) {
    ctx?.logger?.warn?.(`${name}: archive-delete job ${jobId} aborted: ${String(error?.message ?? error)}`)
    putCleanupJob(jobId, { state: 'error', phase: 'error', error: String(error?.message ?? error) })
  } finally {
    snapshotCleanupRunning = false
  }
}

/**
 * 批量归档的执行体（0.42.0）：接单即回执 + 后台执行体（job 表 + 进度轮询）。
 *
 * 归档只是把目录挪进归档区，**不释放磁盘字节**，所以 progress.bytesFreed 只记
 * 顺带删掉的快照账本（purgeBytes），不把归档体量算成「已释放」——那是骗人的数。
 */
async function runIdleJob(jobId, ctx, idle, options = {}) {
  const hours = Number(options.hours ?? 24)
  const total = idle.length
  // 🔴 M1（2026-11-11）：idle 批归档也有「试算」这一路（body.dryRun === true）。
  // 试算必须既不改目录、也不把 phase 写成 archive，否则前端会报「正在归档…」
  // 而实际上一条都没动（反向误导，同样是假的）。
  const dryRun = options.dryRun === true
  const archived = []
  const failed = []
  const skippedByDryRun = []
  let done = 0
  let bytesFreed = 0
  let bytesTotal = 0
  try {
    // 🔴 O6（2026-11-11）：进度工厂进 try，理由同 runDeleteJob 上方 —— 在 try
    // 之外抛错会绕过 finally，让共用破坏性锁永不释放。
    const progress = makeJobProgress(jobId, { dryRun })
    const registry = ctx?.get?.('workspaceRegistry')
    if (!registry || typeof registry.archiveSession !== 'function') {
      throw new Error('workspaceRegistry.archiveSession is unavailable')
    }
    let sized = new Map()
    try {
      sized = await measureSessionDirsFor(idle.map((entry) => entry.id), ctx)
    } catch (error) {
      sized = new Map()
    }
    for (const entry of idle) {
      const measured = sized.get(String(entry.id))
      bytesTotal += Number(measured?.bytes) || 0
    }
    for (const entry of idle) {
      try {
        // 🔴 M1：试算只报进度、绝不搬目录。phase 说「试算」而目录真被挪走，
        // 比原来的假 phase 更糟。
        if (dryRun) {
          skippedByDryRun.push(String(entry.id))
        } else {
          await registry.archiveSession(entry.id)
          archived.push(entry.id)
          noteSelfArchived(entry.id)
        }
      } catch (error) {
        failed.push({ id: entry.id, reason: String(error?.message ?? error) })
      }
      done += 1
      progress({
        state: 'running',
        phase: dryRun ? 'dryRun' : 'archive',
        done,
        total,
        bytesFreed,
        bytesTotal,
        current: String(entry.title ?? entry.id ?? ''),
      })
    }
    // 归档后顺带删快照：开关语义与原实现一致（policy.enabled 决定跑不跑）。
    //
    // Only `archived` — never the whole archive, never `failed` (those sessions
    // did not move, so they keep their rollback), and never a timer.
    let purged = []
    let purgeFailures = []
    let purgeBytes = 0
    let purgeFiles = 0
    try {
      if (archived.length > 0 && readArchivePurgePolicy().enabled === true) {
        const plan = []
        // The ledger is measured while it is still on disk; the cleanup only
        // reports the bytes the caller declared, so an unmeasured plan logs 0.
        const purgedSized = new Map()
        for (const id of archived) {
          try {
            const dir = await fileHistoryDir(id, ctx)
            if (dir === null) continue
            let measured = null
            try {
              measured = await measureLedger(dir)
            } catch (error) {
              measured = null
            }
            const bytes = Number.isFinite(Number(measured?.bytes)) ? Number(measured.bytes) : 0
            const files = Number(measured?.blobCount ?? 0) + (Number(measured?.manifestBytes ?? 0) > 0 ? 1 : 0)
            plan.push({ sessionId: id, dir, bytes, files })
            purgedSized.set(String(id), { bytes, files })
          } catch (error) {
            purgeFailures.push({ sessionId: id, reason: `resolve-failed:${String(error?.message ?? error)}` })
          }
        }
        if (plan.length > 0) {
          try {
            // dryRun:false is honest here: the user turned the switch on and
            // just pressed archive, and the deletion is reversible from the
            // recycle bin.
            const outcome = await cleanupSnapshotUsage(plan, { dryRun: false })
            purged = outcome.deleted
            purgeBytes = outcome.bytesFreed
            purgeFailures = purgeFailures.concat(outcome.failures, outcome.skipped)
            for (const id of purged) {
              const one = purgedSized.get(String(id)) ?? { bytes: 0, files: 0 }
              purgeFiles += Number(one.files ?? 0)
              ctx?.logger?.info?.(
                `${name}: purged session=${id} bytes=${one.bytes} files=${one.files} toRecycleBin=true`,
              )
            }
          } catch (error) {
            purgeFailures = purgeFailures.concat([{ sessionId: '', reason: `purge-failed:${String(error?.message ?? error)}` }])
          }
        }
        ctx?.logger?.info?.(
          `${name}: archive purge — purged=${purged.length} bytes=${purgeBytes} files=${purgeFiles} toRecycleBin=true problems=${purgeFailures.length}`,
        )
        if (purged.length > 0) {
          ctx?.logger?.info?.(
            `${name}: ${purgeBytes} bytes (${purgeFiles} files) moved to the Windows recycle bin — disk space is released only after the bin is emptied`,
          )
        }
      }
    } catch (error) {
      purgeFailures.push({ sessionId: '', reason: String(error?.message ?? error) })
    }
    bytesFreed = purgeBytes
    const result = {
      ok: true,
      hours,
      archived,
      failed,
      undoable: archived,
      purged,
      purgeBytes,
      purgeFiles,
      purgeFailures,
      // 🔴 M1：试算结果必须自带 dryRun 标记与「将会归档」清单，前端据此显示
      // 「试算」而不是「已归档 N 条」。
      dryRun,
      wouldArchive: dryRun ? skippedByDryRun.slice() : [],
    }
    ctx?.logger?.info?.(
      `${name}: idle-archive job ${jobId} dryRun=${dryRun} archived=${archived.length} failed=${failed.length} purged=${purged} purgeBytes=${purgeBytes}`,
    )
    putCleanupJob(jobId, {
      state: 'done',
      phase: 'done',
      done,
      total,
      bytesFreed,
      bytesTotal,
      current: '',
      result,
    })
  } catch (error) {
    ctx?.logger?.warn?.(`${name}: idle-archive job ${jobId} aborted: ${String(error?.message ?? error)}`)
    putCleanupJob(jobId, { state: 'error', phase: 'error', error: String(error?.message ?? error) })
  } finally {
    snapshotCleanupRunning = false
  }
}

/**
 * 幽灵缓存清理的执行体（0.42.0）：接单即回执 + 后台执行体（job 表 + 进度轮询）。
 *
 * cleanupGhostCache 没有 onProgress，所以逐条调用它（maxItems 逐条递减），
 * 保持原来的预算语义（budget-exhausted 仍由它自己产出）的同时拿到每条进度。
 */
async function runGhostJob(jobId, ctx, plan, options = {}) {
  const total = plan.length
  const dryRun = options.dryRun !== false
  const merged = { dryRun, deleted: [], skipped: [], failures: [], bytesFreed: 0 }
  let budget = Number.isFinite(Number(options.maxItems)) ? Number(options.maxItems) : 500
  let done = 0
  let bytesTotal = 0
  try {
    // 🔴 O6（2026-11-11）：进度工厂进 try，理由同 runDeleteJob 上方。
    const progress = makeJobProgress(jobId, { dryRun })
    for (const entry of plan) bytesTotal += Number(entry?.bytes) || 0
    for (const entry of plan) {
      const one = await cleanupGhostCache(ctx, [entry], {
        dryRun,
        keepPinned: options.keepPinned === true,
        keepArchived: options.keepArchived === true,
        maxItems: Math.max(0, budget),
      })
      if (one) {
        if (Array.isArray(one.deleted)) merged.deleted.push(...one.deleted)
        if (Array.isArray(one.skipped)) merged.skipped.push(...one.skipped)
        if (Array.isArray(one.failures)) merged.failures.push(...one.failures)
        merged.bytesFreed += Number(one.bytesFreed) || 0
        // 与原实现一致：只有真正走到删除那一步的条目才消耗预算。
        if (Array.isArray(one.deleted) && one.deleted.length > 0) budget -= 1
      }
      done += 1
      progress({
        state: 'running',
        // 🔴 M1（2026-11-11）：试算帧落 'dryRun'，否则前端会显示「正在删除幽灵缓存…」。
        phase: dryRun ? 'dryRun' : 'ghost',
        done,
        total,
        bytesFreed: merged.bytesFreed,
        bytesTotal,
        current: String(entry?.sessionId ?? entry?.file ?? ''),
      })
    }
    const result = {
      ok: true,
      dryRun,
      deleted: merged.deleted,
      skipped: merged.skipped,
      failures: merged.failures,
      bytesFreed: merged.bytesFreed,
    }
    ctx?.logger?.info?.(
      `${name}: ghost-cache-clean job ${jobId} dryRun=${dryRun} deleted=${result.deleted.length} `
      + `skipped=${result.skipped.length} failures=${result.failures.length}`,
    )
    putCleanupJob(jobId, {
      state: 'done',
      phase: 'done',
      done,
      total,
      bytesFreed: merged.bytesFreed,
      bytesTotal,
      current: '',
      result,
    })
  } catch (error) {
    ctx?.logger?.warn?.(`${name}: ghost-cache-clean job ${jobId} aborted: ${String(error?.message ?? error)}`)
    putCleanupJob(jobId, { state: 'error', phase: 'error', error: String(error?.message ?? error) })
  } finally {
    snapshotCleanupRunning = false
  }
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

        // 0.40.0 — the ★ Star button. The page posts {url}; WHICH url is
        // allowed is decided here (github.com over https only), and the actual
        // opening happens through the host so the desktop shell's own external
        // link handling is used instead of a renderer popup.
        if (method === 'POST' && route === '/open-external') {
          let body = {}
          try {
            body = await readJsonBody(req)
          } catch {
            // A malformed body is a client bug, not a reason to 500 the page.
            return sendJson(res, 400, { ok: false, reason: 'bad-body' })
          }
          const result = await openExternalUrl(body?.url ?? '')
          return sendJson(res, result.ok ? 200 : 400, result)
        }

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
            // 0.40.0 — additive field for the ★ Star button. The client never
            // hard-codes the repository: it asks here, and an empty string is
            // the honest answer when package.json carries no repository.
            repositoryUrl: PKG_REPOSITORY_URL,
          })
        }

        // 0.37.1 — the 工作区名称 column used to print the LAST FOLDER of the
        // working directory, so every row said "workspace": that is where the
        // files live, not what the workspace is called. The registry does hold a
        // real title ("DeepSeek Chat"), so hand the page the mapping once and let
        // it label rows itself. One small JSON read, no session scan.
        if (method === 'GET' && route === '/workspace-titles') {
          const titles = {}
          try {
            for (const record of await readWorkspaceRecords()) {
              if (!record.path || !record.title) continue
              titles[record.path.replace(/[\\/]+$/, '').toLowerCase()] = record.title
            }
          } catch {
            // No registry file yet: the page falls back to the folder name.
          }
          return sendJson(res, 200, { ok: true, titles })
        }

        // 0.37.2 — the 收藏清单 rows had no size at all: a favourite is just
        // {at, title, cwd}, so 文件大小 and 文件数量 printed a dash on every
        // single row. The page asks for these facts when the panel becomes
        // visible (and again on an explicit refresh), never on paint and
        // never on a timer — same policy as every other measurement here.
        if (method === 'GET' && route === '/favorite-facts') {
          const state = readState()
          const ids = Object.keys(state.favorites || {})
          const facts = {}
          try {
            const measured = await measureSessionDirsFor(ids, ctx)
            for (const [id, fact] of measured) {
              facts[id] = {
                bytes: Number(fact.bytes) || 0,
                fileCount: Number(fact.fileCount) || 0,
                // 0.40.0 — newest mtime of the session dir. The 收藏清单 sorts
                // and shows 时长 from it; null means "not measurable", which the
                // page must render as a dash rather than as age 0.
                modifiedAt: typeof fact.modifiedAt === 'string' ? fact.modifiedAt : null,
              }
            }
          } catch {
            // Not measurable yet: the page falls back to dashes.
          }
          return sendJson(res, 200, { ok: true, facts })
        }

        if (method === 'GET' && route === '/favorites') {
          // 0.37.1 — a favourite only remembers the cwd it had when it was
          // starred, and older ones stored "". Fill the gap from the live
          // registry so the row can name its workspace.
          const state = readState()
          const favorites = state.favorites || {}
          try {
            const catalogue = await activityCatalogue(ctx)
            const byId = new Map(catalogue.map((entry) => [idKey(entry.id), entry]))
            for (const key of Object.keys(favorites)) {
              const hit = byId.get(idKey(key))
              if (hit && hit.cwd && (typeof favorites[key].cwd !== 'string' || favorites[key].cwd.length === 0)) {
                favorites[key] = Object.assign({}, favorites[key], { cwd: hit.cwd })
              }
            }
          } catch {
            // Registry not up yet: rows simply show a dash in that column.
          }
          // 0.42.0 — 上面那个 live registry 只认识 app 当前还开着的会话，所以
          // 每个来自已关闭项目的收藏都留着空 cwd，工作区列几乎每行都是破折号。
          // 投影缓存里带着所有跑过的会话的 identity.cwd，而 metaFromCache() 是
          // 唯一同时处理两种 id 拼写、mtime 缓存和所有失败模式的读者（失败时
          // 返回空对象而不是抛异常）。它是同步的，不能 await：别在这里"修"成 await。
          let cached = 0
          for (const key of Object.keys(favorites)) {
            const entry = favorites[key]
            if (!entry || (typeof entry.cwd === 'string' && entry.cwd.length > 0)) continue
            const meta = metaFromCache(projCacheRoot(), key)
            if (meta && typeof meta.cwd === 'string' && meta.cwd.length > 0) {
              favorites[key] = Object.assign({}, entry, { cwd: meta.cwd })
              cached += 1
            }
          }
          return sendJson(res, 200, { ok: true, favorites })
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
          // Per-row age and title, so the delete card can show a REAL list
          // instead of asking the user to export one. `activityCatalogue` is
          // the only source with an authoritative activity time (file mtimes
          // are rewritten during normal operation), so it is joined here the
          // same way the idle preview joins it.
          const catalogue = await activityCatalogue(ctx)
          const byKey = new Map()
          for (const entry of catalogue) byKey.set(idKey(entry.id), entry)
          const stamp = Date.now()
          // 0.37.1 — the size cells now describe the WHOLE session directory.
          //
          // 0.37.0 wired them to the snapshot ledger, which is truthful but
          // useless here: only 9 of the 212 archived sessions on this machine
          // ever wrote a snapshot, so both columns read "—" for almost every
          // row. On a deletion list the number that matters is "what do I get
          // back if I delete this", and that is the transcript plus its
          // ledger. The ledger is still measured separately for
          // lastSnapshotAt (the "时间" column stays the conversation's own
          // activity time, not the snapshot time).
          const ledgerFacts = await measureLedgersFor(actionable, ctx)
          const dirFacts = await measureSessionDirsFor(actionable, ctx)
          const entries = actionable.map((id) => {
            const hit = byKey.get(idKey(id)) ?? null
            const at = hit && Number.isFinite(hit.updatedAt) && hit.updatedAt > 0 ? hit.updatedAt : null
            const facts = ledgerFacts.get(String(id)) ?? null
            const space = dirFacts.get(String(id)) ?? null
            return {
              sessionId: String(id),
              title: hit && typeof hit.title === 'string' ? hit.title : '',
              cwd: hit && typeof hit.cwd === 'string' ? hit.cwd : '',
              blank: hit ? hit.blank === true : false,
              updatedAt: at,
              // null means "no timestamp", which must never read as age 0.
              idleMs: at === null ? null : Math.max(0, stamp - at),
              // Whole-directory facts: what deleting this row frees.
              bytes: space === null ? 0 : space.bytes,
              fileCount: space === null ? 0 : space.fileCount,
              // Ledger facts, kept for reference / the snapshot card's parity.
              ledgerBytes: facts === null ? 0 : facts.bytes,
              blobCount: facts === null ? 0 : facts.blobCount,
              lastSnapshotAt: facts === null ? null : facts.lastSnapshotAt,
            }
          })
          return sendJson(res, 200, {
            ok: true,
            entries,
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
          // POST 的 body 在这里读一次即可（job 化后 handler 只做接单，不再改它）。
          let postBody = {}
          if (method === 'GET') hours = Number(url.searchParams.get('hours') ?? 24)
          else {
            postBody = await readJsonBody(req)
            hours = Number(postBody.hours ?? 24)
          }
          // 🔴 M1（2026-11-11）：POST 可显式请求「试算」——只报进度、不搬目录，
          // 每一帧（含接单快照）的 phase 都必须落 'dryRun'。
          const dryRun = postBody.dryRun === true

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
            // 0.37.1 — the size cells describe the WHOLE session directory, so
            // "how much would archiving + purging this free" is answerable. 0.37.0
            // measured the snapshot ledger instead and almost every row read "—"
            // (only 9 of 212 sessions here ever wrote a snapshot). The ledger is
            // still measured, for lastSnapshotAt and for parity with the snapshot
            // card. Only the 50 preview rows are measured; the export file keeps
            // its cheap shape.
            const previewIds = idle.slice(0, 50).map((e) => e.id)
            const idleFacts = await measureLedgersFor(previewIds, ctx)
            const idleDirs = await measureSessionDirsFor(previewIds, ctx)
            const factsOf = (id) => idleFacts.get(String(id)) ?? null
            const spaceOf = (id) => idleDirs.get(String(id)) ?? null
            return sendJson(res, 200, {
              ok: true,
              hours,
              idleCount: idle.length,
              total: catalogue.length,
              archivedTotal: archivedIds.length,
              archiveSource: archiveInfo.source,
              sample: idle.slice(0, 50).map((e) => ({
                id: e.id, updatedAt: e.updatedAt, title: e.title || '',
                blank: e.blank === true, cwd: e.cwd || '',
                bytes: spaceOf(e.id) === null ? 0 : spaceOf(e.id).bytes,
                fileCount: spaceOf(e.id) === null ? 0 : spaceOf(e.id).fileCount,
                ledgerBytes: factsOf(e.id) === null ? 0 : factsOf(e.id).bytes,
                blobCount: factsOf(e.id) === null ? 0 : factsOf(e.id).blobCount,
              })),
              // The full list, so "export the list" can be exact rather than
              // capped at the preview size. Titles, the blank flag and the
              // workspace travel with it: an exported list is for a human to
              // read and to match against the sidebar.
              all: idle.map((e) => ({ id: e.id, updatedAt: e.updatedAt, title: e.title || '', blank: e.blank === true, cwd: e.cwd || '' })),
            })
          }

          // 🔴 一把锁管四类破坏性操作（与快照清理/删除归档/幽灵缓存共用）。
          // jobId 前缀 `id-`：前端按前缀区分阶段，但复用同一张 job 表与同一条
          // 读取路由 /snapshot-cleanup-progress?jobId=。
          const wantsStream = postBody.stream === true
          const jobId = typeof postBody.jobId === 'string' && postBody.jobId.trim().length > 0
            ? postBody.jobId.trim()
            : `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const respondRejected = (status, message, code, detail) => sendJson(res, status, {
            ok: false,
            error: message,
            code,
            detail,
          })
          // 检查通过后立刻置位，两者之间不得夹 await；早退由 finally 放锁。
          if (!ensureNoActiveJob(jobId, respondRejected)) return undefined
          snapshotCleanupRunning = true
          let handedOff = false
          try {
            if (idle.length === 0) {
              // 空集合也建 job（立刻 done）：前端只维护「轮询到 done」一条分支，
              // 不必为「无候选」再写一条同步返回的旁路。
              putCleanupJob(jobId, {
                state: 'done',
                phase: 'done',
                done: 0,
                total: 0,
                bytesFreed: 0,
                bytesTotal: 0,
                current: '',
                result: {
                  ok: true,
                  hours,
                  archived: [],
                  failed: [],
                  skipped: [],
                  undoable: [],
                  purged: [],
                  purgeBytes: 0,
                  purgeFiles: 0,
                  purgeFailures: [],
                },
              })
              // 🔴（2026-11-11 顺带修，锁泄漏）空集合这一路**没有执行体**可托付，
              // 绝不能置 handedOff=true：置了就没有任何 finally 会复位
              // snapshotCleanupRunning，此后四条破坏性路由全部 409「已有清理任务
              // 在运行」，直到宿主重启。这里保持 handedOff=false，让本路由的
              // finally 当场放锁（实测证据：修复前空集合 POST 之后 /archive-delete
              // 立刻 409）。
              return respondJobAccepted(res, wantsStream, { jobId, phase: dryRun ? 'dryRun' : 'archive', total: 0 })
            }

            const registry = ctx?.get?.('workspaceRegistry')
            if (!registry || typeof registry.archiveSession !== 'function') {
              // 🔴 O2（2026-11-11）：回 503 之前必须先把这条 jobId 登记成 error。
              // 前端拿到 jobId 后仍会轮询一次进度；快照里没有它就只能空转到超时，
              // 最后报「未找到该清理任务（可能已结束或宿主已重启）」—— 假错误。
              // 这条分支不需要额外放锁：本路由的 finally 会因 handedOff=false
              // 复位 snapshotCleanupRunning。
              const message = 'workspaceRegistry.archiveSession is unavailable'
              putCleanupJob(jobId, { state: 'error', phase: dryRun ? 'dryRun' : 'archive', error: message })
              return sendJson(res, 503, { ok: false, error: message })
            }
            // 接单：先写 running 快照，再把执行体丢进 microtask。handler 到此为止，
            // 绝不再 await 归档主循环（逐条 archiveSession 可能要跑几十秒）。
            putCleanupJob(jobId, {
              state: 'running',
              // 🔴 M1：接单这一帧也要带对 phase，否则轮询第一帧就显示「正在归档」。
              phase: dryRun ? 'dryRun' : 'archive',
              done: 0,
              total: idle.length,
              bytesFreed: 0,
              bytesTotal: 0,
              current: '',
            })
            queueMicrotask(() => {
              void runIdleJob(jobId, ctx, idle, { hours, dryRun }).catch((error) => {
                putCleanupJob(jobId, { state: 'error', phase: 'error', error: String(error?.message ?? error) })
              })
            })
            handedOff = true
            return respondJobAccepted(res, wantsStream, {
              jobId,
              phase: dryRun ? 'dryRun' : 'archive',
              total: idle.length,
            })
          } finally {
            if (!handedOff) snapshotCleanupRunning = false
          }
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

        // The "archiving drops the snapshots" switch. Read on mount, written
        // when the user flips it — deliberately NOT folded into /snapshot-usage,
        // whose contract is "never scan unless asked".
        if (route === '/archive-purge-policy' && (method === 'GET' || method === 'POST')) {
          if (method === 'GET') {
            return sendJson(res, 200, {
              ok: true,
              policy: readArchivePurgePolicy(),
              // "Did the background job run, and what did it do?" — the card
              // renders this straight from the file the host wrote, so the
              // answer survives restarts and does not depend on the page
              // having been open while the cleanup happened.
              lastRun: readBackgroundCleanupLast(),
            })
          }
          const body = await readJsonBody(req)
          const patch = body?.policy && typeof body.policy === 'object' ? body.policy : body
          const current = readArchivePurgePolicy()
          // `background` is merged key-by-key so a card that only flips the
          // switch cannot reset the schedule to its default behind the user's
          // back. Absent keys keep the saved value.
          const backgroundPatch = patch?.background !== null && typeof patch?.background === 'object'
            ? { ...current.background, ...patch.background }
            : undefined
          const saved = writeArchivePurgePolicy({
            enabled: patch?.enabled === undefined ? current.enabled : patch.enabled === true,
            background: backgroundPatch,
          })
          ctx?.logger?.info?.(
            `${name}: archive-purge policy — enabled=${saved.enabled} background=${saved.background.enabled === true ? `ON/${saved.background.scheduleMinutes}m/hours=${resolveBackgroundHours(saved.background, null)}` : 'OFF'}`,
          )
          return sendJson(res, 200, { ok: true, policy: saved, lastRun: readBackgroundCleanupLast() })
        }

        // Background cleanup: status + a deliberate "run now".
        //
        // Kept apart from /archive-purge-policy so reading the switch never
        // scans the disk. POST is the only path that walks the ledgers, and it
        // defaults to a DRY RUN unless the caller says `dryRun: false`, which is
        // the same contract as /snapshot-cleanup.
        if (route === '/background-cleanup' && (method === 'GET' || method === 'POST')) {
          if (method === 'GET') {
            const policy = readArchivePurgePolicy()
            return sendJson(res, 200, {
              ok: true,
              background: policy.background,
              lastRun: readBackgroundCleanupLast(),
            })
          }
          const body = await readJsonBody(req)
          const dryRun = body?.dryRun !== false
          const result = await runBackgroundCleanup(ctx, {
            // `force` bypasses the switch: "run now" is an explicit instruction,
            // not the timer deciding on its own.
            reason: 'force',
            dryRun,
            hours: body?.hours,
            maxItems: body?.maxItems,
          })
          return sendJson(res, 200, { ok: result?.ok !== false, dryRun, result, lastRun: readBackgroundCleanupLast() })
        }

        // Pre-tick policy for the "delete unfavourited archived chats" card.
        // Separate from /snapshot-policy on purpose; see the policy block at
        // the top of this file.
        if (route === '/archive-delete-policy' && (method === 'GET' || method === 'POST')) {
          if (method === 'GET') return sendJson(res, 200, { ok: true, policy: readArchiveDeletePolicy() })
          const body = await readJsonBody(req)
          const current = readArchiveDeletePolicy()
          const patch = body?.policy && typeof body.policy === 'object' ? body.policy : body
          const next = {
            autoSelect: patch?.autoSelect === undefined ? current.autoSelect : patch.autoSelect === true,
            hours: patch?.hours === undefined
              ? current.hours
              : clampPolicyHours(patch.hours, ARCHIVE_DELETE_POLICY_DEFAULT_HOURS),
          }
          const saved = writeArchiveDeletePolicy(next)
          ctx?.logger?.info?.(`${name}: archive-delete policy — autoSelect=${saved.autoSelect} hours=${saved.hours}`)
          return sendJson(res, 200, { ok: true, policy: saved })
        }

        // Bulk delete of archived, unfavourited conversations, with the same
        // two-step rule as every other destructive route here: DRY RUN unless
        // the body says `confirm: true` AND `dryRun: false`.
        //
        // 🔴 THE CANDIDATE SET IS RECOMPUTED HOST-SIDE, NEVER TAKEN FROM THE
        // PAGE. The page may have rendered minutes ago; a conversation could
        // have been unarchived, starred, or deleted since. Rebuilding the set
        // from the live registry is the only way the reported numbers and the
        // actual effect can be the same thing.
        if (method === 'POST' && route === '/archive-delete') {
          const body = await readJsonBody(req)
          const wantsStream = body.stream === true
          // jobId 前缀 `ad-` 是前端契约的一部分（轮询同一张表、同一读取路由）。
          const jobId = typeof body.jobId === 'string' && body.jobId.trim().length > 0
            ? body.jobId.trim()
            : `ad-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const respondRejected = (status, message, code, detail) => sendJson(res, status, {
            ok: false,
            error: message,
            code,
            detail,
          })
          // 🔴 共用破坏性锁：与快照清理/批量归档/幽灵缓存同一把。检查通过后立刻
          // 置位，两者之间**不得夹 await**；任何早退都由下面的 finally 放锁。
          if (!ensureNoActiveJob(jobId, respondRejected)) return undefined
          snapshotCleanupRunning = true
          let handedOff = false
          try {
            const info = await readArchivedSet(ctx)
            if (info.ids === null) {
              // Refuse rather than guess: with an unknown archive set we cannot
              // tell an archived conversation from a live one, and guessing here
              // means deleting something the user never saw in the list.
              // 🔴 O2（2026-11-11）：回 503 之前先登记 error 快照，前端按 jobId
              // 轮询时才拿得到失败原因，而不是空转 6 秒报「未找到该清理任务」。
              const message = `cannot determine the archived set (${info.source}${info.reason ? ': ' + info.reason : ''})`
              putCleanupJob(jobId, { state: 'error', phase: 'delete', error: message })
              return sendJson(res, 503, {
                ok: false,
                error: message
              })
            }
            const visible = sidebarSessionKeys(ctx)
            const blanks = await blankSessionKeys(ctx)
            const favouriteKeys = new Set(Object.keys(readState().favorites).map(idKey))
            const actionable = info.ids.filter((id) => visible.has(idKey(id)) && !blanks.has(idKey(id)))
            const requested = Array.isArray(body.sessionIds) ? body.sessionIds.map((id) => String(id)) : null
            const pool = requested === null
              ? actionable
              : actionable.filter((id) => requested.some((want) => idKey(want) === idKey(id)))
            const missing = requested === null
              ? []
              : requested.filter((want) => !pool.some((id) => idKey(id) === idKey(want)))
            if (missing.length > 0) {
              ctx?.logger?.warn?.(`${name}: archive delete — ${missing.length} requested id(s) are no longer deletable: ${missing.join(', ')}`)
            }
            const refused = pool.filter((id) => favouriteKeys.has(idKey(id)))
            const wanted = pool.filter((id) => !favouriteKeys.has(idKey(id)))
            const dryRun = body.confirm === true ? body.dryRun === true : true
            const refusedFavorites = refused.map((id) => ({ sessionId: String(id), reason: 'favourited' }))
            ctx?.logger?.info?.(
              `${name}: archive delete accepted jobId=${jobId} dryRun=${dryRun} candidates=${wanted.length} `
              + `refusedFavorites=${refusedFavorites.length} missing=${missing.length}`,
            )
            // 接单：先把 running 快照写进去，再把执行体丢进 microtask —— handler
            // 到此为止，绝不再 await 删除主循环。空 wanted 也走这条路径，job 会
            // 立刻写成 done(total=0)，前端只需一条「轮询到 done」的分支。
            putCleanupJob(jobId, {
              state: 'running',
              // 🔴 M1（2026-11-11）：试算帧落 'dryRun'，理由见 runDeleteJob 内的
              // 进度写入处。接单快照与执行体每一帧都必须带对 phase。
              phase: dryRun ? 'dryRun' : 'delete',
              done: 0,
              total: wanted.length,
              bytesFreed: 0,
              bytesTotal: 0,
              current: '',
            })
            queueMicrotask(() => {
              void runDeleteJob(jobId, ctx, wanted, {
                dryRun,
                settings,
                missing: missing.map((id) => String(id)),
                refusedFavorites,
              }).catch((error) => {
                putCleanupJob(jobId, { state: 'error', phase: 'error', error: String(error?.message ?? error) })
              })
            })
            handedOff = true
            return respondJobAccepted(res, wantsStream, {
              jobId,
              phase: dryRun ? 'dryRun' : 'delete',
              total: wanted.length,
            })
          } finally {
            if (!handedOff) snapshotCleanupRunning = false
          }
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
          // One log pass for the boundary + one for the file list would cost
          // 2 x 531 ms on a big conversation; the cache makes it one.
          const info = await turnInfo(sessionId, turn, ctx, new Map())
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
          const result = await restoreFilesBefore(sessionId, keepSeq, ctx, new Map())
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
        // --- in-session rewind (0.39.0) -----------------------------------
        //
        // Undo/edit used to fork a truncated child and delete the original.
        // That is correct but expensive: the child is a new session id, so the
        // whole prompt cache is cold (measured 260K tokens, 14.5 s to first
        // byte). This route instead shadows the tail of THIS session via
        // `surfaceOp: replace`, which leaves the id and the surviving prefix
        // intact.
        //
        // `beforeSeq` accepts null: `turnInfo` reports null for turn 1, and
        // "rewind everything except the system prompt" is the right answer
        // there — `rewindSession` handles the node-0 rule internally.
        if (method === 'POST' && route === '/session-rewind') {
          const body = await readJsonBody(req)
          const sessionId = String(body.sessionId ?? '').trim()
          if (sessionId.length === 0) return sendJson(res, 400, { ok: false, error: 'sessionId required' })
          if (!/^(?:session-)?[A-Za-z0-9_-]+$/.test(sessionId)) {
            return sendJson(res, 400, { ok: false, error: `invalid sessionId: ${sessionId}` })
          }
          const beforeSeq = body.beforeSeq === null || body.beforeSeq === undefined ? null : Number(body.beforeSeq)
          if (beforeSeq !== null && (!Number.isSafeInteger(beforeSeq) || beforeSeq < -1)) {
            return sendJson(res, 400, { ok: false, error: `invalid beforeSeq: ${body.beforeSeq}` })
          }
          const result = await rewindSession(sessionId, beforeSeq, ctx)
          if (!result.ok) return sendJson(res, result.status ?? 500, result)
          ctx?.logger?.info?.(
            `${name}: session rewind ${sessionId} beforeSeq=${beforeSeq} changed=${result.changed} shadowed=${result.shadowed}` +
              (result.changed ? ` range=${result.startSeq}..${result.endSeq} marker=${result.markerSeq}` : ` reason=${result.reason}`),
          )
          return sendJson(res, 200, result)
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
          // 🔴 一把锁管四类破坏性操作（与快照清理/删除归档/批量归档共用）。
          // jobId 前缀 `gc-`，复用同一张 job 表与同一条进度读取路由。
          const wantsStream = body.stream === true
          const jobId = typeof body.jobId === 'string' && body.jobId.trim().length > 0
            ? body.jobId.trim()
            : `gc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const respondRejected = (status, message, code, detail) => sendJson(res, status, {
            ok: false,
            error: message,
            code,
            detail,
          })
          // 检查通过后立刻置位，两者之间不得夹 await；早退由 finally 放锁。
          if (!ensureNoActiveJob(jobId, respondRejected)) return undefined
          snapshotCleanupRunning = true
          let handedOff = false
          try {
            // Re-diagnose rather than trusting the page: a session may have been
            // restored (or re-created) since the client rendered its list, and a
            // stale plan would then delete the cache of a live conversation.
            const report = await diagnoseGhostCache(ctx, {})
            if (report.ok !== true) {
              // 🔴 O2（2026-11-11）：回 503 之前先登记 error 快照，否则前端拿
              // jobId 轮询时空转到超时，报「未找到该清理任务」—— 假错误。
              const message = report.detail ?? 'diagnose failed'
              putCleanupJob(jobId, { state: 'error', phase: 'ghost', error: message })
              return sendJson(res, 503, { ok: false, error: message })
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
            const options = {
              dryRun,
              // 0.36.0 (user decision 2026-11-01): orphaned caches are ALL deletable by
              // default. Keeping pinned/archived ghosts was protecting a flag left in
              // workspace.json for a directory that no longer exists — on this machine it
              // blocked all 86 of them. The protection is now an explicit opt-in: the
              // client sends `keepPinned` / `keepArchived` only when the user ticks the
              // "keep these" box, and the old inverted names stay accepted for callers
              // that still send them.
              keepPinned: body.keepPinned === true,
              keepArchived: body.keepArchived === true,
              maxItems: Number.isFinite(Number(body.maxItems)) ? Number(body.maxItems) : undefined,
            }
            // 接单：写 running 快照 → microtask → 回执。handler 不再 await 清理主循环。
            putCleanupJob(jobId, {
              state: 'running',
              // 🔴 M1（2026-11-11）：试算帧落 'dryRun'，理由见 runGhostJob 内的进度写入处。
              phase: dryRun ? 'dryRun' : 'ghost',
              done: 0,
              total: wanted.length,
              bytesFreed: 0,
              bytesTotal: 0,
              current: '',
            })
            queueMicrotask(() => {
              void runGhostJob(jobId, ctx, wanted, options).catch((error) => {
                putCleanupJob(jobId, { state: 'error', phase: 'error', error: String(error?.message ?? error) })
              })
            })
            handedOff = true
            return respondJobAccepted(res, wantsStream, {
              jobId,
              phase: dryRun ? 'dryRun' : 'ghost',
              total: wanted.length,
            })
          } finally {
            if (!handedOff) snapshotCleanupRunning = false
          }
        }

        // Snapshot ledger usage: READ-ONLY report. See lib/snapshot-usage.js.
        //
        // The ledger under <session>/history-file/ is what makes an old
        // conversation rollbackable, so this endpoint only ever measures: no
        // scan happens on a read, and nothing here deletes.
        //
        // CORRECTION (0.40.0): the old note here claimed "there is no timer and
        // automatic pruning is not coming back". That is now HALF untrue — an
        // opt-in background sweep exists, but it is OFF by default and never
        // runs from this route. See the BACKGROUND CLEANUP block: it is driven
        // by /background-cleanup and by the 60 s tick, and it obeys the same
        // favourites / history-file-only / maxItems limits as the manual button.
        if (route === '/snapshot-usage' && (method === 'GET' || method === 'POST')) {
          const report = await scanSnapshotUsage({})
          // Favourite flags are attached HERE, not inside the scanner: the
          // scanner walks the disk and knows nothing about the star list, and
          // the star list is the ONLY durable statement of "this conversation
          // matters to me". The card uses this to keep favourites out of the
          // delete list entirely.
          const favourites = readState().favorites
          const favouriteKeys = new Set(Object.keys(favourites).map(idKey))
          if (report?.ok === true && Array.isArray(report.entries)) {
            for (const entry of report.entries) entry.favorite = favouriteKeys.has(idKey(entry.sessionId))
            report.favoriteCount = report.entries.filter((entry) => entry.favorite === true).length
            report.favoriteBytes = report.entries.reduce(
              (total, entry) => total + (entry.favorite === true ? entry.bytes : 0),
              0,
            )
          }
          report.policy = readSnapshotPolicy()
          ctx?.logger?.info?.(
            // `elapsedMs` is logged on purpose: this route is the only place
            // in the plugin that walks the whole sessions tree, and if a future
            // change makes it synchronous or unbounded the number here is what
            // will show it first.
            `${name}: snapshot usage — ledgers=${report.summary?.sessions ?? '?'} bytes=${report.summary?.totalBytes ?? '?'} blobs=${report.summary?.totalBlobs ?? '?'} elapsed=${report.elapsedMs ?? '?'}ms`,
          )
          return sendJson(res, 200, report)
        }

        // The policy row: read on open, written when the switch or the
        // threshold changes. Deliberately separate from /snapshot-usage so that
        // flipping the switch does NOT trigger a walk of the sessions tree.
        if (route === '/snapshot-policy' && (method === 'GET' || method === 'POST')) {
          if (method === 'GET') return sendJson(res, 200, { ok: true, policy: readSnapshotPolicy() })
          const body = await readJsonBody(req)
          const current = readSnapshotPolicy()
          const patch = body?.policy && typeof body.policy === 'object' ? body.policy : body
          const next = {
            autoSelect: patch?.autoSelect === undefined ? current.autoSelect : patch.autoSelect === true,
            hours: patch?.hours === undefined ? current.hours : clampHours(patch.hours),
          }
          const saved = writeSnapshotPolicy(next)
          ctx?.logger?.info?.(
            `${name}: snapshot policy — autoSelect=${saved.autoSelect} hours=${saved.hours}`,
          )
          return sendJson(res, 200, { ok: true, policy: saved })
        }

        if (method === 'POST' && route === '/snapshot-cleanup') {
          const body = await readJsonBody(req)

          // ── 接单 + 立即回执（0.39.0）────────────────────────────────────
          // 执行体已搬进 runCleanupJob()（契约见它上方的长注释）。这个 handler
          // 现在只做三件事：算清楚要删谁、登记 job 快照、回一帧「已接单」。
          //
          // stream:true 仍然返回 NDJSON（老客户端一行都不用改），但**只写一帧**
          // `type:'start'` 就 res.end()。client.js 的 clean() 在「流正常结束却没
          // 收到 done」时会自动转 pollProgress(jobId)，而进度与结果一律以 job
          // 快照为准 —— 这条降级路径是设计好的，不是碰运气。
          const wantsStream = body.stream === true
          const jobId = typeof body.jobId === 'string' && body.jobId.trim().length > 0
            ? body.jobId.trim()
            // 与 client.js 的 `"sc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8)`
            // 同格式。老调用方不传 jobId 时也必须有一个：轮询兜底全靠它。
            : `sc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
          const requestedTotal = Array.isArray(body.sessionIds) ? body.sessionIds.length : 0
          // Same two-step rule as every other destructive route here: dry run
          // unless the body says `confirm: true` AND `dryRun: false`.
          const dryRun = body.confirm === true ? body.dryRun === true : true
          // 🔴 永久删除三条件，缺一不可：显式 `permanent:true` + 显式
          // `confirm:true` + 显式 `dryRun:false`。少任何一个都退回回收站。
          // 它**只对本次请求生效**：绝不写 policy / state，后台定时清理永不传它
          // （见 runBackgroundCleanup），所以这是本插件唯一一条「删了不可恢复」
          // 的入口，条件全部显式才放行。
          const permanent = body.permanent === true && body.confirm === true && body.dryRun === false
          // `code` 是可选的机器可读 slug（0.40.x）。client.js 在 `!res.ok` 时
          // 只 `throw new Error(payload.error)`，HTTP status 根本到不了页面，
          // 所以 `error` 必须是用户一眼看懂的中文，slug 另放 `code`/`detail`
          // 两处。不传 `code` 时输出与 0.39.x 逐字节相同 —— 其余调用点全靠
          // 这一条，绝不改它们的返回结构。
          const respondError = (status, message, code, detailOverride) => {
            const text = String(message)
            const slug = typeof code === 'string' && code.length > 0 ? code : null
            // 0.42.0：`detail` 允许单独指「正在跑的那个 job 的 phase」（409 用）。
            // 不传时退回 slug —— 其余调用点的输出与之前逐字节相同。
            const detail = typeof detailOverride === 'string' && detailOverride.length > 0
              ? detailOverride
              : slug
            if (wantsStream) {
              try {
                res.writeHead(status, {
                  'content-type': 'application/x-ndjson; charset=utf-8',
                  'cache-control': 'no-store, no-transform',
                })
                res.write(`${JSON.stringify({
                  type: 'error',
                  jobId,
                  error: text,
                  ...(slug === null ? null : { code: slug, detail }),
                  at: Date.now(),
                })}\n`)
              } catch {}
              try {
                res.end()
              } catch {}
              return undefined
            }
            return sendJson(res, status, {
              ok: false,
              error: text,
              ...(slug === null ? null : { code: slug, detail }),
            })
          }
          const fail = (status, message, code, detail) => {
            putCleanupJob(jobId, { state: 'error', phase: 'error', error: String(message) })
            return respondError(status, message, code, detail)
          }
          // 🔴 一次只允许一条破坏性任务：第二条直接 409，绝不叠一条流水线。
          // 四类操作（快照清理 / 删除归档 / 批量归档 / 幽灵缓存）共用这一把锁，
          // 理由见 ensureNoActiveJob 上方：它们改写的都是同一批会话目录，并行会
          // 互删，用户看到的是「一半成功一半失败」的假失败。后台定时清理不占这把
          // 锁（理由见 runCleanupJob 上方注释），所以「拒绝」只针对并发的手动请求。
          // 🔴 中文文案是给用户看的，slug 只作为 code 给脚本与探针；`detail` 单独
          // 放「正在跑的那个 job 的 phase」，前端据此显示「正在执行 scan/delete…」。
          if (!ensureNoActiveJob(jobId, (status, message, code, detail) => fail(status, message, code, detail))) {
            ctx?.logger?.warn?.(`${name}: destructive job refused — another job is already running (${activeJobPhase()})`)
            return undefined
          }
          // 🔴 检查与置位之间**不允许再夹 await**：0.39.x 把置位放在
          // runCleanupJob 第一行，而两者之间隔着一次磁盘扫描，落在窗口里的
          // 第二个请求会先拿到 202/start（等于被答复「已接单」），随后它的 job
          // 被改写成 error —— 回执语义是错的。现在这里立刻置位，「谁置位谁
          // 复位」：只有真正把任务交给 runCleanupJob 的分支才 handedOff=true，
          // 其余所有早退/抛错路径都在 finally 里放开。
          // ⚠️ 绝不能改成 handler 末尾无条件复位：handler 立即返回，那样会在
          // 任务还在跑的时候把锁放掉，等于又回到竞态。
          snapshotCleanupRunning = true
          let handedOff = false
          try {
          // Re-scan rather than trusting the page: a session can be deleted
          // or re-created between render and click, and a stale entry would
          // then point at a path that no longer means what it did.
          const report = await scanSnapshotUsage({})
          if (report.ok !== true) {
            return fail(503, report.detail ?? 'scan failed')
          }
          // 🔴 FAVOURITES ARE REFUSED, NOT DELETED. This is the second half of
          // the same rule the rest of the plugin follows (a favourited
          // conversation is never offered for bulk deletion): the page already
          // hides the checkbox, but a stale page or a hand-made request must
          // not be able to remove the ledger of a conversation the user marked
          // as important. The refusal is REPORTED, never silent.
          const favouriteKeys = new Set(Object.keys(readState().favorites).map(idKey))
          const requested = Array.isArray(body.sessionIds) ? body.sessionIds.map((id) => String(id)) : null
          const pool = requested === null
            ? report.entries
            : report.entries.filter((entry) => requested.includes(String(entry.sessionId)))
          if (requested !== null && pool.length !== requested.length) {
            const found = new Set(pool.map((entry) => String(entry.sessionId)))
            const missing = requested.filter((id) => !found.has(id))
            ctx?.logger?.warn?.(`${name}: snapshot cleanup — ${missing.length} requested id(s) have no ledger: ${missing.join(', ')}`)
          }
          const wanted = pool.filter((entry) => !favouriteKeys.has(idKey(entry.sessionId)))
          const refused = pool.filter((entry) => favouriteKeys.has(idKey(entry.sessionId)))
          if (refused.length > 0) {
            ctx?.logger?.warn?.(
              `${name}: snapshot cleanup — refused ${refused.length} favourited session(s)`,
            )
          }
          const opts = {
            dryRun,
            permanent,
            maxItems: Number.isFinite(Number(body.maxItems)) ? Number(body.maxItems) : undefined,
            // 每批目录一个 PowerShell 进程；实测拐点是 2（3 个反而更慢，
            // 回收站 API 会互抢）。允许调用方覆盖，默认 2。
            workers: Number.isFinite(Number(body.workers))
              ? Math.max(1, Math.min(8, Number(body.workers)))
              : 2,
            progressThrottleMs: 150,
            refusedFavorites: refused.map((entry) => ({
              sessionId: String(entry.sessionId),
              reason: 'favourited',
            })),
            // 收尾日志要在执行体内部打（handler 那时已经返回了），所以 logger
            // 跟着 opts 一起过去；cleanupSnapshotUsage 会忽略它不认识的键。
            logger: ctx?.logger ?? null,
            // 0.40.x：这把锁已经由 handler 在 busy 检查通过后**立刻**拿下，
            // 通知执行体别再按「已置位 = 别人在跑」拒绝自己，见其头部注释。
            lockHeld: true,
          }
          // 🔴 勾了 0 个 / 只勾了收藏项：没有目录要删，绝不起空 job，也绝不
          // 留下一条永远停在 running 的快照。流式请求直接回一帧 `done`（客户
          // 端的 onLine 只认 done 才 settle，只写 start 会把它推进轮询兜底），
          // 非流式回 `accepted:false` + `reason`。走到这里 handedOff 仍是
          // false，finally 会立刻放开这把锁，不会出现「空请求把锁占死」。
          if (wanted.length === 0) {
            if (wantsStream) {
              try {
                res.writeHead(200, {
                  'content-type': 'application/x-ndjson; charset=utf-8',
                  'cache-control': 'no-store, no-transform',
                  'x-accel-buffering': 'no',
                })
                res.flushHeaders?.()
                res.write(`${JSON.stringify({
                  type: 'done',
                  jobId,
                  result: {
                    dryRun,
                    deleted: [],
                    skipped: [],
                    failures: [],
                    bytesFreed: 0,
                    purged: 0,
                  },
                  at: Date.now(),
                })}\n`)
              } catch {}
              try {
                res.end()
              } catch {}
              return undefined
            }
            return sendJson(res, 200, { ok: true, accepted: false, reason: 'nothing-to-do', jobId })
          }
          // 🔴 先登记 running 再回执：客户端拿到回执后会**立刻**开始轮询（400 ms
          // 一次），job 必须已经在快照里，否则轮询会撞上「查不到 → 6 秒后报
          // 宿主未提供进度接口」的假错误。登记放在 `wanted` 之后是有意的 ——
          // 空集合已在上面短路，不会再留下一条空的 running 快照。
          putCleanupJob(jobId, {
            state: 'running',
            phase: 'scan',
            done: 0,
            total: wanted.length,
            bytesFreed: 0,
            bytesTotal: 0,
            current: '',
            dryRun,
            permanent,
          })
          // 先回执、再启动：`queueMicrotask` 让 runCleanupJob 脱离当前 tick，
          // 等这一轮 HTTP 处理彻底结束、响应已经 flush 之后才开第一条
          // PowerShell。慢删除再也拖不住响应，用户也不会看到「卡着不动」。
          queueMicrotask(() => {
            void runCleanupJob(jobId, wanted, opts).catch((error) => {
              ctx?.logger?.warn?.(
                `${name}: snapshot cleanup job ${jobId} crashed: ${String(error?.message ?? error)}`,
              )
            })
          })
          // 任务已经交给 runCleanupJob：从这里开始这把锁归执行体的 finally
          // 复位，handler 一律不再碰它（否则会在任务还在跑时提前放锁）。
          handedOff = true
          if (wantsStream) {
            try {
              res.writeHead(200, {
                'content-type': 'application/x-ndjson; charset=utf-8',
                'cache-control': 'no-store, no-transform',
                // 关掉 nginx/libuv 一类中间层的攒包，否则用户看到的是「最后
                // 一次性蹦出来」，等于没做进度。
                'x-accel-buffering': 'no',
              })
              res.flushHeaders?.()
              // 唯一一帧。client.js 的 onLine 只有 `type==='done'` 才 settle，
              // 所以这一帧既不动进度也不会提前结束；流一结束就落进轮询兜底。
              res.write(`${JSON.stringify({
                type: 'start',
                jobId,
                accepted: true,
                phase: 'scan',
                done: 0,
                total: wanted.length,
                bytesFreed: 0,
                bytesTotal: 0,
                current: '',
                dryRun,
                permanent,
                at: Date.now(),
              })}\n`)
            } catch {}
            try {
              res.end()
            } catch {}
            return undefined
          }
          return sendJson(res, 202, {
            ok: true,
            accepted: true,
            jobId,
            total: wanted.length,
            dryRun,
            permanent,
            poll: `/snapshot-cleanup-progress?jobId=${encodeURIComponent(jobId)}`,
          })
          } finally {
          // handedOff === false 覆盖：503、空集合短路、组装 opts 抛错、回执写
          // 失败 —— 全在这里放开；true 时一律不动，锁归执行体的 finally。
            if (!handedOff) snapshotCleanupRunning = false
          }
        }

        // 轮询兜底：流被代理攒包 / reader 提前断开时，页面靠它拿同一份进度。
        if (method === 'GET' && route === '/snapshot-cleanup-progress') {
          const jobId = String(url.searchParams.get('jobId') ?? '').trim()
          const job = getCleanupJob(jobId)
          return sendJson(res, 200, { ok: true, found: job !== null, job })
        }

        // 0.40.0 — 「隐藏定时任务」: which scheduled sessions are still waiting for
        // their next fire. READ ONLY — no schedule is created, edited, run or
        // deleted here, and no session is opened. The client uses `hide`
        // (decided in the host) plus `dueAt` (so a row reappears on time even
        // before the next poll).
        if (method === 'GET' && route === '/scheduled-sessions') {
          const payload = await scheduledHidesPayload(ctx, Date.now())
          return sendJson(res, 200, payload)
        }

        return sendJson(res, 404, { ok: false, error: `no route for ${method} ${route}` })
      } catch (error) {
        // 流式响应已经写过 header 时不能再 sendJson（会抛 ERR_HTTP_HEADERS_SENT
        // 并变成未捕获拒绝），只收尾。
        if (res.headersSent) {
          try {
            res.write(`{"type":"error","error":${JSON.stringify(String(error?.message ?? error))}}\n`)
          } catch {}
          try {
            res.end()
          } catch {}
          return undefined
        }
        return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
      }
    },
  })
}

// ---------------------------------------------------------------------------
// 0.40.0 — 「隐藏定时任务」/ hide every task-linked session, manual switch only
//
// WHAT THE USER ASKED FOR (final call, 2026-11-11): a session that belongs to a
// schedule stays out of the sidebar until the user turns the 「隐藏定时任务」
// switch OFF by hand. It never reappears on its own — not when the task fires,
// not after a delivery, not when the task is paused or archived. 用户原话：
// 「我说的隐藏对话指的是只要是定时任务都要隐藏，也不要到时间自动弹出显示了。
// 就手动开关吧，我自己到时候显示出来看」。
//
// WHY THE HOST HAS TO ANSWER THIS: the client cannot see the schedule store at
// all. It gets ONE read-only route and paints the verdict; it never guesses.
//
// WHERE THE TRUTH LIVES (probed on this machine, 2026-11-10):
//   * live service — `ctx.get('schedule').catalog()` returns every
//     ScheduleCatalogEntry WITHOUT activating a session. Authoritative.
//   * storage file — `<DSH_HOME>/storages/schedule.json`, shape
//     `{ tables: { tasks: { '<id>': { record, target, involvedSessionIds,
//     status, lastDelivery, ... } } } }`. Same data one snapshot behind, used
//     only when the service is not resolvable yet (boot) or not installed.
//   * there is NO session-side origin. A session directory holds only
//     `history-file` + `session.v4.jsonl.zstd` — no meta.json, no taskId /
//     scheduleId / origin field. So a session can be tied to a schedule ONLY
//     through `target` / `involvedSessionIds` as seen above. That association is
//     data, not a heuristic, which is why `heuristic:false` is safe to report.
//
// 🔴 WHICH LINKS ARE HIDDEN (2026-11-11, user's final call — hide ALL):
//     target.kind === 'new_once' → the session identity is RESERVED by the task
//                                  at create time → HIDDEN (`reserved`).
//     target.kind === 'session'   → the real conversation this schedule
//                                  delivers into → HIDDEN (`target`).
//     involvedSessionIds          → the session that CREATED the task, plus
//                                  older delivery targets → HIDDEN (`involved`).
//
// The link is the ONLY input. Nothing about time, archive state or delivery
// recency is consulted: there is no "appear on its own" branch at all, the
// switch stays effective until the user turns it off. 用户 2026-11-11 明确要求：
// 只要与定时任务相关就隐藏，不做到点自动显示，纯手动开关控制。
//
// A session that no task references is never touched by this feature, so
// unrelated rows stay in the sidebar exactly as before.
//
// `scheduledAt` is still read, but ONLY to display the next fire (`dueAt`): it is
// not a gate. It is the NEXT fire (absolute, UTC) — verified with an active
// recurring task: after its 15:35Z delivery it advanced to 15:45Z.
//
// Every failure path degrades to "hide nothing": an empty list plus a `note`
// saying why. Nothing here writes: no schedule is created, edited, run or
// deleted, and no session is touched.
// ---------------------------------------------------------------------------

/**
 * Legacy delivery-recency window. Since 2026-11-11 it no longer grants any
 * visibility: it is kept only because the route payload still reports it (and
 * `__internals` exports it), so the client-side diagnostic keeps its shape.
 */
const SCHEDULE_HIDE_GRACE_MS = 10 * 60 * 1000

function scheduleStorePath() {
  const override = String(process.env.DSH_AFF_SCHEDULE_FILE ?? '').trim()
  if (override.length > 0) return override
  const home = String(process.env.DSH_HOME ?? '').trim() || join(homedir(), '.dsh')
  return join(home, 'storages', 'schedule.json')
}

/**
 * Collapse the two shapes into one: the live service hands back a FLAT
 * `ScheduleCatalogEntry`, the storage file hands back `{ record, target, ... }`.
 * Reading both without this is how a field silently goes missing on one path.
 */
function normalizeScheduleRow(raw, fallbackId) {
  const row = raw !== null && typeof raw === 'object' ? raw : {}
  const record = row.record !== null && typeof row.record === 'object' ? row.record : row
  const pick = (key, dflt) => {
    if (row[key] !== undefined) return row[key]
    if (record[key] !== undefined) return record[key]
    return dflt
  }
  const involved = pick('involvedSessionIds', null)
  return {
    id: String(pick('id', fallbackId ?? '') ?? ''),
    title: String(pick('title', '') ?? ''),
    status: String(pick('status', 'active') ?? 'active'),
    scheduledAt: String(pick('scheduledAt', '') ?? ''),
    target: pick('target', null),
    involvedSessionIds: Array.isArray(involved) ? involved.map(String) : [],
    lastDelivery: pick('lastDelivery', null),
  }
}

/** Read every task. Service first, storage file second, empty list last. */
async function readScheduleRows(ctx) {
  try {
    const service = ctx?.get?.('schedule') ?? null
    if (service !== null && typeof service.catalog === 'function') {
      const listed = await service.catalog()
      if (Array.isArray(listed)) {
        return { rows: listed.map((row) => normalizeScheduleRow(row, '')), source: 'service' }
      }
      return { rows: [], source: 'service-shape', error: 'catalog() did not return an array' }
    }
  } catch (error) {
    const message = String(error?.message ?? error)
    // A not-yet-started service is normal during boot; anything else is a fault.
    if (!message.includes('not started yet')) {
      ctx?.logger?.warn?.(`${name}: schedule catalog read failed: ${message}`)
    }
  }

  try {
    const text = await readFile(scheduleStorePath(), 'utf8')
    const parsed = JSON.parse(text)
    const tasks = parsed?.tables?.tasks
    if (tasks === null || typeof tasks !== 'object') {
      return { rows: [], source: 'file-shape', error: 'tables.tasks missing' }
    }
    const rows = []
    for (const key of Object.keys(tasks)) {
      const row = tasks[key]
      if (row === null || typeof row !== 'object') continue
      rows.push(normalizeScheduleRow(row, key))
    }
    return { rows, source: 'file' }
  } catch (error) {
    return { rows: [], source: 'unavailable', error: String(error?.message ?? error) }
  }
}

/**
 * The whole decision, as a pure function so it can be asserted with fake data.
 *
 * Per session the rule is now a SINGLE line, because on 2026-11-11 the user
 * removed every other consideration:
 *   linked to any task at all -> HIDDEN, always, `reason: 'scheduled'`
 *
 * 用户 2026-11-11 明确要求：只要与定时任务相关就隐藏，不做到点自动显示，纯手动
 * 开关控制。原来那批「让它重新显示」的豁免（archived / archived-unknown /
 * inactive / no-due / due-reached / grace / target-visible / weak-link）在这里
 * 一个都不保留 —— 到点、投递过、暂停、归档都不能让行回到侧边栏。
 *
 * `nowMs` 与 `graceMsArg` 只为保持调用签名（探针 / 旧调用方）而保留：时间字段
 * 只用于展示（`dueAt` 告诉界面「下次几点」），不参与判定。`archivedIds` 同理
 * 不再参与判定 —— 任务一旦关联到会话，无论归档与否都隐藏。
 */
function decideScheduledHides(rows, archivedIds, nowMs, graceMsArg) {
  // `now` still feeds the display-only `nextDueMs`; it never gates `hide`.
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()

  const rankOf = { involved: 1, target: 2, reserved: 3 }
  const bySession = new Map()

  const admit = (sessionId, link, entry) => {
    const bare = bareId(sessionId)
    if (bare.length === 0) return
    let slot = bySession.get(bare)
    if (slot === undefined) {
      slot = {
        sessionId: String(sessionId),
        bare,
        links: new Set(),
        scheduleIds: [],
        titles: [],
        activeDueMs: Number.POSITIVE_INFINITY,
        nextDueMs: Number.POSITIVE_INFINITY,
        anyActive: false,
        anyOther: false,
        lastDelivery: null,
      }
      bySession.set(bare, slot)
    }
    slot.links.add(link)
    if (entry.id.length > 0 && !slot.scheduleIds.includes(entry.id)) {
      slot.scheduleIds.push(entry.id)
      if (entry.title.length > 0) slot.titles.push(entry.title)
    }
    const active = entry.status === 'active'
    if (active) slot.anyActive = true
    else slot.anyOther = true
    const dueMs = Date.parse(entry.scheduledAt)
    if (active && Number.isFinite(dueMs)) {
      if (dueMs < slot.activeDueMs) slot.activeDueMs = dueMs
      if (dueMs > now && dueMs < slot.nextDueMs) slot.nextDueMs = dueMs
    }
    const receipt = entry.lastDelivery
    if (receipt !== null && typeof receipt === 'object') {
      const at = Date.parse(String(receipt.deliveredAt ?? ''))
      if (Number.isFinite(at)) {
        const seen = slot.lastDelivery === null ? -Infinity : Date.parse(String(slot.lastDelivery.deliveredAt ?? ''))
        if (!Number.isFinite(seen) || at >= seen) slot.lastDelivery = receipt
      }
    }
  }

  for (const entry of Array.isArray(rows) ? rows : []) {
    if (entry === null || typeof entry !== 'object') continue
    const target = entry.target
    if (target !== null && typeof target === 'object') {
      const targetId = bareId(target.sessionId)
      if (targetId.length > 0) {
        admit(target.sessionId, target.kind === 'new_once' ? 'reserved' : 'target', entry)
      }
    }
    for (const involved of entry.involvedSessionIds) admit(involved, 'involved', entry)
  }

  const items = []
  let hidden = 0
  for (const slot of bySession.values()) {
    let strongest = 'involved'
    for (const link of slot.links) {
      if ((rankOf[link] ?? 0) > (rankOf[strongest] ?? 0)) strongest = link
    }
    const reportedDueMs = Number.isFinite(slot.nextDueMs)
      ? slot.nextDueMs
      : (Number.isFinite(slot.activeDueMs) ? slot.activeDueMs : null)
    const dueAt = reportedDueMs === null ? null : new Date(reportedDueMs).toISOString()
    const state = slot.anyActive ? 'active' : (slot.anyOther ? 'inactive' : 'unknown')
    // 用户 2026-11-11 明确要求：只要与定时任务相关就隐藏，不做到点自动显示，
    // 纯手动开关控制。于是这里没有任何分支 —— 凡进了 `items` 的会话一律
    // hide=true，`now` / `dueAt` / `lastDeliveredAt` / `state` / 归档状态都
    // 不改变这个结果，行只会因为用户手动关掉开关才回到侧边栏。
    // 时间字段只用于展示：`nextDueMs`（下次未来触发）与 `activeDueMs`
    //（最近一次触发）只喂下面的 `dueAt`，不参与判定。
    const hide = true
    const reason = 'scheduled'
    hidden += 1

    items.push({
      sessionId: slot.sessionId,
      sessionKey: slot.bare,
      dueAt,
      state,
      link: strongest,
      hide,
      reason,
      scheduleIds: slot.scheduleIds,
      titles: slot.titles,
      lastDeliveredAt:
        slot.lastDelivery === null ? null : String(slot.lastDelivery.deliveredAt ?? ''),
    })
  }

  items.sort((a, b) => {
    if (a.hide !== b.hide) return a.hide ? -1 : 1
    const left = a.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(a.dueAt)
    const right = b.dueAt === null ? Number.POSITIVE_INFINITY : Date.parse(b.dueAt)
    return left - right
  })
  return { items, hidden }
}

/** The route payload. Never throws: an unreadable store yields an empty list. */
async function scheduledHidesPayload(ctx, nowMs) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now()
  const reading = await readScheduleRows(ctx)
  let archived = { ids: null, source: 'unavailable' }
  try {
    archived = await readArchivedSet(ctx)
  } catch (error) {
    archived = { ids: null, source: 'unavailable', reason: String(error?.message ?? error) }
  }
  // The archive set is still read for diagnostics, but since 2026-11-11 it no
  // longer gates anything: a task-linked session is hidden whether or not it is
  // archived, so a degraded registry can no longer flip the verdict.
  const decided = decideScheduledHides(reading.rows, archived.ids, now)
  const notes = []
  if (reading.error !== undefined) notes.push(`schedule read: ${reading.error}`)
  if (archived.ids === null) notes.push('archived set unavailable — archive state no longer gates hiding')
  if (reading.source === 'unavailable') notes.push('schedule store unavailable — nothing hidden')
  return {
    ok: true,
    source: reading.source,
    // The association is read from the schedule store, never guessed from names
    // or time windows; only a missing store degrades into "hide nothing".
    heuristic: reading.source === 'unavailable',
    note:
      notes.length === 0
        ? 'association from schedule target/involvedSessionIds; every linked session stays hidden until the switch is turned off by hand'
        : notes.join('; '),
    now: new Date(now).toISOString(),
    nowMs: now,
    graceMs: SCHEDULE_HIDE_GRACE_MS,
    archivedSource: archived.source ?? 'unavailable',
    taskCount: reading.rows.length,
    hidden: decided.hidden,
    items: decided.items,
  }
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

  // Sidebar right-click 归档 bypasses every route in this file, so the switch
  // also needs a host-side observer. `ctx.on` is a plain bus subscription —
  // not scoped to the emitting fiber — and the storage-domain facility emits
  // `domain/changed` on every archive-set write. See the SIDEBAR ARCHIVE WATCH
  // block for why the first event only seeds a baseline.
  ctx.effect(() => installArchiveWatch(ctx), `${name}: sidebar-archive-watch`)

  // Arm the diff baseline now, not on the first event — see seedArchiveWatch.
  ctx.effect(() => {
    let alive = true
    Promise.resolve()
      .then(() => (alive ? seedArchiveWatch(ctx) : null))
      .catch((error) => {
        ctx.logger?.warn?.(`${name}: sidebar archive watch seed threw: ${String(error?.message ?? error)}`)
      })
    return () => { alive = false }
  }, `${name}: sidebar-archive-seed`)

  // Background cleanup — the CLOCK the plugin never had. Off by default (see
  // the BACKGROUND CLEANUP block), armed here so the tick lives and dies with
  // the plugin, and inside its own effect so a failed read cannot abort apply():
  // a missing policy file must never stop the host from booting.
  ctx.effect(() => {
    try {
      return installBackgroundCleanup(ctx)
    } catch (error) {
      // Arming a timer is the least important thing this plugin does. If it
      // fails (no timers, unreadable state dir, anything), the plugin must still
      // mount — the event-driven purge and every route keep working.
      ctx.logger?.warn?.(`${name}: background cleanup could not be armed: ${String(error?.message ?? error)}`)
      return () => {}
    }
  }, `${name}: background-cleanup`)

  // One-time MIGRATION of the PRE-0.25 snapshot location. Snapshots used to
  // live in `~/.dsh/file-history/<sessionId>`, which nothing ever
  // garbage-collected; they now live inside each session's own directory (see
  // the FILE HISTORY note above), so the old tree is dead weight.
  //
  // This used to be a bare `rmSync(..., { recursive: true, force: true })` run
  // on EVERY apply(). That broke three of this plugin's own rules at once:
  //   1. "one-time" was never enforced — there was no gate, so it re-ran on
  //      every host boot;
  //   2. the plugin's contract is that EVERY delete is recoverable (Recycle
  //      Bin); rmSync is a permanent unlink, the one place that contract broke;
  //   3. a successful removal was completely silent.
  //
  // The migration is now: gate on a persisted marker (runs at most once),
  // measure + log before/after, and send the tree to the Recycle Bin through
  // the same channel the rest of the plugin uses (`sendToRecycleBin`). If the
  // recycle channel is unavailable we do NOT fall back to deleting — we warn
  // and leave the tree in place. Nothing here may block startup.
  const legacyMigratedPath = join(stateDir(), 'legacy-file-history-migrated.json')
  let legacyAlreadyMigrated = false
  try {
    legacyAlreadyMigrated = existsSync(legacyMigratedPath)
  } catch {
    legacyAlreadyMigrated = false
  }
  if (!legacyAlreadyMigrated) {
    const legacyDir = join(homedir(), '.dsh', 'file-history')
    let legacyPresent = false
    try {
      legacyPresent = existsSync(legacyDir)
    } catch (error) {
      ctx.logger?.warn?.(`${name}: could not stat legacy file-history dir: ${String(error?.message ?? error)}`)
    }
    const writeLegacyMarker = (record) => {
      try {
        mkdirSync(stateDir(), { recursive: true })
        writeFileSync(legacyMigratedPath, `${JSON.stringify(record, null, 2)}\n`)
      } catch (error) {
        ctx.logger?.warn?.(`${name}: could not write legacy-migration marker: ${String(error?.message ?? error)}`)
      }
    }
    if (!legacyPresent) {
      // Nothing to migrate. Record it so we stop re-checking on every boot.
      writeLegacyMarker({ version: PKG_VERSION, at: new Date().toISOString(), result: 'absent', path: legacyDir, files: 0, bytes: 0 })
    } else {
      // Measure, recycle, log. Async and deliberately NOT awaited: `apply()` is
      // synchronous, and a legacy cleanup must never hold up the host. A failure
      // here is a warning and a `failed` marker — never a startup blocker and
      // never a permanent delete.
      ;(async () => {
        let files = 0
        let bytes = 0
        try {
          const walk = (dir) => {
            for (const entry of readdirSync(dir, { withFileTypes: true })) {
              const child = join(dir, entry.name)
              if (entry.isDirectory()) walk(child)
              else if (entry.isFile()) {
                files += 1
                try {
                  bytes += statSync(child).size
                } catch {
                  // A file that vanished mid-walk contributes no bytes; do not
                  // abort the whole measurement over it.
                }
              }
            }
          }
          walk(legacyDir)
        } catch (error) {
          ctx.logger?.warn?.(`${name}: legacy file-history measure failed (path="${legacyDir}"): ${String(error?.message ?? error)}`)
        }
        ctx.logger?.info?.(`${name}: migrating legacy file-history dir to Recycle Bin (path="${legacyDir}", files=${files}, bytes=${bytes})`)
        const recycled = await sendToRecycleBin(legacyDir)
        if (recycled.ok) {
          writeLegacyMarker({ version: PKG_VERSION, at: new Date().toISOString(), result: 'recycled', path: legacyDir, files, bytes })
          ctx.logger?.info?.(`${name}: legacy file-history dir recycled (path="${legacyDir}", files=${files}, bytes=${bytes})`)
        } else {
          // Recycle unavailable (non-Windows, child_process missing, PowerShell
          // failure). Degrade to "do not delete": warn and leave it alone.
          writeLegacyMarker({ version: PKG_VERSION, at: new Date().toISOString(), result: 'failed', path: legacyDir, files, bytes })
          ctx.logger?.warn?.(`${name}: legacy file-history dir NOT removed — recycle unavailable, left in place (path="${legacyDir}", files=${files}, bytes=${bytes}, reason=${recycled.reason ?? 'unknown'})`)
        }
      })().catch((error) => {
        writeLegacyMarker({ version: PKG_VERSION, at: new Date().toISOString(), result: 'failed', path: legacyDir, files: 0, bytes: 0 })
        ctx.logger?.warn?.(`${name}: legacy file-history migration threw: ${String(error?.message ?? error)}`)
      })
    }
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
            + `Open Settings → 归档助手 → 缓存与未分组 to inspect and clean them.`,
          )
        } else {
          ctx.logger?.info?.(`${name}: ungrouped guard — clean (${report.summary?.totalDirs ?? 0} session dirs scanned, source=${report.source ?? 'file'})`)
        }
        // The directory scan above cannot see projection-cache ghosts, and those
        // are the ones that keep coming back: the directory is gone, the cache
        // entry is not, so the running instance keeps rendering it under 未分组.
        // This second pass is the only place that notices them.
        //
        // 0.36.0: every ghost is actionable now — pinned/archived are opt-in
        // keepers instead of silent skips — so the count is simply all of them.
        return diagnoseGhostCache(ctx, {}).then((ghosts) => {
          if (ghosts?.ok !== true) return
          const all = Array.isArray(ghosts.ghosts) ? ghosts.ghosts : []
          const bytes = all.reduce((sum, entry) => sum + (Number(entry?.bytes) || 0), 0)
          if (all.length > 0) {
            ctx.logger?.warn?.(
              `${name}: ⚠ ${all.length} projection-cache ghost(s) with no session directory (${bytes} bytes). `
              + `These render under 未分组 and the directory scan cannot see them. `
              + `Open Settings → 归档助手 → 缓存与未分组 → 孤儿缓存 to inspect and clean.`,
            )
          } else {
            ctx.logger?.info?.(
              `${name}: ghost-cache guard — clean (${ghosts.summary?.cacheFiles ?? 0} cache files vs ${ghosts.summary?.diskSessions ?? 0} session dirs)`,
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
  // 0.39.0 — in-session rewind (surface replace) instead of fork-and-delete.
  rewindSession,
  lastTurnNumber,
  isRewindMarker,
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
  // 0.30.0 — the pre-selection policy (NOT an auto-delete switch).
  readSnapshotPolicy,
  writeSnapshotPolicy,
  clampHours,
  SNAPSHOT_POLICY_DEFAULT_HOURS,
  // 0.31.0 — the same idea for deleting archived conversations; SEPARATE
  // policy, because the blast radius is not the same.
  readArchiveDeletePolicy,
  writeArchiveDeletePolicy,
  clampPolicyHours,
  ARCHIVE_DELETE_POLICY_DEFAULT_HOURS,
  readArchivePurgePolicy,
  writeArchivePurgePolicy,
  ARCHIVE_PURGE_POLICY_VERSION,
  // 0.34.0 — sidebar-archive watch (driven directly by the host probe).
  archivedIdsFromChange,
  handleWorkspaceArchiveChange,
  purgeSnapshotFor,
  resetArchiveWatchSeed,
  seedArchiveWatch,
  noteSelfArchived,
  // 0.37.1 — on-demand size facts behind the six-column rows. Probe-visible so
  // the "two columns were always dashes" regression cannot come back silently.
  measureLedgersFor,
  measureSessionDirsFor,
  // 0.38.0 — snapshot-cleanup progress jobs. Probe-visible because the console's
  // "Running…" state is otherwise only reachable by driving the HTTP route.
  runCleanupJob,
  putCleanupJob,
  getCleanupJob,
  snapshotCleanupBusy,
  // 0.38.0 (2026-11-11 补齐) — 其余三条破坏性执行体 + 共用锁判定也要探针可见。
  // 它们和 runCleanupJob 是同一套进度的读写方：只暴露快照读写、不暴露执行体，
  // 探针就只能靠 `dryRun` 帧的字面值去猜「试算帧 phase 对不对」（M1 正是这样
  // 漏过去的），也无法在不打真 HTTP 的情况下验证 O6 的「构造抛错必放锁」。
  runDeleteJob,
  runIdleJob,
  runGhostJob,
  ensureNoActiveJob,
  // 0.40.0 — the background sweep. Probe-visible so the "did the timer really
  // run without a settings page" question can be answered from the host, and
  // so the filter (favourites / unknown age / maxItems) can be tested directly.
  normalizeBackgroundCleanup,
  resolveBackgroundHours,
  readBackgroundCleanupLast,
  writeBackgroundCleanupLast,
  runBackgroundCleanup,
  installBackgroundCleanup,
  BACKGROUND_CLEANUP_DEFAULT,
  BACKGROUND_CLEANUP_VERSION,
  clampScheduleMinutes,
  clampBackgroundHours,
  // 0.40.0 — hide-scheduled-tasks decision (probe-visible, pure, no I/O).
  decideScheduledHides,
  normalizeScheduleRow,
  readScheduleRows,
  scheduledHidesPayload,
  scheduleStorePath,
  SCHEDULE_HIDE_GRACE_MS,
}

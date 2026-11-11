/**
 * SNAPSHOT STORAGE USAGE — visibility plus a manual delete button.
 *
 * WHY THIS EXISTS
 * ---------------
 * `<session dir>/history-file/` grows without any cap: one blob per edited
 * file per tool call, kept forever, and until now nothing in the UI ever
 * mentioned it. Measured on the author's machine before this module existed:
 * 59 ledgers, 25.4 MB total, the single biggest session holding 10.4 MB of it —
 * invisible from every screen the plugin had.
 *
 * 🔴 TWO RULES THAT SHAPE THIS FILE
 * ---------------------------------
 *
 * 1. NOTHING HERE RUNS ON ITS OWN.
 *    There is no timer, no interval, no scan-on-mount, no scan-on-route-mount.
 *    `scanSnapshotUsage()` runs exactly when the user presses the "measure now"
 *    button on the settings page, and never otherwise. A settings page that
 *    measured on every open would walk thousands of directories while the user
 *    is doing something else, and the plugin would get blamed for the stutter.
 *    Concurrent presses share one in-flight scan (see `inflight`), so a double
 *    click costs one walk, not two.
 *
 * 2. IT MUST NOT FEEL SLOW WHEN IT DOES RUN.
 *    The machine this was built on carries 59 ledgers / 587 blobs / 1246
 *    manifest rows, and a busier machine will carry more. So the scan is:
 *      * fully async (`node:fs/promises`) — never a `readFileSync` over the
 *        sessions tree, or the host event loop stalls and every other plugin's
 *        HTTP route waits behind it;
 *      * bounded-concurrency (one stat pool, width 32) instead of `await` per
 *        file in series;
 *      * JSON-parse free — entry counts come from newline counting, skipped
 *        rows from a substring count, and the first/last snapshot timestamps
 *        from a digit scan around `"time":`. Parsing 1246 JSON rows per scan
 *        would be pure overhead for numbers a string scan already gives;
 *      * capped (`maxDirs`) so a pathological tree cannot turn one click into
 *        a minute of I/O.
 *    `elapsedMs` comes back on the report so the UI can show it and the probe
 *    can guard against a regression into synchronous walking.
 *
 * 🔴 WHAT THIS IS NOT: an automatic pruner.
 *
 * Automatic pruning was shipped in an earlier generation of this plugin and
 * then removed on purpose, because it silently destroyed the one thing the
 * ledger exists for — rolling a file back to how it looked before an assistant
 * rewrote it. A conversation is worth keeping precisely because of what is in
 * it; the snapshot is what makes that conversation recoverable, and an editor
 * that quietly discards recovery paths to save disk is not doing the user a
 * favour. No timer, no size ceiling, no age policy. Not now, not later.
 *
 * So the contract:
 *   * `scanSnapshotUsage()` is READ-ONLY — it walks the tree, stats the blobs,
 *     counts manifest rows, and returns a table. It never deletes.
 *   * `cleanupSnapshotUsage()` deletes ONLY when `dryRun: false` arrives, which
 *     the route only passes after an explicit `confirm: true` from a second
 *     click. And even then it deletes only the selected sessions' ledger
 *     DIRECTORY, always via the Windows recycle bin (quarantine rename as
 *     fallback) — never a physical erase.
 *   * The blast radius is bounded and stated in the UI: losing a ledger costs
 *     rollback for that one conversation. The transcript, the files, and the
 *     conversation itself all survive.
 */

import { existsSync, readdirSync, statSync, readFileSync, mkdirSync, renameSync } from 'node:fs'
import { readdir, stat, readFile, lstat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { homedir } from 'node:os'

// 批量版：一个 PowerShell 删一批目录（见 ungrouped-guard.js 的实测数字）。
// 单目录版仍然从同一个模块导出，供其它调用方使用。
import { sendManyToRecycleBin } from './ungrouped-guard.js'

export const SNAPSHOT_USAGE_VERSION = '1.2.0'

/**
 * The ledger directory name. Also the leaf-name guard in `cleanupSnapshotUsage`.
 * Not exported: all three readers are in-file, so no caller needs it.
 */
const SNAPSHOT_DIRNAME = 'history-file'
const BLOBS_DIRNAME = 'blobs'
const MANIFEST_NAME = 'manifest.jsonl'

/** How many `stat`/`readFile` calls are in flight at once. */
const CONCURRENCY = 32

/**
 * One shared in-flight scan per sessions root.
 *
 * A user who double-clicks, or two settings tabs open at the same time, must
 * not walk the whole tree twice. Keyed by root because the probe suite points
 * several fixtures at different throwaway roots in one process.
 */
const inflight = new Map()

/** `session-<uuid>` and bare `<uuid>` are the same conversation. */
function bareId(sessionId) {
  const text = String(sessionId ?? '')
  return text.startsWith('session-') ? text.slice('session-'.length) : text
}

/** Lowercased, trailing separators stripped — comparison form only. */
function normPath(value) {
  return String(value ?? '').toLowerCase().replace(/[\\/]+$/, '')
}

/**
 * `target` strictly inside `root`.
 *
 * Declared here rather than imported from the guard module so this file stays
 * readable on its own; a one-line path test is cheaper than a dependency.
 * Strict (not `t === r`) on purpose: the ledger dir must be a CHILD of the
 * sessions root, never the root itself.
 */
function isPathInside(root, target) {
  const r = normPath(root)
  const t = normPath(target)
  if (r.length === 0 || t.length === 0) return false
  if (t === r) return false
  return t.startsWith(r + '\\') || t.startsWith(r + '/')
}

function resolveSessionsRoot(options) {
  const explicit = typeof options?.sessionsRoot === 'string' && options.sessionsRoot.length > 0
    ? options.sessionsRoot
    : null
  if (explicit !== null) return explicit
  if (typeof process.env.DSH_AFF_SESSIONS_ROOT === 'string' && process.env.DSH_AFF_SESSIONS_ROOT.length > 0) {
    return process.env.DSH_AFF_SESSIONS_ROOT
  }
  const home = typeof options?.dshHome === 'string' && options.dshHome.length > 0
    ? options.dshHome
    : (process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  return join(home, 'sessions')
}

function resolveProjCacheRoot(options) {
  const explicit = typeof options?.projCacheRoot === 'string' && options.projCacheRoot.length > 0
    ? options.projCacheRoot
    : null
  if (explicit !== null) return explicit
  if (typeof process.env.DSH_AFF_PROJCACHE_ROOT === 'string' && process.env.DSH_AFF_PROJCACHE_ROOT.length > 0) {
    return process.env.DSH_AFF_PROJCACHE_ROOT
  }
  const home = typeof options?.dshHome === 'string' && options.dshHome.length > 0
    ? options.dshHome
    : (process.env.DSH_HOME ?? join(homedir(), '.dsh'))
  return join(home, 'storages', 'session_projcache', 'sessions')
}

/**
 * Run `fn` over `items` with at most `limit` promises live at once.
 *
 * Order is preserved in the result. Written by hand rather than pulled from a
 * package: the plugin ships with zero runtime dependencies, and 15 lines is
 * cheaper to audit than a new dependency tree.
 */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    while (true) {
      const index = next
      next += 1
      if (index >= items.length) return
      results[index] = await fn(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Every session directory that could own a ledger.
 *
 * Machines upgraded across harness generations carry two layouts at once:
 * `<root>/<project>/<session>/` (current) and a flat `<root>/<session>/`
 * (legacy). Both are enumerated — a ledger hiding in the old shape would
 * otherwise be permanently invisible, which is the exact problem this feature
 * exists to fix.
 */
async function listCandidateDirs(root, maxDirs) {
  const out = []
  let level1 = []
  try {
    level1 = await readdir(root, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of level1) {
    if (!entry.isDirectory()) continue
    const top = join(root, entry.name)
    let inner = []
    try {
      inner = await readdir(top, { withFileTypes: true })
    } catch {
      continue
    }
    let nested = 0
    for (const child of inner) {
      if (!child.isDirectory()) continue
      nested += 1
      out.push({ projectName: entry.name, dirName: child.name, dir: join(top, child.name) })
      if (out.length >= maxDirs) return out
    }
    if (nested === 0) {
      out.push({ projectName: entry.name, dirName: entry.name, dir: top })
      if (out.length >= maxDirs) return out
    }
  }
  return out
}

/** Count non-empty lines without splitting the whole file into an array. */
function countLines(text) {
  if (text.length === 0) return 0
  let count = 0
  let lineStart = 0
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) !== 10) continue
    if (i > lineStart) count += 1
    lineStart = i + 1
  }
  if (text.length > lineStart) count += 1
  return count
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack, needle) {
  if (needle.length === 0) return 0
  let count = 0
  let at = haystack.indexOf(needle)
  while (at !== -1) {
    count += 1
    at = haystack.indexOf(needle, at + needle.length)
  }
  return count
}

/**
 * First and last `"time":<digits>` in the manifest, without parsing any JSON.
 *
 * Rows are appended in order, so the first match is the oldest snapshot and the
 * last match is the newest — which is all the UI needs. Falls back to the
 * manifest's own mtime if a row is malformed, because "when did this ledger
 * last change" still beats "unknown".
 */
function manifestTimeRange(text, fallbackMs) {
  const marker = '"time":'
  const readAt = (from) => {
    let cursor = text.indexOf(marker, from)
    if (cursor === -1) return null
    cursor += marker.length
    while (cursor < text.length && text.charCodeAt(cursor) === 32) cursor += 1
    let end = cursor
    while (end < text.length) {
      const code = text.charCodeAt(end)
      if (code < 48 || code > 57) break
      end += 1
    }
    if (end === cursor) return null
    const value = Number(text.slice(cursor, end))
    return Number.isFinite(value) ? value : null
  }
  const first = readAt(0)
  const lastMarker = text.lastIndexOf(marker)
  const last = lastMarker === -1 ? null : readAt(lastMarker)
  return {
    firstSnapshotAt: first ?? fallbackMs,
    lastSnapshotAt: last ?? fallbackMs,
  }
}

/**
 * Measure one ledger. Read-only, async, and deliberately cheaper than it looks.
 *
 * Byte counting has to `stat` every blob — there is no way around that, since
 * `readdir` does not report sizes on every platform — so the stats go through
 * one bounded pool rather than running in series.
 *
 * `bytes` counts blobs PLUS the manifest. The manifest is not negligible: on
 * the measured machine a 143-blob ledger carried a 52 KB ledger file. Counting
 * blobs alone would also report 0 bytes for a ledger whose every blob was
 * skipped by the 8 MB ceiling while still holding thousands of rows — the one
 * case where a bare size report would mislead most.
 */
// 0.37.0 — exported so the archive and idle routes can attach the same
// bytes / blob-count facts the snapshot card shows. Every settings list now
// renders the same six columns, and two of those columns are these numbers.
export async function measureLedger(dir) {
  const out = {
    bytes: 0,
    blobBytes: 0,
    blobCount: 0,
    manifestBytes: 0,
    entryCount: 0,
    skippedCount: 0,
    firstSnapshotAt: null,
    lastSnapshotAt: null,
  }

  const blobsDir = join(dir, BLOBS_DIRNAME)
  let blobNames = []
  try {
    blobNames = await readdir(blobsDir, { withFileTypes: true })
  } catch {
    blobNames = []
  }
  const files = blobNames.filter((entry) => entry.isFile())
  const sizes = await mapLimit(files, CONCURRENCY, async (entry) => {
    try {
      const info = await stat(join(blobsDir, entry.name))
      return info.isFile() ? info.size : 0
    } catch {
      // A blob removed between readdir and stat is not an error worth failing on.
      return 0
    }
  })
  for (const size of sizes) {
    if (size <= 0) continue
    out.blobCount += 1
    out.blobBytes += size
  }

  const manifestPath = join(dir, MANIFEST_NAME)
  let text = null
  let manifestMtime = null
  try {
    const [buffer, info] = await Promise.all([readFile(manifestPath), stat(manifestPath)])
    text = buffer.toString('utf8')
    manifestMtime = info.mtimeMs
  } catch {
    text = null
  }
  if (text !== null) {
    out.manifestBytes = Buffer.byteLength(text, 'utf8')
    out.entryCount = countLines(text)
    // `blob: null` is a legitimate row — the file did not exist yet, or it was
    // above the 8 MB ceiling. Counting the literal keeps "143 blobs / 400 rows"
    // from reading like a bug in the report, without paying for JSON.parse.
    out.skippedCount = countOccurrences(text, '"blob":null')
    const range = manifestTimeRange(text, Number.isFinite(manifestMtime) ? Math.round(manifestMtime) : null)
    out.firstSnapshotAt = range.firstSnapshotAt
    out.lastSnapshotAt = range.lastSnapshotAt
  }

  out.bytes = out.blobBytes + out.manifestBytes
  return out
}

/**
 * A conversation's title out of the projection cache.
 *
 * Used as the fallback so an old session that has never been opened in this
 * process still shows a name instead of a uuid. Both file spellings are tried:
 * the cache filename has been seen with and without the `session-` prefix.
 * Read synchronously on purpose — at most two small JSON files per ledger, and
 * only for the rows the catalogue could not name.
 */
function titleFromCache(projCacheRoot, sessionId) {
  return metaFromCache(projCacheRoot, sessionId).title
}

/** First argument that is a positive finite number, else null. */
function firstFiniteNumber(...values) {
  for (const value of values) {
    const n = Number(value)
    if (Number.isFinite(n) && n > 0) return Math.round(n)
  }
  return null
}

/**
 * Title AND last-activity time for a conversation, out of the projection cache.
 *
 * ⚠️ WHY THIS READS ONE FILE INSTEAD OF TWO: the card needs "how long has this
 * conversation been idle" next to the size — a size list without an age is a
 * list you cannot decide on, and the age column is the whole point of pairing
 * this with the idle-archive threshold. The cache JSON that already supplies the
 * title also carries the two timestamps we want, so it is one read either way:
 *
 *     record.rows.title.val                        -> the sidebar's title
 *     record.rows.sessionListMetadata.val.lastPromptAt -> last prompt, ms epoch
 *     record.rows.timeContext.val.lastMessageTime  -> fallback
 *     record.identity.createdAt                    -> last resort (untouched session)
 *
 * The field order matters: `lastPromptAt` is the harness's own "last activity"
 * projection (it is what the sidebar sorts by), so it wins over the raw message
 * timestamp. Both are read defensively — the rows are projections and their
 * shape is not part of the plugin contract.
 *
 * Read synchronously on purpose: at most two small JSON files per ledger, and
 * only for rows the live catalogue could not name.
 *
 * 0.40.x — MEMOISED ON (path, mtimeMs, size). Measured before this change: one
 * `/snapshot-usage` scan parsed 36 projection files totalling 11.1 MB (mean
 * 314 KB, largest 1.33 MB) and that parse was 43.4 ms of an 86.8 ms scan — half
 * the cost of the whole route, paid again on every "measure now" click and
 * again by `/archived` and `/idle-archive`. Only three fields are kept
 * (title / cwd / lastActivityAt), and the file cannot change without its mtime
 * or size changing, so a `statSync` (≈0.03 ms) replaces a parse (≈1.2 ms).
 *
 * The cache is bounded and insertion-ordered: at `META_CACHE_MAX` entries the
 * oldest key is dropped, so a machine with thousands of sessions cannot turn
 * this into a leak. EVERY failure path (statSync throws, JSON.parse throws,
 * file vanished, EPERM) falls through to exactly the old behaviour — a cache
 * problem must never change the answer. Negative results (both spellings
 * missing, or a projection with no name/age/cwd) are NOT cached, so a session
 * that gains a projection file starts naming itself on the next scan.
 */
const META_CACHE_MAX = 4096
const metaCache = new Map()
const metaCacheStats = { hits: 0, misses: 0, stale: 0, errors: 0 }

/** Cached meta for `file`, or `undefined` when absent/stale/unverifiable. */
function readMetaCache(file) {
  const hit = metaCache.get(file)
  if (hit === undefined) return undefined
  try {
    const info = statSync(file)
    if (info.mtimeMs === hit.mtimeMs && info.size === hit.size) {
      metaCacheStats.hits += 1
      return hit.meta
    }
    metaCacheStats.stale += 1
  } catch {
    // Unverifiable right now (deleted, EPERM, transient ENOENT): drop the entry
    // and let the caller re-read or give up. Never throw out of a cache probe.
    metaCacheStats.errors += 1
  }
  metaCache.delete(file)
  return undefined
}

function writeMetaCache(file, info, meta) {
  if (metaCache.size >= META_CACHE_MAX) {
    const oldest = metaCache.keys().next().value
    if (oldest !== undefined) metaCache.delete(oldest)
  }
  metaCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, meta })
}

export function metaFromCache(projCacheRoot, sessionId) {
  const bare = bareId(sessionId)
  for (const file of [join(projCacheRoot, `${bare}.json`), join(projCacheRoot, `${String(sessionId)}.json`)]) {
    try {
      const cached = readMetaCache(file)
      if (cached !== undefined) return cached
      metaCacheStats.misses += 1
      // statSync replaces the old existsSync probe: same "skip when missing"
      // semantics, one syscall, and it yields the mtime/size the cache needs.
      const info = statSync(file)
      const parsed = JSON.parse(readFileSync(file, 'utf8'))
      const rows = parsed?.record?.rows ?? {}
      const title = typeof rows?.title?.val === 'string' ? rows.title.val : ''
      // 0.37.0: the working directory travels with the title so every list in the
      // settings page can show the same 工作区 column. It comes from the same file
      // read, so this costs nothing extra.
      const cwd = typeof parsed?.record?.identity?.cwd === 'string' ? parsed.record.identity.cwd : ''
      const lastActivityAt = firstFiniteNumber(
        rows?.sessionListMetadata?.val?.lastPromptAt,
        rows?.timeContext?.val?.lastMessageTime,
        parsed?.record?.identity?.createdAt,
      )
      if (title.length === 0 && lastActivityAt === null && cwd.length === 0) continue
      const meta = { title, lastActivityAt, cwd }
      writeMetaCache(file, info, meta)
      return meta
    } catch {
      // Try the other spelling, then give up quietly.
    }
  }
  return { title: '', lastActivityAt: null, cwd: '' }
}

/**
 * READ-ONLY report of every ledger on disk, biggest first.
 *
 * Called only from the explicit "measure now" button (via the
 * `/snapshot-usage` route). Never from `apply()`, never on a timer, never on
 * page mount.
 *
 * @param {object} [options] `sessionsRoot` / `projCacheRoot` / `dshHome` /
 *        `maxDirs` / `skipCacheLookup` / `shared`(默认 true，同根并发扫描复用)
 * @returns {Promise<object>} `{ok, generatedAt, elapsedMs, root, summary, entries, problems, detail?}`
 */
export async function scanSnapshotUsage(options = {}) {
  const root = resolveSessionsRoot(options)
  const shared = options?.shared !== false
  if (shared && inflight.has(root)) return inflight.get(root)
  const promise = runScan(options, root)
  if (shared) {
    inflight.set(root, promise)
    // Clear on completion either way, so a failed scan does not wedge the key.
    promise.then(() => inflight.delete(root), () => inflight.delete(root))
  }
  return promise
}

async function runScan(options, root) {
  const startedAt = Date.now()
  const generatedAt = new Date().toISOString()
  const projCacheRoot = resolveProjCacheRoot(options)
  const maxDirs = Number.isFinite(options?.maxDirs) ? Number(options.maxDirs) : 20000
  const withTitles = options?.skipCacheLookup !== true
  const problems = []
  const emptySummary = { sessions: 0, totalBytes: 0, totalBlobs: 0, totalEntries: 0, largest: null }

  if (!existsSync(root)) {
    return {
      ok: false,
      generatedAt,
      elapsedMs: Date.now() - startedAt,
      root,
      summary: emptySummary,
      entries: [],
      problems,
      detail: `会话根目录不存在：${root}`,
    }
  }

  const dirs = await listCandidateDirs(root, maxDirs)

  // Which candidate directories actually own a ledger. `stat` is far cheaper
  // than opening the directory, and most sessions have none.
  const owned = await mapLimit(dirs, CONCURRENCY, async (item) => {
    const dir = join(item.dir, SNAPSHOT_DIRNAME)
    try {
      const info = await stat(dir)
      return info.isDirectory() ? { item, dir } : null
    } catch {
      return null
    }
  })

  const live = owned.filter((value) => value !== null)
  const measured = await mapLimit(live, CONCURRENCY, async ({ item, dir }) => ({
    item,
    dir,
    measured: await measureLedger(dir),
  }))

  const now = Date.now()
  const entries = measured.map(({ item, dir, measured: m }) => {
    // Names and the last-activity stamp come last because the cache lookup is
    // the only synchronous part; keeping it out of the measured pool bounds the
    // worst case to two small reads per ledger instead of two per ledger in
    // parallel with everything else.
    const meta = withTitles ? metaFromCache(projCacheRoot, item.dirName) : { title: '', lastActivityAt: null, cwd: '' }
    return {
      sessionId: item.dirName,
      projectName: item.projectName,
      dir,
      bytes: m.bytes,
      blobBytes: m.blobBytes,
      blobCount: m.blobCount,
      manifestBytes: m.manifestBytes,
      entryCount: m.entryCount,
      skippedCount: m.skippedCount,
      firstSnapshotAt: m.firstSnapshotAt,
      lastSnapshotAt: m.lastSnapshotAt,
      title: meta.title,
      // The 工作区 column of every list comes from here — see the 0.37.0 note in
      // metaFromCache. Empty string when the cache had nothing to say.
      cwd: meta.cwd ?? '',
      // 🔴 THE AGE COLUMN IS THE POINT, NOT A NICETY. A size table alone cannot
      // be acted on: "this conversation is 10 MB" says nothing about whether
      // the conversation is still alive. Paired with the idle threshold it does
      // — and `idleMs` is computed HERE from the one clock, so every row in the
      // table is measured against the same instant instead of drifting apart by
      // however long the client takes to render.
      lastActivityAt: meta.lastActivityAt,
      idleMs: meta.lastActivityAt === null ? null : Math.max(0, now - meta.lastActivityAt),
    }
  })

  entries.sort((a, b) => b.bytes - a.bytes)

  let totalBytes = 0
  let totalBlobs = 0
  let totalEntries = 0
  for (const entry of entries) {
    totalBytes += entry.bytes
    totalBlobs += entry.blobCount
    totalEntries += entry.entryCount
  }

  return {
    ok: true,
    generatedAt,
    elapsedMs: Date.now() - startedAt,
    root,
    summary: {
      sessions: entries.length,
      totalBytes,
      totalBlobs,
      totalEntries,
      largest: entries.length > 0
        ? { sessionId: entries[0].sessionId, bytes: entries[0].bytes, title: entries[0].title }
        : null,
    },
    entries,
    problems,
  }
}

/**
 * Delete the selected sessions' ledger directories — to the RECYCLE BIN.
 *
 * Defaults to `dryRun: true`: a caller that forgets the flag gets a plan, not a
 * deletion. Every candidate is re-validated here rather than trusted from the
 * page, because a stale list is a real possibility (a session can be deleted
 * or re-created between render and click). Two independent guards:
 *   1. the path must sit strictly inside the sessions root;
 *   2. its last segment must be exactly `history-file`.
 * Either alone would let a crafted or buggy request aim at something else; both
 * together mean "delete a conversation" is not reachable from this route.
 *
 * ⚠️ 永久删除（0.39.0）：`options.permanent` 只做一件事——把第二阶段的
 * 「送回收站」换成 `Remove-Item`，并**关掉 quarantine 兜底**（永久模式下失败就
 * 必须落 `failures`，不许 rename 到 `snapshot_quarantine_<stamp>/` 装作删掉了）。
 * 这里再算一次 `permanent = options.permanent === true && dryRun === false`，
 * 与 index.js 的三条件判定形成双保险：即使上层传错，dry-run 也永远删不了东西。
 *
 * @param {Array}  plan  entries from `scanSnapshotUsage()` (or a subset)
 * @param {object} [options] `dryRun`(默认 true) / `maxItems`(默认 500) /
 *        `sessionsRoot` / `dshHome` / `quarantineFallback`(默认 true) /
 *        `permanent`(默认 false，且必须 dryRun===false 才生效)
 * @returns {Promise<{dryRun:boolean, permanent:boolean, purged:number, deleted:string[], skipped:Array, failures:Array, bytesFreed:number}>}
 */
export async function cleanupSnapshotUsage(plan, options = {}) {
  const dryRun = options?.dryRun !== false
  const maxItems = Number.isFinite(options?.maxItems) ? Number(options.maxItems) : 500
  const quarantineFallback = options?.quarantineFallback !== false
  // 🔴 双保险：dry-run 下 permanent 恒为 false。即便调用方漏了条件，dry-run 也
  // 只生成计划，不存在「试探性真删」这种状态。
  const permanent = options?.permanent === true && dryRun === false
  const root = resolveSessionsRoot(options)

  const result = { dryRun, permanent, purged: 0, deleted: [], skipped: [], failures: [], bytesFreed: 0 }
  const entries = Array.isArray(plan) ? plan : []

  // 📣 进度契约（0.38.0）：一次删除 = 一串 onProgress 事件
  //     { phase, done, total, bytesFreed, bytesTotal, current }
  // phase: 'start' | 'delete' | 'dryRun' | 'done'
  // 第一条在**函数入口**就发（done=0，total 已知），节流 150ms，最后一条必发。
  // 这样「点了删除立刻有反馈」，不会等第一目录删完才有数。
  const totals = {
    total: entries.length,
    bytesTotal: entries.reduce(
      (sum, entry) => sum + (Number.isFinite(Number(entry?.bytes)) ? Number(entry.bytes) : 0),
      0,
    ),
  }
  const sink = makeProgressSink(options, totals)
  sink.emit({ phase: 'start', done: 0, bytesFreed: 0, current: '' }, true)
  if (entries.length === 0) {
    sink.emit({ phase: 'done', done: 0, bytesFreed: 0, current: '' }, true)
    return result
  }

  // 第一阶段：**只校验，不删**。下面这些护栏一字未改（路径必须严格在
  // sessions root 内、末段必须是 history-file、拒绝符号链接、budget 上限），
  // 只是把「删」这一步推迟到第二阶段，好让删除能批量、能并发、能报进度。
  const ready = []
  let budget = maxItems
  for (const entry of entries) {
    const sessionId = String(entry?.sessionId ?? '')
    const dir = String(entry?.dir ?? '')
    if (sessionId.length === 0 || dir.length === 0) {
      result.skipped.push({ sessionId, reason: 'missing-id-or-dir' })
      continue
    }
    if (!isPathInside(root, dir)) {
      result.failures.push({ sessionId, dir, reason: 'outside-sessions-root' })
      continue
    }
    if (basename(dir) !== SNAPSHOT_DIRNAME) {
      result.failures.push({ sessionId, dir, reason: 'not-a-history-file-dir' })
      continue
    }
    if (budget <= 0) {
      result.skipped.push({ sessionId, reason: 'budget-exhausted' })
      continue
    }
    let info = null
    try {
      info = await lstat(dir)
    } catch (error) {
      result.skipped.push({ sessionId, reason: `not-found:${String(error?.code ?? '')}` })
      continue
    }
    // A symlink could point outside the tree while the string test above passes.
    if (info.isSymbolicLink()) {
      result.failures.push({ sessionId, dir, reason: 'refused-symlink' })
      continue
    }
    if (!info.isDirectory()) {
      result.failures.push({ sessionId, dir, reason: 'not-a-directory' })
      continue
    }
    budget -= 1
    const size = Number.isFinite(Number(entry?.bytes)) ? Number(entry.bytes) : 0
    ready.push({ sessionId, dir, size })
  }

  // 第二阶段：删（或试算）。
  totals.total = ready.length
  totals.bytesTotal = ready.reduce((sum, item) => sum + item.size, 0)
  let done = 0
  let bytesFreed = 0
  const tick = (phase, current) => sink.emit({ phase, done, bytesFreed, current })

  if (dryRun) {
    for (const item of ready) {
      result.deleted.push(item.sessionId)
      result.bytesFreed += item.size
      done += 1
      bytesFreed += item.size
      tick('dryRun', item.sessionId)
    }
    sink.emit({ phase: 'done', done, bytesFreed, current: '' }, true)
    return result
  }

  if (ready.length === 0) {
    sink.emit({ phase: 'done', done: 0, bytesFreed: 0, current: '' }, true)
    return result
  }

  // 一次 PowerShell 删一批（并发 2）——实测比「每目录一次进程」快 3.7×。
  // onItem 在**进程结束前**就会逐条回调，所以进度是随删除推进的。
  const outcomes = await sendManyToRecycleBin(
    ready.map((item) => item.dir),
    {
      workers: Number.isFinite(options?.workers) ? Number(options.workers) : 2,
      // permanent 在这里透传给 PowerShell 层：true 时走 Remove-Item，逐条
      // 判定标记从 OK 变 PURGED。默认 false，回收站行为一字未变。
      permanent,
      onItem: (index, outcome) => {
        const item = ready[index]
        done += 1
        if (outcome?.ok === true && item) bytesFreed += item.size
        tick('delete', item?.sessionId ?? '')
      },
    },
  )

  // 结果按**入参顺序**回填：批处理的完成顺序是乱的，而 `deleted` 列表的
  // 顺序是调用方（和日志）用来对账的，不能跟着进程调度变。
  // 失败原因按模式区分：永久删除失败写 purge-failed，回收站失败写
  // recycle-failed —— 日志里「recycle-failed」出现在一次永久删除中会误导排查。
  const failLabel = permanent ? 'purge-failed' : 'recycle-failed'
  for (let index = 0; index < ready.length; index += 1) {
    const item = ready[index]
    const outcome = outcomes[index] ?? { ok: false, reason: 'no-outcome' }
    if (outcome.ok === true) {
      result.deleted.push(item.sessionId)
      result.bytesFreed += item.size
      if (outcome.purged === true) result.purged += 1
      continue
    }

    // 🔴 永久模式下**禁用** quarantine 兜底：兜底是 rename 到一个 quarantine
    // 目录，在「送回收站」语义下它是可恢复的次优解，但在「永久删除」语义下
    // 它会让调用方拿到一个 ok 结果却仍有数据留在盘上——等于用改名假装删掉。
    // 所以永久模式失败一律落 failures，让用户看到真实失败。
    if (quarantineFallback && !permanent) {
      // Rename to a sibling quarantine directory: same volume, recoverable by
      // hand, and — unlike `rm -rf` — impossible to do by accident.
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const target = join(dirname(root), `snapshot_quarantine_${stamp}`, `${item.sessionId}-${SNAPSHOT_DIRNAME}`)
      try {
        mkdirSync(dirname(target), { recursive: true })
        renameSync(item.dir, target)
        result.deleted.push(item.sessionId)
        result.bytesFreed += item.size
        result.skipped.push({ sessionId: item.sessionId, reason: `quarantined-instead-of-recycled:${outcome.reason}` })
        continue
      } catch (error) {
        result.failures.push({
          sessionId: item.sessionId,
          dir: item.dir,
          reason: `${failLabel}:${outcome.reason};quarantine-failed:${String(error?.message ?? error)}`,
        })
        continue
      }
    }

    result.failures.push({ sessionId: item.sessionId, dir: item.dir, reason: `${failLabel}:${outcome.reason}` })
  }

  sink.emit({ phase: 'done', done: ready.length, bytesFreed: result.bytesFreed, current: '' }, true)
  return result
}

/**
 * 进度回调的节流器（默认 150ms）。
 *
 * 三条纪律：①第一条（done=0）与最后一条（done=total）**必定发出**，中间按
 * 时间节流——否则 500 个会话会把 HTTP 响应冲成几千行；②回调抛异常绝不能
 * 影响删除本身；③不挂任何 timer/interval，纯靠调用时刻判断，所以没有需要
 * 清理的句柄（这个文件明确不做定时扫描，也不应留下定时器）。
 */
function makeProgressSink(options, totals) {
  const callback = typeof options?.onProgress === 'function' ? options.onProgress : null
  const throttleMs = Number.isFinite(options?.progressThrottleMs) && options.progressThrottleMs >= 0
    ? Number(options.progressThrottleMs)
    : 150
  let lastAt = 0
  let lastDone = -1
  return {
    emit(payload, force) {
      if (!callback) return
      const total = Number(totals.total) || 0
      const done = Number(payload.done) || 0
      const isFinal = done >= total
      if (force !== true && !isFinal) {
        const now = Date.now()
        if (now - lastAt < throttleMs) return
        if (done === lastDone) return
        lastAt = now
      } else {
        lastAt = Date.now()
      }
      lastDone = done
      try {
        callback({
          phase: String(payload.phase ?? 'delete'),
          done,
          total,
          bytesFreed: Number(payload.bytesFreed) || 0,
          bytesTotal: Number(totals.bytesTotal) || 0,
          current: String(payload.current ?? ''),
        })
      } catch {
        // 进度是装饰，删不删得掉不取决于它。
      }
    },
  }
}

/** Exported for the probe suite; not part of the plugin contract. */
export const __internals = {
  bareId,
  normPath,
  isPathInside,
  resolveSessionsRoot,
  resolveProjCacheRoot,
  listCandidateDirs,
  measureLedger,
  titleFromCache,
  // 0.30.0 — the age half of the cache read. Exported so the probe can pin the
  // "unknown age is null, never 0" rule directly; a zero would silently dodge
  // any inactivity threshold.
  metaFromCache,
  // 0.40.x — the memo behind `metaFromCache`. Exported so a probe can prove the
  // cache actually hits (hits > 0 on the second scan) instead of trusting a
  // faster wall clock, and can assert the bound instead of eyeballing it.
  metaCache,
  metaCacheStats,
  META_CACHE_MAX,
  mapLimit,
  countLines,
  countOccurrences,
  manifestTimeRange,
  inflight,
  CONCURRENCY,
}

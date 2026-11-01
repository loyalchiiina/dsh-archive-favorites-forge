// End-to-end probe for the snapshot ledger half of the "snapshot usage" feature
// (0.29.0): the read-only measurement, and the manual delete that must never
// fire on its own.
//
// WHY THIS EXISTS: `test/probe-client.mjs` proves the CLIENT contract (the card
// renders idle, one press = one scan, the confirm step is two-stage). It cannot
// prove what the HOST does to bytes on disk. Two claims need real bytes:
//   1. the measurement is accurate — bytes, blob count, row count, skip count,
//      and the first/last snapshot timestamps all come out of the ledger;
//   2. the delete is guarded — it defaults to a dry run, it refuses anything
//      that is not a `history-file` directory strictly inside the sessions root,
//      it refuses symlinks, and a real delete only removes the ledgers that were
//      asked for.
// It also pins the product decision the maintainer made twice: NOTHING here may
// schedule itself. No timer, no ceiling, no age policy — a scan only ever runs
// because someone called it.
//
// It runs against an ISOLATED fake DSH home via the same `DSH_AFF_*` overrides
// the other probes use, so it can never read or write the developer's real
// sessions tree. Everything it creates is deleted on the way out.
//
// Run: node test/probe-snapshot-usage.mjs

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; failures.push(label + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : '')) }
}

// ---------------------------------------------------------------------------
// Isolated fake home
// ---------------------------------------------------------------------------

const root = join(here, '..', '.probe-snapshot-usage')
rmSync(root, { recursive: true, force: true })
const sessions = join(root, 'sessions')
const projCache = join(root, 'projcache')

process.env.DSH_AFF_SESSIONS_ROOT = sessions
process.env.DSH_AFF_PROJCACHE_ROOT = projCache
process.env.DSH_AFF_STATE_ROOT = join(root, 'state')

const usage = await import('../lib/snapshot-usage.js')
const { scanSnapshotUsage, cleanupSnapshotUsage, SNAPSHOT_USAGE_VERSION, __internals } = usage

// ---------------------------------------------------------------------------
// Fixtures: two ledgers, deliberately different shapes
// ---------------------------------------------------------------------------

const projectDir = join(sessions, '-probe-project')

/** Build `<project>/<session>/history-file/{manifest.jsonl,blobs/<sha>}`. */
function makeLedger(sessionName, rows, blobBytes) {
  const sessionDir = join(projectDir, sessionName)
  const ledger = join(sessionDir, 'history-file')
  const blobs = join(ledger, 'blobs')
  mkdirSync(blobs, { recursive: true })

  const lines = []
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i]
    if (row.blob !== null) writeFileSync(join(blobs, row.blob), Buffer.alloc(blobBytes, 0x61))
    lines.push(JSON.stringify({
      seq: 100 + i,
      turn: i + 1,
      time: row.time,
      tool: 'write',
      path: 'C:\\probe\\file-' + i + '.txt',
      blob: row.blob,
    }))
  }
  const manifest = lines.join('\n') + '\n'
  writeFileSync(join(ledger, 'manifest.jsonl'), manifest, 'utf8')

  let blobTotal = 0
  for (const row of rows) if (row.blob !== null) blobTotal += blobBytes
  return { sessionDir, ledger, manifestBytes: Buffer.byteLength(manifest, 'utf8'), blobBytes: blobTotal }
}

const T0 = 1793264117719
const T1 = 1793264509287
const T2 = 1793264521739

const big = makeLedger('session-big', [
  { time: T0, blob: 'aaaa' },
  { time: T1, blob: 'bbbb' },
  { time: T2, blob: null },
], 4096)

const small = makeLedger('session-small', [
  { time: T1, blob: 'cccc' },
], 512)

// A session directory that never wrote a file: the ledger must not appear.
mkdirSync(join(projectDir, 'session-empty'), { recursive: true })

// A title for one session only, so the cache lookup is proven to be optional.
mkdirSync(projCache, { recursive: true })
writeFileSync(join(projCache, 'session-big.json'), JSON.stringify({
  version: 7,
  record: { identity: { formatVersion: 4, createdAt: 1, cwd: 'C:\\probe' }, rows: { title: { val: 'Big chat' } } },
}), 'utf8')

// ---------------------------------------------------------------------------
// 1. Measurement
// ---------------------------------------------------------------------------

console.log('\n--- scan ---')

const report = await scanSnapshotUsage({ shared: false })
ok('scan reports ok', report.ok === true, JSON.stringify(report.detail ?? ''))
ok('scan finds exactly the two sessions that own a ledger', report.summary.sessions === 2, String(report.summary.sessions))
ok('scan exposes an elapsed time for the UI', typeof report.elapsedMs === 'number' && report.elapsedMs >= 0)

const byId = new Map(report.entries.map((entry) => [entry.sessionId, entry]))
const bigEntry = byId.get('session-big')
const smallEntry = byId.get('session-small')
ok('the big ledger is listed', bigEntry !== undefined)
ok('the small ledger is listed', smallEntry !== undefined)
ok('a session with no ledger is not listed', byId.get('session-empty') === undefined)

ok('bytes = blob bytes + manifest bytes', bigEntry.bytes === big.blobBytes + big.manifestBytes,
  `got ${bigEntry.bytes}, want ${big.blobBytes + big.manifestBytes}`)
ok('blob bytes are summed from the blobs directory', bigEntry.blobBytes === big.blobBytes, String(bigEntry.blobBytes))
ok('manifest bytes are counted, not ignored', bigEntry.manifestBytes === big.manifestBytes, String(bigEntry.manifestBytes))
ok('blob count is the number of files under blobs/', bigEntry.blobCount === 2, String(bigEntry.blobCount))
ok('row count counts every manifest line', bigEntry.entryCount === 3, String(bigEntry.entryCount))
ok('a row with blob:null counts as skipped', bigEntry.skippedCount === 1, String(bigEntry.skippedCount))
ok('first snapshot timestamp comes from the first manifest row', bigEntry.firstSnapshotAt === T0, String(bigEntry.firstSnapshotAt))
ok('last snapshot timestamp comes from the last manifest row', bigEntry.lastSnapshotAt === T2, String(bigEntry.lastSnapshotAt))
ok('the ledger directory path is reported', bigEntry.dir === big.ledger, bigEntry.dir)

ok('the project name is reported', bigEntry.projectName === '-probe-project', bigEntry.projectName)
ok('a cached title is picked up', bigEntry.title === 'Big chat', JSON.stringify(bigEntry.title))
ok('a session with no cache entry still measures', smallEntry.bytes === small.blobBytes + small.manifestBytes, String(smallEntry.bytes))
ok('a session with no cache entry has an empty title', smallEntry.title === '', JSON.stringify(smallEntry.title))

ok('entries are sorted biggest first', report.entries[0].sessionId === 'session-big',
  report.entries.map((e) => e.sessionId).join(','))
ok('the summary names the largest session', report.summary.largest.sessionId === 'session-big')
ok('the summary largest carries the title', report.summary.largest.title === 'Big chat')

const sumBytes = report.entries.reduce((total, entry) => total + entry.bytes, 0)
ok('summary totalBytes equals the sum of entries', report.summary.totalBytes === sumBytes,
  `${report.summary.totalBytes} vs ${sumBytes}`)
ok('summary totalBlobs equals the sum of entries', report.summary.totalBlobs === 3, String(report.summary.totalBlobs))
ok('summary totalEntries equals the sum of entries', report.summary.totalEntries === 4, String(report.summary.totalEntries))

// ---------------------------------------------------------------------------
// 2. The scan never runs by itself
// ---------------------------------------------------------------------------

console.log('\n--- manual only ---')

const usageSource = readFileSync(join(here, '..', 'lib', 'snapshot-usage.js'), 'utf8')
ok('the module owns no timer', !/setInterval\s*\(/.test(usageSource))
ok('the module never schedules a scan', !/setTimeout\s*\(/.test(usageSource))
ok('there is no age-based policy', !/retentionDays|maxAgeDays|pruneOlderThan/.test(usageSource))
ok('there is no size ceiling that deletes', !/maxBytesPerSession|quotaBytes/.test(usageSource))

const indexSource = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
const snapshotRoutes = (indexSource.match(/\/snapshot-(usage|cleanup)/g) ?? []).length
ok('the host exposes both snapshot routes', snapshotRoutes >= 4, String(snapshotRoutes))
ok('the host wires no timer onto the snapshot routes',
  !/setInterval[^\n]*snapshot/i.test(indexSource) && !/snapshot[^\n]*setInterval/i.test(indexSource))

// Scanning twice in a row must be cheap and must not mutate anything.
const before = readdirSync(big.ledger).sort().join(',')
const again = await scanSnapshotUsage({ shared: false })
ok('a second scan returns the same numbers', again.summary.totalBytes === report.summary.totalBytes)
ok('scanning does not touch the ledger', readdirSync(big.ledger).sort().join(',') === before)

// `shared` collapses concurrent callers onto one pass.
const [a, b] = await Promise.all([scanSnapshotUsage({}), scanSnapshotUsage({})])
ok('concurrent scans share one pass', a === b)
ok('the in-flight key is released when the scan finishes', __internals.inflight.size === 0,
  String(__internals.inflight.size))

// ---------------------------------------------------------------------------
// 3. Cleanup defaults to a dry run
// ---------------------------------------------------------------------------

console.log('\n--- cleanup guards ---')

const empty = await cleanupSnapshotUsage([], {})
ok('an empty plan is a no-op', empty.deleted.length === 0 && empty.dryRun === true)

const plan = [bigEntry, smallEntry]
const dry = await cleanupSnapshotUsage(plan, {})
ok('cleanup is a dry run by default', dry.dryRun === true, String(dry.dryRun))
ok('a dry run lists both sessions as deletable', dry.deleted.length === 2, JSON.stringify(dry.deleted))
ok('a dry run reports the bytes it would free', dry.bytesFreed === bigEntry.bytes + smallEntry.bytes, String(dry.bytesFreed))
ok('a dry run leaves the big ledger on disk', existsSync(big.ledger))
ok('a dry run leaves the small ledger on disk', existsSync(small.ledger))

const guarded = await cleanupSnapshotUsage([
  { sessionId: 'escape', dir: join(root, 'outside', 'history-file'), bytes: 1 },
  { sessionId: 'wrong-leaf', dir: join(projectDir, 'session-big'), bytes: 1 },
  { sessionId: 'root-itself', dir: sessions, bytes: 1 },
], { dryRun: false })
ok('a directory outside the sessions root is refused',
  guarded.failures.some((f) => f.reason === 'outside-sessions-root'), JSON.stringify(guarded.failures))
ok('a directory whose last segment is not history-file is refused',
  guarded.failures.some((f) => f.reason === 'not-a-history-file-dir'), JSON.stringify(guarded.failures))
ok('the sessions root itself is refused (strict containment)',
  guarded.failures.some((f) => f.sessionId === 'root-itself'), JSON.stringify(guarded.failures))
ok('the guarded pass deleted nothing', guarded.deleted.length === 0, JSON.stringify(guarded.deleted))
ok('the guarded pass destroyed nothing', existsSync(big.ledger) && existsSync(small.ledger))

const missing = await cleanupSnapshotUsage([{ sessionId: 'gone', dir: join(projectDir, 'gone', 'history-file'), bytes: 1 }], { dryRun: false })
ok('a stale plan entry is skipped, not failed',
  missing.skipped.some((s) => String(s.reason).startsWith('not-found')), JSON.stringify(missing))

// A symlink inside the tree must not be followed.
let symlinked = false
try {
  const linkDir = join(projectDir, 'session-link')
  mkdirSync(linkDir, { recursive: true })
  symlinkSync(big.ledger, join(linkDir, 'history-file'), 'junction')
  symlinked = true
} catch { symlinked = false }
if (symlinked) {
  const linkResult = await cleanupSnapshotUsage([{ sessionId: 'session-link', dir: join(projectDir, 'session-link', 'history-file'), bytes: 1 }], { dryRun: false })
  ok('a symlinked ledger is refused',
    linkResult.failures.some((f) => f.reason === 'refused-symlink'), JSON.stringify(linkResult))
  ok('the symlink target survives', existsSync(big.ledger))
}

// ---------------------------------------------------------------------------
// 4. A real cleanup deletes exactly what it was asked for
// ---------------------------------------------------------------------------

console.log('\n--- real cleanup ---')

const live = await cleanupSnapshotUsage([bigEntry], { dryRun: false })
ok('a confirmed cleanup reports itself as live', live.dryRun === false)
ok('a confirmed cleanup deletes the requested ledger', live.deleted.includes('session-big'), JSON.stringify(live))
ok('the requested ledger is gone', !existsSync(big.ledger), big.ledger)
ok('the untouched ledger is still there', existsSync(small.ledger), small.ledger)
ok('the session directory itself survives', existsSync(big.sessionDir), big.sessionDir)
ok('the bytes freed match the measurement', live.bytesFreed === bigEntry.bytes, String(live.bytesFreed))

const after = await scanSnapshotUsage({ shared: false })
ok('a re-scan no longer sees the deleted ledger', after.summary.sessions === 1, String(after.summary.sessions))
ok('the surviving ledger still measures correctly', after.entries[0].bytes === small.blobBytes + small.manifestBytes)

// ---------------------------------------------------------------------------
// 5. Contract surface
// ---------------------------------------------------------------------------

console.log('\n--- contract ---')

const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))
ok('the module is versioned', typeof SNAPSHOT_USAGE_VERSION === 'string' && SNAPSHOT_USAGE_VERSION.length > 0)
ok('the module is exported through the host', typeof (await import('../lib/index.js')).__internals.scanSnapshotUsage === 'function')
ok('cleanup is exported through the host', typeof (await import('../lib/index.js')).__internals.cleanupSnapshotUsage === 'function')
ok('the package ships snapshot-usage.js', pkg.files.includes('lib/*.js'), JSON.stringify(pkg.files))

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n=== summary ===')
console.log('  pass: ' + pass)
console.log('  fail: ' + fail)
rmSync(root, { recursive: true, force: true })
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const failure of failures) console.log('  - ' + failure)
  process.exit(1)
}
console.log('\nALL GREEN\n')

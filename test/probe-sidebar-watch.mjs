// End-to-end probe for the 0.34.0 sidebar-archive watch.
//
// WHY THIS EXISTS: the 0.33.0 switch only fired from this plugin's own
// `/idle-archive` route. The feature users actually asked for is 归档 from the
// harness sidebar, and that path runs entirely inside
// `@deepseek-ai/dsh-workspace` — nothing in this repo can be poked with a
// request to prove it works. The seam that DOES exist is `domain/changed`, and
// `handleWorkspaceArchiveChange()` is that seam made callable, so it is tested
// here against real bytes on disk.
//
// Runs against an isolated fake DSH home via the `DSH_AFF_*` overrides, so it
// can never read or write the developer's real sessions tree.
//
// Run: node test/probe-sidebar-watch.mjs

import { mkdirSync, writeFileSync, existsSync, rmSync, readFileSync } from 'node:fs'
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

const root = join(here, '..', '.probe-sidebar-watch')
rmSync(root, { recursive: true, force: true })
const sessions = join(root, 'sessions')
const storages = join(root, 'storages')
mkdirSync(storages, { recursive: true })

const cwdOne = 'C:\\probe\\sidebar-watch-one'
const cwdTwo = 'C:\\probe\\sidebar-watch-two'
const firstId = 'session-11111111-1111-1111-1111-111111111111'
const secondId = 'session-22222222-2222-2222-2222-222222222222'
const thirdId = 'session-33333333-3333-3333-3333-333333333333'

process.env.DSH_AFF_SESSIONS_ROOT = sessions
process.env.DSH_AFF_STATE_ROOT = join(root, 'state')
process.env.DSH_AFF_WORKSPACE_FILE = join(storages, 'workspace.json')

const host = await import('../lib/index.js')
const internals = host.__internals

// A fake logger so the "switch is off" path can be asserted without noise.
const lines = []
const ctx = {
  logger: {
    info: (message) => { lines.push(['info', message]) },
    warn: (message) => { lines.push(['warn', message]) },
    error: (message) => { lines.push(['error', message]) },
  },
}

const projectOne = join(sessions, internals.projectDirName(cwdOne))
const projectTwo = join(sessions, internals.projectDirName(cwdTwo))

function makeSession(dir, logName) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, logName), [
    JSON.stringify({ kind: 'header', version: 4, cwd: dir === projectOne ? cwdOne : cwdTwo }),
    JSON.stringify({ seq: 1, type: 'user/message', text: 'hi' }),
  ].join('\n') + '\n', 'utf8')
}

const firstDir = join(projectOne, internals.bareId(firstId))
const secondDir = join(projectOne, internals.bareId(secondId))
const thirdDir = join(projectTwo, internals.bareId(thirdId))
makeSession(firstDir, 'session.v4.jsonl')
makeSession(secondDir, 'session.v4.jsonl')
makeSession(thirdDir, 'session.v4.jsonl')

/** Write a realistic ledger: one manifest line, one blob. */
function plantLedger(sessionDir, tag) {
  const history = join(sessionDir, 'history-file')
  const blobs = join(history, 'blobs')
  mkdirSync(blobs, { recursive: true })
  const body = 'pre-edit bytes for ' + tag
  writeFileSync(join(blobs, 'a'.repeat(64)), body, 'utf8')
  writeFileSync(join(history, 'manifest.jsonl'), JSON.stringify({
    seq: 7, turn: 2, time: Date.now(), tool: 'edit', path: 'C:\\probe\\' + tag + '.txt', blob: 'a'.repeat(64),
  }) + '\n', 'utf8')
  return history
}

const firstLedger = plantLedger(firstDir, 'first')
const secondLedger = plantLedger(secondDir, 'second')
const thirdLedger = plantLedger(thirdDir, 'third')

/** One `domain/changed` payload exactly like the storage domain emits. */
function change(archivedSessionIds, extra = {}) {
  return {
    domain: 'workspace',
    table: '',
    key: '',
    operation: 'put',
    value: {
      initialized: true,
      workspaceIds: ['ws-1', 'ws-2'],
      archivedSessionIds: archivedSessionIds === null ? undefined : archivedSessionIds,
      pinnedSessionIds: [],
    },
    ...extra,
  }
}

console.log('\n=== payload shape ===\n')

ok('a payload from another domain is ignored', internals.archivedIdsFromChange(change([firstId], { domain: 'session' })) === null)
ok('a table row (not the global record) is ignored', internals.archivedIdsFromChange(change([firstId], { table: 'workspaces' })) === null)
ok('a deleted operation is ignored', internals.archivedIdsFromChange(change([firstId], { operation: 'deleted' })) === null)
ok('a null change is ignored', internals.archivedIdsFromChange(null) === null)
ok('a missing archivedSessionIds reads as an empty set', Array.isArray(internals.archivedIdsFromChange(change(null))))
ok('ids are stringified', JSON.stringify(internals.archivedIdsFromChange(change([1, 2]))) === '["1","2"]')

console.log('\n=== first event only seeds a baseline ===\n')

internals.resetArchiveWatchSeed()
const seeded = await internals.handleWorkspaceArchiveChange(change([firstId]), ctx)
ok('the first observation seeds instead of purging', seeded.action === 'seeded', JSON.stringify(seeded))
ok('seeding keeps the existing ledger', existsSync(firstLedger))
ok('seeding does not log a purge', !lines.some(([, m]) => /purge/.test(m)))

console.log('\n=== switch OFF: a new archive changes nothing ===\n')

// Default policy file is absent → OFF.
const off = await internals.handleWorkspaceArchiveChange(change([firstId, secondId]), ctx)
ok('with the switch off the watch reports disabled', off.action === 'disabled', JSON.stringify(off))
ok('with the switch off the new ledger survives', existsSync(secondLedger))
ok('with the switch off the log says why', lines.some(([level, m]) => level === 'info' && /purge switch is OFF/.test(m)))

console.log('\n=== switch ON: the newly archived session loses its ledger ===\n')

internals.writeArchivePurgePolicy({ enabled: true })
ok('the policy persisting round-trip reads back on', internals.readArchivePurgePolicy().enabled === true)

const on = await internals.handleWorkspaceArchiveChange(change([firstId, secondId, thirdId]), ctx)
ok('with the switch on the watch purges', on.action === 'purged', JSON.stringify(on).slice(0, 200))
ok('the newly archived ledger is gone', !existsSync(thirdLedger))
// second was archived while the switch was OFF. Purging it now would be a
// retroactive sweep of something the user archived under a different setting.
ok('a ledger archived while the switch was OFF is left alone', existsSync(secondLedger))
ok('the session directory itself survives', existsSync(secondDir))
ok('the session log survives (only the ledger moves)', existsSync(join(secondDir, 'session.v4.jsonl')))
ok('it reports only the sessions this event archived', Array.isArray(on.fresh) && on.fresh.length === 1 && on.fresh[0] === thirdId, JSON.stringify(on.fresh))
ok('it reports the bytes freed', typeof on.bytesFreed === 'number', String(on.bytesFreed))
ok('its log line names the sidebar path', lines.some(([, m]) => /sidebar archive purge/.test(m)))

console.log('\n=== un-archiving is NOT a purge trigger ===\n')

const shrink = await internals.handleWorkspaceArchiveChange(change([firstId]), ctx)
ok('removing ids from the archive set purges nothing', shrink.action === 'no-change', JSON.stringify(shrink))
ok('the surviving ledger is untouched', existsSync(firstLedger))

console.log('\n=== re-archiving the same session after removal does fire again ===\n')

const again = await internals.handleWorkspaceArchiveChange(change([firstId, secondId]), ctx)
ok('re-adding the id is a fresh archive, so it purges again', again.action === 'purged', JSON.stringify(again).slice(0, 200))
ok('the re-archived ledger is gone', !existsSync(secondLedger))

console.log('\n=== this plugin\'s own archive never double-purges ===\n')

internals.resetArchiveWatchSeed()
internals.writeArchivePurgePolicy({ enabled: true })
// A ledger for a session this plugin is about to "archive itself".
const fourthId = 'session-44444444-4444-4444-4444-444444444444'
const fourthDir = join(projectOne, internals.bareId(fourthId))
makeSession(fourthDir, 'session.v4.jsonl')
const fourthLedger = plantLedger(fourthDir, 'fourth')

// Seed, then mark it as self-archived before the watch sees it.
await internals.handleWorkspaceArchiveChange(change([firstId]), ctx)
internals.noteSelfArchived(fourthId)
const selfResult = await internals.handleWorkspaceArchiveChange(change([firstId, fourthId]), ctx)
const selfEntry = (selfResult.results ?? []).find((entry) => internals.bareId(entry.sessionId) === internals.bareId(fourthId))
ok('a self-archived id is recognised', selfEntry === undefined || selfEntry.skipped === 'archived-by-this-plugin', JSON.stringify(selfEntry))

console.log('\n=== guards ===\n')

internals.writeArchivePurgePolicy({ enabled: true })
// Hold the baseline at [firstId] so the unknown id below counts as fresh.
await internals.handleWorkspaceArchiveChange(change([firstId]), ctx)
const missing = await internals.handleWorkspaceArchiveChange(change([firstId, 'session-99999999-9999-9999-9999-999999999999']), ctx)
ok('an unknown session is reported, not thrown', missing.action === 'purged', JSON.stringify(missing).slice(0, 160))
ok('the unknown session surfaces as a failure entry', (missing.results ?? []).some((entry) => (entry.failures ?? []).some((f) => /session-directory-missing|resolve-failed/.test(String(f.reason)))), JSON.stringify(missing.results ?? []))
ok('the plugin exports the watch seams', typeof internals.handleWorkspaceArchiveChange === 'function' && typeof internals.resetArchiveWatchSeed === 'function')
ok('the host source installs the watch inside a ctx.effect', /ctx\.effect\(\(\) => installArchiveWatch\(ctx\)/.test(readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')))


// ---------------------------------------------------------------------------
// Startup baseline (seedArchiveWatch)
//
// Seeding on the first event is safe but lossy: that event becomes the
// baseline, so the archive that produced it is never examined. A live test
// caught exactly that — the user archived one conversation right after a
// restart, the switch was on, and nothing happened. These checks pin the fix.
// ---------------------------------------------------------------------------

function fakeCtx(replies) {
  const log = []
  let index = 0
  const ctx = {
    logger: {
      info: (message) => { log.push(['info', message]) },
      warn: (message) => { log.push(['warn', message]) },
      error: (message) => { log.push(['error', message]) },
    },
    get: () => {
      const reply = replies[Math.min(index, replies.length - 1)]
      index += 1
      // A function reply models a getter that THROWS (the "not started yet"
      // window); anything else is returned as the registry object itself.
      return typeof reply === 'function' ? reply() : reply
    },
  }
  return { ctx, log }
}

{
  internals.resetArchiveWatchSeed()
  const ready = fakeCtx([{ archivedSessionIds: [firstId, secondId] }])
  const armed = await internals.seedArchiveWatch(ready.ctx, 3, 1)
  ok('a readable registry arms the baseline at load time', armed === 2, String(armed))
  ok('arming is logged once', ready.log.some(([level, m]) => level === 'info' && /baseline of 2 archived/.test(m)))

  // With the baseline already armed, the very first event must be treated as a
  // real archive — this is the exact sequence the live test performed.
  const fifthId = 'session-55555555-5555-5555-5555-555555555555'
  const fifthDir = join(projectOne, internals.bareId(fifthId))
  makeSession(fifthDir, 'session.v4.jsonl')
  const fifthLedger = plantLedger(fifthDir, 'fifth')
  internals.writeArchivePurgePolicy({ enabled: true })
  const firstAfterRestart = await internals.handleWorkspaceArchiveChange(
    change([firstId, secondId, fifthId]),
    ready.ctx,
  )
  ok(
    'the first archive after a restart is purged, not swallowed as a baseline',
    firstAfterRestart.action === 'purged',
    JSON.stringify(firstAfterRestart).slice(0, 200),
  )
  ok('that first archive really lost its ledger', !existsSync(fifthLedger))
}

{
  // The registry exists long before it is usable. "not started yet" must be
  // retried, not treated as a hard failure.
  internals.resetArchiveWatchSeed()
  const starting = fakeCtx([
    () => { throw new Error('workspace registry is not started yet') },
    () => { throw new Error('workspace registry is not started yet') },
    { archivedSessionIds: [firstId] },
  ])
  const slow = await internals.seedArchiveWatch(starting.ctx, 5, 1)
  ok('a registry that is still starting is retried until readable', slow === 1, String(slow))
}

{
  // Degraded but safe: no baseline means the first-event path still applies.
  internals.resetArchiveWatchSeed()
  const broken = fakeCtx([null])
  const gaveUp = await internals.seedArchiveWatch(broken.ctx, 2, 1)
  ok('an unreadable registry leaves the baseline unset', gaveUp === null, String(gaveUp))
  const seededLater = await internals.handleWorkspaceArchiveChange(change([firstId]), broken.ctx)
  ok('without a baseline the first event falls back to seeding', seededLater.action === 'seeded')
}

{
  internals.resetArchiveWatchSeed()
  const crashing = fakeCtx([() => { throw new Error('storage exploded') }])
  const warned = await internals.seedArchiveWatch(crashing.ctx, 2, 1)
  ok('a non-transient registry error is reported, not retried forever', warned === null, String(warned))
  ok('that error reaches the log as a warning', crashing.log.some(([level, m]) => level === 'warn' && /could not arm/.test(m)))
}

ok('the plugin exports the startup seed seam', typeof internals.seedArchiveWatch === 'function')
ok(
  'the host source arms the baseline inside a ctx.effect',
  /ctx\.effect\(\(\) => seedArchiveWatch|seedArchiveWatch\(ctx\)/.test(readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')),
)
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

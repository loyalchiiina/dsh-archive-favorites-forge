// Probe: does EVERY deletion path take the snapshot ledger with it?
//
// WHY THIS EXISTS: the ledger lives at `<session dir>/history-file/`, so the
// claim "deleting a conversation always deletes its snapshots" is a claim about
// directory structure, not about a switch. That is exactly the kind of claim
// that silently rots — move the ledger, change the delete to a file-level unlink,
// and nothing fails. So it is tested against bytes on disk.
//
// It also pins the one asymmetry that matters: ARCHIVE is a registry operation
// and must leave both the transcript and the ledger alone.
//
// Isolated fake home via the DSH_AFF_* overrides, so the real sessions tree is
// never touched. Everything created here is removed on the way out.
//
// Run: node test/probe-delete-ledger.mjs

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) {
    pass += 1
    console.log('  PASS  ' + label)
  } else {
    fail += 1
    failures.push(label + (detail ? ' :: ' + detail : ''))
    console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : ''))
  }
}

// ---------------------------------------------------------------------------
// Isolated fake home
// ---------------------------------------------------------------------------

const root = join(here, '..', '.probe-delete-ledger')
rmSync(root, { recursive: true, force: true })
const sessions = join(root, 'sessions')
const storages = join(root, 'storages')
mkdirSync(storages, { recursive: true })

const cwd = 'C:\\probe\\delete-ledger'
const doomed = 'session-11111111-1111-1111-1111-111111111111'
const kept = 'session-22222222-2222-2222-2222-222222222222'
const favourited = 'session-33333333-3333-3333-3333-333333333333'

process.env.DSH_AFF_SESSIONS_ROOT = sessions
process.env.DSH_AFF_STATE_ROOT = join(root, 'state')
process.env.DSH_AFF_WORKSPACE_FILE = join(storages, 'workspace.json')

const host = await import('../lib/index.js')
const { projectDirName, bareId, handleDelete, fileHistoryDir, writeState } = host.__internals

const projectDir = join(sessions, projectDirName(cwd))

writeFileSync(
  join(storages, 'workspace.json'),
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [kept] },
    tables: {
      workspaces: {
        'ws-1': {
          path: cwd,
          title: 'delete-ledger probe',
          sessionIds: [doomed, kept, favourited],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }),
  'utf8',
)

writeState({ favorites: { [favourited]: { at: 1, title: 'keep me' } }, archived: [] })

/** Build a real-shaped session directory: transcript + ledger with one blob. */
function plantLedger(sessionId) {
  const dir = join(projectDir, bareId(sessionId))
  mkdirSync(join(dir, 'history-file', 'blobs'), { recursive: true })
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), Buffer.from('not-a-real-log', 'utf8'))
  writeFileSync(
    join(dir, 'history-file', 'manifest.jsonl'),
    JSON.stringify({ seq: 1, turn: 1, time: 1793439312641, tool: 'write', path: join(root, 'a.txt'), blob: null }) + '\n',
    'utf8',
  )
  writeFileSync(join(dir, 'history-file', 'blobs', 'a'.repeat(64)), 'pre-edit bytes', 'utf8')
  return dir
}

const doomedDir = plantLedger(doomed)
const keptDir = plantLedger(kept)
const favDir = plantLedger(favourited)

// ---------------------------------------------------------------------------
// A. The ledger really is inside the session directory
// ---------------------------------------------------------------------------

console.log('\n=== the ledger is a child of the session directory ===\n')

{
  const resolved = await fileHistoryDir(doomed, undefined)
  ok('fileHistoryDir resolves to <session dir>/history-file',
    resolved === join(doomedDir, 'history-file'),
    String(resolved))
  ok('the ledger sits strictly inside the session directory',
    resolved.startsWith(doomedDir + require$sep()),
    resolved)
  ok('the transcript and the ledger are siblings',
    existsSync(join(doomedDir, 'session.v4.jsonl.zstd')) && existsSync(join(doomedDir, 'history-file')))
}

function require$sep() {
  return process.platform === 'win32' ? '\\' : '/'
}

// ---------------------------------------------------------------------------
// B. Deleting a conversation takes the ledger with it
// ---------------------------------------------------------------------------

console.log('\n=== handleDelete removes the whole session directory ===\n')

{
  const result = await handleDelete({ sessionIds: [doomed] }, undefined, {})
  ok('the delete reports the session as deleted',
    Array.isArray(result.deleted) && result.deleted.includes(doomed),
    JSON.stringify(result.deleted))
  ok('the session directory is gone', !existsSync(doomedDir))
  ok('the ledger is gone with it', !existsSync(join(doomedDir, 'history-file')))
  ok('no orphan ledger is left behind for that id', !existsSync(join(doomedDir, 'history-file', 'manifest.jsonl')))
}

// ---------------------------------------------------------------------------
// C. A favourite is refused, and refusing means the ledger survives
// ---------------------------------------------------------------------------

console.log('\n=== a favourited conversation is refused and keeps its ledger ===\n')

{
  const result = await handleDelete({ sessionIds: [favourited] }, undefined, {})
  ok('the delete refuses a favourite',
    Array.isArray(result.skipped) && result.skipped.some((s) => s.sessionId === favourited && s.reason === 'favorited'),
    JSON.stringify(result.skipped))
  ok('the favourite directory survived', existsSync(favDir))
  ok('the favourite ledger survived', existsSync(join(favDir, 'history-file', 'manifest.jsonl')))
}

// ---------------------------------------------------------------------------
// D. Archiving is NOT a delete — it must leave the bytes alone
// ---------------------------------------------------------------------------

console.log('\n=== archiving a conversation never removes the ledger ===\n')

{
  // Archiving is a registry write (workspace global record). The plugin's watch
  // only ever touches the ledger when the purge switch is ON, and only for a
  // fresh archive. With the switch explicitly OFF, nothing may disappear.
  host.__internals.writeArchivePurgePolicy({ enabled: false })
  host.__internals.resetArchiveWatchSeed()
  await host.__internals.handleWorkspaceArchiveChange(
    { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [kept] } },
    undefined,
  )
  const outcome = await host.__internals.handleWorkspaceArchiveChange(
    { domain: 'workspace', table: '', key: '', operation: 'put', value: { archivedSessionIds: [kept, favourited] } },
    undefined,
  )
  ok('the archive change is seen but the purge switch is off',
    outcome && outcome.action === 'disabled', JSON.stringify(outcome))
  ok('the archived transcript survives', existsSync(join(keptDir, 'session.v4.jsonl.zstd')))
  ok('the archived ledger survives', existsSync(join(keptDir, 'history-file', 'manifest.jsonl')))
  ok('the archived blob survives', existsSync(join(keptDir, 'history-file', 'blobs', 'a'.repeat(64))))
}

// ---------------------------------------------------------------------------
// E. Every deletion route in the host funnels through handleDelete
// ---------------------------------------------------------------------------

console.log('\n=== both deletion routes delegate to handleDelete ===\n')

{
  const source = readFileSync(join(here, '..', 'lib', 'index.js'), 'utf8')
  const single = source.indexOf("route === '/delete'")
  ok('the single-session menu route exists', single > 0)
  ok('the single-session route delegates to handleDelete',
    /route === '\/delete'[\s\S]{0,400}?handleDelete\(/.test(source))

  const bulk = source.indexOf("route === '/archive-delete'")
  ok('the bulk archive-delete route exists', bulk > 0)
  ok('the bulk route delegates to handleDelete',
    /route === '\/archive-delete'[\s\S]{0,2000}?await handleDelete\(/.test(source))

  const direct = [...source.matchAll(/rm\(sessionDir/g)].length
  ok('exactly one place removes a session directory', direct === 1, 'found ' + direct)
}

// ---------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------

console.log('\n=== summary ===')
console.log('  pass: ' + pass)
console.log('  fail: ' + fail)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
} else {
  console.log('\nALL GREEN')
}

try {
  rmSync(root, { recursive: true, force: true })
} catch {}

process.exit(fail === 0 ? 0 : 1)

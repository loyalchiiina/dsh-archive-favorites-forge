// End-to-end probe for the 0.25.0 file-history half (the "undo rolls back the
// files too" promise).
//
// WHY THIS EXISTS: `test/probe-client.mjs` proves the CLIENT contract, and
// `node --check` proves nothing about behaviour. Neither can answer the only
// question that matters for this feature — "if the assistant rewrites a file and
// I undo that turn, does the file actually come back?" That is a claim about
// bytes on disk, so it is tested against bytes on disk.
//
// It runs against an ISOLATED fake DSH home via the same `DSH_AFF_*` overrides
// the client probe uses, so it can never read or write the developer's real
// sessions tree. Everything it creates is deleted on the way out.
//
// Run: node test/probe-filehistory.mjs

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'

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

const root = join(here, '..', '.probe-filehistory')
rmSync(root, { recursive: true, force: true })
const sessions = join(root, 'sessions')
const storages = join(root, 'storages')
mkdirSync(storages, { recursive: true })

const cwd = 'C:\\probe\\filehistory'
const sessionId = 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'

process.env.DSH_AFF_SESSIONS_ROOT = sessions
process.env.DSH_AFF_STATE_ROOT = join(root, 'state')
process.env.DSH_AFF_WORKSPACE_FILE = join(storages, 'workspace.json')

const host = await import('../lib/index.js')
const { projectDirName, bareId } = host.__internals

const projectDir = join(sessions, projectDirName(cwd))
const sessionDir = join(projectDir, bareId(sessionId))
mkdirSync(sessionDir, { recursive: true })

writeFileSync(join(storages, 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [sessionId] },
  tables: {
    workspaces: {
      'ws-1': {
        path: cwd,
        title: 'filehistory probe',
        sessionIds: [sessionId],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  },
}), 'utf8')

const target = join(root, 'target.txt')
const created = join(root, 'created-later.txt')

// ---------------------------------------------------------------------------
// A real-shaped session log: a header frame, then one zstd frame per event.
//
// 🔴 THE MULTI-FRAME SHAPE IS THE POINT. The app appends a separate frame per
// event; decompressing the concatenation in one call fails, so a decoder that
// "works" on a single-frame fixture would still fail on every real session.
// Building the fixture any other way would test a format nobody writes.
// ---------------------------------------------------------------------------

const events = [
  { type: 'turn/start', seq: 3, data: { turn: 1 } },
  { type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'first ask' }] } },
  { type: 'tool/call', seq: 7, data: { name: 'edit', turn: 1, arguments: { file_path: target, old_string: 'ORIGINAL CONTENT', new_string: 'EDITED BY TURN 1' } } },
  { type: 'turn/start', seq: 20, data: { turn: 2 } },
  { type: 'user/message', seq: 22, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'second ask' }] } },
  { type: 'tool/call', seq: 24, data: { name: 'write', turn: 2, arguments: { file_path: target, content: 'OVERWRITTEN BY TURN 2' } } },
  { type: 'tool/call', seq: 26, data: { name: 'write', turn: 2, arguments: { file_path: created, content: 'brand new' } } },
]

const header = JSON.stringify({ sessionId, cwd, version: 4 })
const frames = [zlib.zstdCompressSync(Buffer.from(header + '\n', 'utf8'))]
for (const event of events) {
  frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
}
writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))

// ---------------------------------------------------------------------------
// A. Log decoding and turn boundaries
// ---------------------------------------------------------------------------

console.log('\n=== log decoding / turn info ===\n')

const decoded = await host.__internals.readSessionEvents(sessionId, undefined)
ok('decodes a multi-frame zstd log and drops the header line',
  Array.isArray(decoded) && decoded.length === events.length,
  decoded === null ? 'null' : String(decoded?.length))
ok('preserves event order',
  decoded?.map((e) => e.type).join(',') === events.map((e) => e.type).join(','),
  decoded?.map((e) => e.type).join(','))

const t1 = await host.__internals.turnInfo(sessionId, 1, undefined)
ok('turn 1 has no prefix, so beforeSeq is null (the caller starts a new session)',
  t1 && t1.beforeSeq === null, JSON.stringify(t1))
ok('turn 1 reports what the user actually typed',
  t1?.userText === 'first ask', JSON.stringify(t1?.userText))

const t2 = await host.__internals.turnInfo(sessionId, 2, undefined)
// 🔴 The boundary is the event BEFORE `turn/start`, i.e. seq 7 — not 20. Cutting
// inside the turn/start..user-message gap leaves the child holding an unclosed
// turn/start, and the fork then invents a completed turn the user never sent.
ok('turn 2 beforeSeq is the event BEFORE turn/start (7, not 20)',
  t2 && t2.beforeSeq === 7, JSON.stringify(t2 && { beforeSeq: t2.beforeSeq }))
ok('turn 2 reports what the user actually typed',
  t2?.userText === 'second ask', JSON.stringify(t2?.userText))
ok('turn 2 lists every file touched after its boundary',
  Array.isArray(t2?.files) && t2.files.includes(target) && t2.files.includes(created),
  JSON.stringify(t2?.files))

const absent = await host.__internals.turnInfo(sessionId, 99, undefined)
ok('a turn that does not exist answers null rather than throwing', absent === null, JSON.stringify(absent))

// ---------------------------------------------------------------------------
// B. The real ordering: announce -> snapshot -> the write lands
//
// `tool/call` is published BEFORE the tool runs. Reproducing that order is what
// makes this a test of the feature instead of a test of a helper: the snapshot
// must capture the PRE-edit bytes, which are only reachable before the write.
// ---------------------------------------------------------------------------

console.log('\n=== snapshots ===\n')

writeFileSync(target, 'ORIGINAL CONTENT\n', 'utf8')
await host.__internals.recordToolCall(sessionId, { type: 'tool/call', seq: 7, time: 'T1', data: events[2].data }, undefined)
writeFileSync(target, 'EDITED BY TURN 1\n', 'utf8')
await host.__internals.recordToolCall(sessionId, { type: 'tool/call', seq: 24, time: 'T2', data: events[5].data }, undefined)
writeFileSync(target, 'OVERWRITTEN BY TURN 2', 'utf8')
await host.__internals.recordToolCall(sessionId, { type: 'tool/call', seq: 26, time: 'T2', data: events[6].data }, undefined)
writeFileSync(created, 'brand new', 'utf8')

const historyDir = join(sessionDir, 'history-file')
ok('snapshots live in <sessionDir>/history-file', existsSync(historyDir), historyDir)

const lines = readFileSync(join(historyDir, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
ok('three tool calls produced three ledger lines', lines.length === 3, JSON.stringify(lines.map((l) => l.seq)))
ok('a ledger line carries {seq,turn,time,tool,path,blob}',
  lines[0] && lines[0].seq === 7 && lines[0].turn === 1 && lines[0].time === 'T1' &&
  lines[0].tool === 'edit' && lines[0].path === target && typeof lines[0].blob === 'string',
  JSON.stringify(lines[0]))
ok('the seq-7 blob holds the bytes from BEFORE that edit',
  readFileSync(join(historyDir, 'blobs', lines[0].blob), 'utf8') === 'ORIGINAL CONTENT\n',
  JSON.stringify(readFileSync(join(historyDir, 'blobs', lines[0].blob), 'utf8')))
ok('the seq-24 blob holds the bytes from BEFORE that overwrite',
  readFileSync(join(historyDir, 'blobs', lines[1].blob), 'utf8') === 'EDITED BY TURN 1\n',
  JSON.stringify(readFileSync(join(historyDir, 'blobs', lines[1].blob), 'utf8')))
// A file that did not exist yet has no bytes to save. Recording `null` (rather
// than skipping the call) is what lets a rollback know to DELETE it.
ok('a file that did not exist yet records blob:null', lines[2].blob === null, JSON.stringify(lines[2]))

// ---------------------------------------------------------------------------
// C. Roll back to the turn-2 boundary: only turn-2 damage is undone
// ---------------------------------------------------------------------------

console.log('\n=== rollback to a boundary ===\n')

const r7 = await host.__internals.restoreFilesBefore(sessionId, 7, undefined)
ok('reports source=snapshot (the exact-bytes path, not the log guess)',
  r7.source === 'snapshot', JSON.stringify(r7.source))
ok('rewinds the overwrite to its pre-turn-2 content',
  readFileSync(target, 'utf8') === 'EDITED BY TURN 1\n', JSON.stringify(readFileSync(target, 'utf8')))
ok('deletes a file that did not exist before the boundary',
  !existsSync(created), existsSync(created) ? 'still there' : 'gone')

// The boundary is INCLUSIVE: keepSeq=7 means "keep everything up to and
// including seq 7", so that ledger line and its blob survive. Consuming it would
// throw away the only copy of the pre-turn-1 bytes and make a deeper rollback
// impossible — which is exactly what the next block proves still works.
const kept = readFileSync(join(historyDir, 'manifest.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
ok('keeps the ledger line AT the boundary (so a deeper rollback stays possible)',
  kept.length === 1 && kept[0].seq === 7, JSON.stringify(kept.map((l) => l.seq)))
ok('consumes every ledger line past the boundary',
  kept.every((l) => l.seq <= 7), JSON.stringify(kept.map((l) => l.seq)))
const blobsLeft = existsSync(join(historyDir, 'blobs')) ? readdirSync(join(historyDir, 'blobs')) : []
ok('deletes the blobs nothing references any more',
  blobsLeft.length === 1 && blobsLeft[0] === kept[0].blob, JSON.stringify(blobsLeft))

// ---------------------------------------------------------------------------
// D. A second, deeper rollback — proves the ledger is reusable, not one-shot
// ---------------------------------------------------------------------------

const r5 = await host.__internals.restoreFilesBefore(sessionId, 5, undefined)
ok('a deeper rollback rewinds all the way to the original bytes',
  readFileSync(target, 'utf8') === 'ORIGINAL CONTENT\n', JSON.stringify(readFileSync(target, 'utf8')))
ok('the deeper rollback reports the file it restored',
  r5.restored.length === 1 && r5.restored[0].path === target, JSON.stringify(r5.restored))

// ---------------------------------------------------------------------------
// E. The log-reverse fallback, used for sessions that never had a ledger
//
// In practice that is a FORKED child: `Session.fromRestore` replays the parent's
// events without publishing `session/event`, so nothing inherited was ever
// snapshotted. The log still holds every tool call, so the edits can be inverted.
// ---------------------------------------------------------------------------

console.log('\n=== log-reverse fallback ===\n')

{
  rmSync(historyDir, { recursive: true, force: true })
  writeFileSync(target, 'EDITED BY TURN 1\n', 'utf8')
  const narrowed = await host.__internals.reverseApplyFromLog(sessionId, 7, undefined)
  // Past seq 7 there is a `write`, whose previous content is nowhere in the log.
  // The honest outcome is a named warning, never a plausible-but-wrong guess.
  ok('refuses to guess past a full overwrite and warns about the file',
    (narrowed.warnings ?? []).some((w) => w.includes('write')) &&
    readFileSync(target, 'utf8') === 'EDITED BY TURN 1\n',
    JSON.stringify(narrowed))
}

{
  // A history made only of invertible edits must reverse exactly.
  const editOnlyId = 'session-ffffffff-1111-2222-3333-444444444444'
  const editOnlyDir = join(projectDir, bareId(editOnlyId))
  mkdirSync(editOnlyDir, { recursive: true })
  const editEvents = [
    { type: 'turn/start', seq: 3, data: { turn: 1 } },
    { type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'go' }] } },
    { type: 'tool/call', seq: 9, data: { name: 'edit', turn: 1, arguments: { file_path: target, old_string: 'ORIGINAL', new_string: 'REPLACED' } } },
  ]
  const frames2 = [zlib.zstdCompressSync(Buffer.from(JSON.stringify({ sessionId: editOnlyId, cwd, version: 4 }) + '\n', 'utf8'))]
  for (const event of editEvents) frames2.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
  writeFileSync(join(editOnlyDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames2))

  writeFileSync(target, 'REPLACED CONTENT\n', 'utf8')
  const rebuilt = await host.__internals.restoreFilesBefore(editOnlyId, 5, undefined)
  ok('with no ledger at all, restore falls back to log reversal',
    rebuilt.source === 'log', JSON.stringify(rebuilt.source))
  ok('log reversal undid the edit exactly',
    readFileSync(target, 'utf8') === 'ORIGINAL CONTENT\n', JSON.stringify(readFileSync(target, 'utf8')))
  ok('log reversal reported no warnings for a clean edit-only history',
    (rebuilt.warnings ?? []).length === 0, JSON.stringify(rebuilt.warnings))
}

// ---------------------------------------------------------------------------
// F. Static contract: what is tracked, and what replace-mode delete may skip
// ---------------------------------------------------------------------------

console.log('\n=== tracked surface + replace-mode delete ===\n')

ok('FILE_TOOL_PATHS lists exactly the three file-writing tools',
  Object.keys(host.__internals.FILE_TOOL_PATHS).sort().join(',') === 'edit,str_replace_editor,write',
  Object.keys(host.__internals.FILE_TOOL_PATHS).join(','))
ok('str_replace_editor view (a READ) produces no snapshot path',
  host.__internals.FILE_TOOL_PATHS.str_replace_editor({ command: 'view', path: target }).length === 0)
ok('a relative path is extracted but rejected later as non-absolute',
  host.__internals.FILE_TOOL_PATHS.write({ file_path: 'relative.txt' }).length === 1)
ok('the blob limit is 8MB', host.__internals.FILE_HISTORY_BLOB_LIMIT === 8 * 1024 * 1024,
  String(host.__internals.FILE_HISTORY_BLOB_LIMIT))

// 🔴 The one guard replace mode is allowed to skip is the FAVOURITE check, and
// nothing else. Prove both halves: the default path refuses, the explicit
// `replace` path proceeds — and it is an argument, so no request body can set it.
host.__internals.writeState({ version: 1, favorites: { [sessionId]: { at: '2026-01-01T00:00:00.000Z', title: 'fav', cwd } } })
const guarded = await host.__internals.handleDelete({ sessionIds: [sessionId] }, undefined, {})
ok('the default delete path still refuses a favourited session',
  guarded.deleted.length === 0 && guarded.skipped.some((s) => s.reason === 'favorited'),
  JSON.stringify(guarded))
const replaced = await host.__internals.handleDelete({ sessionIds: [sessionId] }, undefined, {}, { replace: true })
ok('replace mode does remove the favourited session', replaced.deleted.includes(sessionId), JSON.stringify(replaced))
ok('replace mode really removed the directory', !existsSync(sessionDir), sessionDir)

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

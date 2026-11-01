// Behavioural probe for the ungrouped guard (lib/ungrouped-guard.js).
//
// WHY THIS EXISTS: `node --check lib/ungrouped-guard.js` proves the file parses and
// nothing else. The questions that actually matter for this feature are behavioural:
//
//   1. does the detector reproduce the official `sessionVisible()` exclusion order,
//      so a subagent / blank / archived / already-registered session can never land
//      in the "未分组" bucket?
//   2. does `adviseEntry()` really pick delete / delete / attach / archive / manual
//      for the five shapes of stray session seen on this machine?
//   3. does `cleanupUngrouped()` really refuse to touch the disk by default, and
//      really refuse the current session and anything outside the sessions root?
//
// All three are claims about which branch runs and about bytes on disk, so they are
// asserted against an ISOLATED fake DSH home plus a spy registry — never the real
// `~/.dsh` tree. Everything created here is deleted on the way out.
//
// It also covers the multi-frame zstd trap: `zlib.zstdDecompressSync()` does NOT
// throw on a multi-frame stream, it silently returns only the first frame (one real
// 100 KB log once decoded to 230 bytes, so its title read as null). Every log this
// probe writes is deliberately multi-frame, and one title marker lives in the LAST
// frame only.
//
// Run: node test/probe-ungrouped-guard.mjs

import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import zlib from 'node:zlib'

import {
  diagnoseUngrouped,
  cleanupUngrouped,
  explainUngrouped,
  diagnoseGhostCache,
  cleanupGhostCache,
  UNGROUPED_GUARD_VERSION,
  __internals,
} from '../lib/ungrouped-guard.js'

const here = dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) { pass += 1; console.log('  PASS  ' + label) }
  else {
    fail += 1
    failures.push(label + (detail ? ' :: ' + detail : ''))
    console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : ''))
  }
}

function brief(value, max = 220) {
  let text
  try { text = JSON.stringify(value) } catch { text = String(value) }
  if (typeof text !== 'string') text = String(text)
  return text.length > max ? text.slice(0, max) + '…' : text
}

// ---------------------------------------------------------------------------
// 0. Preconditions
// ---------------------------------------------------------------------------

console.log('\n--- ungrouped guard probe (v' + UNGROUPED_GUARD_VERSION + ') ---')

if (typeof zlib.zstdCompressSync !== 'function' || typeof zlib.zstdDecompressSync !== 'function') {
  console.log('  SKIP  this Node build has no zstd support (need >= 22.15 / 24)')
  process.exit(2)
}

ok('guard exports the version string', typeof UNGROUPED_GUARD_VERSION === 'string' && /^\d+\.\d+\.\d+$/.test(UNGROUPED_GUARD_VERSION), String(UNGROUPED_GUARD_VERSION))
ok('guard exports diagnoseUngrouped / cleanupUngrouped / explainUngrouped',
  typeof diagnoseUngrouped === 'function' && typeof cleanupUngrouped === 'function' && typeof explainUngrouped === 'function')
ok('guard exposes __internals for white-box checks',
  __internals !== null && typeof __internals === 'object' && typeof __internals.readSessionLog === 'function' && typeof __internals.adviseEntry === 'function')

// ---------------------------------------------------------------------------
// 1. Isolated fake DSH home
// ---------------------------------------------------------------------------

const root = join(here, '..', '.probe-ungrouped')
rmSync(root, { recursive: true, force: true })

const sessions = join(root, 'sessions')
const storages = join(root, 'storages')
const workspaceFile = join(storages, 'workspace.json')
mkdirSync(sessions, { recursive: true })
mkdirSync(storages, { recursive: true })

const WS_PATH = 'C:\\Probe\\Workspace'
const STRAY_PATH = 'C:\\Probe\\Stray'
const CURRENT_ID = 'session-probe-current-0009'
const CREATED_AT = 1761000000000
const E2E_CREATED_AT = 1792475000000

process.env.DSH_HOME = root
process.env.DSH_AFF_SESSIONS_ROOT = sessions
process.env.DSH_AFF_WORKSPACE_FILE = workspaceFile
process.env.DSH_SESSION_ID = CURRENT_ID

// One workspace that owns exactly one session; one archived session that is not a
// member. Both records are deliberately *consistent* with the fake tree below, so a
// miscount cannot hide behind missing data.
writeFileSync(workspaceFile, JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: ['ws-probe'],
    archivedSessionIds: ['session-probe-archived-0003'],
    pinnedSessionIds: [],
  },
  tables: {
    workspaces: {
      'ws-probe': {
        path: WS_PATH,
        title: 'Probe Workspace',
        sessionIds: ['session-probe-member-0004'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  },
}, null, 2), 'utf8')

const workspaceBytesBefore = readFileSync(workspaceFile, 'utf8')

// ---------------------------------------------------------------------------
// 2. Multi-frame zstd session logs
// ---------------------------------------------------------------------------

const PROJ_WS = '--C-Probe-Workspace--'
const PROJ_STRAY = '--C-Probe-Stray--'

const dirOf = (project, sessionId) => join(sessions, project, sessionId)

function ev(type, data) {
  return JSON.stringify({ type, data })
}

function header(sessionId, extra = {}) {
  return JSON.stringify({
    type: 'session/created',
    data: { id: sessionId, delegationDepth: 0, createdAt: CREATED_AT, ...extra },
  })
}

/** Write `lines` as a deliberately MULTI-FRAME zstd log (the real-world shape). */
function writeLog(project, sessionId, lines, frames = 3) {
  const dir = dirOf(project, sessionId)
  mkdirSync(dir, { recursive: true })
  const per = Math.max(1, Math.ceil(lines.length / frames))
  const groups = []
  for (let index = 0; index < lines.length; index += per) groups.push(lines.slice(index, index + per))
  const buf = Buffer.concat(groups.map((group) => zlib.zstdCompressSync(Buffer.from(group.join('\n') + '\n', 'utf8'))))
  writeFileSync(join(dir, 'session.v4.jsonl.zstd'), buf)
  return { dir, buf, frames: groups.length }
}

const created = {}

// 1) subagent — excluded by the FIRST sessionVisible rule.
created.subagent = writeLog(PROJ_WS, 'session-probe-subagent-0001', [
  header('session-probe-subagent-0001', { cwd: WS_PATH, origin: 'subagent' }),
  ev('user/message', { role: 'user', text: '子代理内部指令' }),
])

// 2) blank, not the current session — excluded by the SECOND rule.
created.blank = writeLog(PROJ_WS, 'session-probe-blank-0002', [
  header('session-probe-blank-0002', { cwd: WS_PATH, blank: true }),
])

// 3) archived — excluded by the THIRD rule (default archived filter).
created.archived = writeLog(PROJ_WS, 'session-probe-archived-0003', [
  header('session-probe-archived-0003', { cwd: WS_PATH }),
  ev('user/message', { role: 'user', text: '已归档的旧会话' }),
  ev('session/title', { title: '已归档的旧会话' }),
])

// 4) already a workspace member — excluded by the FOURTH rule (accounted for).
created.member = writeLog(PROJ_WS, 'session-probe-member-0004', [
  header('session-probe-member-0004', { cwd: WS_PATH }),
  ev('user/message', { role: 'user', text: '已登记成员' }),
  ev('session/title', { title: '已登记成员' }),
])

// 5) stray e2e fixture — exactly the shape of the 4 official test leftovers found on
//    this machine: 11 events, createdAt 1792475000000, text "body image e2e".
created.e2e = writeLog(PROJ_STRAY, 'session-probe-e2e-0005', [
  header('session-probe-e2e-0005', { cwd: STRAY_PATH, createdAt: E2E_CREATED_AT }),
  ev('user/message', { role: 'user', text: 'body image e2e' }),
  ev('assistant/message', { role: 'assistant', text: '![img](data:image/png;base64,AAAA)' }),
  ev('session/title', { title: 'body image e2e' }),
])

// 6) stray empty shell — no user message at all, tiny (like the 349 B orphan).
created.shell = writeLog(PROJ_STRAY, 'session-probe-shell-0006', [
  header('session-probe-shell-0006', { cwd: STRAY_PATH }),
  ev('permission/preset', { preset: 'danger-full-access' }),
])

// 7) stray whose cwd DOES have a workspace — should be re-attached, not hidden.
created.attach = writeLog(PROJ_WS, 'session-probe-attach-0007', [
  header('session-probe-attach-0007', { cwd: WS_PATH }),
  ev('user/message', { role: 'user', text: '需要归位的会话' }),
  ev('session/title', { title: '需要归位' }),
])

// 8) stray with real content, cwd has NO workspace — should be archived.
//    The title marker lives in the LAST frame only, on purpose.
created.archive = writeLog(PROJ_STRAY, 'session-probe-archive-0008', [
  header('session-probe-archive-0008', { cwd: STRAY_PATH }),
  ev('user/message', { role: 'user', text: '有真实内容的孤儿会话' }),
  ev('assistant/message', { role: 'assistant', text: '收到' }),
  ev('session/title', { title: '孤儿会话-LASTFRAME-MARKER' }),
])

// 9) the CURRENT session, stray — must be advised `manual` and never touched.
created.current = writeLog(PROJ_STRAY, CURRENT_ID, [
  header(CURRENT_ID, { cwd: STRAY_PATH }),
  ev('user/message', { role: 'user', text: '当前正在使用的会话' }),
  ev('session/title', { title: '当前会话' }),
])

const allDirs = Object.values(created).map((item) => item.dir)

// ---------------------------------------------------------------------------
// 3. Multi-frame zstd really is multi-frame
// ---------------------------------------------------------------------------

const archiveDir = created.archive.dir
const archiveLog = __internals.readSessionLog(archiveDir)
const singleCallText = (() => {
  try { return zlib.zstdDecompressSync(readFileSync(join(archiveDir, 'session.v4.jsonl.zstd'))).toString('utf8') }
  catch { return '' }
})()

ok('probe fixtures are genuinely multi-frame', created.archive.frames >= 2, 'frames=' + created.archive.frames)
ok('readSessionLog reads the multi-frame log', archiveLog.ok === true, brief(archiveLog))
ok('the LAST zstd frame is decoded too (marker survives)',
  archiveLog.ok === true && archiveLog.text.includes('LASTFRAME-MARKER'),
  'single-call decode ' + singleCallText.length + ' chars vs guard ' + (archiveLog.ok ? archiveLog.text.length : 0) + ' chars')
console.log('  note  single-call zstdDecompressSync returned ' + singleCallText.length
  + ' chars, guard returned ' + (archiveLog.ok ? archiveLog.text.length : 0) + ' chars (frames=' + created.archive.frames + ')')

// ---------------------------------------------------------------------------
// 3b. The cheap header read must NOT decode every frame
//
// diagnoseUngrouped used to decode all frames of all 653 logs on this machine
// (746 MB / 355k frames) and took 12.6 s of blocked main thread. The four-step
// exclusion test only needs the header, which always lives in frame 1, so the
// per-directory read must stay cheap. These assertions pin that down: if
// someone makes readSessionHeader decode everything again, this fails loudly.
// ---------------------------------------------------------------------------

const archiveHead = __internals.readSessionHeader(archiveDir)
ok('readSessionHeader reads the header of a multi-frame log', archiveHead.ok === true, brief(archiveHead))
ok('readSessionHeader reports the log as incomplete (only frame 1 decoded)',
  archiveHead.ok === true && archiveHead.complete === false, 'complete=' + (archiveHead.ok ? archiveHead.complete : 'n/a'))
ok('readSessionHeader decoded exactly one frame, not the whole file',
  archiveHead.ok === true && archiveHead.text.length === singleCallText.length,
  'header read ' + (archiveHead.ok ? archiveHead.text.length : 0) + ' chars vs single-frame ' + singleCallText.length + ' chars')
ok('readSessionHeader counted the frames without decoding them',
  archiveHead.ok === true && archiveHead.frames === created.archive.frames,
  'frames=' + (archiveHead.ok ? archiveHead.frames : 'n/a') + ' expected=' + created.archive.frames)
ok('the cheap header read still yields id/cwd/origin',
  archiveHead.ok === true && archiveHead.data.id === 'session-probe-archive-0008' && archiveHead.data.cwd === STRAY_PATH,
  brief(archiveHead.ok ? archiveHead.data : archiveHead))

// The header read must also be right when a frame boundary lands mid-line
// (hand-made fixtures do that, DSH itself does not): fall back to full decode
// rather than reporting bad-header.
// NOTE: must go through dirOf() so it lands in the isolated fake home. Joining the
// project name by hand resolves against the *current working directory* and litters
// an empty `--C-Probe-Stray--/` folder in the repo root on every run.
const midLineDir = dirOf(PROJ_STRAY, 'session-probe-midline-0010')
mkdirSync(midLineDir, { recursive: true })
{
  const body = [
    header('session-probe-midline-0010', { cwd: STRAY_PATH }),
    ev('user/message', { role: 'user', text: '帧边界切在行中间' }),
  ].join('\n') + '\n'
  const cut = 12 // deliberately inside the header line
  writeFileSync(join(midLineDir, 'session.v4.jsonl.zstd'), Buffer.concat([
    zlib.zstdCompressSync(Buffer.from(body.slice(0, cut), 'utf8')),
    zlib.zstdCompressSync(Buffer.from(body.slice(cut), 'utf8')),
  ]))
}
const midLineHead = __internals.readSessionHeader(midLineDir)
ok('a frame boundary inside a line still yields a header (falls back to full decode)',
  midLineHead.ok === true && midLineHead.data.id === 'session-probe-midline-0010', brief(midLineHead))
ok('the mid-line fallback marks the text as complete',
  midLineHead.ok === true && midLineHead.complete === true, 'complete=' + (midLineHead.ok ? midLineHead.complete : 'n/a'))
rmSync(midLineDir, { recursive: true, force: true })

// ---------------------------------------------------------------------------
// 4. diagnoseUngrouped — file source (no live registry)
// ---------------------------------------------------------------------------

const diagFile = await diagnoseUngrouped(null)

ok('diagnoseUngrouped(file) succeeds', diagFile.ok === true, brief(diagFile.detail ?? diagFile.verdict))
ok('diagnoseUngrouped(file) reports source=file', diagFile.source === 'file', String(diagFile.source))
ok('archived set is known from the file', diagFile.archivedKnown === true, String(diagFile.archivedKnown))

const s = diagFile.summary
ok('summary.workspaceCount = 1', s.workspaceCount === 1, brief(s))
ok('summary.totalDirs = 9', s.totalDirs === 9, brief(s))
ok('summary.subagentCount = 1 (origin=subagent excluded)', s.subagentCount === 1, brief(s))
ok('summary.blankCount = 1 (blank non-current excluded)', s.blankCount === 1, brief(s))
ok('summary.archivedCount = 1 (archived excluded)', s.archivedCount === 1, brief(s))
ok('summary.memberCount = 1 (registered member excluded)', s.memberCount === 1, brief(s))
ok('summary.unreadableCount = 0', s.unreadableCount === 0, brief(s))
ok('summary.ungroupedCount = 5', s.ungroupedCount === 5, brief(s))
ok('verdict is has-ungrouped', diagFile.verdict === 'has-ungrouped', String(diagFile.verdict))

const mapOf = (diagnosis) => diagnosis.ungrouped.map((row) => row.sessionId + '=' + row.advise).sort().join(', ')

const WANT_ADVICE = [
  'session-probe-archive-0008=archive',
  'session-probe-attach-0007=attach',
  'session-probe-current-0009=manual',
  'session-probe-e2e-0005=delete',
  'session-probe-shell-0006=delete',
].join(', ')

console.log('  note  got  = ' + mapOf(diagFile))
console.log('  note  want = ' + WANT_ADVICE)
ok('the five stray sessions get the five expected advices', mapOf(diagFile) === WANT_ADVICE, mapOf(diagFile))
ok('no excluded session leaked into ungrouped',
  !diagFile.ungrouped.some((row) => ['session-probe-subagent-0001', 'session-probe-blank-0002', 'session-probe-archived-0003', 'session-probe-member-0004'].includes(row.sessionId)),
  brief(diagFile.ungrouped.map((row) => row.sessionId)))

const currentRow = diagFile.ungrouped.find((row) => row.sessionId === CURRENT_ID)
ok('the current session is flagged isCurrent', currentRow !== undefined && currentRow.isCurrent === true, brief(currentRow))
ok('only the current session is flagged isCurrent',
  diagFile.ungrouped.filter((row) => row.isCurrent === true).length === 1,
  brief(diagFile.ungrouped.filter((row) => row.isCurrent).map((row) => row.sessionId)))

const e2eRow = diagFile.ungrouped.find((row) => row.sessionId === 'session-probe-e2e-0005')
ok('the e2e fixture is recognised as e2eFixture', e2eRow !== undefined && e2eRow.e2eFixture === true, brief(e2eRow))

// ---------------------------------------------------------------------------
// 5. adviseEntry — the four decision tiers, called directly
// ---------------------------------------------------------------------------

const memberPaths = new Map([[__internals.normPath(WS_PATH), 'ws-probe']])
const base = { hasUserMsg: true, size: 9000, title: 't', cwd: STRAY_PATH, isCurrent: false, e2eFixture: false }

ok('adviseEntry: e2e fixture -> delete',
  __internals.adviseEntry({ ...base, e2eFixture: true }, memberPaths).advise === 'delete')
ok('adviseEntry: empty shell -> delete',
  __internals.adviseEntry({ ...base, hasUserMsg: false, size: 349 }, memberPaths).advise === 'delete')
ok('adviseEntry: stray whose cwd has a workspace -> attach',
  __internals.adviseEntry({ ...base, cwd: WS_PATH }, memberPaths).advise === 'attach')
ok('adviseEntry: stray whose cwd has no workspace -> archive',
  __internals.adviseEntry({ ...base, cwd: STRAY_PATH }, memberPaths).advise === 'archive')
ok('adviseEntry: current session -> manual (never auto-touched)',
  __internals.adviseEntry({ ...base, isCurrent: true, e2eFixture: true }, memberPaths).advise === 'manual')

// ---------------------------------------------------------------------------
// 6. diagnoseUngrouped — live registry source must agree with the file
// ---------------------------------------------------------------------------

const calls = []
const spyRegistry = {
  archivedSessionIds: ['session-probe-archived-0003'],
  archiveSession: async (sessionId) => { calls.push(['archive', sessionId]) },
  list: () => [{
    record: { workspaceId: 'ws-probe', path: WS_PATH, sessionIds: ['session-probe-member-0004'] },
    attachSession: async (sessionId) => { calls.push(['attach', sessionId]) },
  }],
}
const spyCtx = {
  get: (name) => (name === 'workspaceRegistry' ? spyRegistry : undefined),
  emit: (name, payload) => { calls.push(['emit', name, payload]) },
}

const diagRegistry = await diagnoseUngrouped(spyCtx)
ok('diagnoseUngrouped(registry) reports source=registry', diagRegistry.source === 'registry', String(diagRegistry.source))
ok('registry source and file source agree on every counter',
  JSON.stringify(diagRegistry.summary) === JSON.stringify(diagFile.summary),
  brief(diagRegistry.summary) + ' vs ' + brief(diagFile.summary))
ok('registry source and file source agree on the ungrouped set',
  mapOf(diagRegistry) === mapOf(diagFile), mapOf(diagRegistry))

// ---------------------------------------------------------------------------
// 7. cleanupUngrouped — default is dryRun and must not touch the disk
// ---------------------------------------------------------------------------

calls.length = 0
const dry = await cleanupUngrouped(spyCtx, diagRegistry.ungrouped)

ok('cleanupUngrouped defaults to dryRun', dry.dryRun === true, brief(dry))
ok('dryRun plans both deletes', dry.deleted.length === 2, brief(dry.deleted))
ok('dryRun plans the archive', dry.archived.length === 1 && dry.archived[0] === 'session-probe-archive-0008', brief(dry.archived))
ok('dryRun plans the attach', dry.attached.length === 1 && dry.attached[0] === 'session-probe-attach-0007', brief(dry.attached))
ok('dryRun leaves the manual/current entry alone',
  dry.skipped.some((row) => row.sessionId === CURRENT_ID && row.reason === 'action-not-allowed:manual'),
  brief(dry.skipped))
ok('dryRun calls no registry method and emits nothing', calls.length === 0, brief(calls))
ok('dryRun leaves all 9 session directories on disk', allDirs.every((dir) => existsSync(dir)),
  brief(allDirs.filter((dir) => !existsSync(dir))))
ok('dryRun leaves workspace.json byte-identical', readFileSync(workspaceFile, 'utf8') === workspaceBytesBefore)

// ---------------------------------------------------------------------------
// 8. Guards: outside-sessions-root and current-session
// ---------------------------------------------------------------------------

const outsideDir = join(root, 'outside', 'session-probe-outside-0010')
mkdirSync(outsideDir, { recursive: true })

const outsideResult = await cleanupUngrouped(null, [
  { sessionId: 'session-probe-outside-0010', dir: outsideDir, advise: 'delete' },
])
ok('a directory outside the sessions root is refused',
  outsideResult.failures.length === 1 && outsideResult.failures[0].reason === 'outside-sessions-root',
  brief(outsideResult))
ok('the refused outside directory is still on disk', existsSync(outsideDir), outsideDir)

const currentResult = await cleanupUngrouped(null, [
  { sessionId: CURRENT_ID, dir: created.current.dir, advise: 'delete' },
])
ok('the current session is refused',
  currentResult.skipped.length === 1 && currentResult.skipped[0].reason === 'current-session',
  brief(currentResult))
ok('the current session directory is still on disk', existsSync(created.current.dir), created.current.dir)

const budgetResult = await cleanupUngrouped(null, [
  { sessionId: 'session-probe-e2e-0005', dir: created.e2e.dir, advise: 'delete' },
  { sessionId: 'session-probe-shell-0006', dir: created.shell.dir, advise: 'delete' },
], { maxItems: 1 })
ok('maxItems caps the plan at one item per action',
  budgetResult.deleted.length === 1 && budgetResult.skipped.some((row) => row.reason === 'budget-exhausted:delete'),
  brief(budgetResult))

// ---------------------------------------------------------------------------
// 9. Non-dryRun reaches the registry (spy only — no real archive, no real delete)
// ---------------------------------------------------------------------------

calls.length = 0
const live = await cleanupUngrouped(spyCtx, diagRegistry.ungrouped, { dryRun: false, actions: ['archive', 'attach'] })

ok('non-dryRun archive reaches registry.archiveSession',
  live.archived.length === 1 && calls.some((call) => call[0] === 'archive' && call[1] === 'session-probe-archive-0008'),
  brief({ archived: live.archived, calls }))
ok('non-dryRun attach reaches the workspace entity owning that cwd',
  live.attached.length === 1 && calls.some((call) => call[0] === 'attach' && call[1] === 'session-probe-attach-0007'),
  brief({ attached: live.attached, calls }))
ok('restricting actions leaves the deletes untouched (no recycle-bin call, dirs intact)',
  live.deleted.length === 0 && existsSync(created.e2e.dir) && existsSync(created.shell.dir),
  brief({ deleted: live.deleted }))
ok('workspace.json is still byte-identical after every cleanup call',
  readFileSync(workspaceFile, 'utf8') === workspaceBytesBefore)

// ---------------------------------------------------------------------------
// 10. explainUngrouped — the user-facing answer
// ---------------------------------------------------------------------------

const paragraphs = explainUngrouped()
ok('explainUngrouped returns 7 paragraphs', Array.isArray(paragraphs) && paragraphs.length === 7, 'n=' + (Array.isArray(paragraphs) ? paragraphs.length : 'n/a'))
ok('explainUngrouped states that deleting history is NOT the cause',
  paragraphs.some((text) => text.includes('不是') && (text.includes('删') || text.includes('删除'))),
  brief(paragraphs.filter((text) => text.includes('不是')).join(' | ')))
ok('explainUngrouped mentions the three hard gates',
  paragraphs.some((text) => text.includes('硬门')), brief(paragraphs[paragraphs.length - 1]))

// ---------------------------------------------------------------------------
// 11. Ghost cache — the half of the story a directory scan cannot see
// ---------------------------------------------------------------------------
//
// WHY: a session directory can be deleted while `storages/session_projcache/
// sessions/<id>.json` survives. The sidebar still draws that row (its title lives
// in the cache, not the directory) and the id is in nobody's `sessionIds`, so it
// lands in "未分组" — while `diagnoseUngrouped()` above correctly reports clean,
// because it only walks directories. These assertions pin the ONLY detector that
// can see that state, and the safety rules around removing it.

const projCacheRoot = join(storages, 'session_projcache', 'sessions')
mkdirSync(projCacheRoot, { recursive: true })

function cacheFile(sessionId, rows = {}) {
  const record = {
    version: 7,
    record: {
      identity: { formatVersion: 4, createdAt: CREATED_AT, cwd: WS_PATH, isSeeded: false, inheritedEventCount: 3 },
      rows: {
        title: { val: rows.title ?? ('缓存标题 ' + sessionId) },
        sessionListMetadata: { val: { blank: false, lastPromptAt: rows.lastPromptAt ?? CREATED_AT + 1000 } },
        turnOutline: { val: { turns: [{ turn: 1, seq: 4, prompt: '1+1', response: '2' }] } },
      },
    },
  }
  writeFileSync(join(projCacheRoot, sessionId + '.json'), JSON.stringify(record), 'utf8')
}

// (a) a cache whose session directory STILL exists — must never be called a ghost.
cacheFile('session-probe-member-0004', { title: '仍在磁盘上的会话' })
// (b) a plain ghost — the case that fills the bucket.
cacheFile('session-probe-ghost-0011', { title: '1+1' })
// (c) a ghost that is PINNED — kept by default, the user marked it deliberately.
cacheFile('session-probe-ghostpinned-0012', { title: '每日插件版本更新检查' })
// (d) a ghost that is ARCHIVED — cleaned by default (archived means "out of the way").
cacheFile('session-probe-ghostarchived-0013', { title: '已归档的幽灵' })

// A workspace record that marks (c) pinned and (d) archived, so the classifier has
// real input rather than a stub.
writeFileSync(workspaceFile, JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: {
    initialized: true,
    workspaceIds: ['ws-probe'],
    archivedSessionIds: ['session-probe-archived-0003', 'session-probe-ghostarchived-0013'],
    pinnedSessionIds: ['session-probe-ghostpinned-0012'],
  },
  tables: {
    workspaces: {
      'ws-probe': {
        path: WS_PATH,
        title: 'Probe Workspace',
        sessionIds: ['session-probe-member-0004'],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  },
}, null, 2), 'utf8')
const workspaceBytesBeforeGhosts = readFileSync(workspaceFile, 'utf8')

const ghostDiag = await diagnoseGhostCache(null)

ok('diagnoseGhostCache succeeds', ghostDiag.ok === true, brief(ghostDiag.detail ?? ghostDiag.verdict))
ok('diagnoseGhostCache counts every cache file', ghostDiag.summary.cacheFiles === 4, brief(ghostDiag.summary))
ok('diagnoseGhostCache finds exactly the 3 orphans', ghostDiag.summary.ghostCount === 3, brief(ghostDiag.summary))
ok('diagnoseGhostCache never flags a session that still has a directory',
  !ghostDiag.ghosts.some((row) => row.sessionId === 'session-probe-member-0004'),
  brief(ghostDiag.ghosts.map((row) => row.sessionId)))
ok('diagnoseGhostCache separates pinned and archived ghosts',
  ghostDiag.summary.pinnedGhostCount === 1 && ghostDiag.summary.archivedGhostCount === 1,
  brief(ghostDiag.summary))
ok('diagnoseGhostCache verdict is has-ghosts', ghostDiag.verdict === 'has-ghosts', String(ghostDiag.verdict))
ok('diagnoseGhostCache reads the title out of the cache (that is what the sidebar draws)',
  ghostDiag.ghosts.some((row) => row.sessionId === 'session-probe-ghost-0011' && row.title === '1+1'),
  brief(ghostDiag.ghosts.map((row) => row.sessionId + '=' + row.title)))

// 0.36.0 flipped this default on purpose. Before it, a ghost that happened to
// sit in `archivedSessionIds` was advised `keep` and skipped by the cleanup —
// and on a real machine 85 of 86 orphans carried exactly that stale flag, so
// the "clean up" button deleted nothing at all while showing a full list. The
// orphan's own archive/pin marker only described a conversation that no longer
// exists; it says nothing about whether a cache file should survive. So the
// diagnosis now advises `delete` for every orphan, and the counts only remain
// as labels for the UI.
const ghostAdvice = new Map(ghostDiag.ghosts.map((row) => [row.sessionId, row.advise]))
ok('a plain ghost is advised delete', ghostAdvice.get('session-probe-ghost-0011') === 'delete', brief([...ghostAdvice]))
ok('a pinned ghost is ALSO advised delete by default',
  ghostAdvice.get('session-probe-ghostpinned-0012') === 'delete', brief([...ghostAdvice]))
ok('an archived ghost is ALSO advised delete by default',
  ghostAdvice.get('session-probe-ghostarchived-0013') === 'delete', brief([...ghostAdvice]))

const ghostDry = await cleanupGhostCache(null, ghostDiag.ghosts)

ok('cleanupGhostCache defaults to dryRun', ghostDry.dryRun === true, brief(ghostDry))
// All three orphans are deletable by default now. The list and the confirm
// button agree: what the card lists is what the plan contains.
ok('dryRun plans every orphan, including the pinned and archived ones',
  ghostDry.deleted.length === 3 &&
  ghostDry.deleted.includes('session-probe-ghost-0011') &&
  ghostDry.deleted.includes('session-probe-ghostpinned-0012') &&
  ghostDry.deleted.includes('session-probe-ghostarchived-0013'),
  brief(ghostDry.deleted))
ok('dryRun skips nothing by default', ghostDry.skipped.length === 0, brief(ghostDry.skipped))
ok('dryRun removes no cache file from disk',
  ghostDiag.ghosts.every((row) => existsSync(row.file)),
  brief(ghostDiag.ghosts.filter((row) => !existsSync(row.file)).map((row) => row.sessionId)))
ok('dryRun leaves workspace.json byte-identical',
  readFileSync(workspaceFile, 'utf8') === workspaceBytesBeforeGhosts)

// The opt-out: "keep the pinned/archived ones" is a real checkbox on the card,
// and it must be the ONLY way those rows survive.
const ghostKeepPinned = await cleanupGhostCache(null, ghostDiag.ghosts, { keepPinned: true })
ok('keepPinned:true spares the pinned ghost',
  !ghostKeepPinned.deleted.includes('session-probe-ghostpinned-0012') &&
  ghostKeepPinned.skipped.some((row) => row.sessionId === 'session-probe-ghostpinned-0012' && row.reason === 'pinned-kept'),
  brief({ deleted: ghostKeepPinned.deleted, skipped: ghostKeepPinned.skipped }))

const ghostKeepArchived = await cleanupGhostCache(null, ghostDiag.ghosts, { keepArchived: true })
ok('keepArchived:true spares the archived ghost',
  !ghostKeepArchived.deleted.includes('session-probe-ghostarchived-0013') &&
  ghostKeepArchived.skipped.some((row) => row.sessionId === 'session-probe-ghostarchived-0013' && row.reason === 'archived-kept'),
  brief({ deleted: ghostKeepArchived.deleted, skipped: ghostKeepArchived.skipped }))

// The old parameter names are inert rather than silently reversed: a caller
// that still says `includePinned: true` must not be read as `keepPinned: true`
// (which would invert the meaning of the very same word).
const ghostLegacy = await cleanupGhostCache(null, ghostDiag.ghosts, { includePinned: true, includeArchived: true })
ok('legacy includePinned/includeArchived no longer change the plan',
  ghostLegacy.deleted.length === 3, brief({ deleted: ghostLegacy.deleted }))

const ghostOutside = await cleanupGhostCache(null, [
  { sessionId: 'session-probe-outside-0010', file: join(root, 'outside', 'session-probe-outside-0010.json') },
])
ok('a cache path outside the projcache root is refused',
  ghostOutside.failures.length === 1 && ghostOutside.failures[0].reason === 'outside-projcache-root',
  brief(ghostOutside))

const ghostMissing = await cleanupGhostCache(null, [{ sessionId: 'session-probe-ghost-0011' }])
ok('an entry without a file path is skipped, not deleted',
  ghostMissing.skipped.some((row) => row.reason === 'missing-id-or-file') && ghostMissing.deleted.length === 0,
  brief(ghostMissing))

// Three ghosts are deletable under the defaults now, so a budget of 1 must both
// delete one and report the other two as budget-exhausted.
const ghostBudget = await cleanupGhostCache(null, ghostDiag.ghosts, { maxItems: 1 })
ok('maxItems caps the ghost plan',
  ghostBudget.deleted.length === 1 &&
  ghostBudget.skipped.filter((row) => row.reason === 'budget-exhausted').length === 2,
  brief({ deleted: ghostBudget.deleted, skipped: ghostBudget.skipped }))

// ---------------------------------------------------------------------------
// 12. A blank session keeps its flag in the CACHE, not the header
// ---------------------------------------------------------------------------
//
// 🔴 REAL BUG THIS PINS. `sessionVisible()` excludes `blank` sessions, but `blank`
// is not a header field — the harness writes it to the projection cache as
// `record.rows.sessionListMetadata.val.blank`. A guard that only reads the header
// therefore sees a freshly created, never-used session as a perfectly ordinary one,
// finds it in nobody's `sessionIds`, and reports it under "未分组" — while the
// sidebar never draws it. That was a false alarm on a real boot log
// (session-02c86ef3-…, 432 bytes, 5 events: header + permission preset + sandbox
// mode + approval policy + end-seed, zero user messages).
//
// The fixture deliberately splits the two spellings: the log directory is
// `session-<uuid>` and the cache file is the bare uuid, which is how this machine
// actually stores them after a cross-generation upgrade.

console.log('\n=== blank lives in the cache, not the header ===\n')

const BLANK_CACHE_ID = 'session-probe-blankcache-0014'
const BLANK_CACHE_BARE = 'probe-blankcache-0014'

created.blankCache = writeLog(PROJ_WS, BLANK_CACHE_ID, [
  header(BLANK_CACHE_ID, { cwd: WS_PATH }),
  ev('permission/preset', { preset: 'danger-full-access' }),
  ev('sandbox/mode', { mode: 'danger-full-access' }),
  ev('approval/policy', { policy: 'never' }),
  ev('session/end-seed', {}),
])
// No blank flag anywhere in the header — that is the whole point.
ok('the fixture header carries no blank flag',
  !JSON.stringify(created.blankCache.buf).includes('blank'))

writeFileSync(join(projCacheRoot, BLANK_CACHE_BARE + '.json'), JSON.stringify({
  version: 7,
  record: {
    identity: { formatVersion: 4, createdAt: CREATED_AT, cwd: WS_PATH, isSeeded: false, inheritedEventCount: 0 },
    rows: {
      title: { val: '' },
      sessionListMetadata: { val: { blank: true, lastPromptAt: null } },
      turnOutline: { val: { turns: [] } },
    },
  },
}), 'utf8')

ok('readCacheBlank finds the flag under the bare-uuid spelling',
  __internals.readCacheBlank(__internals.resolveEnv({}), BLANK_CACHE_ID) === true,
  String(__internals.readCacheBlank(__internals.resolveEnv({}), BLANK_CACHE_ID)))
ok('readCacheBlank reports null (not false) when there is no cache file',
  __internals.readCacheBlank(__internals.resolveEnv({}), 'session-probe-nocache-9999') === null)

const blankCacheDiag = await diagnoseUngrouped(null)
ok('a header-only blank check would have called it ungrouped — the cache saves it',
  !blankCacheDiag.ungrouped.some((row) => row.sessionId === BLANK_CACHE_ID),
  brief(blankCacheDiag.ungrouped.map((row) => row.sessionId)))
ok('it is counted as blank instead of as a stray',
  blankCacheDiag.summary.blankCount >= 2, brief(blankCacheDiag.summary))

// The other half of the contract: a cache that says blank:false must NOT be hidden.
const LIVE_CACHE_ID = 'session-probe-livecache-0015'
created.liveCache = writeLog(PROJ_WS, LIVE_CACHE_ID, [
  header(LIVE_CACHE_ID, { cwd: WS_PATH }),
  ev('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'real question' }] }),
])
writeFileSync(join(projCacheRoot, LIVE_CACHE_ID + '.json'), JSON.stringify({
  version: 7,
  record: {
    identity: { formatVersion: 4, createdAt: CREATED_AT, cwd: WS_PATH, isSeeded: false, inheritedEventCount: 2 },
    rows: {
      title: { val: '真实会话' },
      sessionListMetadata: { val: { blank: false, lastPromptAt: CREATED_AT + 500 } },
      turnOutline: { val: { turns: [{ turn: 1, seq: 4, prompt: 'real question', response: 'answer' }] } },
    },
  },
}), 'utf8')

const liveCacheDiag = await diagnoseUngrouped(null)
ok('a cache saying blank:false does not hide the session',
  liveCacheDiag.ungrouped.some((row) => row.sessionId === LIVE_CACHE_ID),
  brief(liveCacheDiag.ungrouped.map((row) => row.sessionId)))
ok('that session still gets a real advice, not a silent drop',
  liveCacheDiag.ungrouped.find((row) => row.sessionId === LIVE_CACHE_ID)?.advise === 'attach',
  brief(liveCacheDiag.ungrouped.map((row) => [row.sessionId, row.advise])))

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

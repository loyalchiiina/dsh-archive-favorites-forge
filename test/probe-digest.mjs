// End-to-end probe for the 0.28.0 "continue in a new window" brief.
//
// WHY THIS EXISTS: the whole promise of the feature is "you will not lose the
// user's requirements or the task progress when you start a fresh window". That
// is a claim about TEXT DERIVED FROM A LOG, and nothing else in this repo can
// check it: `node --check` proves the file parses, `probe-client.mjs` proves the
// bundle shape, and neither can tell whether a `todo/write` event survives the
// distillation or whether a steering injection is mistaken for a user turn.
//
// It runs against an ISOLATED fake DSH home via the same `DSH_AFF_*` overrides
// the other probes use, so it can never touch the developer's real sessions.
//
// Run: node test/probe-digest.mjs

import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
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

const root = join(here, '..', '.probe-digest')
rmSync(root, { recursive: true, force: true })
const sessions = join(root, 'sessions')
const storages = join(root, 'storages')
mkdirSync(storages, { recursive: true })

const cwd = 'C:\\probe\\digest'
const sessionId = 'session-12345678-90ab-cdef-1234-567890abcdef'

process.env.DSH_AFF_SESSIONS_ROOT = sessions
process.env.DSH_AFF_STATE_ROOT = join(root, 'state')
process.env.DSH_AFF_WORKSPACE_FILE = join(storages, 'workspace.json')

const host = await import('../lib/index.js')
const { projectDirName, bareId, sessionDigest, clipText, textBlocksOf } = host.__internals

const sessionDir = join(sessions, projectDirName(cwd), bareId(sessionId))
mkdirSync(sessionDir, { recursive: true })

writeFileSync(join(storages, 'workspace.json'), JSON.stringify({
  unit: { name: 'workspace', version: 2 },
  global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [] },
  tables: {
    workspaces: {
      'ws-1': {
        path: cwd,
        title: 'digest probe',
        sessionIds: [sessionId],
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    },
  },
}), 'utf8')

// ---------------------------------------------------------------------------
// A log shaped like a real long conversation.
//
// It deliberately contains the things that must be DROPPED (tool calls, tool
// results, reasoning, step bookkeeping, a steering injection) right next to the
// things that must SURVIVE (user turns, the newest todo list, team tasks, the
// last assistant reply, the title).
// ---------------------------------------------------------------------------

const events = [
  { type: 'session/title', seq: 2, data: { title: '把侧边栏未分组修好', source: { kind: 'provider' } } },
  { type: 'turn/start', seq: 3, data: { turn: 1 } },
  { type: 'user/message', seq: 5, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第一个要求：修未分组' }] } },
  { type: 'step/start', seq: 6, data: { turn: 1, step: 1 } },
  { type: 'assistant/message', seq: 7, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '内部思考，不该出现' }, { type: 'text', text: '好的，先看数据。' }] } } },
  { type: 'tool/call', seq: 8, data: { name: 'pwsh', turn: 1, arguments: { command: 'Get-ChildItem' } } },
  { type: 'tool/result', seq: 9, data: { name: 'pwsh', turn: 1, result: '一万行输出，必须丢掉' } },
  { type: 'todo/write', seq: 10, data: { todos: [
    { content: '排查未分组根因', status: 'completed' },
    { content: '清理游离会话', status: 'in_progress' },
    { content: '写成因报告', status: 'pending' },
  ] } },
  { type: 'team/task', seq: 11, data: { version: 2, teamId: sessionId, task: { id: 'task-1', revision: 1, subject: '清理未分组', description: '', status: 'pending', ownerName: 'ungrouped-fix' } } },
  { type: 'team/member', seq: 12, data: { version: 2, teamId: sessionId, member: { id: 'm1', name: 'ungrouped-fix', description: '清理', phase: 'active' } } },
  { type: 'turn/start', seq: 20, data: { turn: 2 } },
  { type: 'user/message', seq: 22, data: { source: { kind: 'user' }, content: [{ type: 'text', text: '第二个要求：顺便加个硬门' }] } },
  // A steering injection: also a user/message, but NOT a user requirement.
  { type: 'user/message', seq: 25, data: { source: { kind: 'steering' }, content: [{ type: 'text', text: '打断注入，不属于时间线' }] } },
  { type: 'todo/write', seq: 30, data: { todos: [
    { content: '排查未分组根因', status: 'completed' },
    { content: '清理游离会话', status: 'completed' },
    { content: '把硬门注入归档插件', status: 'in_progress' },
  ] } },
  { type: 'team/task', seq: 31, data: { version: 2, teamId: sessionId, task: { id: 'task-1', revision: 3, subject: '清理未分组', description: '', status: 'completed', ownerName: 'ungrouped-fix' } } },
  { type: 'team/task', seq: 32, data: { version: 2, teamId: sessionId, task: { id: 'task-2', revision: 1, subject: '把硬门注入归档插件', description: '', status: 'in_progress', ownerName: 'lead' } } },
  { type: 'assistant/message', seq: 40, data: { turn: 2, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '硬门已经接好了，接下来跑探针。' }] } } },
  { type: 'turn/end', seq: 41, data: { turn: 2 } },
]

const header = JSON.stringify({ type: 'session', version: 4, id: sessionId, cwd, agentPreset: 'dsh-plugin-master' })
const frames = [zlib.zstdCompressSync(Buffer.from(header + '\n', 'utf8'))]
for (const event of events) {
  frames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
}
writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), Buffer.concat(frames))

// ---------------------------------------------------------------------------
// A. The helpers the brief is built from
// ---------------------------------------------------------------------------

console.log('\n=== helpers ===\n')

ok('clipText collapses CRLF and trims', clipText('a\r\nb  ', 100) === 'a\nb', JSON.stringify(clipText('a\r\nb  ', 100)))
ok('clipText marks a truncation with an ellipsis', clipText('abcdefghij', 5).endsWith('…'), JSON.stringify(clipText('abcdefghij', 5)))
ok('clipText never exceeds the limit', clipText('x'.repeat(50), 10).length <= 10, String(clipText('x'.repeat(50), 10).length))
ok('clipText tolerates null', clipText(null, 10) === '', JSON.stringify(clipText(null, 10)))

ok('textBlocksOf joins only text blocks',
  textBlocksOf([{ type: 'reasoning', text: 'NO' }, { type: 'text', text: 'YES' }]) === 'YES',
  JSON.stringify(textBlocksOf([{ type: 'reasoning', text: 'NO' }, { type: 'text', text: 'YES' }])))
ok('textBlocksOf returns empty for a non-array', textBlocksOf(undefined) === '')

// ---------------------------------------------------------------------------
// B. What survives the distillation
// ---------------------------------------------------------------------------

console.log('\n=== digest content ===\n')

const digest = await sessionDigest(sessionId, undefined)
ok('a readable log produces a digest', digest !== null)
ok('the title is taken from the last session/title event', digest?.title === '把侧边栏未分组修好', JSON.stringify(digest?.title))
ok('the cwd is carried over', digest?.cwd === cwd, JSON.stringify(digest?.cwd))
ok('the transcript path is carried over so the reader can dig deeper',
  typeof digest?.transcriptPath === 'string' && digest.transcriptPath.endsWith('session.v4.jsonl.zstd'),
  JSON.stringify(digest?.transcriptPath))
ok('the turn count is the highest turn/start, not the number of turn/start frames',
  digest?.turns === 2, String(digest?.turns))

// 🔴 THE CORE PROMISE: every requirement the user typed is on the timeline.
ok('every real user message is on the timeline',
  digest?.userMessageCount === 2, String(digest?.userMessageCount))
ok('the timeline keeps the requirements in order and in full',
  digest?.timeline?.map((item) => item.text).join(' | ') === '第一个要求：修未分组 | 第二个要求：顺便加个硬门',
  JSON.stringify(digest?.timeline?.map((item) => item.text)))
ok('the timeline records which turn each requirement belongs to',
  digest?.timeline?.map((item) => item.turn).join(',') === '1,2',
  JSON.stringify(digest?.timeline?.map((item) => item.turn)))

// 🔴 A steering injection is a user/message too; counting it would invent a
// requirement the user never made.
ok('a steering injection is NOT counted as a user requirement',
  !digest?.timeline?.some((item) => item.text.includes('打断注入')),
  JSON.stringify(digest?.timeline?.map((item) => item.text)))

// 🔴 THE OTHER CORE PROMISE: the task progress line survives.
ok('the NEWEST todo snapshot wins over earlier ones',
  digest?.todos?.length === 3 && digest.todos[2].content === '把硬门注入归档插件',
  JSON.stringify(digest?.todos))
ok('todo progress is summarised as counts',
  digest?.todoSummary?.completed === 2 && digest.todoSummary.inProgress === 1 && digest.todoSummary.pending === 0,
  JSON.stringify(digest?.todoSummary))
ok('the in-progress item is named, so the brief can say "carry on from here"',
  digest?.todoSummary?.current === '把硬门注入归档插件', JSON.stringify(digest?.todoSummary?.current))

ok('team tasks are de-duplicated to the highest revision per id',
  digest?.teamTasks?.length === 2, JSON.stringify(digest?.teamTasks?.map((task) => `${task.id}@${task.revision}`)))
ok('a completed team task reports its final status',
  digest?.teamTasks?.find((task) => task.id === 'task-1')?.status === 'completed',
  JSON.stringify(digest?.teamTasks?.find((task) => task.id === 'task-1')))
ok('team members are carried over', digest?.teamMembers?.length === 1 && digest.teamMembers[0].name === 'ungrouped-fix',
  JSON.stringify(digest?.teamMembers))
ok('the team summary names the in-progress task',
  digest?.teamSummary?.current === '把硬门注入归档插件', JSON.stringify(digest?.teamSummary))

ok('the last assistant reply is carried over', digest?.lastAssistant === '硬门已经接好了，接下来跑探针。', JSON.stringify(digest?.lastAssistant))

// ---------------------------------------------------------------------------
// C. What must be dropped
// ---------------------------------------------------------------------------

console.log('\n=== what the brief must NOT contain ===\n')

const prompt = String(digest?.prompt ?? '')
ok('the brief drops reasoning blocks', !prompt.includes('内部思考，不该出现'))
ok('the brief drops tool results', !prompt.includes('一万行输出，必须丢掉'))
ok('the brief drops tool arguments', !prompt.includes('Get-ChildItem'))
ok('the brief counts tool calls instead of quoting them', digest?.toolCallCount === 1, String(digest?.toolCallCount))

// ---------------------------------------------------------------------------
// D. The brief is a usable handover document
// ---------------------------------------------------------------------------

console.log('\n=== brief shape ===\n')

ok('the brief opens with the conversation title', prompt.startsWith('# 继续对话：把侧边栏未分组修好'), JSON.stringify(prompt.slice(0, 40)))
ok('the brief states the session id so the original can be found',
  prompt.includes(sessionId), 'missing session id')
ok('the brief states the transcript path', prompt.includes('session.v4.jsonl.zstd'))
ok('the brief states the working directory', prompt.includes(cwd))
ok('the brief has a requirement timeline section', prompt.includes('## 用户要求时间线'))
ok('the brief has a task progress section', prompt.includes('## 任务进度清单'))
ok('the brief has a team task section', prompt.includes('## 团队任务'))
ok('the brief has a recent-progress section', prompt.includes('## 最近进展'))
ok('the brief tells the new assistant to carry on rather than restart', prompt.includes('不要从头重做已经完成的工作'))
ok('the brief tells the new assistant not to recite the handover', prompt.includes('不要复述这份交接资料'))
ok('the brief names the in-progress todo as the place to resume',
  prompt.includes('把硬门注入归档插件'), 'in-progress item missing from the brief')
ok('the brief marks todo status with checkboxes',
  prompt.includes('[x] 排查未分组根因') && prompt.includes('[~] 把硬门注入归档插件'),
  JSON.stringify(prompt.split('\n').filter((line) => line.includes('[x]') || line.includes('[~]')).slice(0, 3)))
ok('the brief never exceeds the prompt budget',
  prompt.length <= host.__internals.DIGEST_PROMPT_BUDGET,
  String(prompt.length))

// ---------------------------------------------------------------------------
// E. Failure and budget behaviour
// ---------------------------------------------------------------------------

console.log('\n=== edges ===\n')

ok('an unknown session yields null instead of throwing',
  (await sessionDigest('session-00000000-0000-0000-0000-000000000000', undefined)) === null)
ok('the per-message clip is 600 characters', host.__internals.DIGEST_MESSAGE_CLIP === 600,
  String(host.__internals.DIGEST_MESSAGE_CLIP))
ok('the prompt budget is 24000 characters', host.__internals.DIGEST_PROMPT_BUDGET === 24000,
  String(host.__internals.DIGEST_PROMPT_BUDGET))

// A long conversation must be thinned, not silently truncated mid-sentence:
// the brief has to SAY that a gap exists.
const longSessionId = 'session-aaaaaaaa-1111-2222-3333-444444444444'
const longDir = join(sessions, projectDirName(cwd), bareId(longSessionId))
mkdirSync(longDir, { recursive: true })
const longEvents = [{ type: 'session/title', seq: 1, data: { title: '很长很长的一段对话' } }]
let seq = 10
for (let turn = 1; turn <= 60; turn += 1) {
  longEvents.push({ type: 'turn/start', seq: seq++, data: { turn } })
  longEvents.push({
    type: 'user/message',
    seq: seq++,
    data: { source: { kind: 'user' }, content: [{ type: 'text', text: `第 ${turn} 条要求：${'很长的描述'.repeat(40)}` }] },
  })
}
const longFrames = [zlib.zstdCompressSync(Buffer.from(JSON.stringify({ type: 'session', version: 4, id: longSessionId, cwd }) + '\n', 'utf8'))]
for (const event of longEvents) longFrames.push(zlib.zstdCompressSync(Buffer.from(JSON.stringify(event) + '\n', 'utf8')))
writeFileSync(join(longDir, 'session.v4.jsonl.zstd'), Buffer.concat(longFrames))

const longDigest = await sessionDigest(longSessionId, undefined)
ok('a 60-requirement conversation still produces a digest', longDigest !== null)
ok('an over-long timeline is thinned', longDigest?.timelineTruncated === true, String(longDigest?.timelineTruncated))
ok('the thinned timeline keeps the earliest requirements',
  longDigest?.timeline?.[0]?.text.includes('第 1 条要求'), JSON.stringify(longDigest?.timeline?.[0]?.text?.slice(0, 20)))
ok('the thinned timeline keeps the most recent requirements',
  longDigest?.timeline?.[longDigest.timeline.length - 1]?.text.includes('第 60 条要求'),
  JSON.stringify(longDigest?.timeline?.[longDigest.timeline.length - 1]?.text?.slice(0, 20)))
ok('the brief announces that the middle was omitted',
  String(longDigest?.prompt ?? '').includes('已省略中间'), 'no gap notice')
ok('a thinned brief still fits the budget',
  String(longDigest?.prompt ?? '').length <= host.__internals.DIGEST_PROMPT_BUDGET,
  String(longDigest?.prompt?.length))

// ---------------------------------------------------------------------------
// F. Static contract: the client half wires the feature the safe way
// ---------------------------------------------------------------------------

console.log('\n=== client contract ===\n')

const { readFileSync } = await import('node:fs')
const bundleSource = readFileSync(join(here, '..', 'lib', 'client.js'), 'utf8')

ok('the menu row is registered', bundleSource.includes('id: "aff-continue"'))
ok('the menu row is ordered next to the other handover row',
  bundleSource.includes('id: "aff-continue",\n              order: 520'), 'order 520 not found')
ok('the digest route is called before anything is created',
  bundleSource.includes('api("/session-digest"'), 'digest call missing')
// 🔴 The safety property: reading the brief must not create a session. Prove the
// creation call sits inside `onConfirm`, i.e. after the dialog was shown.
const continueBody = bundleSource.slice(bundleSource.indexOf('function continueInNewWindow'))
const confirmIndex = continueBody.indexOf('onConfirm')
const createIndex = continueBody.indexOf('sessions.create')
ok('the new session is created only inside the confirm callback',
  confirmIndex >= 0 && createIndex > confirmIndex, `confirm@${confirmIndex} create@${createIndex}`)
ok('the new session inherits the agent preset', continueBody.includes('payload.agentPreset = preset'))
ok('the new session is named 新对话-<original title>', continueBody.includes('"新对话-" + (title || "未命名")'))
// The wire contract for session/prompt validates `content` as an array of
// content blocks; a bare string is rejected with gateway/input-invalid. Lock in
// the wrapping so this regression cannot come back.
ok('the brief is sent through the official prompt path',
  bundleSource.includes('session.prompt(blocks, "queue")'), 'prompt call missing')
ok('the brief is wrapped into a text content block before sending',
  bundleSource.includes('typeof content === "string" ? [{ type: "text", text: content }] : content'),
  'string-to-blocks wrapping missing')
ok('the confirm button of a create-only dialog is not painted red',
  continueBody.includes('confirmDanger: false'))

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

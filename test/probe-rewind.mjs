// Probe for the 0.39.0 in-session rewind (`POST /session-rewind`).
//
// WHY THIS EXISTS: until 0.38.x, "撤销这一轮 / 删除这条消息 / 编辑后重发" all
// forked a child session at `beforeSeq` and then deleted the original. That
// worked, but it threw away the session id — and with it the entire prompt
// cache. Measured on this machine: a 260k-token prefix went from 99.6% cached
// to 2.5% cached, and the first byte from ~5.7s to 14.5s. Every undo paid it.
//
// 0.39.0 instead appends ONE surface node carrying
// `surfaceOp: {op:'replace', startSeq, endSeq}` — the same mechanism the
// official `/compact` uses. The log is untouched, the session id survives, the
// prefix stays warm. That is a load-bearing claim about someone else's
// validator, so it is tested here rather than asserted in prose.
//
// 0.39.3 CORRECTION: that node used to be a `system/message`, which the v4
// lifecycle validator only accepts while a turn AND a step are open. An undo is
// appended after `turn/end`, so the file wrote fine and then FAILED TO LOAD —
// one user lost access to a whole conversation
// ("system/message does not match an open turn and step"). The node is now a
// `user/message`, the only surface type a replace may use outside a turn.
// Section 7b mirrors that lifecycle validator and goes red if anyone
// reintroduces a turn-bound type here.
//
// TWO LAYERS:
//   1. `rewindSession` itself, driven against a stub live Session — every
//      refusal path and the exact `append` arguments.
//   2. A LOCAL MIRROR of the official surface planner rules
//      (`@deepseek-ai/dsh-session` → `lib/types/surface.js`, functions
//      `planSurfaceEvent` :384 / `replacementRange` :301 /
//      `assertSourceEventReferences` :221 / `assertSystemHeadRewrite` :373 /
//      `deriveEventMessage` :218), applied to the marker we actually build.
//      The real module cannot be imported here: this repo ships no
//      node_modules and the package lives inside app.asar. The mirror is
//      deliberately narrow — it only covers what a rewind marker exercises —
//      and every rule cites the line it copies so drift is checkable.
//
// Run: node test/probe-rewind.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const hostPath = join(here, '..', 'lib', 'index.js')
const clientPath = join(here, '..', 'lib', 'client.js')

let pass = 0
let fail = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; failures.push(label + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : '')) }
}

const host = await import('../lib/index.js')
const { rewindSession, lastTurnNumber, bareId } = host.__internals

// ---------------------------------------------------------------------------
// Stub live Session
//
// The real one is a class inside app.asar. `rewindSession` only ever touches
// `surface.nodes`, `eventAt(seq)`, `log`, and `append(type, data, opts)`, so a
// stub with exactly those members is a faithful seam: anything the host code
// reaches for that the real Session does not have would also be missing here.
// ---------------------------------------------------------------------------

function makeSession({ nodes, log, headType = 'system/message', appendThrows = null }) {
  const appended = []
  // `eventAt(seq)` is `this.log[seq]` in the real Session, so the stub reads the
  // log too. A rewind marker appended by a previous call must therefore be
  // findable here for the idempotency check to be exercised honestly.
  const bySeq = new Map()
  for (const event of log) if (typeof event?.seq === 'number') bySeq.set(event.seq, event)
  return {
    log,
    surface: { nodes },
    eventAt: (seq) => bySeq.get(seq) ?? { type: seq === nodes[0] ? headType : 'user/message' },
    append(type, data, opts) {
      if (appendThrows) throw new Error(appendThrows)
      appended.push({ type, data, opts })
    },
    appended,
  }
}

function makeCtx({ live = null, status = null, flushed = [] } = {}) {
  return {
    get(name) {
      if (name === 'sessions') {
        return {
          get: (id) => (live && id === live.id ? live : live),
          flush: async (session) => { flushed.push(session) },
        }
      }
      if (name === 'agents') return { get: () => ({ status }) }
      return null
    },
  }
}

// A realistic tail: the system prompt at seq 0, then surface nodes for three
// turns, with trace-only events (turn/start, step/*, tool traffic) interleaved
// in the log — which is exactly the shape that makes seq != index.
const LOG = [
  { type: 'system/message', seq: 0 },
  { type: 'turn/start', seq: 1, data: { turn: 1 } },
  { type: 'user/message', seq: 2 },
  { type: 'step/start', seq: 3 },
  { type: 'tool/call', seq: 4 },
  { type: 'assistant/message', seq: 5 },
  { type: 'user/message', seq: 6 },
  { type: 'turn/start', seq: 7, data: { turn: 2 } },
  { type: 'step/start', seq: 8 },
  { type: 'assistant/message', seq: 9 },
]
// Only the message-producing events are surface nodes; the trace events sit in
// the log but never in the surface. That is the whole reason `startSeq` must be
// looked up in `surface.nodes` rather than assumed equal to an index.
const NODES = [0, 2, 5, 6, 9]

// ---------------------------------------------------------------------------
// 1. Refusal paths
// ---------------------------------------------------------------------------

{
  // No live session: the persistence layer has no entry point that can write an
  // event without a resident Session, so the client must open the chat first.
  const result = await rewindSession('session-aaaa', 5, makeCtx({ live: null }))
  ok('a session that is not resident is refused', result.ok === false && result.code === 'not-resident', JSON.stringify(result))
  ok('that refusal is a 409, not a 500', result.status === 409, String(result.status))
  ok('the refusal explains itself in the user\'s language', /先打开/.test(result.error ?? ''), result.error)
}

{
  const live = makeSession({ nodes: NODES, log: LOG })
  const result = await rewindSession('session-aaaa', 5, makeCtx({ live, status: 'running' }))
  ok('a session mid-turn is refused', result.ok === false && result.code === 'running', JSON.stringify(result))
  ok('nothing is appended when the turn is still publishing', live.appended.length === 0, String(live.appended.length))
}

{
  // `ctx.get('agents')` throwing must not turn a rewind into a 500.
  const live = makeSession({ nodes: NODES, log: LOG })
  const ctx = { get: (name) => { if (name === 'agents') throw new Error('no agents seat'); return { get: () => live, flush: async () => {} } } }
  const result = await rewindSession('session-aaaa', 5, ctx)
  ok('an exploding agents seat is treated as "not running"', result.ok === true && result.changed === true, JSON.stringify(result))
}

// ---------------------------------------------------------------------------
// 2. Nothing-to-do paths (idempotent, never an error)
// ---------------------------------------------------------------------------

{
  const live = makeSession({ nodes: [], log: [] })
  const result = await rewindSession('session-aaaa', 5, makeCtx({ live }))
  ok('an empty surface is a no-op', result.ok === true && result.changed === false && result.reason === 'empty-surface', JSON.stringify(result))
}

{
  const live = makeSession({ nodes: NODES, log: LOG })
  const result = await rewindSession('session-aaaa', 9, makeCtx({ live }))
  ok('a boundary at the last node is a no-op', result.ok === true && result.changed === false && result.reason === 'nothing-after-boundary', JSON.stringify(result))
  ok('a no-op appends nothing', live.appended.length === 0, String(live.appended.length))
}

{
  // A boundary seq carried over from a log that has since changed: no surface
  // node sits at or before it. Shadowing the whole conversation is never what
  // the user asked for, so refuse instead of obeying.
  const live = makeSession({ nodes: [5, 6, 9], log: LOG })
  const result = await rewindSession('session-aaaa', 2, makeCtx({ live }))
  ok('a boundary no surface node sits at is refused, not obeyed', result.ok === false && result.code === 'stale-boundary', JSON.stringify(result))
  ok('a stale boundary appends nothing', live.appended.length === 0, String(live.appended.length))
}

{
  // Boundary -1 is what `turnInfo` reports for turn 1: everything after it goes,
  // except the system prompt, which must survive or the session loses its rules.
  const live = makeSession({ nodes: [0], log: [{ type: 'system/message', seq: 0 }] })
  const result = await rewindSession('session-aaaa', -1, makeCtx({ live }))
  ok('a surface holding only the system prompt is a no-op', result.ok === true && result.changed === false && result.reason === 'only-the-system-prompt-remains', JSON.stringify(result))
  ok('the system prompt is never shadowed', live.appended.length === 0, String(live.appended.length))
}

{
  const live = makeSession({ nodes: NODES, log: LOG })
  const result = await rewindSession('session-aaaa', -1, makeCtx({ live }))
  const shadowed = live.appended[0]?.opts?.sourceEventSeqs ?? []
  ok('boundary -1 keeps the system prompt out of the shadowed set', shadowed[0] !== 0 && result.startSeq === 2, JSON.stringify(shadowed))
  ok('boundary -1 shadows everything else', JSON.stringify(shadowed) === JSON.stringify([2, 5, 6, 9]), JSON.stringify(shadowed))
}

// ---------------------------------------------------------------------------
// 3. The happy path: exact `append` arguments
// ---------------------------------------------------------------------------

{
  const live = makeSession({ nodes: NODES, log: LOG })
  const flushed = []
  const result = await rewindSession('session-bbbb', 5, makeCtx({ live, flushed }))

  ok('a rewind at seq 5 reports success', result.ok === true && result.changed === true, JSON.stringify(result))
  ok('it shadows exactly the nodes after the boundary', JSON.stringify(live.appended[0]?.opts?.sourceEventSeqs) === JSON.stringify([6, 9]), JSON.stringify(live.appended[0]?.opts?.sourceEventSeqs))
  ok('startSeq is the first shadowed node', result.startSeq === 6, String(result.startSeq))
  ok('endSeq is the last shadowed node', result.endSeq === 9, String(result.endSeq))
  ok('the shadowed count is reported for the toast', result.shadowed === 2, String(result.shadowed))

  ok('the appended event is a user/message (system/message would not load)', live.appended[0]?.type === 'user/message', String(live.appended[0]?.type))
  ok('it is a surface replace', live.appended[0]?.opts?.surfaceOp?.op === 'replace', JSON.stringify(live.appended[0]?.opts?.surfaceOp))
  ok('the replace range matches the shadowed range',
    live.appended[0]?.opts?.surfaceOp?.startSeq === 6 && live.appended[0]?.opts?.surfaceOp?.endSeq === 9,
    JSON.stringify(live.appended[0]?.opts?.surfaceOp))

  const message = live.appended[0]?.data ?? {}
  ok('the marker carries an id (the validator rejects an unidentified message)', typeof message.id === 'string' && message.id !== '', JSON.stringify(message.id))
  ok('the marker id names the session and the range start',
    typeof message.id === 'string' && message.id.startsWith('rewind-' + bareId('session-bbbb') + '-6-'), String(message.id))
  ok('the marker role is user (a system role would need an open turn)', message.role === 'user', String(message.role))
  ok('the marker source kind is user (required: non-empty, never "plugin")', message.source?.kind === 'user', JSON.stringify(message.source))
  ok('the marker content is one short text note (an empty-content user turn would be dropped or rejected)',
    Array.isArray(message.content) && message.content.length === 1 && message.content[0]?.type === 'text' && typeof message.content[0]?.text === 'string' && message.content[0].text.length > 0, JSON.stringify(message.content))
  ok('the marker carries no turn/step of its own (it lives outside the turn)',
    live.appended[0]?.data?.turn === undefined && live.appended[0]?.data?.step === undefined, JSON.stringify({ turn: live.appended[0]?.data?.turn, step: live.appended[0]?.data?.step }))
  ok('the session is flushed right after the append', flushed.length === 1, String(flushed.length))
  ok('markerSeq points at the appended event', result.markerSeq === LOG.length, String(result.markerSeq))
}

// ---------------------------------------------------------------------------
// 4. A failed append is reported, not swallowed
// ---------------------------------------------------------------------------

{
  const live = makeSession({ nodes: NODES, log: LOG, appendThrows: 'session append cannot reenter while another append is being published' })
  const result = await rewindSession('session-aaaa', 5, makeCtx({ live }))
  ok('an append failure is an error result', result.ok === false && result.code === 'append-failed', JSON.stringify(result))
  ok('the failure is a 500', result.status === 500, String(result.status))
  ok('the validator message is passed through', /cannot reenter/.test(result.error ?? ''), result.error)
}

// ---------------------------------------------------------------------------
// 5. `lastTurnNumber`
// ---------------------------------------------------------------------------

{
  ok('a session with no turn/start reports turn 0', lastTurnNumber({ log: [] }) === 0, String(lastTurnNumber({ log: [] })))
  ok('it takes the newest turn, not the first', lastTurnNumber({ log: LOG }) === 2, String(lastTurnNumber({ log: LOG })))
  ok('a malformed log cannot throw', lastTurnNumber(null) === 0 && lastTurnNumber({}) === 0, 'null/{}')
  ok('a non-integer turn field is ignored', lastTurnNumber({ log: [{ type: 'turn/start', data: { turn: 'x' } }] }) === 0, 'string turn')
}

// ---------------------------------------------------------------------------
// 6. Local mirror of the official surface planner, applied to the real marker
// ---------------------------------------------------------------------------

// `replacementRange` — surface.js 的 replacementRange. Both endpoints must be current surface
// nodes, and start must not come after end.
function mirrorReplacementRange(nodes, startSeq, endSeq) {
  const startIdx = nodes.indexOf(startSeq)
  const endIdx = nodes.indexOf(endSeq)
  if (startIdx === -1) return { error: 'surface replace: start seq ' + startSeq + ' not found in surface' }
  if (endIdx === -1) return { error: 'surface replace: end seq ' + endSeq + ' not found in surface' }
  if (startIdx > endIdx) return { error: 'surface replace: start seq ' + startSeq + ' is after end seq ' + endSeq }
  return { startIdx, endIdx }
}

// `assertSourceEventReferences` — surface.js 的 assertSourceEventReferences. Every shadowed node must be
// listed, each exactly once, each strictly older than the replacing event.
function mirrorSourceRefs(shadowed, sourceEventSeqs, eventSeq) {
  if (!Array.isArray(sourceEventSeqs) || sourceEventSeqs.length === 0) return { error: 'sourceEventSeqs must be a non-empty array' }
  if (new Set(sourceEventSeqs).size !== sourceEventSeqs.length) return { error: 'sourceEventSeqs contains duplicates' }
  for (const seq of sourceEventSeqs) {
    if (seq >= eventSeq) return { error: 'sourceEventSeqs must reference earlier events (' + seq + ' >= ' + eventSeq + ')' }
  }
  for (const seq of shadowed) {
    if (!sourceEventSeqs.includes(seq)) return { error: 'sourceEventSeqs must include every shadowed surface node; missing ' + seq }
  }
  return {}
}

// `assertSystemHeadRewrite` — surface.js 的 assertSystemHeadRewrite. `if (startIdx !== 0) return;` so a
// tail-only replace is free; touching node 0 requires a single system node.
function mirrorSystemHead(startIdx, nodes, eventAt, eventType) {
  if (startIdx !== 0) return {}
  if (eventAt(nodes[0])?.type !== 'system/message') return { error: 'node 0 is not a system message' }
  if (eventType !== 'system/message') return { error: 'node 0 may only be replaced by a system/message' }
  return {}
}

// `deriveEventMessage` — surface.js 的 deriveEventMessage. Empty system/developer/assistant
// content derives null, i.e. the node keeps its position but contributes no
// wire message — that is how the shadowed turns leave the context.
// `user/message` is the exception: it derives its data even when empty.
function mirrorDeriveMessage(event) {
  const message = event.type === 'user/message' ? event.data : event.data?.message
  if (event.type !== 'user/message') {
    const content = message?.content
    if (Array.isArray(content) && content.length === 0) return null
  }
  return message
}

{
  const live = makeSession({ nodes: NODES, log: LOG })
  const result = await rewindSession('session-cccc', 5, makeCtx({ live }))
  const marker = live.appended[0]
  const eventAt = (seq) => live.eventAt(seq)
  const nodesBefore = NODES
  const eventSeq = LOG.length
  const shadowed = marker.opts.sourceEventSeqs

  const range = mirrorReplacementRange(nodesBefore, marker.opts.surfaceOp.startSeq, marker.opts.surfaceOp.endSeq)
  ok('the marker range resolves against the live surface', range.error === undefined, range.error)
  ok('the range ends at the last surface node', range.endIdx === nodesBefore.length - 1, String(range.endIdx))

  const refs = mirrorSourceRefs(shadowed, marker.opts.sourceEventSeqs, eventSeq)
  ok('every shadowed node is referenced exactly once', refs.error === undefined, refs.error)

  const head = mirrorSystemHead(range.startIdx, nodesBefore, eventAt, marker.type)
  ok('a tail-only replace never trips the node-0 rule', head.error === undefined, head.error)

  // Fold, the way `applySurfacePlan` (surface.js 的 applySurfacePlan) does it.
  const folded = [
    ...nodesBefore.slice(0, range.startIdx),
    eventSeq,
    ...nodesBefore.slice(range.endIdx + 1),
  ]
  ok('the folded surface keeps the system prompt and the boundary', JSON.stringify(folded) === JSON.stringify([0, 2, 5, eventSeq]), JSON.stringify(folded))
  ok('the fold drops every shadowed node', folded.filter((seq) => shadowed.includes(seq)).length === 0, JSON.stringify(folded))

  const derived = mirrorDeriveMessage({ type: marker.type, data: marker.data })
  ok('the marker derives one short user note so the model learns the tail was withdrawn',
    derived !== null && derived.role === 'user' && derived.content?.[0]?.type === 'text', JSON.stringify(derived))
  ok('the boundary message still derives (it is what the model sees last)',
    mirrorDeriveMessage({ type: 'user/message', data: { role: 'user', content: [{ type: 'text', text: 'hi' }], source: { kind: 'user' }, id: 'u1' } }) !== null, 'expected a message')
  ok('the legacy empty system marker still derives nothing (old logs keep working)',
    mirrorDeriveMessage({ type: 'system/message', data: { message: { role: 'system', content: [] } } }) === null, 'expected null')

  // Negative controls: the mirror must actually reject the mistakes a future
  // edit could make, otherwise the green above proves nothing.
  ok('the mirror rejects a range whose start is not a surface node',
    mirrorReplacementRange(nodesBefore, 7, 9).error !== undefined, 'start=7 (trace-only event)')
  ok('the mirror rejects a reversed range',
    mirrorReplacementRange(nodesBefore, 9, 6).error !== undefined, 'start=9 end=6')
  ok('the mirror rejects an incomplete shadow list',
    mirrorSourceRefs([6, 9], [6], eventSeq).error !== undefined, 'missing 9')
  ok('the mirror rejects a reference to the marker itself',
    mirrorSourceRefs([6, 9], [6, 9, eventSeq], eventSeq).error !== undefined, 'self-reference')
  ok('the mirror rejects duplicate references',
    mirrorSourceRefs([6, 9], [6, 9, 9], eventSeq).error !== undefined, 'duplicate 9')
  ok('the mirror rejects a non-system rewrite of node 0',
    mirrorSystemHead(0, nodesBefore, eventAt, 'user/message').error !== undefined, 'user/message over node 0')
  ok('the mirror accepts a system rewrite of node 0',
    mirrorSystemHead(0, nodesBefore, eventAt, 'system/message').error === undefined, 'system/message over node 0')
}

// ---------------------------------------------------------------------------
// 7. Nested rewinds: a second rewind must fold onto the marker, not resurrect
// ---------------------------------------------------------------------------

{
  const live = makeSession({ nodes: NODES, log: LOG })
  await rewindSession('session-dddd', 5, makeCtx({ live }))
  const first = live.appended[0]
  const markerSeq = LOG.length

  // The surface after the first rewind is [0, 2, 5, marker], and the marker
  // event now sits in the log at `markerSeq`. A second click at the same
  // boundary sees only that marker after the boundary — it must recognise it
  // and do nothing, otherwise every click stacks another empty node.
  const markerEvent = {
    type: 'user/message',
    seq: markerSeq,
    data: first.data,
    surfaceOp: first.opts.surfaceOp,
    sourceEventSeqs: first.opts.sourceEventSeqs,
  }
  const foldedAfterFirst = [0, 2, 5, markerSeq]
  const live2 = makeSession({ nodes: foldedAfterFirst, log: [...LOG, markerEvent] })
  const second = await rewindSession('session-dddd', 5, makeCtx({ live: live2 }))
  ok('a repeated rewind at the same boundary is a no-op, not a double-append',
    second.changed === false && second.reason === 'already-rewound', JSON.stringify(second))
  ok('the repeated rewind appends nothing', live2.appended.length === 0, String(live2.appended.length))
  ok('the first marker is still in the surface', foldedAfterFirst.includes(markerSeq), JSON.stringify(foldedAfterFirst))
  ok('the first marker was a replace, so no new surface node was created for the log',
    first.opts.surfaceOp.op === 'replace', JSON.stringify(first.opts.surfaceOp))

  // Negative control: a genuinely new turn after the marker is NOT a marker, so
  // the guard must let that rewind through.
  const newTurn = { type: 'user/message', seq: markerSeq + 1 }
  const live3 = makeSession({ nodes: [...foldedAfterFirst, newTurn.seq], log: [...LOG, markerEvent, newTurn] })
  const third = await rewindSession('session-dddd', 5, makeCtx({ live: live3 }))
  ok('a real new turn after the marker is still rewound',
    third.changed === true && third.startSeq === markerSeq && third.endSeq === newTurn.seq, JSON.stringify(third))
}

// ---------------------------------------------------------------------------
// 7b. The v4 LIFECYCLE gate — the exact bug that broke a real conversation
// ---------------------------------------------------------------------------
//
// This is the gate 0.39.0-0.39.2 failed. A log that violates it is refused when
// it is LOADED, not when it is written, so a bad append looks fine and then the
// conversation will not open at all. Mirrored from
// @deepseek-ai/dsh-session-persistence-jsonl/lib/worker.cjs:
//   STEP_EVENT_TYPES @11946, accept() @12193, requireStep @12027,
//   turn/start @12201, turn/end @12207, step/start @12213, step/end @12216,
//   assistant/message|tool/call|tool/result -> tool() -> requireTurn @12074.

const STEP_TYPES = new Set(['system/message', 'developer/message', 'assistant/attempt'])

function mirrorLifecycle(events) {
  let turn = null
  let step = null
  let nextTurn = 1
  let nextStep = 1
  const fail = (event, why) => ({ error: why, seq: event?.seq })
  for (const event of events) {
    const data = event.data ?? {}
    if (STEP_TYPES.has(event.type)) {
      if (turn === null || step === null || data.turn !== turn || data.step !== step) {
        return fail(event, event.type + ' does not match an open turn and step')
      }
    }
    switch (event.type) {
      case 'turn/start':
        if (turn !== null || data.turn !== nextTurn) return fail(event, 'turn/start does not open the expected turn')
        turn = nextTurn
        nextStep = 1
        break
      case 'turn/end':
        if (turn === null || data.turn !== turn || step !== null) return fail(event, 'turn/end does not match the open turn with no open step')
        turn = null
        nextTurn += 1
        break
      case 'step/start':
        if (turn === null || data.turn !== turn || step !== null || data.step !== nextStep) return fail(event, 'step/start does not match the open turn and next step')
        step = nextStep
        break
      case 'step/end':
        if (turn === null || step === null || data.turn !== turn || data.step !== step) return fail(event, 'step/end does not match the open turn and step')
        step = null
        nextStep += 1
        break
      case 'assistant/message':
      case 'tool/call':
      case 'tool/result':
        if (turn === null) return fail(event, event.type + ' is outside an open turn')
        if (event.type === 'assistant/message' && (step === null || data.turn !== turn || data.step !== step)) {
          return fail(event, 'assistant/message does not match an open turn and step')
        }
        break
      default:
        break
    }
  }
  return {}
}

{
  // A legal tail: one user turn, fully opened and closed. No system/message head:
  // in DSH the system prompt is per-request, and a session-level system/message
  // outside a turn would be refused by the same gate.
  const before = [
    { type: 'user/message', seq: 0, data: { role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user' }, id: 'u1' } },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    { type: 'step/start', seq: 2, data: { turn: 1, step: 1 } },
    { type: 'assistant/message', seq: 3, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: 'ok' }] } } },
    { type: 'step/end', seq: 4, data: { turn: 1, step: 1 } },
    { type: 'turn/end', seq: 5, data: { turn: 1 } },
  ]
  ok('the mirror accepts a well-formed closed turn', mirrorLifecycle(before).error === undefined, mirrorLifecycle(before).error)

  const live = makeSession({ nodes: NODES, log: LOG })
  await rewindSession('session-eeee', 5, makeCtx({ live }))
  const marker = live.appended[0]
  const asLog = { type: marker.type, seq: 6, data: marker.data, surfaceOp: marker.opts.surfaceOp, sourceEventSeqs: marker.opts.sourceEventSeqs }
  const after = [...before, asLog]

  const verdict = mirrorLifecycle(after)
  ok('an undo appended after turn/end still passes the v4 lifecycle gate', verdict.error === undefined, JSON.stringify(verdict))

  // Negative control: the 0.39.2 shape — same intent, typed system/message —
  // must be refused, otherwise the green above proves nothing.
  const systemShape = { type: 'system/message', seq: 6, data: { turn: 1, step: 1, message: { role: 'system', content: [], source: { kind: 'system-prompt' }, id: 'rewind-x-6' } } }
  const bad = mirrorLifecycle([...before, systemShape])
  ok('the old system/message marker is rejected outside an open turn', bad.error !== undefined, JSON.stringify(bad))
  ok('...and the rejection is the exact production error',
    bad.error === 'system/message does not match an open turn and step', String(bad.error))

  ok('the marker really is a user/message', marker.type === 'user/message', String(marker.type))
  ok('the host no longer appends a system/message for a rewind',
    !readFileSync(hostPath, 'utf8').includes("live.append('system/message'"), 'legacy append still present')
}

// ---------------------------------------------------------------------------
// 8. The route exists, is registered, and is reachable
// ---------------------------------------------------------------------------

{
  const hostSource = readFileSync(hostPath, 'utf8')
  ok('the host registers POST /session-rewind', /['"`]\/session-rewind['"`]/.test(hostSource), 'route literal')
  ok('the route validates the session id before touching anything',
    /sessionId required/.test(hostSource), 'missing guard')
  ok('the route validates beforeSeq', /invalid beforeSeq/.test(hostSource), 'missing guard')
  ok('the route maps a failed rewind onto its HTTP status', /result\.status \?\? 500/.test(hostSource), 'status mapping')
  ok('the host exports the rewind seam for probing',
    typeof host.__internals.rewindSession === 'function' && typeof host.__internals.lastTurnNumber === 'function', 'internals')
  ok('the host never reads an undeclared ctx property for this feature',
    !/\bctx\.(sessions|agents)\b/.test(hostSource), 'direct ctx.<service> read')
}

// ---------------------------------------------------------------------------
// 9. The client stopped forking
// ---------------------------------------------------------------------------

{
  const clientSource = readFileSync(clientPath, 'utf8')
  // Comments legitimately NAME the property this probe forbids (the host-side
  // note explains why `ctx.get` is used instead), so scan code only.
  const clientCode = clientSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')

  ok('the client calls the rewind route', /ROUTE \+ '\/session-rewind'/.test(clientCode), 'route call')
  ok('the client no longer forks a child to undo', !/sessions\.fork/.test(clientCode), 'fork call')
  ok('the fork helper is gone', !/openTruncatedChild/.test(clientCode), 'helper')
  ok('the client no longer deletes the original session after undoing', !/ROUTE \+ '\/session-replace'/.test(clientCode), 'replace call')
  ok('the undo passes a longer timeout than the default 8s', /postJson\(ROUTE \+ '\/session-rewind', body, 20000\)/.test(clientCode), 'timeout')
  ok('the draft is prefilled through the conversation service, not a localStorage guess',
    /get\('conversation'\)/.test(clientCode) && /setDraft\(text\)/.test(clientCode), 'prefill')
  ok('the prefill falls back instead of throwing',
    /dsh\.conversation\.\$\{sessionId\}/.test(clientCode), 'fallback')
  ok('the client does not read pluginCtx.conversation directly',
    !/pluginCtx\.conversation\b/.test(clientCode), 'undeclared property read')
}

// ---------------------------------------------------------------------------
// 10. Feedback: the user must be able to SEE that a rewind happened
// ---------------------------------------------------------------------------
//
// 0.39.0 shipped a rewind that is invisible on purpose: the old rows stay in
// the window (the chat stream renders append-origin events only) and the
// request returns in ~100 ms with no spinner. The user read that as "clicking
// undo does nothing". 0.39.1 adds two pieces of feedback and this section
// pins both of them down.

{
  const clientSource = readFileSync(clientPath, 'utf8')
  const clientCode = clientSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')

  // --- the toast -----------------------------------------------------------
  ok('toast takes an optional dwell time so a rewind message can stay up',
    /function toast\(message, durationMs\)/.test(clientCode), 'toast signature')
  ok('toast still defaults to 2400 ms for ordinary messages',
    /typeof durationMs === "number" && durationMs > 0 \? durationMs : 2400/.test(clientCode), 'toast default')

  const undoSeg = clientCode.slice(
    clientCode.indexOf('const doUndoTurn = async'),
    clientCode.indexOf('const doDeleteMessage = async')
  )
  const deleteSeg = clientCode.slice(
    clientCode.indexOf('const doDeleteMessage = async'),
    clientCode.indexOf('let busy = false')
  )
  ok('undo reports how many messages it hid', /rewound\.shadowed/.test(undoSeg), 'count in toast')
  ok('undo says the content is kept but the model can no longer see it',
    /模型已不可见/.test(undoSeg) && /原内容保留/.test(undoSeg), 'undo wording')
  ok('delete reports how many messages it hid', /rewound\.shadowed/.test(deleteSeg), 'count in toast')
  ok('delete says the content is kept but the model can no longer see it',
    /模型已不可见/.test(deleteSeg) && /原内容保留/.test(deleteSeg), 'delete wording')
  ok('the rewind toast dwells longer than the default',
    /, 4200\)/.test(undoSeg) && /, 4200\)/.test(deleteSeg), 'dwell time')
  ok('the old wording that hid the count is gone',
    !/已撤销第 \$\{info\.turn\} 轮及其后的对话/.test(clientCode), 'stale wording')

  // --- the grey-out --------------------------------------------------------
  ok('the stylesheet defines the shadowed row style',
    /\.dsh-aff-sd-shadowed \{[^}]*opacity/.test(clientCode), 'css opacity')
  ok('the stylesheet strikes through shadowed human messages',
    /\.dsh-aff-sd-shadowed-msg \{[^}]*text-decoration: line-through/.test(clientCode), 'css strike')
  ok('the shadow style wins over the host row styling',
    /\.dsh-aff-sd-shadowed \{[^}]*opacity: \.[0-9]+ !important/.test(clientCode), 'css specificity')

  // Rows are identified by the host's own stable flow key, never by turn
  // number: after a rewind the user often resends immediately, and the new
  // message can legitimately reuse a turn number the user just discarded.
  ok('shadowed rows are keyed by the host flow key, not by turn number',
    /getAttribute\('data-chat-flow-key'\)/.test(clientCode) && !/data-chat-turn=.\$\{.*\}\].*shadowed/i.test(clientCode),
    'flow key')
  ok('the capture reads the turn it was asked for and nothing earlier',
    /Number\(el\.getAttribute\('data-chat-turn'\)\)/.test(clientCode) && /turn < fromTurn/.test(clientCode), 'turn filter')
  ok('the shadow state is remembered per session',
    /shadowedKeys = new Map\(\)/.test(clientCode), 'per-session map')
  ok('marking is skipped entirely when nothing was ever shadowed',
    /shadowedKeys\.size === 0 && document\.querySelector\('\.dsh-aff-sd-shadowed'\) === null/.test(clientCode), 'fast path')
  ok('a failed rewind does not paint anything grey',
    (() => {
      const commitAt = undoSeg.indexOf('commitShadowedKeys(sessionId, shadowCandidate)')
      const guardAt = undoSeg.indexOf('if (!rewound.changed) throw')
      return commitAt > 0 && guardAt > 0 && commitAt > guardAt
    })(), 'commit order')
  ok('the keys are captured before the request, while the DOM is still whole',
    (() => {
      const capAt = undoSeg.indexOf('captureShadowedKeys(sessionId, info.turn)')
      const callAt = undoSeg.indexOf('await rewindSession(sessionId, info.beforeSeq)')
      return capAt > 0 && callAt > 0 && capAt < callAt
    })(), 'capture order')
  ok('editing and resending also greys out the rows it replaced',
    /captureShadowedKeys\(sessionId, info\.turn\)/.test(clientCode) &&
      clientCode.slice(clientCode.indexOf('const submitEdit = async'), clientCode.indexOf('// 撤销此轮：先取 turn 元信息')).includes('commitShadowedKeys'),
    'edit path')
  ok('the button injector repaints the marks after React wipes the classes',
    (() => {
      const scanAt = clientCode.indexOf('const scan = () =>')
      const applyAt = clientCode.lastIndexOf('applyShadowMarks()')
      return scanAt > 0 && applyAt > scanAt
    })(), 'scan repaint')
  ok('marking never touches a session it cannot identify',
    /if \(!activeId\) return/.test(clientCode), 'unknown session guard')
}

// ---------------------------------------------------------------------------
// 11. Refusals speak: no turn-action click ever dies silently
// ---------------------------------------------------------------------------
//
// guard() used to return null without a word when a request was already in
// flight, or when the current conversation could not be resolved. The user
// clicked the button, nothing happened, and concluded the feature was broken.
// Every refusal now either toasts or paints the button red (or both).

{
  const clientSource = readFileSync(clientPath, 'utf8')
  const clientCode = clientSource
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')

  const guardStart = clientCode.indexOf('const guard = (tag, button) => {')
  const guardEnd = guardStart < 0 ? -1 : clientCode.indexOf('\n      }\n', guardStart)
  const guardBody = guardStart >= 0 && guardEnd > guardStart
    ? clientCode.slice(guardStart, guardEnd)
    : ''

  ok('the guard that gates every turn action is still there',
    guardBody.length > 0, 'guard missing')

  ok('no refusal in the guard is silent any more',
    (() => {
      const parts = guardBody.split('return null')
      if (parts.length < 4) return false
      for (let i = 0; i < parts.length - 1; i += 1) {
        if (!/toast\(|fail\(/.test(parts[i])) return false
      }
      return true
    })(), 'a return null with no toast and no fail')

  ok('a request already in flight tells the user to wait',
    /正在处理上一步/.test(guardBody) && /toast\(/.test(guardBody), 'busy toast')

  ok('an unresolved conversation names the thing to do',
    /找不到当前对话，请先在侧栏点开这条对话再操作/.test(guardBody), 'unknown session message')

  ok('a running session refuses out loud instead of just a red tint',
    /会话正在运行，请等当前回合结束/.test(guardBody) &&
      /toast\(why\.message/.test(guardBody), 'running toast')

  ok('resolving the current conversation cannot throw out of a click handler',
    /try \{[\s\S]{0,40}currentSessionRow\(\)[\s\S]{0,40}catch/.test(guardBody), 'try/catch')
}
// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n=== summary ===')
console.log('  pass: ' + pass)
console.log('  fail: ' + fail)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const failure of failures) console.log('  - ' + failure)
  process.exit(1)
}
console.log('\nALL GREEN\n')

// DOM-stub probe for dsh-archive-favorites-forge client bundle.
//
// WHY THIS EXISTS: `node --check` validates syntax only. It cannot catch a
// wrong slot id, a component that throws on render, a hook used outside a
// component, or a registration that never reaches the slots service. Those are
// exactly the failures that read as "the plugin does nothing" in the app, where
// there is no debugger. So we stub enough DOM + React + slots to run the real
// bundle and assert the observable contract.
//
// Run: node test/probe-client.mjs

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const clientPath = join(here, '..', 'lib', 'client.js')

let pass = 0
let fail = 0
const failures = []

function ok(label, condition, detail) {
  if (condition) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; failures.push(label + (detail ? ' :: ' + detail : '')); console.log('  FAIL  ' + label + (detail ? ' :: ' + detail : '')) }
}

// ---------------------------------------------------------------------------
// Minimal React stand-in.
//
// The bundle uses only createElement, useState, useEffect and useRef. The stub
// records element trees so we can assert what a component returns, and it runs
// useState/useEffect/useRef for real so a component that violates the hook rules
// or crashes on render fails the probe rather than silently rendering nothing.
// ---------------------------------------------------------------------------

let hookSlots = []
let hookCursor = 0
let effectQueue = []

const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat() }
  },
  useState(initial) {
    const slot = hookCursor
    hookCursor += 1
    if (hookSlots[slot] === undefined) hookSlots[slot] = { value: typeof initial === 'function' ? initial() : initial }
    const entry = hookSlots[slot]
    return [entry.value, (next) => {
      entry.value = typeof next === 'function' ? next(entry.value) : next
    }]
  },
  useEffect(fn, deps) {
    hookSlots[hookCursor] = hookSlots[hookCursor] ?? { value: undefined }
    hookCursor += 1
    effectQueue.push(fn)
  },
  // The confirm dialog holds two stable mutable boxes across renders: the dialog
  // element itself (to focus it) and the element that had focus before opening
  // (to restore it on close). Real React keys those boxes to the hook slot, so
  // this stub must too — returning a fresh `{ current: null }` on each render
  // would still "work" for these assertions while quietly breaking focus
  // restoration, which is exactly the kind of regression the probe exists for.
  useRef(initial) {
    const slot = hookCursor
    hookCursor += 1
    if (hookSlots[slot] === undefined) hookSlots[slot] = { value: { current: initial ?? null } }
    return hookSlots[slot].value
  },
}

// ---------------------------------------------------------------------------
// DOM / fetch stubs
// ---------------------------------------------------------------------------

const createdNodes = []
const fetchCalls = []

// ---------------------------------------------------------------------------
// A small but REAL element tree.
//
// The favourites filter walks the DOM: it queries `div[role='menu']`, collects
// `button[role='menuitem']` rows, reads textContent, clones a node and appends
// it to a parent. A stub whose querySelectorAll always returns [] would let the
// whole feature no-op while every assertion still "passed" — so this stub
// implements selector matching and traversal for real.
// ---------------------------------------------------------------------------

function parseSelector(selector) {
  // Supports exactly the forms this plugin uses:
  //   tag | [attr] | [attr='v'] | [attr^='v'] | tag[attr='v'][attr2] |
  //   'a b' (descendant)
  //
  // Two traps this must not fall into, both of which produce a matcher that
  // silently matches EVERYTHING (and therefore breaks idempotence checks):
  //   * a bare `[attr]` with no value must still record the attribute;
  //   * consecutive `[..][..]` groups must all be collected, not just the first.
  return String(selector).trim().split(/\s+(?![^\[]*\])/).map((part) => {
    const attrs = []
    let tag = ''
    // Walk the part character by character so every bracket group is visited.
    let i = 0
    while (i < part.length) {
      const ch = part[i]
      if (ch === '[') {
        const close = part.indexOf(']', i)
        if (close < 0) break
        const expr = part.slice(i + 1, close).trim()
        const valued = /^([a-zA-Z-]+)\s*(\^?=)\s*'([^']*)'$/.exec(expr)
        if (valued) attrs.push({ name: valued[1], op: valued[2], value: valued[3] })
        else if (/^[a-zA-Z-]+$/.test(expr)) attrs.push({ name: expr, op: 'exists', value: null })
        i = close + 1
        continue
      }
      tag += ch
      i += 1
    }
    return { tag: tag || null, attrs }
  })
}

function matchesSimple(node, spec) {
  if (node.nodeType !== 1) return false
  if (spec.tag !== null && node.tagName.toLowerCase() !== spec.tag.toLowerCase()) return false
  for (const attr of spec.attrs) {
    const actual = node.getAttribute(attr.name)
    if (actual === null) return false
    if (attr.op === 'exists') continue
    if (attr.op === '=' && actual !== attr.value) return false
    if (attr.op === '^=' && !actual.startsWith(attr.value)) return false
  }
  return true
}

function matchesSelector(node, selector) {
  const chain = parseSelector(selector)
  if (!matchesSimple(node, chain[chain.length - 1])) return false
  let current = node.parentElement
  for (let i = chain.length - 2; i >= 0; i--) {
    let found = false
    while (current !== null) {
      if (matchesSimple(current, chain[i])) { found = true; current = current.parentElement; break }
      current = current.parentElement
    }
    if (!found) return false
  }
  return true
}

function* walk(node) {
  for (const child of node.childNodes) {
    if (child.nodeType === 1) {
      yield child
      yield* walk(child)
    }
  }
}

function makeNode(tag) {
  const node = {
    nodeType: 1,
    tagName: String(tag).toUpperCase(),
    id: '',
    _ownText: '',
    style: { cssText: '', setProperty() {}, removeProperty() {} },
    dataset: {},
    attributes: {},
    childNodes: [],
    value: '',
    parentElement: null,
    appendChild(child) {
      if (child.parentElement !== null) child.parentElement.removeChild(child)
      this.childNodes.push(child)
      child.parentElement = this
      return child
    },
    removeChild(child) {
      const at = this.childNodes.indexOf(child)
      if (at >= 0) this.childNodes.splice(at, 1)
      child.parentElement = null
      return child
    },
    setAttribute(k, v) { this.attributes[k] = String(v) },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null },
    removeAttribute(k) { delete this.attributes[k] },
    hasAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) },
    addEventListener() {},
    removeEventListener() {},
    select() {},
    dispatchEvent() { return true },
    focus() {},
    contains(other) {
      let cur = other
      while (cur !== null && cur !== undefined) {
        if (cur === this) return true
        cur = cur.parentElement
      }
      return false
    },
    closest(selector) {
      let cur = this
      while (cur !== null && cur.nodeType === 1) {
        if (matchesSelector(cur, selector)) return cur
        cur = cur.parentElement
      }
      return null
    },
    matches(selector) { return matchesSelector(this, selector) },
    querySelector(selector) {
      for (const n of walk(this)) if (matchesSelector(n, selector)) return n
      return null
    },
    querySelectorAll(selector) {
      const out = []
      for (const n of walk(this)) if (matchesSelector(n, selector)) out.push(n)
      return out
    },
    cloneNode() {
      const copy = makeNode(this.tagName)
      copy.id = this.id
      copy._ownText = this._ownText
      copy.attributes = Object.assign({}, this.attributes)
      for (const child of this.childNodes) {
        if (child.nodeType === 1) copy.appendChild(child.cloneNode())
        else {
          const text = { nodeType: 3, textContent: child.textContent, parentElement: copy }
          copy.childNodes.push(text)
        }
      }
      return copy
    },
    get textContent() {
      let text = this._ownText
      for (const child of this.childNodes) text += child.textContent ?? ''
      return text
    },
    set textContent(value) {
      this.childNodes.length = 0
      this._ownText = String(value)
    },
    get children() { return this.childNodes.filter((c) => c.nodeType === 1) },
    // `lastElementChild` locates the official check seat and
    // `nextElementSibling` walks the flat sidebar list; the stub must provide
    // both, or the plugin's structural lookups silently find nothing and the
    // test reports a false failure.
    get lastElementChild() {
      const kids = this.childNodes.filter((c) => c.nodeType === 1)
      return kids.length === 0 ? null : kids[kids.length - 1]
    },
    get nextElementSibling() {
      const parent = this.parentElement
      if (parent === null) return null
      const kids = parent.childNodes.filter((c) => c.nodeType === 1)
      const at = kids.indexOf(this)
      return at < 0 || at + 1 >= kids.length ? null : kids[at + 1]
    },
  }
  createdNodes.push(node)
  return node
}

/**
 * `<div><button role=menuitem><span/>(icon) <span>label</span> [<svg/>](check)</button></div>`
 *
 * The trailing element is a BARE `<svg>`, exactly as the shipped renderer emits
 * it AND ONLY ON THE SELECTED ROW:
 *
 *     selected && selection === "check" && jsx(IconCheckOutlineRegular, { className: check })
 *
 * `selected` models that. A fixture that put a tick on every row would hide the
 * real requirement — that the plugin locate the one selected row to copy the
 * glyph from.
 */
function makeMenuRow(label, selected = false) {
  const wrap = makeNode('div')
  const btn = makeNode('button')
  btn.setAttribute('role', 'menuitem')
  btn.appendChild(makeNode('span'))            // icon seat
  const text = makeNode('span')
  text.textContent = label
  btn.appendChild(text)
  if (selected) btn.appendChild(makeNode('svg'))   // check seat: a bare svg
  wrap.appendChild(btn)
  return wrap
}

/** The official view-options menu, including its three archived-filter rows. */
function makeViewOptionsMenu() {
  const menu = makeNode('div')
  menu.setAttribute('role', 'menu')
  // These are the REAL strings the shipped menu renders: 分组方式 / 排序方式 /
  // 筛选会话 / 手动排序 / 最近更新. An earlier fixture invented "视图选项", which
  // is the trigger's tooltip and never appears in the menu body — so the fixture
  // matched a detector that could never match in production, and the injection
  // bug it should have caught stayed hidden.
  const label = makeNode('div')
  label.textContent = '分组方式'
  menu.appendChild(label)
  const sortGroup = makeNode('div')
  sortGroup.appendChild(makeMenuRow('手动排序', true))     // groupBy selection
  sortGroup.appendChild(makeMenuRow('最近更新'))
  menu.appendChild(sortGroup)
  const filterLabel = makeNode('div')
  filterLabel.textContent = '筛选会话'
  menu.appendChild(filterLabel)
  const group = makeNode('div')
  // Exactly one row is selected, as the harness always has (its `selectedIds`
  // names one entry per group). "隐藏已归档" is the shipped default.
  group.appendChild(makeMenuRow('隐藏已归档', true))
  group.appendChild(makeMenuRow('全部对话（显示已归档）'))
  group.appendChild(makeMenuRow('仅显示已归档'))
  menu.appendChild(group)
  return menu
}

// `document` must itself be a real queryable root: the plugin calls
// `document.querySelectorAll("[data-row-key^='session:']")` and
// `document.documentElement.setAttribute(...)`.
const documentElement = makeNode('html')
const documentStub = Object.assign(makeNode('#document'), {
  readyState: 'complete',
  documentElement,
  head: makeNode('head'),
  body: makeNode('body'),
  activeElement: null,
  createElement: makeNode,
  execCommand() { return true },
})
documentElement.appendChild(documentStub.head)
documentElement.appendChild(documentStub.body)
documentStub.childNodes.push(documentElement)
documentElement.parentElement = null

// Restore a live getElementById (the Object.assign above replaced makeNode's).
documentStub.getElementById = (id) => {
  for (const node of createdNodes) if (node.id === id) return node
  return null
}

// MutationObserver stub: records every instance so the probe can (a) prove the
// enhancer started, (b) drive synthetic mutations through the real callback, and
// (c) observe teardown. Collecting the instance is what makes the injection
// tests meaningful — without it the callback never runs and the feature looks
// like a no-op.
const observers = []
globalThis.MutationObserver = class {
  constructor(callback) { this.callback = callback; this.observing = null; this.disconnected = false; observers.push(this) }
  observe(target, options) { this.observing = { target, options } }
  disconnect() { this.disconnected = true; this.observing = null }
  takeRecords() { return [] }
}

globalThis.document = documentStub
globalThis.window = globalThis
// Node 24 defines `navigator` as a getter-only global, so define the property
// instead of assigning it.
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  writable: true,
  value: { clipboard: { writeText: async () => {} } },
})
if (!globalThis.setTimeout) globalThis.setTimeout = () => 0
if (!globalThis.clearTimeout) globalThis.clearTimeout = () => {}

let capturedLoader = null
globalThis.window.__ModuleLoader__ = {
  load(spec) { capturedLoader = spec },
}

// Settle any pending promise chains (the plugin's fetch handlers, the debounced
// mark scheduler). Real timers are used, so this is a bounded wait rather than a
// fake-clock tick.
async function settle(ms = 120) {
  await new Promise((resolve) => setTimeout(resolve, ms))
}

// Snapshot-usage fixtures. The report shape mirrors lib/snapshot-usage.js.
let snapshotUsageCalls = 0
const snapshotCleanupRequests = []
// The saved policy, mutated by the fake /snapshot-policy route so a test can
// flip the switch and then re-measure against the new value.
let snapshotPolicy = { autoSelect: false, hours: 720 }
const snapshotPolicyWrites = []
const SNAPSHOT_USAGE_REPORT = {
  ok: true,
  generatedAt: '2026-11-01T00:00:00.000Z',
  elapsedMs: 62,
  root: 'C:\\fake\\sessions',
  summary: {
    sessions: 2,
    totalBytes: 11534336,
    totalBlobs: 151,
    totalEntries: 268,
    largest: { sessionId: 'session-big', bytes: 10917809, title: 'Big chat' },
  },
  // The card now shows an AGE per row, needs to know which conversations are
  // starred, and carries the saved policy so a re-scan can re-tick from it.
  // `session-big` is deliberately OLD (40 days) and `session-small` recent,
  // so the pre-tick assertions can tell "old enough" from "not old enough".
  favoriteCount: 1,
  favoriteBytes: 2048,
  policy: { autoSelect: false, hours: 720 },
  entries: [
    {
      sessionId: 'session-big',
      projectName: 'proj',
      dir: 'C:\\fake\\sessions\\proj\\session-big\\history-file',
      bytes: 10917809,
      blobBytes: 10865557,
      blobCount: 143,
      manifestBytes: 52252,
      entryCount: 257,
      skippedCount: 102,
      firstSnapshotAt: 1793264117719,
      lastSnapshotAt: 1793264521739,
      title: 'Big chat',
      lastActivityAt: Date.now() - 40 * 24 * 3600000,
      idleMs: 40 * 24 * 3600000,
      favorite: false,
    },
    {
      sessionId: 'session-small',
      projectName: 'proj',
      dir: 'C:\\fake\\sessions\\proj\\session-small\\history-file',
      bytes: 616527,
      blobBytes: 616000,
      blobCount: 8,
      manifestBytes: 527,
      entryCount: 11,
      skippedCount: 1,
      firstSnapshotAt: 1793264117700,
      lastSnapshotAt: 1793264521700,
      title: 'Small chat',
      lastActivityAt: Date.now() - 15 * 60000,
      idleMs: 15 * 60000,
      favorite: false,
    },
    {
      sessionId: 'session-star',
      projectName: 'proj',
      dir: 'C:\\fake\\sessions\\proj\\session-star\\history-file',
      bytes: 2048,
      blobBytes: 2000,
      blobCount: 1,
      manifestBytes: 48,
      entryCount: 1,
      skippedCount: 0,
      firstSnapshotAt: 1793264117700,
      lastSnapshotAt: 1793264521700,
      title: 'Starred chat',
      lastActivityAt: Date.now() - 90 * 24 * 3600000,
      idleMs: 90 * 24 * 3600000,
      favorite: true,
    },
  ],
  problems: [],
}

globalThis.fetch = async (url, init) => {
  fetchCalls.push({ url, init })
  const body = init && init.body ? JSON.parse(init.body) : null
  let payload = { ok: true }
  if (url.endsWith('/favorites')) payload = { ok: true, favorites: FAKE_FAVORITES }
  else if (url.endsWith('/archived')) {
    // 0.31.0: the batch-delete card renders the archive as a list, so the stub
    // has to hand over titles, workspace folders and ages alongside the ids.
    // `session-fav-1` is starred (protected), the two plain ones are deletable,
    // and one of them is deliberately old so a threshold can single it out.
    const now = Date.now()
    payload = {
      ok: true,
      archivedSessionIds: FAKE_ARCHIVED,
      source: "workspace",
      count: FAKE_ARCHIVED.length,
      entries: [
        { sessionId: 'session-fav-1', title: 'A favourited chat', cwd: 'C:\\fake\\alpha', blank: false, updatedAt: now - 60 * 24 * 3600000, idleMs: 60 * 24 * 3600000 },
        { sessionId: 'session-plain-1', title: 'Plain old chat', cwd: 'C:\\fake\\beta', blank: false, updatedAt: now - 50 * 24 * 3600000, idleMs: 50 * 24 * 3600000 },
        { sessionId: 'session-plain-2', title: '', cwd: 'C:\\fake\\gamma', blank: true, updatedAt: null, idleMs: null },
      ],
    }
  }
  else if (url.endsWith('/favorite')) payload = { ok: true, favorites: FAKE_FAVORITES }
  else if (url.endsWith('/session-info')) payload = { ok: true, sessionId: body?.sessionId, path: 'C:\\fake\\sessions\\' + String(body?.sessionId) + '\\session.v4.jsonl.zstd' }
  else if (url.includes('/idle-archive')) {
    // 0.30.0: the idle card renders its candidates inline, so the probe needs a
    // non-empty preview or the whole list is untested. Two rows here: one with a
    // real title and one blank (a blank session must never look like a normal
    // conversation).
    payload = {
      ok: true,
      hours: 720,
      idleCount: 2,
      sample: [
        { id: 'session-old', title: 'Old thread', cwd: 'C:\\fake\\one', updatedAt: Date.now() - 40 * 24 * 3600000, blank: false },
        { id: 'session-blank', title: '', cwd: 'C:\\fake\\two', updatedAt: Date.now() - 50 * 24 * 3600000, blank: true },
      ],
    }
  }
  else if (url.endsWith('/snapshot-usage')) {
    snapshotUsageCalls += 1
    payload = { ...SNAPSHOT_USAGE_REPORT, policy: { ...snapshotPolicy } }
  }
  else if (url.endsWith('/archive-purge-policy')) {
    if (body && body.policy) {
      archivePurgePolicyWrites.push(body.policy)
      archivePurgePolicy = { enabled: body.policy.enabled === true }
    }
    payload = { ok: true, policy: { ...archivePurgePolicy } }
  }
  else if (url.endsWith('/snapshot-policy')) {
    if (body && body.policy) {
      snapshotPolicyWrites.push(body.policy)
      snapshotPolicy = { ...snapshotPolicy, ...body.policy }
    }
    payload = { ok: true, policy: { ...snapshotPolicy } }
  }
  else if (url.endsWith('/snapshot-cleanup')) {
    snapshotCleanupRequests.push(body)
    payload = {
      ok: true,
      dryRun: body?.dryRun === true,
      deleted: body?.dryRun === true ? (body?.sessionIds ?? []) : [],
      skipped: [],
      failures: [],
      bytesFreed: body?.dryRun === true ? 1234567 : 0,
    }
  }
  else if (url.endsWith('/archive-delete-policy')) {
    if (body && body.policy) {
      archiveDeletePolicyWrites.push(body.policy)
      archiveDeletePolicy = { ...archiveDeletePolicy, ...body.policy }
    }
    payload = { ok: true, policy: { ...archiveDeletePolicy } }
  }
  else if (url.endsWith('/archive-delete')) {
    archiveDeleteRequests.push(body)
    payload = {
      ok: true,
      dryRun: body?.dryRun === true,
      deleted: body?.dryRun === true ? (body?.sessionIds ?? []) : [],
      wouldDelete: body?.sessionIds ?? [],
      skipped: [],
      failures: [],
      missing: [],
      refusedFavorites: [],
    }
  }
  else if (url.endsWith('/delete')) {
    deletedRequests.push(body?.sessionIds ?? [])
    payload = { ok: true, deleted: deleteShouldSucceed ? (body?.sessionIds ?? []) : [], skipped: [], failures: [] }
  }
  return { ok: true, status: 200, json: async () => payload }
}

// 0.31.0: the batch-delete card keeps its own saved pre-tick policy, separate
// from the snapshot card — deleting a conversation and deleting its undo
// ledger have different blast radii, so the two thresholds must not be shared.
let archivePurgePolicy = { enabled: false }
const archivePurgePolicyWrites = []
let archiveDeletePolicy = { autoSelect: false, hours: 720 }
const archiveDeletePolicyWrites = []
const archiveDeleteRequests = []

const deletedRequests = []
let deleteShouldSucceed = true
// Capture click handlers the plugin registers on `document`, so a test can fire
// them exactly as a real capture-phase click would.
const documentClickHandlers = []
documentStub.addEventListener = (type, handler, capture) => {
  if (type === 'click' && capture === true) documentClickHandlers.push(handler)
}
documentStub.removeEventListener = (type, handler) => {
  const at = documentClickHandlers.indexOf(handler)
  if (at >= 0) documentClickHandlers.splice(at, 1)
}
function registeredClickHandlers() { return documentClickHandlers.filter(Boolean) }

let FAKE_FAVORITES = { 'session-fav-1': { at: '2026-01-01T00:00:00.000Z', title: 'A favourited chat', cwd: '' } }
let FAKE_ARCHIVED = ['session-fav-1', 'session-plain-1', 'session-plain-2']

// ---------------------------------------------------------------------------
// Load the real bundle.
// ---------------------------------------------------------------------------

const source = readFileSync(clientPath, 'utf8')

// Simulate the ModuleLoader environment: hand the factory a `require` that
// resolves "react" to our stub, which is what the app's UMD loader does.
function loadBundle() {
  capturedLoader = null
  const fn = new Function('window', 'document', 'navigator', 'fetch', 'console', 'setTimeout', 'clearTimeout', source)
  fn(globalThis.window, documentStub, globalThis.navigator, globalThis.fetch, console, setTimeout, clearTimeout)
  if (capturedLoader === null) throw new Error('bundle never called __ModuleLoader__.load')
  return capturedLoader
}

console.log('\n=== dsh-archive-favorites-forge client probe ===\n')

const spec = loadBundle()

ok('bundle id is the full package name', spec.id === 'dsh-archive-favorites-forge', String(spec.id))
ok('factory is a function', typeof spec.factory === 'function')

const requireStub = (name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
}

const mod = spec.factory(requireStub)

ok('exports.inject is a plain array', Array.isArray(mod.inject), typeof mod.inject)
ok('exports.inject includes slots', Array.isArray(mod.inject) && mod.inject.indexOf('slots') >= 0)
ok('exports.apply is a function', typeof mod.apply === 'function')

// ---------------------------------------------------------------------------
// Run apply against a recording slots service.
// ---------------------------------------------------------------------------

const registrations = []

function emptyProps() {
  return {
    props: {
      sessionId: 'session-plain-1',
      displayTitle: 'A plain chat',
      useMenuOpenState: () => [false, () => {}],
    },
  }
}

const ctx = {
  slots: {
    inject(name, fn) {
      // The real contract: run the factory as soon as the owner mounts. Running
      // it synchronously here is the strictest case, and it is what proves the
      // registration code cannot depend on a later tick.
      const disposer = fn()
      registrations.push({ name, disposer })
      return () => { if (typeof disposer === 'function') disposer() }
    },
    register(options, component) {
      registrations.push({ name: options.name, id: options.id, order: options.order, component })
      return () => {}
    },
    entries() { return [] },
  },
}

// `register` is recorded twice per entry on purpose by the stub above: once by
// `inject` (proving the inject arm ran) and once by `register`. Assertions that
// care about the registered ENTRIES must therefore look only at records that
// carry a component, or they double-count. Normalise here, once, so every
// downstream assertion sees the real registration list.
function registeredEntries() {
  return registrations.filter((r) => typeof r.component === 'function')
}

let applyThrew = null
try {
  mod.apply(ctx)
} catch (error) {
  applyThrew = error
}
ok('apply does not throw', applyThrew === null, applyThrew && applyThrew.message)

// --- registered slot ids ---
const entries = registeredEntries()
const menuItems = entries.filter((r) => r.name === 'sidebar.workspaces.session.menu.item')
const rowActions = entries.filter((r) => r.name === 'sidebar.workspaces.session.row.action')
const sections = entries.filter((r) => r.name === 'settings.section')
const overlays = entries.filter((r) => r.name === 'shell.overlay')

// 0.25.0 folded the session-manager half in, which added exactly ONE new arm:
// the `shell.overlay` confirm dialog. 0.28.0 added one more: the
// "continue in a new window" session-menu row. The count therefore moved
// 5 -> 6 -> 7 and the menu rows 3 -> 4. Keep these exact rather than `>=`: the
// whole point is to notice an arm appearing or vanishing, since a duplicate
// delete affordance or a silently-dropped registration is the failure mode that
// a looser assertion would let through.
const injectArms = registrations.filter((r) => r.component === undefined)
ok('every inject arm ran (4 menu rows + 1 star + 1 section + 1 overlay = 7)',
  injectArms.length === 7,
  String(injectArms.length))
ok('inject arms cover four distinct slot names',
  new Set(injectArms.map((r) => r.name)).size === 4,
  JSON.stringify([...new Set(injectArms.map((r) => r.name))]))
ok('registers 4 session-menu rows',
  entries.filter((r) => r.name === 'sidebar.workspaces.session.menu.item').length === 4,
  String(entries.filter((r) => r.name === 'sidebar.workspaces.session.menu.item').length))
ok('registers 1 row-action star',
  entries.filter((r) => r.name === 'sidebar.workspaces.session.row.action').length === 1)
ok('registers 1 settings section',
  entries.filter((r) => r.name === 'settings.section').length === 1)
// One overlay only: the session-manager half's delete dialog. The upstream
// plugin also shipped its own delete row-action and menu item; those were
// deliberately NOT ported, so `aff-delete` stays the single delete affordance.
ok('registers exactly 1 overlay (confirm dialog, no duplicate delete UI)',
  overlays.length === 1 && overlays[0].id === 'aff-session-confirm',
  JSON.stringify(overlays.map((r) => r.id)))

const menuIds = menuItems.map((r) => r.id).sort()
ok('menu ids are namespaced (no shipped-id reuse)',
  menuIds.every((id) => typeof id === 'string' && id.startsWith('aff-')),
  JSON.stringify(menuIds))
ok('no menu id collides with a shipped id',
  ['pin', 'rename', 'fork', 'archive'].every((shipped) => menuIds.indexOf(shipped) < 0),
  JSON.stringify(menuIds))
ok('menu orders sit after the shipped archive row (400)',
  menuItems.every((r) => typeof r.order === 'number' && r.order > 400),
  JSON.stringify(menuItems.map((r) => r.order)))

const everyComponent = entries
ok('every registered entry carries a render function',
  everyComponent.length === entries.length && entries.length === 7,
  entries.length + ' entries')

// ---------------------------------------------------------------------------
// Render every component once. A component that throws here is a component
// that takes the whole slot down in the app.
// ---------------------------------------------------------------------------

function renderOne(entry, props) {
  // Reset IN PLACE. Reassigning to a fresh array would orphan any setter or
  // effect closure handed out by an earlier render, so a component's async
  // state update would land in an array nothing reads — which looks exactly
  // like "the component never received the data".
  resetHooks()
  let tree = null
  let error = null
  try {
    tree = entry.component(props)
    // React resolves a function component into its returned element before
    // committing. A probe that stopped at `{ type: MenuRow }` would inspect the
    // *component*, not the DOM it produces — and would therefore miss the exact
    // structural bug this suite exists to catch (a missing `div.itemWrap`).
    tree = expand(tree, 0)
  } catch (e) {
    error = e
  }
  // Run queued effects so a crashing effect is caught too.
  for (const fn of effectQueue) {
    try { fn() } catch (e) { if (error === null) error = e }
  }
  return { tree, error }
}

/** Recursively resolve function components, the way React does. */
function expand(node, depth) {
  if (node === null || node === undefined) return node
  if (Array.isArray(node)) return node.map((child) => expand(child, depth + 1))
  if (typeof node === 'string' || typeof node === 'number') return node
  if (typeof node.type === 'function') {
    // Guard against a component that renders itself forever.
    if (depth > 24) throw new Error('component recursion too deep')
    // React passes position arguments as `props.children`. This stub keeps them
    // in `node.children`, so they must be folded back before invoking the
    // component — otherwise every component sees `children === undefined` and
    // renders a label-less row.
    const props = Object.assign({}, node.props)
    const kids = node.children ?? []
    if (kids.length === 1) props.children = kids[0]
    else if (kids.length > 1) props.children = kids
    const rendered = node.type(props)
    return expand(rendered, depth + 1)
  }
  const children = node.children ?? []
  const out = Object.assign({}, node, { children: children.map((child) => expand(child, depth + 1)) })
  // Mirror the same fold for host elements so textOf can read either carrier.
  const kids = node.children ?? []
  if (kids.length === 1) out.props = Object.assign({}, node.props, { children: expand(kids[0], depth + 1) })
  else if (kids.length > 1) out.props = Object.assign({}, node.props, { children: kids.map((c) => expand(c, depth + 1)) })
  return out
}

for (const entry of entries) {
  const { error } = renderOne(entry, emptyProps().props)
  ok('renders without throwing: ' + (entry.id ?? entry.name), error === null, error && (error.stack ?? error.message))
}

// ---------------------------------------------------------------------------
// Assert the render OUTPUT, not just that it did not throw. A component that
// returns null passes "does not throw" while doing nothing at all.
// ---------------------------------------------------------------------------

function textOf(tree) {
  if (tree === null || tree === undefined) return ''
  if (typeof tree === 'string') return tree
  if (typeof tree === 'number') return String(tree)
  if (Array.isArray(tree)) return tree.map(textOf).join(' ')
  // `expand` rebuilds `children` while `props.children` keeps the original
  // createElement payload; both can hold text, so walk both and de-duplicate
  // nothing — a label appearing twice in the join is harmless for a /regex/.
  const parts = []
  if (typeof tree.props?.children === 'string') parts.push(tree.props.children)
  else if (Array.isArray(tree.props?.children)) parts.push(tree.props.children.map(textOf).join(' '))
  for (const child of tree.children ?? []) parts.push(textOf(child))
  return parts.join(' ').trim()
}

const menuTexts = {}
for (const entry of menuItems) {
  const { tree } = renderOne(entry, emptyProps().props)
  menuTexts[entry.id] = textOf(tree)
}

ok('favourite menu row has a label', /收藏/.test(menuTexts['aff-favorite'] ?? ''), menuTexts['aff-favorite'])
// One copy row only: the separate id / path rows were removed.
ok('the single copy row mentions both id and path',
  /ID/.test(menuTexts['aff-copy-both'] ?? '') && /路径/.test(menuTexts['aff-copy-both'] ?? ''),
  menuTexts['aff-copy-both'])
ok('no separate copy-id row is registered', menuTexts['aff-copy-id'] === undefined)
ok('no separate copy-path row is registered', menuTexts['aff-copy-path'] === undefined)

// 🔴 The regression test for the bug that made every menu row invisible.
//
// `Menu` renders its `children` directly into a flex-column viewport, where
// every row it draws itself is a wrapper div around a full-width flex button.
// A bare `<button>` dropped in beside those collapses to almost nothing, so the
// row exists in the tree but cannot be seen or clicked. Assert the wrapper, the
// button, and the label span.
//
// 🔴 SECOND REGRESSION, and the one this suite previously MISSED: the row used
// to copy the shipped menu's class names (`itemWrap`, `item`, `itemLabel`).
// Those are CSS Module names, hashed to `_item_4ub78_90` in a real build, so the
// literals matched nothing — and the row's inline `background: transparent` beat
// every `:hover` rule short of `!important`. The result had correct layout and
// NO hover highlight, which is what users reported. The old assertions here
// actively locked the bug in by demanding those literal names. They now demand
// the opposite, plus the behaviour that was actually missing: paint on hover.
//
// `aff-delete` is skipped in the first pass: it renders nothing until the
// archived set has arrived, so it gets its own pass once the fetch has settled.
const structureEntries = menuItems.filter((e) => e.id !== 'aff-delete')

/** The shipped CSS Modules names that must NEVER be matched literally. */
const HASHED_OFFICIAL_CLASSES = ['itemWrap', 'itemLabel', 'itemIcon']

function findRowButton(tree) {
  if (tree === null || tree === undefined) return null
  const kids = tree.children ?? []
  return kids.find((c) => c !== null && c !== undefined && c.type === 'button') ?? null
}

/**
 * Assert one menu row's structure AND its hover paint.
 *
 * The hover half re-renders the SAME component instance with the hook slots
 * kept in place (only the cursor is rewound), which is what models React
 * re-rendering after `setHovered(true)` rather than remounting the component.
 */
function assertMenuRowStructure(entry, tree, label, props) {
  const wrapped = tree !== null && tree !== undefined && tree.type === 'div' &&
    typeof tree.props?.className === 'string' &&
    tree.props.className.split(/\s+/).indexOf('dsh-aff-mi-wrap') >= 0
  ok('menu row is wrapped in div.dsh-aff-mi-wrap: ' + label, wrapped,
    tree === null || tree === undefined ? 'null' : String(tree.type) + ' . ' + String(tree.props?.className))

  const btn = wrapped ? findRowButton(tree) : null
  const btnClasses = btn === null || btn === undefined ? '' : String(btn.props.className ?? '')
  ok('menu row has a button.dsh-aff-mi with role=menuitem: ' + label,
    btn !== null && btn !== undefined &&
    btn.props.role === 'menuitem' &&
    btnClasses.split(/\s+/).indexOf('dsh-aff-mi') >= 0,
    JSON.stringify({ role: btn?.props?.role, cls: btn?.props?.className }))

  // The bug: matching the hashed official names is a no-op, so their presence
  // is now itself a failure. Our own markers are what selectors may rely on.
  ok('menu row does not rely on hashed official class names: ' + label,
    HASHED_OFFICIAL_CLASSES.every((n) => btnClasses.split(/\s+/).indexOf(n) < 0),
    btnClasses)

  const labelSpan = btn === null || btn === undefined ? null : (btn.children ?? []).find(
    (c) => c !== null && c !== undefined && c.props &&
      String(c.props.className ?? '').split(/\s+/).indexOf('dsh-aff-mi-label') >= 0)
  ok('menu row label lives in span.dsh-aff-mi-label: ' + label, labelSpan !== null && labelSpan !== undefined)

  // HOVER PAINT — the actual reported symptom.
  const restingBg = btn === null || btn === undefined ? '' : String(btn.props.style?.background ?? '')
  ok('menu row starts with no background paint: ' + label,
    restingBg === 'transparent', restingBg)

  ok('menu row handles mouse enter: ' + label,
    btn !== null && typeof btn.props.onMouseEnter === 'function')
  ok('menu row handles mouse leave: ' + label,
    btn !== null && typeof btn.props.onMouseLeave === 'function')

  if (btn === null || btn === undefined || props === undefined ||
      typeof btn.props.onMouseEnter !== 'function') return

  // Re-render in place: rewind the cursor, keep the slots the setters close over.
  btn.props.onMouseEnter()
  hookCursor = 0
  effectQueue.length = 0
  const hovered = expand(entry.component(props), 0)
  const hoveredBtn = findRowButton(hovered)
  const hoveredBg = hoveredBtn === null ? '' : String(hoveredBtn.props.style?.background ?? '')
  ok('menu row paints a hover background: ' + label,
    hoveredBg !== 'transparent' && hoveredBg !== '',
    hoveredBg)

  const danger = hoveredBtn !== null &&
    String(hoveredBtn.props.className ?? '').split(/\s+/).indexOf('dsh-aff-mi-danger') >= 0
  const expectedToken = danger
    ? '--dsw-alias-interactive-bg-hover-danger'
    : '--dsw-alias-interactive-bg-hover'
  ok('hover background uses the ' + (danger ? 'danger' : 'normal') + ' theme token: ' + label,
    hoveredBg.indexOf(expectedToken) >= 0,
    hoveredBg + ' (expected ' + expectedToken + ')')

  // Mouse leave must restore the resting state, or the row stays lit.
  if (hoveredBtn !== null && typeof hoveredBtn.props.onMouseLeave === 'function') {
    hoveredBtn.props.onMouseLeave()
    hookCursor = 0
    effectQueue.length = 0
    const left = expand(entry.component(props), 0)
    const leftBtn = findRowButton(left)
    ok('menu row drops the hover background on leave: ' + label,
      leftBtn !== null && String(leftBtn.props.style?.background ?? '') === 'transparent',
      leftBtn === null ? 'no button' : String(leftBtn.props.style?.background ?? ''))
  }
}

for (const entry of structureEntries) {
  const p = emptyProps().props
  const { tree } = renderOne(entry, p)
  assertMenuRowStructure(entry, tree, entry.id, p)
}

// `aff-delete` renders only for an ARCHIVED, UNFAVOURITED session. Render it
// once to fire its `/archived` request, let that settle, then re-render.
{
  const deleteEntryForStructure = menuItems.find((e) => e.id === 'aff-delete')
  const deleteProps = {
    sessionId: 'session-plain-1',
    displayTitle: 'A plain chat',
    useMenuOpenState: () => [false, () => {}],
  }
  resetHooks()
  deleteEntryForStructure.component(deleteProps)
  for (const fn of effectQueue) { try { fn() } catch (e) {} }
  await settle()
  hookCursor = 0
  effectQueue.length = 0
  const tree = deleteEntryForStructure.component(deleteProps)
  const expanded = expand(tree, 0)
  assertMenuRowStructure(deleteEntryForStructure, expanded, 'aff-delete (archived)', deleteProps)
}

const starEntry = rowActions[0]
const starRender = renderOne(starEntry, emptyProps().props)
ok('star row button renders glyph', /[★☆]/.test(textOf(starRender.tree)), textOf(starRender.tree))
ok('star row button has an aria-label',
  typeof starRender.tree?.props?.['aria-label'] === 'string' && starRender.tree.props['aria-label'].length > 0,
  JSON.stringify(starRender.tree?.props?.['aria-label']))

// The star's click must stop propagation, otherwise it also opens the chat
// behind it (the row owns an onClick that navigates).
let starClickStopped = false
const fakeEvent = {
  stopPropagation() { starClickStopped = true },
  preventDefault() {},
}
try {
  starRender.tree?.props?.onClick?.(fakeEvent)
} catch (e) { /* async side effects are fine */ }
ok('star click stops propagation (does not open the chat)', starClickStopped)

// ---------------------------------------------------------------------------
// The settings section is the risky one: it fetches and renders a list. Render
// it and assert it actually produced content.
// ---------------------------------------------------------------------------

const sectionText = textOf(renderOne(sections[0], {}).tree)
ok('settings section renders a heading', /归档收藏/.test(sectionText), sectionText.slice(0, 120))
ok('settings section mentions favourites', /收藏/.test(sectionText), sectionText.slice(0, 120))

// ---------------------------------------------------------------------------
// Guard: the client must never build an absolute host URL for fetch. An
// absolute http://127.0.0.1:<port> URL is blocked by the desktop renderer's
// CSP, and a hard-coded port breaks when the host picks another. This is a
// regression assertion for a bug that already cost a full rewrite once.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Favourites filter: it must actually tag rows and actually inject menu rows.
//
// These assertions re-run the plugin's own flow through the observable DOM, so
// a no-op implementation cannot pass: the row must carry the expected attribute
// value AND the menu must gain exactly three new rows.
// ---------------------------------------------------------------------------

console.log('\n=== favourites filter (DOM enhancement) ===\n')

// Build session rows the way the official sidebar does: `data-row-key`.
function buildSessionRow(id) {
  const row = makeNode('div')
  row.setAttribute('data-row-key', 'session:' + id)
  row.textContent = id
  documentStub.body.appendChild(row)
  return row
}

const rowFav = buildSessionRow('session-fav-1')       // in FAKE_FAVORITES
const rowPlainA = buildSessionRow('session-plain-1')  // not a favourite
const rowPlainB = buildSessionRow('session-plain-2')  // not a favourite

// The plugin marks rows from a MutationObserver callback; drive it directly by
// delivering the mutations the real observer would see.
function driveObservers(addedNodes) {
  for (const observer of observers) {
    if (observer.disconnected || observer.observing === null) continue
    observer.callback([{ addedNodes }], observer)
  }
}

// Re-apply the plugin so the enhancer starts against the populated DOM.
mod.apply(ctx)
await settle()

const favRows = documentStub.querySelectorAll("[data-dsh-aff-fav='1']")
const plainRows = documentStub.querySelectorAll("[data-dsh-aff-fav='0']")
ok('marks a favourited row as favourite',
  rowFav.getAttribute('data-dsh-aff-fav') === '1',
  String(rowFav.getAttribute('data-dsh-aff-fav')))
ok('marks a plain row as not favourite',
  rowPlainA.getAttribute('data-dsh-aff-fav') === '0',
  String(rowPlainA.getAttribute('data-dsh-aff-fav')))
ok('exactly one row is marked favourite',
  favRows.length === 1, String(favRows.length))
ok('both plain rows are marked', plainRows.length === 2, String(plainRows.length))

// The filter stylesheet must exist and must scope on the plugin's own attribute.
const filterStyle = documentStub.getElementById('dsh-aff-fav-filter-style')
ok('injects its own scoped stylesheet', filterStyle !== null)
ok('stylesheet keys on data-row-key (stable) not a CSS-module hash',
  filterStyle !== null && filterStyle.textContent.includes("data-row-key^='session:'") &&
  !/_[A-Za-z0-9]{6}_/.test(filterStyle.textContent || ''))

// --- menu injection ---
// The filter modes are declared as a literal in the bundle; read them from the
// source so the assertion tracks the code rather than a copy of it.
const FILTER_MODE_PROBE = (() => {
  const m = /var FILTER_MODES = \[([^\]]*)\]/.exec(source)
  return m === null ? [] : m[1].split(',').map((s) => s.trim().replace(/^"|"$/g, '')).filter(Boolean)
})()

const menu = makeViewOptionsMenu()
documentStub.body.appendChild(menu)
driveObservers([menu])
await settle()

// The marker `data-dsh-aff-injected` is shared by BOTH kinds of injected row
// (filter and sort), so counting it alone double-counts. Select the filter rows
// by their own attribute.
const injected = menu.querySelectorAll("[data-dsh-aff-injected='1'][data-dsh-aff-mode]")
ok('injects exactly 2 filter rows into the official view-options menu',
  injected.length === FILTER_MODE_PROBE.length && injected.length === 2,
  String(injected.length) + ' (modes: ' + FILTER_MODE_PROBE.join(',') + ')')

const injectedLabels = injected.map((n) => (n.textContent || '').trim())
ok('the injected rows carry the two archive-state labels',
  injectedLabels.some((l) => l.includes('仅显示收藏（已归档）')) &&
  injectedLabels.some((l) => l.includes('仅显示收藏（未归档）')),
  JSON.stringify(injectedLabels))
ok('no "turn the filter off" row is offered',
  !injectedLabels.some((l) => l.includes('关闭')), JSON.stringify(injectedLabels))

// Cloning the official row is what keeps the styling; assert we did clone and
// did not fabricate a bare button.
ok('injected rows keep a role=menuitem button (official markup)',
  injected.every((n) => n.querySelector("button[role='menuitem']") !== null))

// The tick must exist on every injected row, start HIDDEN, and sit LAST — the
// official position. Exactly one row may ever show it, which `syncFilterChecks`
// enforces by toggling visibility on clones of the harness's own glyph.
ok('every injected row carries exactly one tick, hidden by default',
  injected.every((n) => {
    const btn = n.querySelector("button[role='menuitem']")
    if (btn === null) return false
    const seat = btn.lastElementChild
    if (seat === null) return false
    if (typeof seat.tagName !== 'string' || seat.tagName.toLowerCase() !== 'svg') return false
    // Exactly one bare svg child of the button, and it starts hidden.
    const svgs = (btn.children ?? []).filter(
      (c) => typeof c.tagName === 'string' && c.tagName.toLowerCase() === 'svg')
    return svgs.length === 1 && seat.style.display === 'none'
  }),
  JSON.stringify(injected.map((n) => {
    const btn = n.querySelector("button[role='menuitem']")
    if (btn === null) return 'no-btn'
    const seat = btn.lastElementChild
    if (seat === null) return 'no-seat'
    const svgs = (btn.children ?? []).filter(
      (c) => typeof c.tagName === 'string' && c.tagName.toLowerCase() === 'svg').length
    return 'svgCount=' + svgs + ' display=' + String(seat.style.display)
  })))

// The glyph is a clone of the harness's own, so it inherits official size,
// colour and position — never a fabricated "✓".
ok('the tick is a clone of the harness glyph, not a fabricated character',
  !/textContent = "✓"/.test(source) && source.includes('tickSample.cloneNode(true)'))

// Idempotence: a second mutation pass must not add duplicates.
driveObservers([menu])
await settle()
ok('re-injection is idempotent (still 2 filter rows)',
  menu.querySelectorAll("[data-dsh-aff-injected='1'][data-dsh-aff-mode]").length === 2,
  String(menu.querySelectorAll("[data-dsh-aff-injected='1'][data-dsh-aff-mode]").length))

// A menu that is NOT the view-options menu must be left alone.
const otherMenu = makeNode('div')
otherMenu.setAttribute('role', 'menu')
otherMenu.textContent = '重命名 删除'
documentStub.body.appendChild(otherMenu)
driveObservers([otherMenu])
await settle()
ok('leaves an unrelated menu untouched',
  otherMenu.querySelectorAll("[data-dsh-aff-injected='1']").length === 0)

// --- applying a mode sets the scoping attribute the CSS depends on ---
//
// The plugin binds its click handler at the DOCUMENT in the capture phase. The
// probe's document stub does not implement listener dispatch, so rather than
// fake a dispatch we assert the two things that actually matter and are
// observable: the attribute starts absent, and the stylesheet's two rules are
// scoped on it.
ok('filter attribute is absent before choosing a mode',
  documentElement.getAttribute('data-dsh-aff-filter') === null,
  String(documentElement.getAttribute('data-dsh-aff-filter')))

const styleText = filterStyle === null ? '' : filterStyle.textContent
// 🔴 TWO INDEPENDENT GATES. The favourites rule needs only the favourites set;
// the two archive rules additionally need the archive set. A single combined
// gate meant an archive-set problem disabled the WHOLE filter, which is how
// "仅显示收藏（未归档）" ended up showing every unarchived conversation.
ok('the favourites rule is gated on the favourites marker alone',
  /html\[data-dsh-aff-ready='1'\]\[data-dsh-aff-filter\]/.test(styleText),
  styleText.slice(0, 200))
ok('the archive rules are gated on their own marker',
  (styleText.match(/data-dsh-aff-archready='1'/g) ?? []).length === 2,
  String((styleText.match(/data-dsh-aff-archready='1'/g) ?? []).length))
ok('the rule hides rows that are NOT favourites',
  /\[data-row-key\^='session:'\]:not\(\[data-dsh-aff-fav='1'\]\)/.test(styleText),
  styleText.slice(0, 220))
// Nothing keys on an archived marker any more: the single mode hides by the
// favourite marker alone, and the archived axis belongs to the harness's own
// control. Mutation of archived rows was removed with the second mode.
ok('the archived mode hides rows that are NOT archived',
  /\[data-dsh-aff-filter='archived'\][^{]*\[data-dsh-aff-arch='0'\]/.test(styleText),
  styleText.slice(0, 320))
ok('the unarchived mode hides rows that ARE archived',
  /\[data-dsh-aff-filter='unarchived'\][^{]*\[data-dsh-aff-arch='1'\]/.test(styleText),
  styleText.slice(0, 320))

// The "turn the filter off" row was removed: re-picking the active mode toggles
// it off, and a row that only reported state was noise.
// A heading whose every row was filtered away must disappear too; otherwise a
// heading with nothing under it reads as "this workspace suddenly has 69 chats".
// The marker is computed in JS — headings and rows are FLAT SIBLINGS in one
// list, so CSS `:has()` cannot express "no visible rows follow this heading" —
// and this rule consumes it.
// The workspace-heading rule was removed with the group experiment: it could
// hide a heading while its rows were merely not yet marked, which made the
// sidebar look like it had lost a project.
ok('the filter offers two modes, one per archive state',
  FILTER_MODE_PROBE.length === 2 && FILTER_MODE_PROBE.includes('archived') && FILTER_MODE_PROBE.includes('unarchived'),
  JSON.stringify(FILTER_MODE_PROBE))

// The row scan must publish the archived marker the liveOnly rule needs.
// The archived marker is back: the two modes are defined by archive state, so
// the row scan must publish it.
ok('row scan writes the archived marker',
  rowFav.getAttribute('data-dsh-aff-arch') !== null,
  String(rowFav.getAttribute('data-dsh-aff-arch')))

// ---------------------------------------------------------------------------
// Single-session delete menu row: must render ONLY for archived, unfavourited
// sessions, and must never fire without confirmation.
// ---------------------------------------------------------------------------

console.log('\n=== turn-count sort ===\n')

// --- Turn-count ordering -------------------------------------------------
// Reuse the ONE realistic menu fixture above. (An earlier version kept a second
// builder here whose text did not match production, which is exactly how the
// "视图选项" detector bug survived its own test suite.)
const menu2 = makeViewOptionsMenu()
documentStub.body.appendChild(menu2)
driveObservers([menu2])
await settle()

const injectedFilters = menu2.querySelectorAll("[data-dsh-aff-injected='1'][data-dsh-aff-mode]")
const injectedSorts = menu2.querySelectorAll("[data-dsh-aff-injected='1'][data-dsh-aff-sort]")
ok('injects the 2 favourites-filter rows',
  injectedFilters.length === 2, String(injectedFilters.length))
// The turn-sort rows were MOVED to the settings page at the user's request, so
// the harness's own view-options menu must now stay free of them.
ok('the view-options menu carries NO turn-sort rows (moved to settings)',
  injectedSorts.length === 0, String(injectedSorts.length))

// Sorting is applied via CSS `order` on the rows, inside each row's parent, so
// the official DOM order is never mutated.
const listParent = makeNode('div')
documentStub.body.appendChild(listParent)
const sortedRows = [
  { id: 'session-t1', order: null },
  { id: 'session-t9', order: null },
  { id: 'session-t5', order: null },
]
for (const spec of sortedRows) {
  const row = makeNode('div')
  row.setAttribute('data-row-key', 'session:' + spec.id.slice('session-'.length))
  row.setAttribute('data-row-key', 'session:' + spec.id.slice('session-'.length))
  listParent.appendChild(row)
  spec.node = row
}

// The conversation-length sort feature was removed on request, and the host no
// longer serves its route either. Both halves must stay gone, so a later edit
// cannot quietly resurrect a deleted feature.
for (const gone of ['applyTurnSort', 'turnSortMode', 'TURN_SORT', 'loadTurnCounts', 'turnCounts', 'data-dsh-aff-sort', '轮次']) {
  ok('turn-sort code is absent from the client: ' + gone,
    !source.includes(gone), gone)
}
{
  const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('the turn-counts route is gone from the host',
    !hostSource.includes("route === '/turn-counts'"))
  ok('the turn-count helpers are gone from the host',
    !hostSource.includes('countTurns') && !hostSource.includes('turnCountFor'))
}

// And the settings page must not offer the control any more.
const sectionForSort = entries.find((r) => r.id === 'archive-favorites')
resetHooks()
const sectionTree = expand(sectionForSort.component({ close() {} }), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
await settle()

function collectButtons(node, out) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const c of node) collectButtons(c, out); return out }
  if (typeof node !== 'object') return out
  if (node.type === 'button' && node.props) out.push(node)
  for (const c of node.children ?? []) collectButtons(c, out)
  return out
}
const sectionButtons = collectButtons(sectionTree, [])
const sectionBodyText = textOf(sectionTree)
ok('settings section no longer mentions 轮次',
  !sectionBodyText.includes('轮次'), sectionBodyText.slice(0, 160))
// The export button replaces the inline list.
ok('settings section offers an export-to-txt control',
  sectionButtons.some((b) => textOf(b).includes('导出清单')),
  JSON.stringify(sectionButtons.map((b) => textOf(b)).filter(Boolean)))
// 0.30.0 REVERSED THIS ASSERTION. Through 0.29.0 the idle card offered only
// an export button, so the probe demanded that no candidate list render inline.
// That made the user run to the filesystem to judge what would be archived —
// "an archive you must export to review is an archive nobody reviews" — so
// 0.30.0 renders the candidates in the card. The probe now demands the list IS
// there, with the age and the workspace of every row, and that a blank session
// is labelled as such instead of showing up as a nameless row.
// The preview lands asynchronously: re-render in place (rewind the hook
// cursor, keep the slots the setters closed over) so the tree can actually
// contain the rows this block is about. Reading the pre-settle tree would make
// every assertion below fail for a reason that has nothing to do with the code.
hookCursor = 0
effectQueue.length = 0
const idleTree = expand(sectionForSort.component({ close() {} }), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const idleText = textOf(idleTree)
const idleButtons = collectButtons(idleTree, [])

ok('settings section renders the idle candidates inline',
  idleText.includes('天前'), idleText.slice(0, 400))
ok('the inline candidates show how stale each one is',
  idleText.includes('40 天前') && idleText.includes('50 天前'),
  idleText.slice(0, 400))
ok('the inline candidates name the workspace',
  idleText.includes('one') && idleText.includes('two'),
  idleText.slice(0, 400))
ok('a blank candidate is labelled, not left nameless',
  idleText.includes('（新会话）'), idleText.slice(0, 400))
ok('the idle card still offers the export control next to the list',
  idleButtons.some((b) => textOf(b).includes('导出清单')))

// ---------------------------------------------------------------------------
// Single-session delete menu row: must render ONLY for archived, unfavourited
// sessions, and must never fire without confirmation.
// ---------------------------------------------------------------------------

// Idle auto-archive assertions live in the HOST section below (`host` is
// imported there); the client section above only covers the UI wiring.

console.log('\n=== single-session delete ===\n')

const deleteEntry = entries.find((r) => r.id === 'aff-delete')
ok('delete menu row is registered', deleteEntry !== undefined)

// Favourited session -> renders nothing, regardless of archive state.
//
// NOTE: reset the hook slots IN PLACE (`length = 0`), never by reassigning to a
// fresh array. `useState` hands out a setter that closes over `hookSlots[i]`, so
// a reassignment orphans the previous render's slots and its async effect then
// writes into an array nobody reads — which reads exactly like "the component
// never saw the data".
function resetHooks() {
  hookSlots.length = 0
  hookCursor = 0
  effectQueue.length = 0
}

resetHooks()
const delFavTree = deleteEntry.component({
  sessionId: 'session-fav-1',
  displayTitle: 'A favourite',
  useMenuOpenState: () => [false, () => {}],
})
for (const fn of effectQueue) { try { fn() } catch (e) {} }
ok('delete row renders nothing for a favourited session (synchronously hidden)',
  delFavTree === null || delFavTree === undefined,
  JSON.stringify(delFavTree))

// The delete row no longer waits on an archived check: any non-favourited
// session may be deleted, so it appears on the first render.
resetHooks()
const delCold = deleteEntry.component({
  sessionId: 'session-plain-1',
  displayTitle: 'A plain chat',
  useMenuOpenState: () => [false, () => {}],
})
ok('delete row appears immediately for a non-favourited session',
  delCold !== null && delCold !== undefined && /删除对话/.test(textOf(delCold)),
  delCold === null || delCold === undefined ? 'null' : JSON.stringify(textOf(delCold)).slice(0, 60))
// Run the queued effects: this is what actually issues the `/archived` request
// whose result the re-render below reads. Without it the component would sit on
// "unknown" forever and the next assertion could never pass.
for (const fn of effectQueue) { try { fn() } catch (e) {} }

// Now let the archived fetch land and re-render: the row must appear.
//
// This models React re-rendering the SAME component instance: the hook slots are
// reset in place (so the effect's setter still targets a slot we read) and the
// component is invoked again. A fresh array here would model a REMOUNT, which
// legitimately starts from "archived set unknown".
await settle()
hookCursor = 0
effectQueue.length = 0
const delWarm = deleteEntry.component({
  sessionId: 'session-plain-1',
  displayTitle: 'A plain chat',
  useMenuOpenState: () => [false, () => {}],
})
for (const fn of effectQueue) { try { fn() } catch (e) {} }
ok('delete row appears for an archived, unfavourited session',
  delWarm !== null && delWarm !== undefined && /删除对话/.test(textOf(delWarm)),
  delWarm === null || delWarm === undefined ? 'null' : JSON.stringify(textOf(delWarm)).slice(0, 80))

// Confirmation gate: the first render must NOT be the destructive action.
ok('first render asks for confirmation rather than deleting',
  /删除对话/.test(textOf(delWarm)) && !/^确认删除$/.test(textOf(delWarm).trim()),
  textOf(delWarm).slice(0, 60))

// No delete request is issued merely by rendering.
ok('rendering the delete row issues no delete request',
  deletedRequests.length === 0,
  JSON.stringify(deletedRequests))
// Strip comments before scanning for banned patterns: the source legitimately
// *documents* why an absolute loopback URL is wrong, and a naive scan matches
// that explanation instead of real code.
const codeOnly = source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .map((line) => line.replace(/\/\/.*$/, ''))
  .join('\n')

const absoluteUrlPattern = /['"`]https?:\/\//
ok('client code never hard-codes an absolute URL',
  !absoluteUrlPattern.test(codeOnly),
  (codeOnly.match(absoluteUrlPattern) ?? []).join(','))
ok('client code never hard-codes a loopback address',
  !/127\.0\.0\.1/.test(codeOnly))
ok('client code never builds an iframe', !/<iframe/i.test(codeOnly))
ok('client uses root-relative API paths', source.indexOf('"/plugins/dsh-archive-favorites-forge"') >= 0)

// ---------------------------------------------------------------------------
// Host half: verify the pure helpers and the delete guards, which are the parts
// where a mistake destroys user data.
// ---------------------------------------------------------------------------

console.log('\n=== host half ===\n')

// Isolate the host store and the sessions root. Without this the delete guards
// below would read the developer's REAL favorites and could act on the REAL
// sessions directory — the worst possible thing for a test of a destructive
// code path to do.
const probeRoot = join(here, '..', '.probe-home')
const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
const { rm } = await import('node:fs/promises')
rmSync(probeRoot, { recursive: true, force: true })

const probeState = join(probeRoot, 'state')
const probeSessions = join(probeRoot, 'sessions')
mkdirSync(probeState, { recursive: true })
process.env.DSH_AFF_STATE_ROOT = probeState
process.env.DSH_AFF_SESSIONS_ROOT = probeSessions

const host = await import('../lib/index.js')

// Seed the isolated store with exactly one favourite, so the guard has
// something real to refuse.
writeFileSync(
  join(probeState, 'favorites.json'),
  JSON.stringify({ version: 1, favorites: { 'session-fav-1': { at: '2026-01-01T00:00:00.000Z', title: 'A favourited chat', cwd: '' } } }),
  'utf8',
)

// Plant a REAL session directory so the happy path can be exercised against a
// real file. The project directory name must match what the host computes for
// the cwd we will hand it.
const realCwd = 'C:\\probe\\workspace'
const realProjectDir = join(probeSessions, host.__internals.projectDirName(realCwd))
const realSessionId = 'session-11111111-2222-3333-4444-555555555555'
const realSessionDir = join(realProjectDir, host.__internals.bareId(realSessionId))
mkdirSync(realSessionDir, { recursive: true })
writeFileSync(join(realSessionDir, 'session.v4.jsonl.zstd'), 'probe', 'utf8')

// And a favourited one that DOES exist on disk — this is the case that proves
// the guard, and not merely "the file was missing", is what spares it.
const keptSessionId = 'session-fav-1'
const keptSessionDir = join(realProjectDir, host.__internals.bareId(keptSessionId))
mkdirSync(keptSessionDir, { recursive: true })
writeFileSync(join(keptSessionDir, 'session.v4.jsonl.zstd'), 'probe', 'utf8')

// A workspace registry page so `transcriptPathFor` can resolve cwd from the
// owning workspace, exactly as production does.
const probeStorage = join(probeRoot, '.dsh', 'storages')
mkdirSync(probeStorage, { recursive: true })
writeFileSync(
  join(probeStorage, 'workspace.json'),
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: ['ws-1'],
      archivedSessionIds: [realSessionId, keptSessionId],
    },
    tables: {
      workspaces: {
        'ws-1': {
          path: realCwd,
          title: 'probe',
          sessionIds: [realSessionId, keptSessionId],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }),
  'utf8',
)

ok('host exports a name', host.name === 'dsh-archive-favorites-forge', host.name)
ok('host declares inject', Array.isArray(host.inject))
ok('host exports apply', typeof host.apply === 'function')

// 🔴 The regression test for the bug that actually shipped. Exporting a
// plain-object `Config` makes Cordis call `Config.validate()` — which does not
// exist — and the ENTIRE plugin fails to activate. The symptom is maximally
// misleading: the client half is a separate bundle and keeps working, so
// favorites and copy-id look fine while EVERY host route 404s. Assert absence.
ok('host exports NO Config (a plain object kills activation)',
  host.Config === undefined,
  host.Config === undefined ? 'absent, correct' : 'PRESENT: ' + typeof host.Config)
ok('host exports no other schema-like config key',
  !['schema', 'defaultConfig'].some((key) => key in host))

// 🔴 The regression test for "cannot get property \"config\" without inject",
// which broke EVERY delete attempt before it touched a file.
//
// Cordis treats `ctx.<name>` as a DECLARED property: reading one the plugin did
// not list in `inject` throws. The config object must arrive as
// `apply(ctx, config)` and be threaded through explicitly. Scan the source so a
// future edit cannot reintroduce a direct read.
{
  const hostRaw = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')

  // Read `inject` from the RAW source, before any stripping — stripping string
  // literals would empty this very list and make the check vacuous.
  const declared = (() => {
    const m = /export const inject = \[([^\]]*)\]/.exec(hostRaw)
    return m === null ? [] : m[1].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean)
  })()
  ok('host declares its inject list', declared.length > 0, JSON.stringify(declared))

  // Strip comments only. This file DOCUMENTS the `ctx.config` bug, and a naive
  // scan matches that prose instead of real code.
  const hostSource = hostRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((line) => line.replace(/\/\/.*$/, '')).join('\n')

  // Every `ctx.<identifier>` read, ignoring the context's own methods and the
  // always-present logger seat.
  const accessed = new Set()
  for (const m of hostSource.matchAll(/\bctx\??\.([A-Za-z_$][\w$]*)/g)) accessed.add(m[1])
  const builtins = new Set(['get', 'effect', 'on', 'logger', 'emit', 'plugin', 'inject'])
  const undeclared = [...accessed].filter((key) => !builtins.has(key) && !declared.includes(key))
  ok('host never reads an undeclared ctx property',
    undeclared.length === 0,
    'undeclared: ' + JSON.stringify(undeclared))
  ok('host never reads ctx.config (use the apply-config argument)',
    !/\bctx\??\.config\b/.test(hostSource),
    (hostSource.match(/\bctx\??\.config\b/g) ?? []).length + ' occurrence(s)')
}

// Normalise a session id the way the plugin does (bare uuid).
function idKeyProbe(sessionId) {
  const text = String(sessionId ?? '')
  return text.startsWith('session-') ? text.slice('session-'.length) : text
}

// 🔴 The candidate lists must be the INTERSECTION of "archived" and "visible".
//
// Measured on this machine: 106 archived ids, 83 sidebar conversations, and only
// 78 in both — the other 28 are archived sessions with no cwd that
// `sessionController.list()` skips. Using the raw archive set produced
// "归档共 105 条 … 可删除 105 条" for a sidebar showing 83 conversations.
{
  const { visibleKeysOf } = host.__internals
  const catalogue = [
    { id: 'session-aaa', updatedAt: 1 },
    { id: 'bbb', updatedAt: 2 },          // bare-uuid spelling
  ]
  const visible = visibleKeysOf(catalogue)
  // The set stores NORMALISED keys only — that is the whole point: both
  // spellings must reduce to one key so a lookup of either succeeds.
  ok('visibleKeysOf normalises both id spellings to one key',
    visible.size === 2 && visible.has('aaa') && visible.has('bbb') &&
    visible.has(idKeyProbe('session-aaa')) && visible.has(idKeyProbe('session-bbb')),
    JSON.stringify([...visible]))

  // An archived id that is NOT visible must not survive the intersection.
  const archivedIds = ['session-aaa', 'session-ccc', 'session-ddd']
  const actionable = archivedIds.filter((id) => visible.has(idKeyProbe(id)))
  ok('archived ids absent from the sidebar are excluded from candidates',
    actionable.length === 1 && actionable[0] === 'session-aaa',
    JSON.stringify(actionable))
}

// 🔴 The gate that keeps the plugin from emptying the sidebar.
//
// Before the favourites set has loaded, EVERY row lacks the favourite marker. An
// ungated hiding rule would therefore hide the whole conversation list —
// including newly created and archived sessions — which the user reported as
// "the plugin broke the sidebar". The rule requires `data-dsh-aff-ready='1'`,
// and `markRows` only sets it after a real marking pass.
{
  const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('every hiding rule is behind a gate',
    (bundleSource.match(/html\[data-dsh-aff-ready='1'\]/g) ?? []).length === 1 &&
    (bundleSource.match(/html\[data-dsh-aff-archready='1'\]/g) ?? []).length === 2)
  ok('markRows bails out and clears the gate while favourites are unloaded',
    bundleSource.includes('if (!favoritesLoaded)') &&
    bundleSource.includes('removeAttribute("data-dsh-aff-ready")'))
  ok('the favourites gate opens on the favourites set alone',
    bundleSource.includes('marked > 0 && favoritesLoaded'))
  ok('the archive gate opens on the archive set',
    bundleSource.includes('marked > 0 && archiveLoaded') &&
    bundleSource.includes('archiveLoaded = true'))
  // 🔴 The archive set must be primed at mount, not only when the settings page
  // opens. Priming it only from that page meant the gate stayed shut for anyone
  // who never visited settings, and the favourites narrowing never ran.
  ok('apply primes the archive set at mount',
    /stopFilterEnhancer\(\)[\s\S]{0,200}refreshArchivedCache\(\)/.test(bundleSource) ||
    /refreshArchivedCache\(\)\.then/.test(bundleSource))
  ok('refreshArchivedCache is actually called, not merely defined',
    (bundleSource.match(/refreshArchivedCache\(\)/g) ?? []).length >= 2)
  ok('the plugin strips the template check seat rather than hiding it',
    bundleSource.includes('seat.parentElement.removeChild(seat)'))
  // 🔴 The tick is a BARE <svg>. Testing `seat.querySelector("svg")` never
  // matches (an element does not match its own selector), which is why an
  // earlier version silently kept the harness's tick on our rows. Assert the
  // check uses the tag test; the comment above it may still name the old form.
  ok('the tick is detected by its own tag',
    bundleSource.includes('seat.tagName.toLowerCase() === "svg"'))
  ok('the removal path does not use a descendant query on the seat',
    !/seat\.querySelector\("svg"\)\s*!==\s*null/.test(bundleSource))
}

// 🔴 The archive axis is delegated to the harness.
//
// A row the official filter excluded is NOT RENDERED, so no CSS can restore it:
// "favourites that are archived" was empty whenever the harness hid archived
// rows. The plugin therefore clicks the harness's own filter row, and only adds
// the favourites axis on top.
{
  const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('the filter clicks the harness row for the archived mode',
    bundleSource.includes('仅显示已归档') && bundleSource.includes('officialBtn.click()'))
  ok('the filter clicks the harness row to restore the default view',
    bundleSource.includes('隐藏已归档'))
  ok('the helper never targets one of our own rows',
    bundleSource.includes("closest(\"[data-dsh-aff-injected='1']\") !== null) continue"))
  // Localisation: a Chinese-only match silently does nothing on an English
  // build, and a silent no-op is indistinguishable from a broken feature.
  ok('both the Chinese and English labels are accepted',
    bundleSource.includes('"Archived only"') && bundleSource.includes('"Hide archived"'))
  // Switching the harness filter rebuilds the rows; the scan must be re-run on a
  // ladder so the list cannot be left blank between the rebuild and the marking.
  ok('marking is re-run on a ladder after the harness filter changes',
    bundleSource.includes('setTimeout(markRows, 240)'))
  ok('a missing harness row is reported instead of failing silently',
    bundleSource.includes('harness filter row not found for'))
}

// 🔴 Deleting files tells nobody. The host must ALSO emit the client's
// row-removal event, or the deleted conversation stays on screen — the shipped
// UI drops a row on `api-session/removed`, so we emit that same contract event.
{
  const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('a successful delete emits api-session/removed',
    hostSource.includes("api-session/removed'"))
  ok('the emit sits in a try/catch so a missing event service cannot fail the delete',
    /try \{\n\s+ctx\?\.emit\?\.\('api-session\/removed'/.test(hostSource))
  ok('the deleted id is also dropped from its workspace record',
    hostSource.includes('rewriteSessionIds') || hostSource.includes('entity?.mutate'))
}

ok('host exposes internals for probing', typeof host.__internals === 'object')

// ---------------------------------------------------------------------------
// Blank sessions must be excluded from every candidate list.
//
// A blank session is the provisional New Session slot: no content to archive,
// and the shipped sidebar hides every blank session except the currently
// selected one (`if (session.blank && session.id !== current) return false`).
// A candidate the user cannot look at is a candidate they cannot verify.
// ---------------------------------------------------------------------------

console.log('\n=== blank sessions are not candidates ===\n')

{
  const now = Date.now()
  const day = 86400000
  const cat = [
    { id: 'session-real', updatedAt: now - 5 * day, title: '真实对话', blank: false },
    { id: 'session-blank', updatedAt: now - 30 * day, title: '', blank: true },
    { id: 'session-real2', updatedAt: now - 6 * day, title: '另一条', blank: false },
  ]
  const picked = host.__internals.selectIdleSessions(cat, [], 24, now)
  ok('a blank session is never an idle candidate',
    picked.length === 2,
    JSON.stringify(picked.map((e) => e.id)))
  ok('a blank session older than every real one is still excluded',
    picked.every((e) => e.blank !== true), JSON.stringify(picked.map((e) => e.blank)))
}

{
  const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('the idle pool skips blank sessions',
    hostSource.includes('if (entry.blank === true) continue'))
  ok('the archived-candidate set skips blank sessions',
    hostSource.includes('blankSessionKeys') && hostSource.includes('!blanks.has(idKey(id))'))
  ok('the blank flag is read from the harness summary',
    hostSource.includes('item?.blank === true'))
}

// ---------------------------------------------------------------------------
// Export list: the file must be HUMAN-READABLE, and the follow-ups must exist.
// ---------------------------------------------------------------------------

console.log('\n=== export list ===\n')

const { humanDuration } = host.__internals
ok('humanDuration renders minutes', humanDuration(5 * 60000) === '5 分钟', humanDuration(5 * 60000))
ok('humanDuration renders hours', humanDuration(3 * 3600000) === '3 小时', humanDuration(3 * 3600000))
ok('humanDuration renders days and hours',
  humanDuration(26 * 86400000 + 3 * 3600000) === '26 天 3 小时',
  humanDuration(26 * 86400000 + 3 * 3600000))
ok('humanDuration renders sub-minute ages',
  humanDuration(30 * 1000) === '不到 1 分钟', humanDuration(30 * 1000))
ok('humanDuration tolerates junk instead of printing NaN',
  humanDuration(null) === '' && humanDuration(-1) === '' && humanDuration(NaN) === '',
  JSON.stringify([humanDuration(null), humanDuration(-1), humanDuration(NaN)]))

// The title comes from the harness's `title` session projection.
{
  const cat = await host.__internals.activityCatalogue({
    get: () => ({
      list: async () => ({
        items: [
          { sessionId: 'session-t1', updatedAt: 1000, projections: { values: { title: '我的对话' } } },
          { sessionId: 'session-t2', updatedAt: 2000 },
        ],
      }),
    }),
  })
  ok('a conversation title is read from the title projection',
    cat[0].title === '我的对话', JSON.stringify(cat[0]))
  ok('a missing title becomes an empty string, not undefined',
    cat[1].title === '', JSON.stringify(cat[1]))
}

{
  const bundleSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  ok('the export result is kept in state, not only toasted',
    bundleSource.includes('setExportInfo({ path: res.path'))
  ok('a copy-path action is offered for the export',
    bundleSource.includes('已复制导出文件路径'))
  ok('an open-folder action is offered for the export',
    bundleSource.includes('在文件夹中打开') && bundleSource.includes('revealExport'))
  ok('the export sends a human title',
    bundleSource.includes('闲置超过 '))
  // 🔴 The export UI lives INSIDE the idle card, and no standalone card remains.
  // A separate card put the path somewhere else on the page from the button that
  // created it.
  ok('no standalone export card remains',
    !bundleSource.includes('key: "export"') &&
    !bundleSource.includes('清单为制表符分隔的文本'))
  // The window is character distance inside one component. It grew with the
  // 0.30.0 inline candidate list, which sits between the head of the card and
  // the export result — so the bound is generous on purpose: what is being
  // asserted is "same component, in that order", not a layout pixel count.
  ok('the export result is rendered inside the idle card',
    /key: "idle"[\s\S]{0,18000}?exportInfo === null/.test(bundleSource))
  // The settings page's own cards. A bare COUNT over the whole bundle stopped
  // being meaningful once 0.26.0 added a second component with its own pushed
  // children, so this asserts the cards by name instead — that is what "the
  // page has these cards" actually means. `head` is the title row, not a
  // CARD_STYLE box, so it is matched on its own.
  ok('the settings page renders its head row',
    bundleSource.includes('key: "head", style: { display: "flex"'))
  for (const key of ['idle', 'fav']) {
    ok(`the settings page renders its ${key} card`,
      bundleSource.includes(`key: "${key}", style: CARD_STYLE`))
  }
  // 0.31.0 moved the batch-delete card into ArchiveDeleteCard so that it can
  // share the pre-tick shell with the snapshot card. It is still a card on the
  // same page — only the way it is produced changed.
  ok('the settings page renders its del card through ArchiveDeleteCard',
    /React\.createElement\(ArchiveDeleteCard, \{[\s\S]{0,400}?key: "del"/.test(bundleSource) ||
    /key: "del",[\s\S]{0,400}?entries: archiveEntries/.test(bundleSource))
  // 🔴 The ungrouped card must be mounted AND must not be able to delete
  // without an explicit confirm. Both halves are asserted: a card that renders
  // but sends `confirm: true` unconditionally would be a one-click deleter.
  ok('the ungrouped health card is mounted in the settings page',
    bundleSource.includes('React.createElement(UngroupedCard, { key: "ungrouped" })'))
  ok('the ungrouped card only confirms after a dry run',
    bundleSource.includes('confirm: dryRun !== true') &&
    bundleSource.includes('dryRun: dryRun === true'))
  ok('the ungrouped card offers a read-only diagnosis first',
    bundleSource.includes('api("/ungrouped-diagnose"') &&
    bundleSource.includes('api("/ungrouped-cleanup"') &&
    bundleSource.includes('api("/ungrouped-explain"'))
  // 🔴 The "hide the bucket" switch must be a pure VIEW toggle.
  //
  // The bucket is shipped UI with no owner and no dismiss control, so hiding it
  // is the only lever a plugin has — but it must never touch data. All four
  // halves are asserted because each one alone would be a different bug:
  //   * the marker selector must be the EMPTY key (a real Workspace has a
  //     non-empty one, so this can never hide a user's own group),
  //   * the rule must be gated on the switch attribute (not always on),
  //   * the group CONTAINER must be hidden, not just the header (or its rows
  //     would be left orphaned under the previous group),
  //   * the preference must persist, or the group returns on every restart.
  ok('the ungrouped marker matches only the ownerless bucket',
    bundleSource.includes('document.querySelectorAll("[data-row-key=\'workspace:\']")'))
  ok('hiding the ungrouped group is gated on a switch attribute',
    bundleSource.includes("html[data-dsh-aff-hide-ungrouped='1'] [data-dsh-aff-ungrouped='1']{display:none !important}"))
  ok('the ungrouped switch hides the group container, not just its header',
    bundleSource.includes('var seat = headers[i].parentElement;'))
  ok('the ungrouped switch persists its preference',
    bundleSource.includes('"dsh-aff-hide-ungrouped"') &&
    bundleSource.includes('localStorage.setItem(HIDE_UNGROUPED_STORAGE_KEY'))
  // 🔴 The switch must default to ON. The bucket is shipped UI the user never
  // asked for, so "unset" has to mean hidden — otherwise every fresh install
  // shows it again and the switch looks broken. Only an explicit "0" opts in to
  // seeing it. Asserting the exact comparison keeps a future "=== '1'" refactor
  // from silently flipping the default back.
  ok('hiding the ungrouped group defaults to on when unset',
    bundleSource.includes('localStorage.getItem(HIDE_UNGROUPED_STORAGE_KEY) !== "0"'))
  ok('the ungrouped default is on even when localStorage is unavailable',
    /catch \(e\) \{ return true; \}/.test(bundleSource))
  // 🔴 Ghost-cache cleanup is the only half of this card that can fix the
  // recurring case, because the directory scan cannot see it. Three properties
  // matter and each would be a separate bug if missing:
  //   * the block exists and is mounted in the same card,
  //   * the destructive call is dry-run-first (`confirm` only on a real run),
  //   * the host re-diagnoses instead of trusting the client's id list.
  ok('the ghost-cache block is mounted inside the ungrouped card',
    bundleSource.includes('React.createElement(GhostCacheBlock, { key: "ghosts" })'))
  ok('the ghost-cache block reads and cleans through its own routes',
    bundleSource.includes('api("/ghost-cache-diagnose"') &&
    bundleSource.includes('api("/ghost-cache-clean"'))
  ok('the ghost-cache cleanup only confirms after a dry run',
    bundleSource.includes('confirm: dryRun !== true') &&
    bundleSource.includes('dryRun: dryRun === true'))
  // The harness ships its own "复制 Session ID" row, which duplicates this
  // plugin's "复制 ID + 路径". A slot cannot remove a sibling slot, so the row
  // is hidden in the DOM. Both halves matter: the labels must be the exact
  // shipped strings (a substring match would also hit our own row) and the
  // WRAPPER must be the node hidden, or a blank line is left behind.
  ok('the duplicate built-in "复制 Session ID" row is hidden',
    bundleSource.includes('"复制 Session ID"') &&
    bundleSource.includes('"Copy Session ID"') &&
    bundleSource.includes('data-dsh-aff-hidden-official'))
  ok('the hidden built-in row hides its wrapper, not just the button',
    bundleSource.includes('var seat = btn.parentElement !== null ? btn.parentElement : btn'))
  ok('the single-session delete row is labelled 删除对话',
    bundleSource.includes('}, "删除对话");'))
  // 🔴 A turn typed mid-answer is rendered with data-chat-flow-kind="steering",
  // not "user" — both kinds share the same UserMessageNodeView. Matching only
  // "user" silently drops every interjected message row, which is exactly the
  // "the undo/edit/delete buttons disappeared" bug (0.28.2). The shared
  // selector constant must cover both kinds, and nothing may fall back to a
  // user-only lookup.
  ok('the human-turn selector covers interjected (steering) messages too',
    bundleSource.includes('const HUMAN_FLOW = \'[data-chat-flow-kind="user"][data-chat-turn], [data-chat-flow-kind="steering"][data-chat-turn]\''))
  ok('the button scan resolves its owner through the shared selector',
    bundleSource.includes('const owner = row.closest(HUMAN_FLOW)'))
  ok('no turn lookup is still restricted to data-chat-flow-kind="user" alone',
    !bundleSource.includes('closest(\'[data-chat-flow-kind="user"][data-chat-turn]\')') &&
    !/querySelector\(`\[data-chat-flow-kind="user"\]\[data-chat-turn="\$\{[a-zA-Z.]+\}"\]`\)/.test(bundleSource))
  ok('the batch card is titled 超时批量归档',
    bundleSource.includes('"超时批量归档"') && !bundleSource.includes('"超时自动归档"'))
}

// The reveal route must refuse anything outside the plugin's own export folder,
// so it can never become an "open any path on disk" hole.
{
  const hostSource = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  ok('the reveal route restricts itself to the plugin export folder',
    hostSource.includes('only this plugin') && hostSource.includes('normalizedDir'))
  ok('the reveal route is its own route',
    hostSource.includes("route === '/reveal'"))
  ok('the export writes a header row naming the columns',
    hostSource.includes('# 对话名称\\t对话ID\\t所属工作区\\t闲置时长\\t最后活动时间'))
  // 🔴 The row label must be the word the SIDEBAR uses. The shipped sidebar
  // renders `node.blank ? "新会话" : title || "未命名"`, so an export saying
  // "(未命名)" for a blank row cannot be matched to the row visible on screen.
  ok('an untitled row is labelled with the sidebar wording',
    hostSource.includes("? '新会话' : '未命名'"))
  ok('the catalogue carries the blank flag and cwd outward',
    hostSource.includes('blank: e.blank === true') && hostSource.includes('cwd: e.cwd || '))
}

const { projectDirName, bareId } = host.__internals

// Project directory naming must match the jsonl backend: separators become
// dashes, non-ASCII is escaped. A mismatch means "copy path" reports a path
// that does not exist.
ok('bareId strips the session- prefix',
  bareId('session-abc-123') === 'abc-123', bareId('session-abc-123'))
ok('bareId leaves a bare uuid alone',
  bareId('abc-123') === 'abc-123', bareId('abc-123'))

// Two directory-naming conventions coexist on an upgraded machine (measured:
// 96 `session-<uuid>` and 92 bare `<uuid>` on this one). A resolver that only
// tries one form silently fails for half the sessions.
const bothNames = host.__internals.sessionDirNames('session-aa11')
ok('sessionDirNames yields the bare uuid first',
  bothNames[0] === 'aa11', JSON.stringify(bothNames))
ok('sessionDirNames also yields the prefixed form',
  bothNames.indexOf('session-aa11') > 0, JSON.stringify(bothNames))
ok('sessionDirNames covers a bare id without duplicating',
  JSON.stringify(host.__internals.sessionDirNames('aa11')) === JSON.stringify(['aa11']),
  JSON.stringify(host.__internals.sessionDirNames('aa11')))

const winDir = projectDirName('C:\\Users\\someone\\Documents\\sample-repo')
ok('projectDirName encodes a Windows cwd',
  winDir === '--C-Users-someone-Documents-sample-repo--', winDir)

// A drive letter followed by a separator must collapse to ONE dash. This is the
// assertion that matters: the naive "replace each separator with a dash" rule
// produces `C--Users`, which names a directory that does not exist, and the
// resulting "copy path" silently hands the user a dead link.
ok('projectDirName collapses the drive colon and separator into one dash',
  projectDirName('C:\\Users') === '--C-Users--', projectDirName('C:\\Users'))

const cjkDir = projectDirName('E:\\本地部署AI模型工作区')
ok('projectDirName escapes non-ASCII as ~XXXX',
  /^--E-/.test(cjkDir) && /~[0-9A-F]{4}/.test(cjkDir), cjkDir)

ok('projectDirName escapes a space as ~0020',
  projectDirName('C:\\Programs\\DSH Desktop') === '--C-Programs-DSH~0020Desktop--',
  projectDirName('C:\\Programs\\DSH Desktop'))

// ---------------------------------------------------------------------------
// Ground truth: compare against the REAL directories this machine already has.
//
// A synthetic assertion can only prove the function agrees with my belief about
// the format. The directories on disk are the actual answer, so we check
// against them — that is what caught the `C--Users` bug.
// ---------------------------------------------------------------------------

const { readdirSync, existsSync } = await import('node:fs')
const realSessionsRoot = join((await import('node:os')).homedir(), '.dsh', 'sessions')
if (existsSync(realSessionsRoot)) {
  const realDirs = new Set(
    readdirSync(realSessionsRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name),
  )
  // Derive each real directory's cwd back from the registry, then assert our
  // encoder reproduces the very name on disk.
  const registryFile = join((await import('node:os')).homedir(), '.dsh', 'storages', 'workspace.json')
  let checkedAgainstDisk = 0
  if (existsSync(registryFile)) {
    const registry = JSON.parse(readFileSync(registryFile, 'utf8'))
    for (const record of Object.values(registry?.tables?.workspaces ?? {})) {
      if (typeof record?.path !== 'string') continue
      const guess = projectDirName(record.path)
      if (!realDirs.has(guess)) {
        ok('projectDirName matches the real on-disk dir for ' + record.path, false, guess)
        continue
      }
      checkedAgainstDisk += 1
    }
  }
  ok('projectDirName reproduces every real workspace directory name on disk',
    checkedAgainstDisk > 0,
    'matched ' + checkedAgainstDisk + ' of ' + realDirs.size + ' dirs')
}

// ---------------------------------------------------------------------------
// End-to-end path resolution against REAL sessions on this machine.
//
// The synthetic fixtures above prove the guards. This proves the feature: that
// `POST /session-info` returns a path which actually exists, for sessions that
// are really on disk, under BOTH naming conventions.
// ---------------------------------------------------------------------------

if (existsSync(realSessionsRoot)) {
  // Clear the probe overrides so resolution runs against the real tree.
  const savedSessionsRoot = process.env.DSH_AFF_SESSIONS_ROOT
  const savedWorkspaceFile = process.env.DSH_AFF_WORKSPACE_FILE
  delete process.env.DSH_AFF_SESSIONS_ROOT
  delete process.env.DSH_AFF_WORKSPACE_FILE

  const { readdirSync: rd } = await import('node:fs')
  const realIds = []
  for (const projectDir of rd(realSessionsRoot, { withFileTypes: true })) {
    if (!projectDir.isDirectory()) continue
    for (const sessionDir of rd(join(realSessionsRoot, projectDir.name), { withFileTypes: true })) {
      if (!sessionDir.isDirectory()) continue
      // Feed the resolver the API-shaped id (what the client actually passes).
      realIds.push(sessionDir.name.startsWith('session-') ? sessionDir.name : 'session-' + sessionDir.name)
      if (realIds.length >= 6) break
    }
    if (realIds.length >= 6) break
  }

  let resolved = 0
  for (const id of realIds) {
    const p = await host.__internals.transcriptPath(id)
    if (typeof p === 'string' && existsSync(p)) resolved += 1
    else ok('resolves a real session path for ' + id, false, String(p))
  }
  ok('resolves real on-disk transcript paths end to end',
    realIds.length > 0 && resolved === realIds.length,
    resolved + '/' + realIds.length)

  // And the negative case: a well-formed but absent id must answer null rather
  // than inventing a path.
  const absent = await host.__internals.transcriptPath('session-00000000-0000-0000-0000-000000000000')
  ok('an absent session resolves to null, not a plausible path',
    absent === null, String(absent))

  if (savedSessionsRoot !== undefined) process.env.DSH_AFF_SESSIONS_ROOT = savedSessionsRoot
  if (savedWorkspaceFile !== undefined) process.env.DSH_AFF_WORKSPACE_FILE = savedWorkspaceFile
}

// Point the workspace-registry read at the probe copy too.
process.env.DSH_AFF_WORKSPACE_FILE = join(probeStorage, 'workspace.json')

// --- delete guard: a favourite must never be removed --------------------
//
// The planted directory makes this a REAL test: the file exists, so "spared"
// can only mean the favourite guard fired, not that resolution failed.
const guardResult = await host.__internals.handleDelete(
  { sessionIds: [keptSessionId] },
  undefined, { maxDeletePerCall: 500 },
)
const keptStillOnDisk = (await import('node:fs')).existsSync(keptSessionDir)
ok('delete refuses a favourited session',
  guardResult.deleted.length === 0 &&
  guardResult.skipped.some((s) => s.sessionId === keptSessionId && s.reason === 'favorited'),
  JSON.stringify(guardResult))
ok('the favourited session directory survives the delete call', keptStillOnDisk, keptSessionDir)

// --- delete happy path: a real, unfavourited, resolvable session IS removed
const happyResult = await host.__internals.handleDelete(
  { sessionIds: [realSessionId] },
  undefined, { maxDeletePerCall: 500 },
)
const realGone = !(await import('node:fs')).existsSync(realSessionDir)
ok('delete removes a real unfavourited session',
  happyResult.deleted.indexOf(realSessionId) >= 0,
  JSON.stringify(happyResult))
ok('the removed session directory is actually gone from disk', realGone, realSessionDir)
ok('delete reports no failures on the happy path',
  happyResult.failures.length === 0,
  JSON.stringify(happyResult.failures))

// --- delete guard: a nonexistent session is skipped, not failed ---------
const missingResult = await host.__internals.handleDelete(
  { sessionIds: ['session-00000000-0000-0000-0000-000000000000'] },
  undefined, { maxDeletePerCall: 500 },
)
ok('delete skips an unknown session without throwing',
  missingResult.deleted.length === 0 && Array.isArray(missingResult.failures),
  JSON.stringify(missingResult))

// --- delete guard: the batch cap is enforced ---------------------------
const many = Array.from({ length: 10 }, (_, i) => 'session-cap-' + i)
const capResult = await host.__internals.handleDelete(
  { sessionIds: many },
  undefined, { maxDeletePerCall: 3 },
)
ok('delete enforces maxDeletePerCall',
  typeof capResult.error === 'string' && capResult.error.length > 0,
  JSON.stringify(capResult))

// --- delete guard: an empty request is a no-op --------------------------
const emptyResult = await host.__internals.handleDelete({ sessionIds: [] }, undefined, {})
ok('delete with no ids is a no-op',
  emptyResult.deleted.length === 0 && emptyResult.failures.length === 0,
  JSON.stringify(emptyResult))

// --- delete guard: nothing outside the sessions root is ever touched -----
//
// This is the guard that matters most. If path resolution ever returns
// something outside the root, the plugin must refuse rather than remove. We
// prove it by planting a decoy OUTSIDE the configured root and pointing the
// resolver at it through the workspace registry.
const outsideRoot = join(probeRoot, 'outside')
const outsideSessionId = 'session-99999999-8888-7777-6666-555555555555'
const outsideDir = join(outsideRoot, host.__internals.bareId(outsideSessionId))
mkdirSync(outsideDir, { recursive: true })
writeFileSync(join(outsideDir, 'session.v4.jsonl.zstd'), 'decoy', 'utf8')

// Re-point the workspace registry so this session resolves to the decoy cwd.
writeFileSync(
  process.env.DSH_AFF_WORKSPACE_FILE,
  JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: ['ws-1'], archivedSessionIds: [outsideSessionId] },
    tables: {
      workspaces: {
        'ws-1': {
          path: outsideRoot.replace(/\\/g, '\\\\'),
          title: 'outside',
          sessionIds: [outsideSessionId],
          createdAt: '2026-01-01T00:00:00.000Z',
          updatedAt: '2026-01-01T00:00:00.000Z',
        },
      },
    },
  }),
  'utf8',
)

const outsideResult = await host.__internals.handleDelete(
  { sessionIds: [outsideSessionId] },
  undefined, { maxDeletePerCall: 500 },
)
const decoySurvived = (await import('node:fs')).existsSync(outsideDir)
ok('delete never removes a directory outside the sessions root',
  outsideResult.deleted.length === 0 && decoySurvived,
  JSON.stringify(outsideResult) + ' survived=' + decoySurvived)

// --- state store: a corrupt file reads as empty, never throws ------------
writeFileSync(join(probeState, 'favorites.json'), '{ this is not json', 'utf8')
let corruptThrew = null
let corruptValue = null
try { corruptValue = host.__internals.readState() } catch (e) { corruptThrew = e }
ok('a corrupt favorites file degrades to empty instead of throwing',
  corruptThrew === null && corruptValue && Object.keys(corruptValue.favorites).length === 0,
  corruptThrew ? corruptThrew.message : JSON.stringify(corruptValue))

// ---------------------------------------------------------------------------
// Idle auto-archive ("超时归档") — the host selector and its safety guards.
// ---------------------------------------------------------------------------

console.log('\n=== idle auto-archive (host selector) ===\n')

// 🔴 The return-shape regression test.
//
// `sessionController.list()` resolves to `{ items: [...] }`, NOT an array.
// Testing `Array.isArray(result)` therefore always failed, the catalogue came
// back empty, and the idle preview reported "0 conversations" for every
// threshold — a silent wrong answer with no error anywhere. Pin the shape down.
{
  const { activityCatalogue } = host.__internals
  const summaries = [
    { sessionId: 'session-a', updatedAt: 1000 },
    { sessionId: 'session-b', updatedAt: 2000 },
    { id: 'session-c', updatedAt: 3000 },          // tolerated alias
    { sessionId: 'session-d' },                    // no timestamp
  ]

  const wrapped = await activityCatalogue({ get: () => ({ list: async () => ({ items: summaries }) }) })
  ok('reads the { items } envelope the controller actually returns',
    wrapped.length === 4 && wrapped[0].id === 'session-a',
    JSON.stringify(wrapped))

  const bare = await activityCatalogue({ get: () => ({ list: async () => summaries }) })
  ok('also tolerates a bare array',
    bare.length === 4, JSON.stringify(bare))

  const broken = await activityCatalogue({ get: () => ({ list: async () => { throw new Error('boom') } }) })
  ok('a throwing controller yields an empty catalogue, not an exception',
    Array.isArray(broken) && broken.length === 0)

  const absent = await activityCatalogue({ get: () => undefined })
  ok('a missing controller yields an empty catalogue',
    Array.isArray(absent) && absent.length === 0)

  const noTs = await activityCatalogue({ get: () => ({ list: async () => ({ items: [{ sessionId: 'x' }] }) }) })
  ok('a summary without a timestamp yields updatedAt null',
    noTs.length === 1 && noTs[0].updatedAt === null, JSON.stringify(noTs))
}

const { selectIdleSessions } = host.__internals
const NOW = Date.now()
const HOUR = 3600000
const DAY = 24 * HOUR
const catalogue = [
  { id: 's-fresh', updatedAt: NOW - 0.5 * DAY },   // 12h
  { id: 's-old', updatedAt: NOW - 3 * DAY },       // 72h
  { id: 's-older', updatedAt: NOW - 10 * DAY },    // 240h
  { id: 's-archived', updatedAt: NOW - 30 * DAY }, // 720h (name only; not in the set below)
  { id: 's-notime', updatedAt: null },
  { id: 's-zero', updatedAt: 0 },
]

// The unit is HOURS. `1` means one hour, not one day — so every session except
// a sub-hour-old one qualifies, oldest first.
ok('selects every session older than the hour threshold, oldest first',
  selectIdleSessions(catalogue, [], 1, NOW).map((e) => e.id).join(',') === 's-archived,s-older,s-old,s-fresh',
  selectIdleSessions(catalogue, [], 1, NOW).map((e) => e.id).join(','))
ok('the oldest candidate comes first (so a cap keeps the oldest)',
  selectIdleSessions(catalogue, [], 1, NOW)[0].id === 's-archived')
ok('a 24-hour threshold drops the 12-hour-old session',
  selectIdleSessions(catalogue, [], 24, NOW).map((e) => e.id).join(',') === 's-archived,s-older,s-old',
  selectIdleSessions(catalogue, [], 24, NOW).map((e) => e.id).join(','))
ok('a weekly threshold keeps only the oldest two',
  selectIdleSessions(catalogue, [], 24 * 7, NOW).map((e) => e.id).join(',') === 's-archived,s-older',
  selectIdleSessions(catalogue, [], 24 * 7, NOW).map((e) => e.id).join(','))
ok('skips an already-archived session',
  selectIdleSessions(catalogue, ['s-archived'], 24 * 30, NOW).every((e) => e.id !== 's-archived'))
ok('skips a session with no usable timestamp',
  selectIdleSessions(catalogue, [], 1, NOW).every((e) => e.id !== 's-notime' && e.id !== 's-zero'))

// 🔴 The guard that matters most: a zero, negative, or NaN threshold would put
// the cutoff in the future and select EVERY session — archiving the whole list
// from one click.
ok('refuses a zero threshold (would select everything)',
  selectIdleSessions(catalogue, [], 0, NOW).length === 0)
ok('refuses a negative threshold',
  selectIdleSessions(catalogue, [], -5, NOW).length === 0)
ok('refuses a NaN threshold',
  selectIdleSessions(catalogue, [], NaN, NOW).length === 0)
ok('refuses an undefined threshold',
  selectIdleSessions(catalogue, [], undefined, NOW).length === 0)
ok('a very large threshold selects nothing',
  selectIdleSessions(catalogue, [], 24 * 3650, NOW).length === 0)

// --- state store: round-trips a write ------------------------------------
host.__internals.writeState({ version: 1, favorites: { 'session-round-trip': { at: '2026-02-02T00:00:00.000Z', title: 'RT', cwd: 'X' } } })
const roundTripped = host.__internals.readState()
ok('favorites round-trip through the store',
  roundTripped.favorites['session-round-trip']?.title === 'RT',
  JSON.stringify(roundTripped))

// ---------------------------------------------------------------------------
// Snapshot usage card ("快照占用")
//
// Two things are load-bearing here and both come straight from the user:
//   * the card must NOT scan on render — no timer, no mount-time walk;
//   * pressing the button scans once and shows the numbers, plus a dry-run
//     before anything is deleted.
// ---------------------------------------------------------------------------

console.log('\n=== snapshot usage card ===\n')

/** Depth-first search for the first element whose own text matches `re`. */
function findButtonByText(tree, re) {
  if (tree === null || tree === undefined) return null
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const hit = findButtonByText(child, re)
      if (hit !== null) return hit
    }
    return null
  }
  if (typeof tree !== 'object') return null
  if (tree.type === 'button' && re.test(textOf(tree))) return tree
  return findButtonByText(tree.children ?? [], re)
}

/**
 * Depth-first search for a checkbox input.
 *
 * 🔴 THE CARD NOW HOLDS TWO KINDS OF CHECKBOX — the pre-tick SWITCH and one per
 * ledger ROW — so "the first checkbox" is no longer a meaningful selector. Rows
 * carry `aria-label="选择会话 …"`; anything else is the policy switch. The
 * filter is what keeps these assertions about rows from silently binding to the
 * switch and passing (or failing) for the wrong reason.
 */
function findCheckbox(tree, index = 0, filter = null) {
  const found = []
  ;(function walk(node) {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (node.type === 'input' && node.props?.type === 'checkbox') {
      if (filter === null || filter.test(String(node.props?.['aria-label'] ?? ''))) found.push(node)
    }
    walk(node.children ?? [])
  })(tree)
  return found[index] ?? null
}

/**
 * The pre-tick switches, by their accessible name rather than by position.
 *
 * 🔴 There are TWO of them now (snapshot card and archive-delete card) and they
 * are deliberately independent — so "the first checkbox without an aria-label"
 * would silently pick whichever card rendered first and then assert the wrong
 * thing about the wrong policy.
 */
function findPolicySwitch(tree) {
  return findCheckbox(tree, 0, /的会话$/)
}
function findArchiveSwitch(tree) {
  return findCheckbox(tree, 0, /已归档对话/)
}
/**
 * The card that carries `markerRe` somewhere in its rendered text.
 *
 * 🔴 Both destructive cards render 试算删除 / 确认删除, and the archive card is
 * pushed BEFORE the snapshot card. Looking a button up by its label alone
 * therefore returns the wrong card, which is invisible until you notice the
 * request went to the other route. Every button below is scoped this way.
 */
/** The panel that carries `key` (0.32.0 turns the section into tabs). */
function panelOf(tree, key) {
  const kids = Array.isArray(tree?.children) ? tree.children : []
  for (const kid of kids) {
    if (!kid || typeof kid !== 'object') continue
    const props = kid.props || {}
    if (props['data-aff-panel'] === key) return kid
  }
  return null
}
/**
 * 0.32.0: the section now renders a tab bar whose labels repeat every card
 * title (超时归档 / 归档清理 / 快照占用 …). A plain "first child whose text
 * matches" search therefore resolves to the TAB BAR, and every button lookup
 * scoped through it comes back empty. Panels are checked first so a marker
 * still resolves to the card that owns it.
 */
function cardContaining(tree, markerRe) {
  const kids = Array.isArray(tree?.children) ? tree.children : []
  for (const kid of kids) {
    if (!kid || typeof kid !== 'object') continue
    const props = kid.props || {}
    const key = props['data-aff-panel']
    if (key && markerRe.test(textOf(kid))) return kid
  }
  for (const kid of kids) {
    if (kid && typeof kid === 'object' && markerRe.test(textOf(kid))) return kid
  }
  return null
}

resetHooks()
snapshotUsageCalls = 0
const settingsBefore = fetchCalls.filter((c) => String(c.url).endsWith('/snapshot-usage')).length
const settingsTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }

ok('settings page shows the snapshot-usage card', /快照占用/.test(textOf(settingsTree)))

// --- 0.32.0: one function switcher, one panel on screen -------------------
function tabButtons(tree) {
  const out = []
  ;(function walk(node) {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) { for (const c of node) walk(c); return }
    if (node.type === 'button' && node.props && node.props.role === 'tab') out.push(node)
    for (const c of node.children ?? []) walk(c)
  })(tree)
  return out
}
function visiblePanels(tree) {
  const kids = Array.isArray(tree?.children) ? tree.children : []
  return kids.filter((k) => k && typeof k === 'object' && (k.props || {})['data-aff-panel'])
}
/**
 * 0.33.0: panels mount on FIRST VISIT, so a card that has never been opened
 * does not exist in the tree at all. Anything reaching into a non-default card
 * has to press its tab first — the same gesture a user makes. Returns the
 * re-rendered tree, or null when the tab is missing.
 */
async function goToView(tree, key) {
  const btn = tabButtons(tree).find((b) => (b.props || {})['data-aff-view'] === key)
  if (!btn || typeof btn.props.onClick !== 'function') return null
  btn.props.onClick()
  hookCursor = 0
  effectQueue.length = 0
  const next = expand(sections[0].component({}), 0)
  for (const fn of effectQueue) { try { fn() } catch (e) {} }
  await settle()
  return next
}
const tabNodes = tabButtons(settingsTree)
ok('the section renders a function switcher', tabNodes.length === 5,
  JSON.stringify(tabNodes.map((b) => textOf(b))))
ok('the switcher names all five functions',
  ['超时归档', '归档清理', '快照占用', '收藏列表', '未分组体检'].every((label) =>
    tabNodes.some((b) => textOf(b).indexOf(label) >= 0)),
  JSON.stringify(tabNodes.map((b) => textOf(b))))
const panels = visiblePanels(settingsTree)
ok('every function gets exactly one panel', panels.length === 5,
  JSON.stringify(panels.map((p) => p.props['data-aff-panel'])))
ok('exactly one panel is visible at a time',
  panels.filter((p) => (p.props.style || {}).display !== 'none').length === 1,
  JSON.stringify(panels.map((p) => [p.props['data-aff-panel'], (p.props.style || {}).display])))
ok('the first function is the one that opens',
  panels.findIndex((p) => (p.props.style || {}).display !== 'none') === 0,
  JSON.stringify(panels.map((p) => p.props['data-aff-panel'])))
ok('the open tab is marked selected',
  tabNodes.filter((b) => b.props['aria-selected'] === 'true').length === 1,
  JSON.stringify(tabNodes.map((b) => [textOf(b), b.props['aria-selected']])))
// 0.33.0 changed the contract on purpose: panels are mounted on first visit
// and then frozen, NOT all mounted up front. The frame of every panel still
// renders (switching stays a display flip), but an unvisited body is null.
ok('every panel frame is still rendered', panels.length === 5)
const neverVisited = panels.filter((p) => (p.props || {})['data-aff-visited'] === '0')
ok('panels that were never opened are not mounted', neverVisited.length === 4,
  JSON.stringify(panels.map((p) => [p.props['data-aff-panel'], p.props['data-aff-visited']])))
ok('an unvisited panel mounts no body',
  neverVisited.every((p) => (Array.isArray(p.children) ? p.children : []).every((k) => !k)),
  JSON.stringify(neverVisited.map((p) => p.children)))
ok('the switcher remembers the choice via localStorage',
  source.includes('dsh-aff-settings-view'),
  'client.js does not persist the selected view')

{
// --- 0.33.0: archive-triggered snapshot purge -----------------------------
//
// This is the first switch in the plugin that authorises a destructive action
// WITHOUT the user pressing a delete button, so the assertions hold it to the
// two-step gesture: off by default, a risk block on the way on, nothing written
// until the risk is acknowledged.
await settle()
hookCursor = 0
effectQueue.length = 0
const purgeTree0 = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const purgeText0 = textOf(purgeTree0)
ok('the purge switch is on the idle card', /归档后顺带删除这些对话的快照/.test(purgeText0),
  purgeText0.slice(0, 200))
const purgeBox0 = findCheckbox(purgeTree0, 0, /归档后删除快照开关/)
ok('the purge switch is an unchecked checkbox',
  purgeBox0 !== null && purgeBox0.props.checked === false)
ok('the purge switch states it is off by default', /默认关闭/.test(purgeText0), purgeText0.slice(0, 400))
ok('nothing was written to the purge policy yet', archivePurgePolicyWrites.length === 0,
  JSON.stringify(archivePurgePolicyWrites))
ok('the purge switch never promises a silent cleanup',
  /除这个归档动作外不会自动清理任何东西/.test(purgeText0) || /默认关闭/.test(purgeText0))

purgeBox0?.props?.onChange?.()
await settle()
hookCursor = 0
effectQueue.length = 0
const purgeRiskTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const purgeRiskText = textOf(purgeRiskTree)
ok('turning the purge switch on asks for a risk acknowledgement first',
  /我知道风险，打开/.test(purgeRiskText), purgeRiskText.slice(0, 400))
ok('the purge risk box names the recycle bin', /回收站/.test(purgeRiskText))
ok('the purge risk box names the real loss', /撤销到某一轮/.test(purgeRiskText))
// 0.34.0: the sidebar right-click archive is now observed through
// domain/changed, so the copy must say both paths are covered.
ok('the purge risk box names the sidebar archive path',
  /侧栏右键归档/.test(purgeRiskText), purgeRiskText.slice(0, 700))
ok('the purge risk box promises no other automatic cleanup',
  /永远不会自动清理/.test(purgeRiskText), purgeRiskText.slice(0, 700))
ok('acknowledging is required before anything is persisted',
  archivePurgePolicyWrites.length === 0, JSON.stringify(archivePurgePolicyWrites))

const ackBtn = findButtonByText(purgeRiskTree, /我知道风险，打开/)
ackBtn?.props?.onClick?.()
await settle()
ok('acknowledging persists enabled:true',
  archivePurgePolicyWrites.length === 1 && archivePurgePolicyWrites[0]?.enabled === true,
  JSON.stringify(archivePurgePolicyWrites))
// Two passes on purpose: the first fires the mount effect (which re-reads the
// policy from the stub and settles any in-flight GET), the second is asserted on.
hookCursor = 0
effectQueue.length = 0
expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
await settle()
hookCursor = 0
effectQueue.length = 0
const purgeOnTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const purgeOnText = textOf(purgeOnTree)

ok('the purge switch reads as enabled afterwards', /已开启/.test(purgeOnText), purgeOnText.slice(0, 400))
const purgeBoxOn = findCheckbox(purgeOnTree, 0, /归档后删除快照开关/)
ok('the enabled purge switch is checked', purgeBoxOn !== null && purgeBoxOn.props.checked === true)

archivePurgePolicyWrites.length = 0
purgeBoxOn?.props?.onChange?.()
await settle()
ok('turning the purge switch off persists enabled:false',
  archivePurgePolicyWrites.length === 1 && archivePurgePolicyWrites[0]?.enabled === false,
  JSON.stringify(archivePurgePolicyWrites))
}


// 🔴 The constraint: rendering is IDLE. Nothing may have been measured yet.
const scansOnRender = fetchCalls.filter((c) => String(c.url).endsWith('/snapshot-usage')).length - settingsBefore
ok('settings page performs NO snapshot scan on render', scansOnRender === 0, String(scansOnRender))

// 0.33.0: the card mounts when its tab is opened, so open it.
const snapTree = await goToView(settingsTree, 'snapshot-usage')
ok('opening the snapshot tab mounts its card',
  snapTree !== null && cardContaining(snapTree, /快照占用/) !== null)
ok('a panel that has been opened stays mounted',
  (panelOf(snapTree, 'idle')?.props || {})['data-aff-visited'] === '1',
  JSON.stringify((panelOf(snapTree, 'idle')?.props || {})['data-aff-visited']))
ok('snapshot card starts idle with an explicit button',
  /立即统计/.test(textOf(snapTree)) && /点「立即统计」/.test(textOf(snapTree)))
ok('snapshot card explains the ledger in plain words', /history-file/.test(textOf(snapTree)))

// Press the button. This is the ONLY path that may scan.
const measureBtn = findButtonByText(snapTree, /立即统计/)
ok('snapshot card button is a real clickable button', measureBtn !== null && typeof measureBtn.props.onClick === 'function')
measureBtn?.props?.onClick?.()
await settle()

const scansAfterClick = fetchCalls.filter((c) => String(c.url).endsWith('/snapshot-usage')).length - settingsBefore
ok('pressing the button scans exactly once', scansAfterClick === 1, String(scansAfterClick))

// Re-render in place (rewind the hook cursor, keep the slots the setters close
// over) — the same technique the menu-row hover assertions use.
hookCursor = 0
effectQueue.length = 0
const measuredTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const measuredText = textOf(measuredTree)

ok('measured card reports the cleanupable session count', /2 个可清理会话/.test(measuredText), measuredText.slice(0, 240))
ok('measured card reports total size in human units', /11\.0 MB|11 MB/.test(measuredText), measuredText.slice(0, 200))
ok('measured card reports blob and row totals', /151 个快照文件/.test(measuredText) && /268 条记录/.test(measuredText), measuredText.slice(0, 200))
ok('measured card reports the elapsed time', /统计耗时 62 ms/.test(measuredText), measuredText.slice(0, 200))
// The largest row is still reported, but it now sits BELOW the favourites
// summary — the card lifts starred conversations out of the list, so both
// numbers have to coexist.
ok('measured card names the largest session', /最大一项：Big chat/.test(measuredText), measuredText.slice(0, 240))
ok('measured card states the favourites carve-out',
  /另有 1 个已收藏会话占用 2\.0 KB/.test(measuredText) && /不列入清理/.test(measuredText),
  measuredText.slice(0, 300))
ok('measured card lists both sessions', /Big chat/.test(measuredText) && /Small chat/.test(measuredText))
ok('measured card warns what deletion costs', /撤销到某一轮/.test(measuredText))
ok('measured card does NOT re-scan after rendering the result',
  fetchCalls.filter((c) => String(c.url).endsWith('/snapshot-usage')).length - settingsBefore === 1,
  String(fetchCalls.filter((c) => String(c.url).endsWith('/snapshot-usage')).length - settingsBefore))

// Nothing is selected yet, so the delete path must be disabled.
const dryBtnIdle = findButtonByText(cardContaining(measuredTree, /快照占用/), /试算删除/)
ok('delete is disabled until something is selected', dryBtnIdle !== null && dryBtnIdle.props.disabled === true)
ok('card says what to do when nothing is selected', /先勾选要删的会话/.test(measuredText))

// Tick the first row, re-render, and the delete button must wake up.
const box = findCheckbox(cardContaining(measuredTree, /快照占用/), 0, /选择会话/)
ok('each ledger row carries a checkbox', box !== null && typeof box.props.onChange === 'function')
box?.props?.onChange?.()
hookCursor = 0
effectQueue.length = 0
const pickedTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const pickedText = textOf(pickedTree)
ok('picking a row enables the dry run', /已选 1 个/.test(pickedText), pickedText.slice(0, 200))

// Dry run first — the host must be asked for a PLAN, never a deletion.
const dryBtn = findButtonByText(cardContaining(pickedTree, /快照占用/), /试算删除/)
snapshotCleanupRequests.length = 0
dryBtn?.props?.onClick?.()
await settle()
ok('dry run posts a plan request', snapshotCleanupRequests.length === 1, String(snapshotCleanupRequests.length))
ok('dry run sends dryRun:true and confirm:false',
  snapshotCleanupRequests[0]?.dryRun === true && snapshotCleanupRequests[0]?.confirm === false,
  JSON.stringify(snapshotCleanupRequests[0]))
ok('dry run sends exactly the ticked session id',
  JSON.stringify(snapshotCleanupRequests[0]?.sessionIds) === JSON.stringify(['session-big']),
  JSON.stringify(snapshotCleanupRequests[0]?.sessionIds))

hookCursor = 0
effectQueue.length = 0
const confirmTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const confirmText = textOf(confirmTree)
ok('dry run result is labelled as no-change', /试算结果，未做任何修改/.test(confirmText), confirmText.slice(0, 240))
ok('a confirmation prompt appears before deleting', /确认删除这 1 个会话的快照/.test(confirmText), confirmText.slice(0, 240))
ok('confirmation says the recycle bin is used', /回收站/.test(confirmText))
ok('confirmation states the real blast radius', /对话和磁盘文件都还在/.test(confirmText))

// Only the explicit confirm may send dryRun:false.
const confirmBtn = findButtonByText(cardContaining(confirmTree, /快照占用/), /确认删除/)
snapshotCleanupRequests.length = 0
confirmBtn?.props?.onClick?.()
await settle()
ok('confirm sends dryRun:false and confirm:true',
  snapshotCleanupRequests.length === 1 &&
  snapshotCleanupRequests[0]?.dryRun === false &&
  snapshotCleanupRequests[0]?.confirm === true,
  JSON.stringify(snapshotCleanupRequests[0]))
ok('cancel button is offered next to confirm', findButtonByText(cardContaining(confirmTree, /快照占用/), /取消/) !== null)

// ---------------------------------------------------------------------------
// 0.30.0 — the age column, the pre-tick switch, and the favourites carve-out
// ---------------------------------------------------------------------------

// Re-render the measured card so the policy row is present and readable.
hookCursor = 0
effectQueue.length = 0
const policyTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const policyText = textOf(policyTree)

ok('the card shows an inactivity age per row',
  /40 天/.test(policyText) && /15 分钟/.test(policyText),
  policyText.slice(0, 400))
ok('a favourited conversation is NOT listed as a cleanup candidate',
  !/Starred chat/.test(policyText) && !/选择会话 Starred chat/.test(policyText),
  policyText.slice(0, 400))
ok('the pre-tick switch is present and OFF by default',
  /统计时自动勾选/.test(policyText) && /默认关闭/.test(policyText),
  policyText.slice(0, 400))
const policySwitch = findPolicySwitch(policyTree)
ok('the pre-tick switch is an unchecked checkbox',
  policySwitch !== null && policySwitch.props.checked === false)
ok('nothing is pre-ticked while the switch is off',
  !/已选 /.test(policyText), policyText.slice(0, 400))

// Flipping it ON must ask for a risk acknowledgement first — never enable
// destructive pre-selection on a single click.
snapshotPolicyWrites.length = 0
policySwitch?.props?.onChange?.()
hookCursor = 0
effectQueue.length = 0
const riskTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const riskText = textOf(riskTree)
ok('turning the switch on asks for a risk acknowledgement first',
  /我知道风险，打开/.test(riskText), riskText.slice(0, 400))
ok('the risk box names the real cost',
  /撤销到以前的某一轮/.test(riskText) && /两次确认|再点一次/.test(riskText),
  riskText.slice(0, 400))
ok('the ask does not write the policy yet', snapshotPolicyWrites.length === 0,
  JSON.stringify(snapshotPolicyWrites))

const ackBtn = findButtonByText(riskTree, /我知道风险，打开/)
ackBtn?.props?.onClick?.()
await settle()
ok('acknowledging persists autoSelect:true',
  snapshotPolicyWrites.length === 1 && snapshotPolicyWrites[0]?.autoSelect === true,
  JSON.stringify(snapshotPolicyWrites))

hookCursor = 0
effectQueue.length = 0
const onTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const onText = textOf(onTree)
ok('the switch reads as enabled afterwards', /已开启/.test(onText), onText.slice(0, 400))
// 40 days idle > the 720h (30 day) threshold → ticked. 15 minutes → not.
ok('the aged row is pre-ticked', /已选 1 个/.test(onText), onText.slice(0, 400))

// Turning it back off must clear the pre-selection, not leave stale ticks.
const onSwitch = findPolicySwitch(onTree)
snapshotPolicyWrites.length = 0
onSwitch?.props?.onChange?.()
await settle()
hookCursor = 0
effectQueue.length = 0
const offTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
ok('turning the switch off persists autoSelect:false',
  snapshotPolicyWrites.length === 1 && snapshotPolicyWrites[0]?.autoSelect === false,
  JSON.stringify(snapshotPolicyWrites))
ok('turning the switch off drops the pre-selection',
  /先勾选要删的会话/.test(textOf(offTree)), textOf(offTree).slice(0, 400))

// A preferred flow: with the switch on, pressing measure re-ticks. That is the
// "每次点击快照会自动勾选" behaviour the user asked for, and it must go through
// the same scan-on-demand route, not a new one.
snapshotPolicy = { autoSelect: true, hours: 720 }
const remeasureBtn = findButtonByText(offTree, /重新统计/)
remeasureBtn?.props?.onClick?.()
await settle()
hookCursor = 0
effectQueue.length = 0
const remeasuredTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
ok('a re-measure with the switch on pre-ticks the aged row again',
  /已选 1 个/.test(textOf(remeasuredTree)), textOf(remeasuredTree).slice(0, 400))

// The card must never fetch on its own again — no polling, no interval.
const totalScans = fetchCalls.filter((c) => String(c.url).endsWith('/snapshot-usage')).length - settingsBefore
ok('the card never scans without a button press', totalScans <= 4, String(totalScans))

// ---------------------------------------------------------------------------
// Batch delete of unfavourited archived chats ("批量删除归档中「未收藏」的对话")
//
// Same shell as the snapshot card, DIFFERENT policy. The two thresholds are not
// shared on purpose: deleting a conversation throws the conversation away, while
// deleting its snapshot ledger only loses one undo step. One number governing
// both would let a cautious setting for one silently authorise the other.
// ---------------------------------------------------------------------------

console.log('\n=== archive delete card ===\n')

{

resetHooks()
archiveDeletePolicy = { autoSelect: false, hours: 720 }
archiveDeletePolicyWrites.length = 0
archiveDeleteRequests.length = 0

hookCursor = 0
effectQueue.length = 0
expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
await settle()

// Second pass: /archived has landed by now, so the rows exist.
hookCursor = 0
effectQueue.length = 0
const afterLoadTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
// 0.33.0: this card also mounts only when its own tab is opened.
const delTree = await goToView(afterLoadTree, 'del')
const delText = delTree === null ? '' : textOf(delTree)

ok('the archive delete card is on the settings page',
  /批量删除归档中「未收藏」的对话/.test(delText), delText.slice(0, 200))

// 🔴 The archive is listed inline, not exported. A list you must export before
// you can read it is a list nobody reads.
ok('the archive delete card lists the archive inline',
  /归档共 3 条：其中已收藏 1 条（保留），未收藏 2 条（可删除）/.test(delText),
  delText.slice(0, 320))
ok('the archive delete card reports where the archive set came from',
  /归档来源：官方工作区记录（3 条）/.test(delText), delText.slice(0, 320))
// A healthy but previously-unrecognised source must NOT be dressed up as an
// outage: 'workspace' used to render as '不可用：workspace:3'.
ok('a healthy source is never reported as unavailable',
  !/不可用/.test(delText), delText.slice(0, 320))

function delRowBoxes(tree) {
  const found = []
  function walk(node) {
    if (node === null || node === undefined) return
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (node.type === 'input' && node.props?.type === 'checkbox' &&
        /^删除对话 /.test(String(node.props?.['aria-label'] ?? ''))) found.push(node)
    walk(node.children ?? [])
  }
  walk(tree)
  return found
}
const delBoxes = delRowBoxes(cardContaining(delTree, /批量删除归档中/))
ok('a starred conversation is not offered for deletion',
  delBoxes.length === 2 &&
  !delBoxes.some((b) => String(b.props['aria-label']).includes('A favourited chat')),
  JSON.stringify(delBoxes.map((b) => b.props['aria-label'])))
// The ages come through, and the one the cache knows nothing about says so
// instead of pretending to be brand new.
ok('an archived row shows its age', /50 天/.test(delText), delText.slice(0, 400))
ok('an untitled archived conversation is labelled a new session',
  /（新会话）/.test(delText), delText.slice(0, 400))

// -- the shell really is shared -------------------------------------------
ok('the archive card carries the same pre-tick switch',
  /统计时自动勾选「超时」的已归档对话/.test(delText), delText.slice(0, 400))
ok('the archive card states the switch is off by default',
  /默认关闭/.test(delText), delText.slice(0, 400))
ok('the archive card has its own threshold input',
  delText.includes('超时阈值') && delText.includes('小时'), delText.slice(0, 400))

// -- dry run -> confirm ---------------------------------------------------
delBoxes[0]?.props?.onChange?.()
await settle()
hookCursor = 0
effectQueue.length = 0
const pickedTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const pickedText = textOf(pickedTree)
ok('picking an archived row enables the dry run',
  /已选 1 个/.test(pickedText), pickedText.slice(0, 400))

const dryBtn = findButtonByText(cardContaining(pickedTree, /批量删除归档中/), /试算删除/)
ok('the archive card offers a dry run',
  dryBtn !== null && typeof dryBtn.props.onClick === 'function')
dryBtn?.props?.onClick?.()
await settle()
ok('the dry run hits the archive-delete route',
  archiveDeleteRequests.length === 1, String(archiveDeleteRequests.length))
ok('the dry run is a plan, not a deletion',
  archiveDeleteRequests[0]?.dryRun === true && archiveDeleteRequests[0]?.confirm === false,
  JSON.stringify(archiveDeleteRequests[0]))
ok('the dry run carries exactly the ticked session id',
  JSON.stringify(archiveDeleteRequests[0]?.sessionIds) === JSON.stringify(['session-plain-1']),
  JSON.stringify(archiveDeleteRequests[0]?.sessionIds))

hookCursor = 0
effectQueue.length = 0
const dryTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const dryText = textOf(dryTree)
ok('the dry run result is labelled as no-change',
  /【试算结果，未做任何修改】/.test(dryText), dryText.slice(0, 500))
ok('the confirmation prompt names the real loss',
  /永久删除这 1 条已归档、未收藏的对话/.test(dryText) &&
  /不可撤销/.test(dryText) &&
  /已收藏的 1 条会被保留/.test(dryText),
  dryText.slice(0, 500))

const confirmBtn = findButtonByText(cardContaining(dryTree, /批量删除归档中/), /确认删除/)
ok('a confirm button appears after the dry run',
  confirmBtn !== null && typeof confirmBtn.props.onClick === 'function')
confirmBtn?.props?.onClick?.()
await settle()
ok('confirming the archive deletion is a real deletion',
  archiveDeleteRequests.length === 2 &&
  archiveDeleteRequests[1]?.dryRun === false &&
  archiveDeleteRequests[1]?.confirm === true,
  JSON.stringify(archiveDeleteRequests[1]))

// -- the separate policy really drives this card --------------------------
hookCursor = 0
effectQueue.length = 0
const beforeSwitchTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const delSwitch = findArchiveSwitch(beforeSwitchTree)
ok('the archive card exposes its own pre-tick switch',
  delSwitch !== null && delSwitch.props?.checked === false,
  JSON.stringify(delSwitch?.props?.['aria-label']))
delSwitch?.props?.onChange?.()
await settle()
hookCursor = 0
effectQueue.length = 0
const askTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
ok('turning the archive switch on asks for a risk acknowledgement too',
  /我知道风险，打开/.test(textOf(askTree)), textOf(askTree).slice(0, 500))
ok('the archive ask writes nothing yet', archiveDeletePolicyWrites.length === 0,
  JSON.stringify(archiveDeletePolicyWrites))

const delAck = findButtonByText(askTree, /我知道风险，打开/)
delAck?.props?.onClick?.()
await settle()
ok('acknowledging persists the archive policy on its own route',
  archiveDeletePolicyWrites.length === 1 &&
  archiveDeletePolicyWrites[0]?.autoSelect === true &&
  !snapshotPolicyWrites.some((w) => w.autoSelect === true),
  JSON.stringify({ archive: archiveDeletePolicyWrites, snapshot: snapshotPolicyWrites }))

hookCursor = 0
effectQueue.length = 0
const onDelTree = expand(sections[0].component({}), 0)
for (const fn of effectQueue) { try { fn() } catch (e) {} }
const onDelText = textOf(onDelTree)
ok('the archive switch reads as enabled afterwards', /已开启/.test(onDelText),
  onDelText.slice(0, 400))
// 50 days > the 720h (30 day) threshold → ticked. The unknown-age row must NOT
// be ticked: "unknown" is not "very old".
ok('the aged archived row is pre-ticked', /已选 1 个/.test(onDelText),
  onDelText.slice(0, 400))
}

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

console.log('\n=== summary ===')
console.log('  pass: ' + pass)
console.log('  fail: ' + fail)
if (fail > 0) {
  console.log('\nFAILURES:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log('\nALL GREEN\n')

// billion-cache.js —— billion-context 上下文压缩插件的「垃圾缓存」诊断与清理模块
//
// 依赖（全部为既有能力，不新增 npm 依赖）：
//   - Node 内置模块 node:fs/promises、node:os、node:path、node:child_process
//   - ./ungrouped-guard.js 的 sendToRecycleBin（目录删除到回收站）
//   - Windows PowerShell（回收站删除经 Microsoft.VisualBasic.FileIO）
// 安全约束：
//   - 诊断只读；清理默认 dryRun，真实删除一律进回收站，不做永久删除
//   - 只清理白名单根目录内的候选条目；活动状态（instances/writers/session-order/prefix-affinity/bili.log 等）不删
//   - 可重建缓存（overview-cache / models-dev.json 等）仅在 includeRebuild=true 时清理
//   - keepDays 控制「会话检索图片缓存」保留窗口，默认 7 天

import * as fs from 'node:fs/promises'
import * as os from 'node:os'
import * as path from 'node:path'
import { sendToRecycleBin } from './ungrouped-guard.js'

export const BILLION_CACHE_VERSION = 1

const DAY_MS = 24 * 60 * 60 * 1000

function homeDir() {
  return os.homedir()
}

export function billionCacheRoots() {
  const home = homeDir()
  const localApp = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local')
  const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
  return [
    { dir: path.join(home, '.local', 'state', 'billion-context'), label: 'billion-context 数据目录（~/.local/state/billion-context）' },
    { dir: path.join(home, '.cache', 'billion-context'), label: 'billion-context 缓存目录（~/.cache/billion-context）' },
    { dir: path.join(home, '.dsh', 'storages', 'dsh-context'), label: 'DSH 上下文存储（~/.dsh/storages/dsh-context）' },
    { dir: path.join(localApp, 'billion-context'), label: 'billion-context（%LOCALAPPDATA%）' },
    { dir: path.join(roaming, 'billion-context'), label: 'billion-context（%APPDATA%）' },
  ]
}

function clampKeepDays(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 7
  if (n < 0) return 0
  if (n > 3650) return 3650
  return Math.floor(n)
}

async function statSafe(p) {
  try {
    return await fs.stat(p)
  } catch {
    return null
  }
}

async function dirBytes(dir) {
  let total = 0
  const stack = [dir]
  while (stack.length) {
    const d = stack.pop()
    let ents = []
    try {
      ents = await fs.readdir(d, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of ents) {
      const fp = path.join(d, e.name)
      if (e.isDirectory()) stack.push(fp)
      else {
        const s = await statSafe(fp)
        if (s) total += s.size
      }
    }
  }
  return total
}

const KIND_LABELS = {
  'retrieve-image-cache': '会话检索图片缓存',
  'log-rotation': '日志轮转文件',
  'model-catalog-cache': '模型目录缓存',
  'remote-notices-snapshot': '远程通知快照',
  'overview-cache': '会话概览缓存',
  state: '运行状态（保留）',
}

function isLogRotationName(name) {
  const lower = String(name).toLowerCase()
  if (lower.endsWith('.log.old')) return true
  const idx = lower.lastIndexOf('.log.')
  if (idx >= 0) {
    const tail = lower.slice(idx + 5)
    if (tail && /^[0-9]+$/.test(tail)) return true
  }
  return false
}

function classify(base, rel, isDir, st, keepDays) {
  const abs = path.join(base.dir, rel)
  const parts = rel.split(path.sep)
  const name = parts[parts.length - 1]
  const ageDays = Math.max(0, (Date.now() - st.mtimeMs) / DAY_MS)
  const mk = (kind, deletable, rebuild, reason) => ({
    id: abs, root: base.dir, rootLabel: base.label, path: abs, rel, name, isDir,
    kind, kindLabel: KIND_LABELS[kind] || kind, deletable, rebuild, reason,
    bytes: 0, mtime: new Date(st.mtimeMs).toISOString(), ageDays: Math.round(ageDays * 10) / 10,
  })

  // 会话检索图片缓存：retrieve/img/<uuid 或 session-uuid>/（可随需重建，按 keepDays 保留最近）
  if (parts[0] === 'retrieve' && parts[1] === 'img' && parts.length === 3) {
    const keep = ageDays < keepDays
    return mk('retrieve-image-cache', !keep, false, keep
      ? ('最近 ' + keepDays + ' 天内的检索图片缓存，保留')
      : '超过 ' + keepDays + ' 天的会话检索图片缓存，可按需重建后清理')
  }
  // retrieve / retrieve/img 容器本身不单独计入（避免与子项重复统计）
  if (parts[0] === 'retrieve' && parts.length <= 2) return null

  if (!isDir && isLogRotationName(name)) {
    return mk('log-rotation', true, false, '日志轮转文件（*.log.old / *.log.N），可安全删除')
  }
  if (!isDir && name.toLowerCase() === 'models-dev.json') {
    return mk('model-catalog-cache', false, true, '模型目录缓存，可重建（重建时重新拉取）')
  }
  if (!isDir && name.toLowerCase() === 'remote-notices-snapshot.json') {
    return mk('remote-notices-snapshot', false, true, '远程通知快照，可重建')
  }
  if (!isDir && /^overview-cache.*\.json$/i.test(name)) {
    return mk('overview-cache', false, true, '会话概览缓存，可重建（下次启动重新扫描生成）')
  }
  // 顶层其余项：一律视为运行状态，仅报告不删
  if (parts.length === 1) {
    return mk('state', false, false, 'billion-context 运行状态/配置，保留不动')
  }
  return null
}

async function walkRoot(base, rel, keepDays, out) {
  let ents = []
  try {
    ents = await fs.readdir(rel ? path.join(base.dir, rel) : base.dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of ents) {
    const childRel = rel ? path.join(rel, e.name) : e.name
    const abs = path.join(base.dir, childRel)
    const st = await statSafe(abs)
    if (!st) continue
    const entry = classify(base, childRel, e.isDirectory(), st, keepDays)
    if (entry) {
      entry.bytes = e.isDirectory() ? await dirBytes(abs) : st.size
      out.push(entry)
    }
    const parts = childRel.split(path.sep)
    // 只沿 retrieve/img 链向下枚举每个会话缓存目录，其余容器不递归
    if (e.isDirectory() && parts[0] === 'retrieve' && parts.length < 3) {
      await walkRoot(base, childRel, keepDays, out)
    }
  }
}

function summarize(entries) {
  const byKind = {}
  let totalBytes = 0
  let deletableCount = 0
  let deletableBytes = 0
  let rebuildCount = 0
  let rebuildBytes = 0
  for (const e of entries) {
    totalBytes += e.bytes
    const k = byKind[e.kind] || (byKind[e.kind] = { kind: e.kind, kindLabel: e.kindLabel, count: 0, bytes: 0 })
    k.count += 1
    k.bytes += e.bytes
    if (e.deletable) {
      deletableCount += 1
      deletableBytes += e.bytes
    }
    if (e.rebuild) {
      rebuildCount += 1
      rebuildBytes += e.bytes
    }
  }
  return { totalEntries: entries.length, totalBytes, deletableCount, deletableBytes, rebuildCount, rebuildBytes, byKind }
}

export async function diagnoseBillionCache(ctx, options = {}) {
  const keepDays = clampKeepDays(options && options.keepDays)
  const scannedAt = new Date().toISOString()
  const roots = []
  const entries = []
  for (const base of billionCacheRoots()) {
    const st = await statSafe(base.dir)
    if (!st || !st.isDirectory()) {
      roots.push({ dir: base.dir, label: base.label, exists: false, bytes: 0 })
      continue
    }
    roots.push({ dir: base.dir, label: base.label, exists: true, bytes: await dirBytes(base.dir) })
    await walkRoot(base, '', keepDays, entries)
  }
  return { ok: true, version: BILLION_CACHE_VERSION, scannedAt, keepDays, roots, entries, summary: summarize(entries) }
}

function normalizePath(p) {
  return path.resolve(p).toLowerCase()
}

function insideAnyRoot(target, rootDirs) {
  const t = normalizePath(target)
  return rootDirs.some((r) => {
    const rr = normalizePath(r)
    return t === rr || t.startsWith(rr + path.sep)
  })
}

function psLiteral(p) {
  return "'" + String(p).replace(/'/g, "''") + "'"
}

async function recycleFile(file) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not-windows' }
  let spawn
  try {
    const mod = await import('node:child_process')
    spawn = mod.spawn ?? mod.default?.spawn
  } catch {
    return { ok: false, reason: 'child_process-unavailable' }
  }
  if (typeof spawn !== 'function') return { ok: false, reason: 'child_process-unavailable' }
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$target = ' + psLiteral(file),
    "if (-not (Test-Path -LiteralPath $target)) { Write-Output 'MISSING'; exit 0 }",
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($target,'OnlyErrorDialogs','SendToRecycleBin')",
    "if (Test-Path -LiteralPath $target) { Write-Output 'STILL-THERE'; exit 3 }",
    "Write-Output 'RECYCLED'",
    'exit 0',
  ].join('\n')
  return await new Promise((resolve) => {
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolve({ ok: false, reason: String(error?.message ?? error) })
      return
    }
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', (e) => resolve({ ok: false, reason: String(e?.message ?? e) }))
    child.on('close', (code) => {
      const trimmed = out.trim()
      if (trimmed === 'MISSING') return resolve({ ok: true, reason: 'missing' })
      if (trimmed === 'RECYCLED') return resolve({ ok: true, reason: 'recycled' })
      resolve({ ok: false, reason: trimmed || err.trim() || ('exit ' + code) })
    })
  })
}

export async function cleanupBillionCache(ctx, params = {}, options = {}) {
  const dryRun = options.dryRun === true
  const includeRebuild = options.includeRebuild === true
  const keepDays = clampKeepDays(options.keepDays)
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null
  const requested = Array.isArray(params.entryIds) && params.entryIds.length ? new Set(params.entryIds) : null

  const report = await diagnoseBillionCache(ctx, { keepDays })
  const rootDirs = report.roots.filter((r) => r.exists).map((r) => r.dir)
  const targets = report.entries.filter((e) => {
    if (requested) return requested.has(e.id)
    return e.deletable || (e.rebuild && includeRebuild)
  })

  const result = {
    ok: true,
    dryRun,
    includeRebuild,
    keepDays,
    deleted: [],
    skipped: [],
    failures: [],
    bytesFreed: 0,
    bytesTotal: targets.reduce((sum, e) => sum + (Number(e.bytes) || 0), 0),
  }

  const total = targets.length
  let done = 0

  for (const e of targets) {
    done += 1
    const allowed = e.deletable || (e.rebuild && includeRebuild)
    if (!allowed) {
      result.skipped.push({ id: e.id, path: e.path, reason: e.reason || 'not-deletable' })
      emit(e)
      continue
    }
    if (!insideAnyRoot(e.path, rootDirs)) {
      result.skipped.push({ id: e.id, path: e.path, reason: 'outside-root' })
      emit(e)
      continue
    }
    if (dryRun) {
      result.deleted.push({ id: e.id, path: e.path, bytes: e.bytes, kind: e.kind, wouldDelete: true })
      result.bytesFreed += Number(e.bytes) || 0
      emit(e)
      continue
    }
    let r
    try {
      r = e.isDir ? await sendToRecycleBin(e.path) : await recycleFile(e.path)
    } catch (error) {
      r = { ok: false, reason: String(error?.message ?? error) }
    }
    if (r && r.ok) {
      result.deleted.push({ id: e.id, path: e.path, bytes: e.bytes, kind: e.kind })
      result.bytesFreed += Number(e.bytes) || 0
    } else {
      result.failures.push({ id: e.id, path: e.path, reason: (r && r.reason) || 'failed' })
    }
    emit(e)
  }

  return result

  function emit(entry) {
    if (!onProgress) return
    try {
      onProgress({
        done,
        total,
        bytesFreed: result.bytesFreed,
        bytesTotal: result.bytesTotal,
        current: entry ? entry.path : '',
      })
    } catch {
      // 进度回调异常不影响清理
    }
  }
}

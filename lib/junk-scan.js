/**
 * 收藏清理 → 删除收藏垃圾文件
 *
 * 只做两件事：给一组会话目录分类量垃圾，把用户勾选的类别送进回收站。
 *
 * 边界（必须守住）：
 *   · `session.v*.jsonl.zstd` 是对话本体，永远不进任何类别；
 *   · 不递归整棵树，只扫会话目录一层 + `history-file` 一层，避免误伤；
 *   · 不接收客户端传来的路径，删除前一律按类别重新扫一遍；
 *   · 默认送回收站，可恢复；`dryRun` 只报计划。
 *
 * 模块自包含：不 import `@deepseek-ai/*`，只吃 node 内置模块，所以可以
 * 单独跑测试（见 test/junk-scan.test.mjs）。
 */
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export const JUNK_SCAN_VERSION = '1.0.0'

/** 类别顺序即界面顺序：先给最安全的，快照放最后（它最“重”）。 */
export const JUNK_CATEGORIES = [
  {
    key: 'temp',
    label: '临时 / 日志 / 备份文件',
    hint: '*.tmp、*.log、*.bak、*.old、*.swp、.DS_Store、Thumbs.db、desktop.ini',
    defaultOn: true,
  },
  {
    key: 'probe',
    label: '测试残留目录',
    hint: '.probe-home / aff-probe / proof 这类调试目录',
    defaultOn: true,
  },
  {
    key: 'empty-dir',
    label: '空目录',
    hint: '会话目录里已经不装任何文件的子目录',
    defaultOn: true,
  },
  {
    key: 'dup-transcript',
    label: '未压缩正文残留',
    hint: '同目录已有 .zstd 压缩版的旧 session.v*.jsonl（可能有旧会话仍在读，删前请确认）',
    defaultOn: false,
  },
  {
    key: 'snapshot',
    label: '历史快照（撤销点）',
    hint: '删掉后这些对话不能再回退到旧版本，对话本身保留',
    defaultOn: false,
  },
]

const TEMP_FILE_RE = /(^\.ds_store$|^thumbs\.db$|^desktop\.ini$|\.(tmp|log|bak|old|swp|crdownload)$)/i
const PROBE_DIR_RE = /^(\.probe-home|aff-probe|proof)$/i
const TRANSCRIPT_RE = /^session\.v\d+\.jsonl$/i

function statSafe(p) {
  try {
    return fs.statSync(p)
  } catch {
    return null
  }
}

function dirSize(dir, limitFiles = 20000) {
  let bytes = 0
  let files = 0
  const stack = [dir]
  while (stack.length) {
    const cur = stack.pop()
    let entries
    try {
      entries = fs.readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const p = path.join(cur, e.name)
      if (e.isDirectory()) {
        stack.push(p)
        continue
      }
      const st = statSafe(p)
      if (!st) continue
      bytes += st.size
      files += 1
      if (files >= limitFiles) return { bytes, files }
    }
  }
  return { bytes, files }
}

function isEmptyDir(dir) {
  try {
    return fs.readdirSync(dir).length === 0
  } catch {
    return false
  }
}

/**
 * 扫一批会话目录。
 *
 * @param {{ dirs: Array<{sessionId: string, dir: string}>, maxSamples?: number }} options
 * @returns {Promise<{ok: true, scanned: number, categories: Array, totalBytes: number, totalFiles: number}>}
 */
export async function scanJunk(options = {}) {
  const dirs = Array.isArray(options.dirs) ? options.dirs : []
  const maxSamples = Number(options.maxSamples) > 0 ? Number(options.maxSamples) : 5
  const acc = new Map()
  for (const c of JUNK_CATEGORIES) acc.set(c.key, { ...c, files: 0, bytes: 0, items: [], samples: [] })
  let scanned = 0

  const push = (key, item) => {
    const bucket = acc.get(key)
    if (!bucket) return
    bucket.items.push(item)
    bucket.files += item.files || 0
    bucket.bytes += item.bytes || 0
    if (bucket.samples.length < maxSamples) bucket.samples.push(item.rel)
  }

  for (const one of dirs) {
    const dir = typeof one?.dir === 'string' ? one.dir : ''
    if (!dir) continue
    const st = statSafe(dir)
    if (!st || !st.isDirectory()) continue
    scanned += 1

    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }

    const names = new Set(entries.map((e) => e.name))
    const hasZstd = entries.some((e) => /^session\.v\d+\.jsonl\.zstd$/i.test(e.name))

    for (const e of entries) {
      const p = path.join(dir, e.name)
      const rel = path.basename(dir) + '/' + e.name

      if (e.isDirectory()) {
        if (e.name.toLowerCase() === 'history-file') {
          const { bytes, files } = dirSize(p)
          if (files > 0) push('snapshot', { path: p, kind: 'dir', files, bytes, rel, sessionId: one.sessionId })
          continue
        }
        if (PROBE_DIR_RE.test(e.name)) {
          const { bytes, files } = dirSize(p)
          push('probe', { path: p, kind: 'dir', files: files || 1, bytes, rel, sessionId: one.sessionId })
          continue
        }
        if (isEmptyDir(p)) {
          push('empty-dir', { path: p, kind: 'dir', files: 1, bytes: 0, rel, sessionId: one.sessionId })
        }
        continue
      }

      if (TEMP_FILE_RE.test(e.name)) {
        const fst = statSafe(p)
        if (fst) push('temp', { path: p, kind: 'file', files: 1, bytes: fst.size, rel, sessionId: one.sessionId })
        continue
      }

      // 未压缩正文：只有同目录里已经存在 .zstd 才算重复，否则它可能是唯一副本。
      if (hasZstd && TRANSCRIPT_RE.test(e.name)) {
        const fst = statSafe(p)
        if (fst) push('dup-transcript', { path: p, kind: 'file', files: 1, bytes: fst.size, rel, sessionId: one.sessionId })
      }
    }
  }

  const categories = JUNK_CATEGORIES.map((c) => {
    const b = acc.get(c.key)
    return {
      key: b.key,
      label: b.label,
      hint: b.hint,
      defaultOn: b.defaultOn,
      files: b.files,
      bytes: b.bytes,
      samples: b.samples,
    }
  })
  return {
    ok: true,
    version: JUNK_SCAN_VERSION,
    scanned,
    categories,
    totalBytes: categories.reduce((n, c) => n + c.bytes, 0),
    totalFiles: categories.reduce((n, c) => n + c.files, 0),
  }
}

function psLiteral(text) {
  return "'" + String(text).replace(/'/g, "''") + "'"
}

/** 一批路径一次进回收站；返回每条的结果，绝不因一条失败中断。 */
async function recyclePaths(paths, options = {}) {
  if (process.platform !== 'win32') return { ok: false, reason: 'not-windows', results: [] }
  if (!paths.length) return { ok: true, results: [] }
  let spawn
  try {
    const mod = await import('node:child_process')
    spawn = mod.spawn ?? mod.default?.spawn
  } catch {
    return { ok: false, reason: 'child_process-unavailable', results: [] }
  }
  if (typeof spawn !== 'function') return { ok: false, reason: 'child_process-unavailable', results: [] }

  const permanent = options?.permanent === true
  const lines = ['Add-Type -AssemblyName Microsoft.VisualBasic', '$out = @()']
  for (const p of paths) {
    const lit = psLiteral(p)
    lines.push(`$t = ${lit}`)
    lines.push("if (-not (Test-Path -LiteralPath $t)) { $out += 'MISSING|' + $t; continue }")
    lines.push('$isDir = (Get-Item -LiteralPath $t -Force).PSIsContainer')
    lines.push('try {')
    lines.push('  if ($isDir) {')
    lines.push(
      permanent
        ? '    Remove-Item -LiteralPath $t -Recurse -Force -ErrorAction Stop'
        : "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($t,'OnlyErrorDialogs','SendToRecycleBin','DoNothing')",
    )
    lines.push('  } else {')
    lines.push(
      permanent
        ? '    Remove-Item -LiteralPath $t -Force -ErrorAction Stop'
        : "    [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($t,'OnlyErrorDialogs','SendToRecycleBin')",
    )
    lines.push('  }')
    lines.push("  if (Test-Path -LiteralPath $t) { $out += 'STILL-THERE|' + $t } else { $out += 'OK|' + $t }")
    lines.push("} catch { $out += 'ERR|' + $t + '|' + $_.Exception.Message }")
  }
  lines.push('$out | ForEach-Object { Write-Output $_ }')
  lines.push('exit 0')

  return await new Promise((resolve) => {
    let out = ''
    let err = ''
    let child
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', lines.join('\n')], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e) {
      resolve({ ok: false, reason: 'spawn-failed:' + String(e && e.message), results: [] })
      return
    }
    child.stdout?.on('data', (b) => {
      out += String(b)
    })
    child.stderr?.on('data', (b) => {
      err += String(b)
    })
    child.on('error', (e) => resolve({ ok: false, reason: 'spawn-error:' + String(e && e.message), results: [] }))
    child.on('close', () => {
      const results = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter(Boolean)
        .map((line) => {
          const parts = line.split('|')
          return { status: parts[0], path: parts[1] || '', error: parts.slice(2).join('|') || '' }
        })
      resolve({ ok: true, stderr: err.trim(), results })
    })
  })
}

/**
 * 删除指定类别的垃圾。**不接收路径**：按类别重新扫描后删除，避免客户端伪造路径。
 *
 * @param {{ dirs: Array<{sessionId: string, dir: string}>, keys: string[], dryRun?: boolean, permanent?: boolean }} options
 */
export async function deleteJunk(options = {}) {
  const keys = Array.isArray(options.keys) ? options.keys.filter((k) => JUNK_CATEGORIES.some((c) => c.key === k)) : []
  if (!keys.length) return { ok: false, error: 'no-category', results: [], deleted: 0, bytes: 0, failed: 0 }

  const dirs = Array.isArray(options.dirs) ? options.dirs : []
  const acc = new Map()
  for (const c of JUNK_CATEGORIES) acc.set(c.key, { ...c, files: 0, bytes: 0, items: [] })
  // 复用扫描：先扫全量，再按类别取路径。
  const scanDirs = dirs.map((d) => ({ sessionId: d.sessionId, dir: d.dir }))
  const scan = await scanJunk({ dirs: scanDirs, maxSamples: 0 })
  const detail = await scanJunkDetail(scanDirs)
  for (const c of detail) {
    if (!acc.has(c.key)) continue
    acc.get(c.key).items = c.items
    acc.get(c.key).files = c.files
    acc.get(c.key).bytes = c.bytes
  }

  const chosen = keys.map((k) => acc.get(k)).filter(Boolean)
  const targets = []
  for (const bucket of chosen) {
    for (const item of bucket.items) targets.push({ ...item, category: bucket.key })
  }
  const plan = {
    categories: chosen.map((b) => ({ key: b.key, files: b.files, bytes: b.bytes })),
    targets: targets.length,
    bytes: targets.reduce((n, t) => n + (t.bytes || 0), 0),
    files: targets.reduce((n, t) => n + (t.files || 0), 0),
  }
  if (options.dryRun === true) {
    // 干跑也要回清单：界面要能把「将删什么」摊开给人看，测试也靠它断言
    // 没有任何 .zstd 命中。最多回 500 条，避免一个请求塞几万行。
    const preview = targets.slice(0, 500).map((t) => ({ path: t.path, rel: t.rel, category: t.category, files: t.files, bytes: t.bytes }))
    return { ok: true, dryRun: true, plan, results: preview, truncated: targets.length > preview.length, deleted: 0, bytes: 0, failed: 0 }
  }
  if (scan.scanned === 0) return { ok: true, plan, results: [], deleted: 0, bytes: 0, failed: 0 }

  const recycled = await recyclePaths(
    targets.map((t) => t.path),
    { permanent: options.permanent === true },
  )
  const byPath = new Map()
  for (const r of recycled.results || []) byPath.set(r.path, r)
  let deleted = 0
  let bytes = 0
  let failed = 0
  const results = []
  for (const t of targets) {
    const r = byPath.get(t.path)
    const ok = r?.status === 'OK' || r?.status === 'MISSING'
    if (ok) {
      deleted += 1
      bytes += t.bytes || 0
    } else {
      failed += 1
    }
    results.push({
      path: t.rel,
      category: t.category,
      ok,
      status: r?.status || 'NO-RESULT',
      error: r?.error || '',
    })
  }
  return { ok: true, plan, results, deleted, bytes, failed, stderr: recycled.stderr || '', reason: recycled.reason || '' }
}

/** 内部：带 items 的扫描结果（scanJunk 只回样本，删除需要全量路径）。 */
async function scanJunkDetail(dirs) {
  const out = new Map()
  for (const c of JUNK_CATEGORIES) out.set(c.key, { ...c, files: 0, bytes: 0, items: [] })
  const push = (key, item) => {
    const b = out.get(key)
    if (!b) return
    b.items.push(item)
    b.files += item.files || 0
    b.bytes += item.bytes || 0
  }
  for (const one of dirs) {
    const dir = typeof one?.dir === 'string' ? one.dir : ''
    if (!dir) continue
    const st = statSafe(dir)
    if (!st || !st.isDirectory()) continue
    let entries = []
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    const names = new Set(entries.map((e) => e.name))
    const hasZstd = entries.some((e) => /^session\.v\d+\.jsonl\.zstd$/i.test(e.name))
    for (const e of entries) {
      const p = path.join(dir, e.name)
      const rel = path.basename(dir) + '/' + e.name
      if (e.isDirectory()) {
        if (e.name.toLowerCase() === 'history-file') {
          const { bytes, files } = dirSize(p)
          if (files > 0) push('snapshot', { path: p, kind: 'dir', files, bytes, rel, sessionId: one.sessionId })
          continue
        }
        if (PROBE_DIR_RE.test(e.name)) {
          const { bytes, files } = dirSize(p)
          push('probe', { path: p, kind: 'dir', files: files || 1, bytes, rel, sessionId: one.sessionId })
          continue
        }
        if (isEmptyDir(p)) push('empty-dir', { path: p, kind: 'dir', files: 1, bytes: 0, rel, sessionId: one.sessionId })
        continue
      }
      if (TEMP_FILE_RE.test(e.name)) {
        const fst = statSafe(p)
        if (fst) push('temp', { path: p, kind: 'file', files: 1, bytes: fst.size, rel, sessionId: one.sessionId })
        continue
      }
      if (hasZstd && TRANSCRIPT_RE.test(e.name)) {
        const fst = statSafe(p)
        if (fst) push('dup-transcript', { path: p, kind: 'file', files: 1, bytes: fst.size, rel, sessionId: one.sessionId })
      }
    }
  }
  return Array.from(out.values())
}

export const __internals = { dirSize, isEmptyDir, recyclePaths, scanJunkDetail, TEMP_FILE_RE, PROBE_DIR_RE, TRANSCRIPT_RE }

// fs/promises 目前未用到，保留引用会让打包器把它当依赖；显式 void 掉。
void fsp

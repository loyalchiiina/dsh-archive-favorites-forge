// ---------------------------------------------------------------------------
// ungrouped-guard — 「未分组」桶的检测 / 诊断 / 一键清理 / 成因解释
// ---------------------------------------------------------------------------
//
// 这个模块是一个 SELF-CONTAINED 宿主侧 ES 模块：它不 import 任何
// `@deepseek-ai/*` 包，所有服务一律通过参数 `ctx` 取（`ctx.get('workspaceRegistry')`、
// `ctx.get('sessions')`），所以它可以被 `lib/index.js` 直接 import 而不会引入
// 新的依赖，也不会与主文件产生循环引用。
//
// 为什么需要它
// ------------
// 官方侧栏 `@deepseek-ai/dsh-client-ui-workspace` 的 `groupByWorkspace()` 有一个
// 兜底分支：凡是出现在 `list.ids` 里、却不被任何 `workspace.sessionIds` 记账、
// 且 `sessionVisible()` 为真的会话，全部塞进标题为空的分组——也就是用户看到的
// 「未分组」。这条分支本身不是 bug（它是"历史会话还没被登记"的逃生门），但它
// 会把「会话目录存在、却从未登记进 workspace.json」的会话暴露成一个丑陋的分组。
//
// 本机实测（2026-10-29）漏进该桶的只有 6 条：4 条官方 e2e 测试夹具残留 +
// 2 条「cwd 没有对应 workspace 记录」的孤儿会话。成因与取证见
// `workspace/未分组成因报告.md`。
//
// 三条原则
// --------
//  1. **只读优先**：`diagnoseUngrouped()` 绝不改任何东西；所有写操作都在
//     `cleanupUngrouped()` 里，且默认 `dryRun = true`。
//  2. **永不直接 rmSync 会话目录**：删除一律走回收站（可恢复）。拿不到回收站
//     通道时退化为「移入隔离目录」（仍然可原路移回），绝不物理抹掉。
//  3. **永不写 workspace.json**：运行中的 DSH 把 registry 状态放在内存里，任何
//     一次 workspace 变更都会用内存快照整份覆盖该文件（已实测：外部写入 290 条
//     归档，6 分钟后被回写成 289 条）。归档只走 `registry.archiveSession()`，
//     登记只走 `entity.attachSession()`。
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { readdir, lstat, rename as fsRename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, basename } from 'node:path'
import zlib from 'node:zlib'

export const UNGROUPED_GUARD_VERSION = '1.2.0'

// ---------------------------------------------------------------------------
// 常量与低层工具
// ---------------------------------------------------------------------------

/** zstd 帧魔数。多帧流必须按它切帧，否则 `zstdDecompressSync` 只静默解第一帧。 */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** 会话日志文件名候选，按「版本代」从高到低。 */
const LOG_PATTERN = /^session(\.v(\d+))?\.jsonl(\.zstd)?$/

/** 判定「e2e 测试夹具」的指纹。本机 4 条夹具全部命中。 */
const E2E_TEXT = /body image e2e|bodymarkdown-e2e|1792475000000/i
const E2E_ID = /e2e|bodymarkdown|fixture/i

/**
 * 把目录名里的 `~XXXX` 十六进制转义还原成真实字符。
 *
 * 会话目录的上一层是「按 cwd 编码的工程目录」，形如
 * `--C-Users-someone-project-workspace--`；非 ASCII 字符与空格
 * 会被写成 `~XXXX`（至少四位大写十六进制），所以中文路径仍然是可读的。
 */
function decodeSeg(text) {
  return String(text ?? '').replace(/~([0-9A-Fa-f]{4})/g, (_m, hex) => String.fromCharCode(parseInt(hex, 16)))
}

/**
 * 会话 id 的归一化键。
 *
 * 同一个会话在磁盘上可能以 `session-<uuid>` 或裸 `<uuid>` 两种目录名出现
 * （本机实测两种并存），而 `workspace.sessionIds` 里通常存带前缀的那一种。
 * 所有集合比较都必须先过这个键，否则会把已登记成员误判成未分组。
 */
function idKey(sessionId) {
  const text = String(sessionId ?? '')
  return text.startsWith('session-') ? text.slice('session-'.length) : text
}

/** 把路径压成比较用的规范形式（小写、去掉尾部斜杠）。 */
function normPath(value) {
  return String(value ?? '').toLowerCase().replace(/[\\/]+$/, '')
}

/** `target` 是否严格位于 `root` 之内（不含 root 自身）。 */
function isInside(root, target) {
  const r = normPath(root)
  const t = normPath(target)
  if (r.length === 0 || t.length === 0) return false
  if (t === r) return false
  return t.startsWith(r + '\\') || t.startsWith(r + '/')
}

/**
 * 解压一个可能是多帧的 zstd 缓冲。
 *
 * 关键坑：`zlib.zstdDecompressSync()` 遇到多帧流 **不报错**，只解出第一帧就返回。
 * 本机一条 100KB 的会话日志因此只解出 230 字节（1 个事件），标题读成 null。
 * 所以：先整体解一次，再按魔数切帧逐帧解，取更长的那份。
 */
function decompressZstd(buf) {
  let whole = null
  try {
    whole = zlib.zstdDecompressSync(buf).toString('utf8')
  } catch {
    whole = null
  }
  const starts = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === ZSTD_MAGIC[0] && buf[i + 1] === ZSTD_MAGIC[1] && buf[i + 2] === ZSTD_MAGIC[2] && buf[i + 3] === ZSTD_MAGIC[3]) {
      starts.push(i)
    }
  }
  if (starts.length <= 1) return whole
  const parts = []
  for (let index = 0; index < starts.length; index++) {
    const from = starts[index]
    const to = index + 1 < starts.length ? starts[index + 1] : buf.length
    try {
      parts.push(zlib.zstdDecompressSync(buf.subarray(from, to)))
    } catch {
      // 单帧损坏不影响其它帧；能解多少算多少。
    }
  }
  if (parts.length === 0) return whole
  const joined = Buffer.concat(parts).toString('utf8')
  if (whole === null || joined.length > whole.length) return joined
  return whole
}

/**
 * 只解第一帧的廉价版本。
 *
 * 会话 header（`id` / `cwd` / `origin` / `blank` / `createdAt`）永远写在第一帧里，
 * 而四步排除判定只需要 header。所以「这个目录要不要进未分组」根本不需要解全文：
 * 本机实测 653 份日志 746 MB / 35.5 万帧，逐帧全解要 10.8 s，
 * 而只解第一帧整轮只要 50 ms —— 相差 200 倍。
 */
function decompressZstdHead(buf) {
  try {
    return zlib.zstdDecompressSync(buf).toString('utf8')
  } catch {
    return null
  }
}

/** 数一下这个缓冲里有几个 zstd 帧（扫魔数，不涉及解压，很快）。 */
function countZstdFrames(buf) {
  let count = 0
  let index = 0
  while (index + 4 <= buf.length) {
    const hit = buf.indexOf(ZSTD_MAGIC, index)
    if (hit === -1) break
    count += 1
    index = hit + 4
  }
  return count
}

/** 挑出目录里版本最高的那份日志文件。 */
function pickLogFile(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return { ok: false, err: 'unreadable' }
  }
  const candidates = []
  for (const name of names) {
    const match = LOG_PATTERN.exec(name)
    if (match === null) continue
    candidates.push({ name, version: match[2] === undefined ? 0 : Number(match[2]), zstd: match[3] === '.zstd' })
  }
  if (candidates.length === 0) return { ok: false, err: 'no-log', files: names }
  candidates.sort((left, right) => right.version - left.version || (right.zstd ? 1 : 0) - (left.zstd ? 1 : 0))
  const chosen = candidates[0]
  const file = join(dir, chosen.name)
  let buf
  try {
    buf = readFileSync(file)
  } catch {
    return { ok: false, err: 'read-fail' }
  }
  return { ok: true, file: chosen.name, zstd: chosen.zstd, buf, size: buf.length }
}

/** 从解出来的正文里取第一行当 header。 */
function parseHeaderLine(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const newline = text.indexOf('\n')
  const firstLine = newline === -1 ? text : text.slice(0, newline)
  let header
  try {
    header = JSON.parse(firstLine)
  } catch {
    return null
  }
  // 会话 header 有两种历史形状：直接铺开，或包在 `data` 里。
  const data = header !== null && typeof header === 'object' && header.data !== null && typeof header.data === 'object'
    ? header.data
    : header
  return { header, data: data ?? {} }
}

/**
 * 廉价读法：只解第一帧，拿 header 做判定。
 *
 * `text` 只在单帧日志时才代表全文；多帧时它只是第一帧（调用方需要全文请用
 * `readSessionLog`）。`complete` 说明这份 text 是否已经是完整正文。
 *
 * @returns {{ ok: true, file: string, size: number, header: object, data: object,
 *             text: string, complete: boolean, frames: number }
 *          | { ok: false, err: string, files?: string[] }}
 */
function readSessionHeader(dir) {
  const picked = pickLogFile(dir)
  if (!picked.ok) return picked
  let text = picked.zstd ? decompressZstdHead(picked.buf) : picked.buf.toString('utf8')
  const frames = picked.zstd ? countZstdFrames(picked.buf) : 1
  let complete = frames <= 1
  let parsed = parseHeaderLine(text)
  if (parsed === null && frames > 1) {
    // 帧边界没落在行边界上（DSH 自己不会这么写，但夹具/旧数据可能有），
    // 第一帧读不出完整 header —— 退回全文解压，保证判定正确性优先于速度。
    const whole = picked.zstd ? decompressZstd(picked.buf) : null
    if (whole !== null) {
      text = whole
      complete = true
      parsed = parseHeaderLine(whole)
    }
  }
  if (parsed === null) return { ok: false, err: 'bad-header' }
  return {
    ok: true,
    file: picked.file,
    size: picked.size,
    header: parsed.header,
    data: parsed.data,
    text,
    complete,
    frames,
  }
}

/**
 * 读一个会话目录里「版本最高」的那份日志（全文）。
 *
 * 只有真正进了未分组桶的少数几条才需要它 —— 全文只为了提标题 / 有无用户消息 /
 * e2e 标记。给全部 653 个目录都跑一遍是本模块曾经 12.6 s 的原因。
 *
 * @returns {{ ok: true, file: string, size: number, header: object, data: object, text: string }
 *          | { ok: false, err: string, files?: string[] }}
 */
function readSessionLog(dir) {
  const picked = pickLogFile(dir)
  if (!picked.ok) return picked
  let text
  try {
    text = picked.zstd ? decompressZstd(picked.buf) : picked.buf.toString('utf8')
  } catch {
    return { ok: false, err: 'read-fail' }
  }
  const parsed = parseHeaderLine(text)
  if (parsed === null) return { ok: false, err: 'bad-header' }
  return { ok: true, file: picked.file, size: picked.size, header: parsed.header, data: parsed.data, text }
}

/** 从日志正文里补出标题、是否真有用户消息、事件数、是否 e2e 夹具。 */
function enrich(row, text, sessionId) {
  let title = null
  const titlePattern = /"type"\s*:\s*"session\/title"[\s\S]{0,600}?"title"\s*:\s*"((?:[^"\\]|\\.)*)"/g
  let match
  while ((match = titlePattern.exec(text)) !== null) title = match[1]
  if (title !== null) {
    try {
      title = JSON.parse('"' + title + '"')
    } catch {
      // 保持原样
    }
  }
  const hasUserMsg = /"type"\s*:\s*"user\/message"/.test(text) || /"role"\s*:\s*"user"/.test(text)
  const eventCount = (text.match(/"type"\s*:/g) ?? []).length
  const e2eFixture = E2E_TEXT.test(text) || E2E_ID.test(String(sessionId ?? ''))
  return { title, hasUserMsg, eventCount, e2eFixture }
}

// ---------------------------------------------------------------------------
// 环境解析
// ---------------------------------------------------------------------------

function resolveEnv(options) {
  const dshHome = options?.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh')
  return {
    dshHome,
    sessionsRoot: options?.sessionsRoot ?? process.env.DSH_AFF_SESSIONS_ROOT ?? join(dshHome, 'sessions'),
    workspaceFile: options?.workspaceFile ?? process.env.DSH_AFF_WORKSPACE_FILE ?? join(dshHome, 'storages', 'workspace.json'),
    // 投影缓存的落盘位置。官方 `sessionProjectionCache` 把每条会话的 title /
    // tokenUsage / turnOutline 等 28 个投影写在这里，文件名是 **裸 uuid**（没有
    // `session-` 前缀），与会话目录名不同。
    projCacheRoot: options?.projCacheRoot ?? process.env.DSH_AFF_PROJCACHE_ROOT
      ?? join(dshHome, 'storages', 'session_projcache', 'sessions'),
    currentSessionId: options?.currentSessionId ?? process.env.DSH_SESSION_ID ?? null,
  }
}

/**
 * 成员 / 归档集合。
 *
 * 优先取 **live registry**（`ctx.get('workspaceRegistry')`）——那才是侧栏渲染用的
 * 真相；`workspace.json` 只是它的持久化残留，运行中的进程会用内存快照覆盖它，
 * 所以文件只作为「registry 不可用」时的降级来源，并在返回值里标明来源。
 */
function readMembership(ctx, env) {
  const member = new Set()
  const memberPaths = new Map() // workspacePath(normalized) -> workspaceId
  let workspaceCount = 0
  let archived = new Set()
  let archivedKnown = false
  // 置顶集合。只有幽灵缓存扫描用得到（置顶的幽灵默认保留），诊断未分组本身不需要。
  let pinned = new Set()
  let source = 'file'
  let registry = null

  try {
    registry = ctx?.get?.('workspaceRegistry') ?? null
  } catch {
    registry = null
  }

  if (registry !== null && typeof registry.list === 'function') {
    let entities = null
    try {
      entities = registry.list()
    } catch {
      entities = null
    }
    if (Array.isArray(entities)) {
      source = 'registry'
      workspaceCount = entities.length
      for (const entity of entities) {
        if (entity === null || entity === undefined) continue
        // `entity.sessionIds` 是活的 getter（内部按「日志路径是否仍匹配本 workspace」
        // 过滤），正是客户端拿到的那个数组；`record.sessionIds` 是未过滤的账面。
        let ids = null
        try {
          ids = entity.sessionIds
        } catch {
          ids = null
        }
        if (!Array.isArray(ids)) {
          const record = entity.record ?? entity
          ids = Array.isArray(record?.sessionIds) ? record.sessionIds : []
        }
        for (const id of ids) member.add(idKey(id))
        const record = entity.record ?? entity
        const recordPath = typeof record?.path === 'string' ? record.path : ''
        if (recordPath.length > 0) memberPaths.set(normPath(recordPath), record?.workspaceId ?? record?.id ?? '')
      }
      try {
        const live = registry.archivedSessionIds
        if (Array.isArray(live)) {
          archived = new Set(live.map(idKey))
          archivedKnown = true
        }
      } catch {
        archivedKnown = false
      }
      try {
        const livePinned = registry.pinnedSessionIds
        if (Array.isArray(livePinned)) pinned = new Set(livePinned.map(idKey))
      } catch {
        pinned = new Set()
      }
    }
  }

  if (source === 'file') {
    try {
      const parsed = JSON.parse(readFileSync(env.workspaceFile, 'utf8'))
      const table = parsed?.tables?.workspaces
      if (table !== null && typeof table === 'object') {
        for (const [workspaceId, record] of Object.entries(table)) {
          workspaceCount += 1
          const ids = Array.isArray(record?.sessionIds) ? record.sessionIds : []
          for (const id of ids) member.add(idKey(id))
          if (typeof record?.path === 'string' && record.path.length > 0) {
            memberPaths.set(normPath(record.path), workspaceId)
          }
        }
      }
      const live = parsed?.global?.archivedSessionIds
      if (Array.isArray(live)) {
        archived = new Set(live.map(idKey))
        archivedKnown = true
      }
      const filePinned = parsed?.global?.pinnedSessionIds
      if (Array.isArray(filePinned)) pinned = new Set(filePinned.map(idKey))
    } catch {
      // 读不到就当作「未知」，由调用方按 verdict 处理。
    }
  }

  return { member, memberPaths, workspaceCount, archived, archivedKnown, pinned, source, registry }
}

// ---------------------------------------------------------------------------
// 判定：谁会被侧栏放进「未分组」
// ---------------------------------------------------------------------------

/**
 * 给一条未分组会话建议处置方式。
 *
 * 顺序即优先级：先认「零价值垃圾」，再认「能直接归位」的，最后才退到归档。
 * `attach` 优于 `archive`：把会话登记回它自己 cwd 对应的 workspace，用户还能
 * 在侧栏里正常看到它，比把它藏进归档更符合「彻底解决」的诉求。
 */
function adviseEntry(entry, memberPaths) {
  if (entry.isCurrent) return { advise: 'manual', reason: '当前正在使用的会话，禁止自动处置' }
  if (entry.e2eFixture) return { advise: 'delete', reason: '官方 e2e 测试夹具残留（无真实用户内容）' }
  if (!entry.hasUserMsg && entry.size < 2000) {
    return { advise: 'delete', reason: `空壳会话：无用户消息且仅 ${entry.size} 字节` }
  }
  const cwd = typeof entry.cwd === 'string' ? entry.cwd : ''
  if (cwd.length > 0 && memberPaths.has(normPath(cwd))) {
    return { advise: 'attach', reason: `cwd 已有对应 workspace，可直接登记归位（不隐藏数据）` }
  }
  if (entry.hasUserMsg || (typeof entry.title === 'string' && entry.title.length > 0)) {
    return { advise: 'archive', reason: '有真实内容但 cwd 无对应 workspace，归档以移出侧栏（数据保留）' }
  }
  return { advise: 'manual', reason: '信息不足，需人工判断' }
}

/**
 * 只读诊断：当前哪些会话会被侧栏放进「未分组」。
 *
 * @param {object} ctx  宿主上下文（可为最小 stub：`{ get(name) { ... } }`）
 * @param {object} [options] `dshHome` / `sessionsRoot` / `workspaceFile` /
 *        `currentSessionId` / `maxDirs`
 * @returns {Promise<object>} 见文件头的结构说明
 */
export async function diagnoseUngrouped(ctx, options = {}) {
  const env = resolveEnv(options)
  const generatedAt = new Date().toISOString()
  const empty = {
    workspaceCount: 0, memberCount: 0, archivedCount: 0, subagentCount: 0,
    blankCount: 0, unreadableCount: 0, totalDirs: 0, ungroupedCount: 0,
  }

  if (!existsSync(env.sessionsRoot)) {
    return {
      ok: false, generatedAt, version: UNGROUPED_GUARD_VERSION,
      env, summary: empty, ungrouped: [], unreadable: [], verdict: 'env-missing',
      detail: `会话根目录不存在：${env.sessionsRoot}`,
    }
  }

  const membership = readMembership(ctx, env)
  const maxDirs = Number.isFinite(options?.maxDirs) ? Number(options.maxDirs) : 100000

  const ungrouped = []
  const unreadable = []
  let subagentCount = 0
  let blankCount = 0
  let memberHits = 0
  let archivedHits = 0
  let totalDirs = 0

  // 目录布局：<sessionsRoot>/<cwd 编码目录>/<会话目录>/session[.vN].jsonl[.zstd]
  // 同时兼容「会话目录直接躺在 sessionsRoot 下」的历史布局。
  let level1 = []
  try {
    level1 = await readdir(env.sessionsRoot, { withFileTypes: true })
  } catch {
    level1 = []
  }

  const sessionDirs = []
  for (const entry of level1) {
    if (!entry.isDirectory()) continue
    const projectDir = join(env.sessionsRoot, entry.name)
    let inner = []
    try {
      inner = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    let nested = 0
    for (const child of inner) {
      if (!child.isDirectory()) continue
      nested += 1
      sessionDirs.push({ projectDir, projectName: entry.name, dirName: child.name, dir: join(projectDir, child.name) })
      if (sessionDirs.length >= maxDirs) break
    }
    // 兜底：这个工程目录自己就含一份日志，说明它本身就是会话目录。
    if (nested === 0) {
      try {
        const names = readdirSync(projectDir)
        if (names.some((name) => LOG_PATTERN.test(name))) {
          sessionDirs.push({ projectDir: env.sessionsRoot, projectName: entry.name, dirName: entry.name, dir: projectDir })
        }
      } catch {
        // 忽略
      }
    }
    if (sessionDirs.length >= maxDirs) break
  }

  for (const item of sessionDirs) {
    totalDirs += 1
    // 先只解第一帧拿 header —— 四步排除判定只用得到 header，而全文解压是
    // 这个模块最贵的一步（本机 653 目录 746 MB / 35.5 万帧）。
    const head = readSessionHeader(item.dir)
    if (!head.ok) {
      unreadable.push({ sessionId: decodeSeg(item.dirName), dir: item.dir, err: head.err })
      continue
    }
    const data = head.data
    const sessionId = String(data.id ?? head.header?.id ?? decodeSeg(item.dirName))
    const key = idKey(sessionId)
    const cwd = typeof data.cwd === 'string' ? data.cwd : (typeof head.header?.cwd === 'string' ? head.header.cwd : null)
    const origin = data.origin ?? head.header?.origin ?? null
    const blank = data.blank === true || head.header?.blank === true
    const createdAt = data.createdAt ?? head.header?.createdAt ?? null
    const isCurrent = env.currentSessionId !== null && idKey(env.currentSessionId) === key

    // 与官方 `sessionVisible(session, current, archived, 'default')` 同序：
    // subagent → blank(非当前) → archived → 是否被任何 workspace 记账。
    if (origin === 'subagent') { subagentCount += 1; continue }
    if (blank && !isCurrent) { blankCount += 1; continue }
    if (membership.archived.has(key)) { archivedHits += 1; continue }
    if (membership.member.has(key)) { memberHits += 1; continue }

    // 🔴 走到这里才是「按 header 判断会进未分组」的候选。但 header 里没有
    // blank 标记 —— 官方把它放在投影缓存的 sessionListMetadata 里。一条刚建好
    // 还没说过话的空白会话，header 看起来完全正常，侧栏却不会画它（blank 且
    // 非当前 → sessionVisible 返回 false）。不查缓存就会把它误报成游离会话。
    // 只在候选这一步查，正常成员一次 I/O 都不多付。
    if (!isCurrent) {
      const cachedBlank = readCacheBlank(env, sessionId)
      if (cachedBlank === true) { blankCount += 1; continue }
    }

    // 到这里才真正「会出现在未分组里」，值得付全文解压的代价（通常个位数条）。
    let text = head.text
    let truncated = false
    if (!head.complete) {
      const full = readSessionLog(item.dir)
      if (full.ok) text = full.text
      else truncated = true
    }
    const meta = enrich(null, text, sessionId)
    const base = {
      sessionId,
      dir: item.dir,
      dirName: item.dirName,
      projectDir: item.projectName,
      cwd,
      createdAt,
      origin,
      blank,
      size: head.size,
      logFile: head.file,
      title: meta.title,
      hasUserMsg: meta.hasUserMsg,
      eventCount: meta.eventCount,
      e2eFixture: meta.e2eFixture,
      isCurrent,
      ...(truncated ? { textTruncated: true } : {}),
    }
    const verdict = adviseEntry(base, membership.memberPaths)
    ungrouped.push({ ...base, advise: verdict.advise, reason: verdict.reason })
  }

  return {
    ok: true,
    generatedAt,
    version: UNGROUPED_GUARD_VERSION,
    env,
    source: membership.source,
    archivedKnown: membership.archivedKnown,
    summary: {
      workspaceCount: membership.workspaceCount,
      memberCount: memberHits,
      archivedCount: archivedHits,
      subagentCount,
      blankCount,
      unreadableCount: unreadable.length,
      totalDirs,
      ungroupedCount: ungrouped.length,
    },
    ungrouped,
    unreadable,
    verdict: ungrouped.length === 0 ? 'clean' : 'has-ungrouped',
  }
}

// ---------------------------------------------------------------------------
// 投影缓存幽灵：有缓存、无会话目录
// ---------------------------------------------------------------------------
//
// 为什么单列一档
// --------------
// `diagnoseUngrouped()` 只扫会话目录，因为「未分组」的官方判定（`groupByWorkspace`
// 的 stray 分支）输入是会话列表。但列表不是只从磁盘来：`sessionQuery.listSessions()`
// 用 `persistence.list()` 打底，再叠加 live 会话；客户端渲染一条会话所需的 title /
// tokenUsage / turnOutline 全部来自**投影缓存**（`session_projcache/sessions/*.json`）。
//
// 于是存在一类磁盘上完全查不到的条目：会话目录早就没了，投影缓存却还留着，运行中的
// 实例仍然把它们当真实会话渲染，而 `workspace.sessionIds` 里从来没有它们 → 落进
// stray 分支 → 侧栏画出「未分组」。本机实测 984 条缓存 vs 438 个目录 = **364 条幽灵**。
//
// 本档只做两件事：**只读列出**这些孤儿缓存，**默认干跑**地把它们清掉。清缓存不删
// 任何对话：会话目录不存在，本来就没有对话可删。

/**
 * 枚举磁盘上真实存在的会话目录。
 *
 * 与 `diagnoseUngrouped()` 用的是同一套布局假设（`<root>/<工程目录>/<会话目录>`，
 * 并兼容会话目录直接躺在 root 下的历史布局），单独抽出来是为了让幽灵扫描能复用，
 * 而不是为了共用状态。
 */
async function listSessionDirs(env, maxDirs) {
  const sessionDirs = []
  let level1 = []
  try {
    level1 = await readdir(env.sessionsRoot, { withFileTypes: true })
  } catch {
    return sessionDirs
  }
  for (const entry of level1) {
    if (!entry.isDirectory()) continue
    const projectDir = join(env.sessionsRoot, entry.name)
    let inner = []
    try {
      inner = await readdir(projectDir, { withFileTypes: true })
    } catch {
      continue
    }
    let nested = 0
    for (const child of inner) {
      if (!child.isDirectory()) continue
      nested += 1
      sessionDirs.push({ projectDir, projectName: entry.name, dirName: child.name, dir: join(projectDir, child.name) })
      if (sessionDirs.length >= maxDirs) break
    }
    if (nested === 0) {
      try {
        const names = readdirSync(projectDir)
        if (names.some((name) => LOG_PATTERN.test(name))) {
          sessionDirs.push({ projectDir: env.sessionsRoot, projectName: entry.name, dirName: entry.name, dir: projectDir })
        }
      } catch {
        // 忽略
      }
    }
    if (sessionDirs.length >= maxDirs) break
  }
  return sessionDirs
}

/**
 * 从投影缓存里读「这条会话是不是还没说过话」。
 *
 * 🔴 这个标记**不在会话日志的 header 里**。官方 `sessionProjectionCache` 把
 * `sessionListMetadata.blank` 写进 `storages/session_projcache/sessions/<裸uuid>.json`，
 * 侧栏的 `sessionVisible()` 判的就是这个字段。早先只读 header 的 `blank`，
 * 于是一条刚建好、还没发过话的空白会话（header 里没有 blank 字段）会被误判成
 * 游离会话、报进「未分组」——而侧栏其实不会画它。
 *
 * 返回 true / false / null（null = 缓存不存在或读不出，保持「不知道」而不是猜）。
 */
function readCacheBlank(env, sessionId) {
  // 两种拼写都试：本机实测缓存文件名有带 `session-` 前缀的，也有裸 uuid 的
  // （跨代升级过）。只试一种就会在另一半机器上永远读到 null。
  const candidates = [
    join(env.projCacheRoot, `${idKey(sessionId)}.json`),
    join(env.projCacheRoot, `${String(sessionId)}.json`),
  ]
  let text = null
  for (const file of candidates) {
    try {
      if (!existsSync(file)) continue
      text = readFileSync(file, 'utf8')
      break
    } catch {
      // 试下一个
    }
  }
  if (text === null) return null
  const identity = readCacheIdentity(text)
  if (identity === null) return null
  return identity.blank
}

/** 从一份投影缓存 JSON 里尽量取出人能看懂的身份信息。 */
function readCacheIdentity(text) {
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  const record = parsed?.record ?? null
  if (record === null || typeof record !== 'object') return null
  const rows = record.rows !== null && typeof record.rows === 'object' ? record.rows : {}
  const titleRow = rows?.title?.val
  const listMeta = rows?.sessionListMetadata?.val
  const turnOutline = rows?.turnOutline?.val
  return {
    title: typeof titleRow === 'string' ? titleRow : null,
    createdAt: typeof record?.identity?.createdAt === 'number' ? record.identity.createdAt : null,
    cwd: typeof record?.identity?.cwd === 'string' ? record.identity.cwd : null,
    blank: listMeta !== null && typeof listMeta === 'object' ? listMeta.blank === true : null,
    lastPromptAt: listMeta !== null && typeof listMeta === 'object' && typeof listMeta.lastPromptAt === 'number'
      ? listMeta.lastPromptAt : null,
    turns: Array.isArray(turnOutline?.turns) ? turnOutline.turns.length : null,
  }
}

/**
 * 只读扫描：投影缓存里那些**磁盘上已经没有会话目录**的记录。
 *
 * @param {object} ctx
 * @param {object} [options] `dshHome` / `sessionsRoot` / `workspaceFile` /
 *        `projCacheRoot` / `currentSessionId` / `maxDirs` / `includePinned`(默认 false)
 * @returns {Promise<object>} `{ok, generatedAt, version, env, summary, ghosts, verdict}`
 */
export async function diagnoseGhostCache(ctx, options = {}) {
  const env = resolveEnv(options)
  const generatedAt = new Date().toISOString()
  const emptySummary = { cacheFiles: 0, diskSessions: 0, ghostCount: 0, pinnedGhostCount: 0, archivedGhostCount: 0, bytes: 0 }

  if (!existsSync(env.projCacheRoot)) {
    return {
      ok: false, generatedAt, version: UNGROUPED_GUARD_VERSION, env,
      summary: emptySummary, ghosts: [], verdict: 'env-missing',
      detail: `投影缓存目录不存在：${env.projCacheRoot}`,
    }
  }

  const maxDirs = Number.isFinite(options?.maxDirs) ? Number(options.maxDirs) : 100000
  const sessionDirs = await listSessionDirs(env, maxDirs)

  // 磁盘侧 id 集合。会话目录名就是会话 id（`~XXXX` 转义后），所以不需要读 header，
  // 这一步是纯 readdir，几万个目录也只要几十毫秒。
  const onDisk = new Set()
  for (const item of sessionDirs) onDisk.add(idKey(decodeSeg(item.dirName)))

  const membership = readMembership(ctx, env)

  let names = []
  try {
    names = await readdir(env.projCacheRoot, { withFileTypes: true })
  } catch {
    names = []
  }

  const ghosts = []
  let cacheFiles = 0
  let bytes = 0
  let pinnedGhostCount = 0
  let archivedGhostCount = 0

  for (const entry of names) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue
    cacheFiles += 1
    const bare = entry.name.slice(0, -'.json'.length)
    const key = idKey(bare)
    // 命中磁盘目录 = 不是幽灵，直接跳过（不读文件，省 I/O）。
    if (onDisk.has(key)) continue

    const file = join(env.projCacheRoot, entry.name)
    let size = 0
    let identity = null
    try {
      const text = readFileSync(file, 'utf8')
      size = Buffer.byteLength(text, 'utf8')
      identity = readCacheIdentity(text)
    } catch {
      identity = null
    }
    bytes += size
    const pinned = membership.pinned.has(key)
    const archived = membership.archived.has(key)
    if (pinned) pinnedGhostCount += 1
    if (archived) archivedGhostCount += 1
    ghosts.push({
      sessionId: bare,
      file,
      bytes: size,
      title: identity?.title ?? null,
      cwd: identity?.cwd ?? null,
      createdAt: identity?.createdAt ?? null,
      lastPromptAt: identity?.lastPromptAt ?? null,
      blank: identity?.blank ?? null,
      turns: identity?.turns ?? null,
      pinned,
      archived,
      // 0.36.0（用户 2026-11-01 拍板）：幽灵缓存默认**全部可删**。
      // 旧版对 pinned/archived 的幽灵给 'keep'，结果就是本机 86 条幽灵一条都删不掉——
      // 会话目录早在几个月前就没了，那两条标记只是 workspace.json 里残留的孤儿 id，
      // 「保留」保护不到任何真实数据，只保护了一个空壳缓存文件。
      // 想留的人可以在界面上勾「保留已归档 / 置顶」——保护改成显式选择，不再是默认。
      advise: 'delete',
    })
  }

  // 新的排前面：最近才产生的幽灵最可能是当前正在困扰用户的那批。
  ghosts.sort((a, b) => (b.lastPromptAt ?? b.createdAt ?? 0) - (a.lastPromptAt ?? a.createdAt ?? 0))

  return {
    ok: true,
    generatedAt,
    version: UNGROUPED_GUARD_VERSION,
    env,
    source: membership.source,
    summary: {
      cacheFiles,
      diskSessions: onDisk.size,
      ghostCount: ghosts.length,
      pinnedGhostCount,
      archivedGhostCount,
      bytes,
    },
    ghosts,
    verdict: ghosts.length === 0 ? 'clean' : 'has-ghosts',
  }
}

/**
 * 清理幽灵缓存。**默认 `dryRun = true`**，只回报「会删哪些」。
 *
 * 删的是 `<projCacheRoot>/<id>.json` 这一个文件，**不是会话目录**（目录本来就不存在）。
 * 优先送回收站，拿不到回收站通道时降级为移入隔离目录，绝不物理抹掉。
 *
 * @param {object} ctx
 * @param {Array}  plan      `diagnoseGhostCache()` 的 `ghosts` 数组（或其子集）
 * @param {object} [options] `dryRun`(默认 true) / `maxItems`(默认 500) /
 *        `keepPinned`(默认 false，置顶幽灵默认**也删**) / `keepArchived`(默认 false，
 *        归档幽灵同样默认删——0.36.0 起保护变成显式勾选) /
 *        `projCacheRoot` / `dshHome` / `quarantineFallback`(默认 true)
 * @returns {Promise<{dryRun:boolean, deleted:string[], skipped:Array, failures:Array, bytesFreed:number}>}
 */
export async function cleanupGhostCache(ctx, plan, options = {}) {
  const env = resolveEnv(options)
  const dryRun = options?.dryRun !== false
  const maxItems = Number.isFinite(options?.maxItems) ? Number(options.maxItems) : 500
  // 0.36.0: 语义从 `includePinned`（默认不删）翻成 `keepPinned`（默认删）。
  // 旧参数名仍然认——外部脚本/旧文档还在传 includePinned:true，那意思正好反了，
  // 所以保留它作为 `keepPinned = !includePinned` 的兼容入口，避免一次误删。
  const keepPinned = options?.keepPinned === true
    || (Object.prototype.hasOwnProperty.call(options || {}, 'includePinned') && options.includePinned !== true)
  const keepArchived = options?.keepArchived === true
    || (Object.prototype.hasOwnProperty.call(options || {}, 'includeArchived') && options.includeArchived !== true)
  const quarantineFallback = options?.quarantineFallback !== false

  const result = { dryRun, deleted: [], skipped: [], failures: [], bytesFreed: 0 }
  const entries = Array.isArray(plan) ? plan : []
  if (entries.length === 0) return result

  let budget = maxItems
  for (const entry of entries) {
    const sessionId = String(entry?.sessionId ?? '')
    const file = String(entry?.file ?? '')
    if (sessionId.length === 0 || file.length === 0) {
      result.skipped.push({ sessionId, file, reason: 'missing-id-or-file' })
      continue
    }
    if (entry?.pinned === true && keepPinned) {
      result.skipped.push({ sessionId, reason: 'pinned-kept' })
      continue
    }
    if (entry?.archived === true && keepArchived) {
      result.skipped.push({ sessionId, reason: 'archived-kept' })
      continue
    }
    if (budget <= 0) {
      result.skipped.push({ sessionId, reason: 'budget-exhausted' })
      continue
    }
    // 铁律：只允许删 projCacheRoot 之内的文件。
    if (!isInside(env.projCacheRoot, file)) {
      result.failures.push({ sessionId, file, reason: 'outside-projcache-root' })
      continue
    }
    let info = null
    try {
      info = await lstat(file)
    } catch (error) {
      result.skipped.push({ sessionId, reason: `not-found:${String(error?.code ?? '')}` })
      continue
    }
    if (info.isSymbolicLink()) {
      result.failures.push({ sessionId, file, reason: 'refused-symlink' })
      continue
    }
    if (!info.isFile()) {
      result.failures.push({ sessionId, file, reason: 'not-a-file' })
      continue
    }
    budget -= 1
    if (dryRun) {
      result.deleted.push(sessionId)
      result.bytesFreed += Number(entry?.bytes ?? info.size ?? 0)
      continue
    }
    const recycled = await sendFileToRecycleBin(file)
    if (recycled.ok) {
      result.deleted.push(sessionId)
      result.bytesFreed += Number(entry?.bytes ?? info.size ?? 0)
      continue
    }
    if (quarantineFallback) {
      const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
      const target = join(env.dshHome, `projcache_quarantine_${stamp}`, basename(file))
      try {
        await fsRename(file, target)
        result.deleted.push(sessionId)
        result.bytesFreed += Number(entry?.bytes ?? info.size ?? 0)
        result.skipped.push({ sessionId, reason: `quarantined-instead-of-recycled:${recycled.reason}` })
        continue
      } catch (error) {
        result.failures.push({ sessionId, file, reason: `recycle-failed:${recycled.reason};quarantine-failed:${String(error?.message ?? error)}` })
        continue
      }
    }
    result.failures.push({ sessionId, file, reason: `recycle-failed:${recycled.reason}` })
  }

  return result
}

// ---------------------------------------------------------------------------
// 清理：默认只干跑
// ---------------------------------------------------------------------------

/** PowerShell 单引号字符串字面量（内部单引号翻倍）。 */
function psLiteral(text) {
  return "'" + String(text).replace(/'/g, "''") + "'"
}

/**
 * 把目录送进回收站（可恢复）。
 *
 * 说明：`node:child_process` 在这里 **按需动态 import**，是本模块唯一的非白名单
 * 依赖，用途仅限于调用 Windows 自带的回收站 API；不用它就只能物理删除，那违反
 * 「删除必须可恢复」的铁律。拿不到 child_process 或非 Windows 时返回
 * `{ ok: false }`，由调用方降级为「移入隔离目录」。
 */
export async function sendToRecycleBin(dir) {
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
    `$target = ${psLiteral(dir)}`,
    "if (-not (Test-Path -LiteralPath $target)) { Write-Output 'MISSING'; exit 0 }",
    "[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($target,'OnlyErrorDialogs','SendToRecycleBin','DoNothing')",
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
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.stderr?.on('data', (chunk) => { err += String(chunk) })
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ ok: false, reason: 'timeout' })
    }, 60000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.includes('RECYCLED')) resolve({ ok: true })
      else resolve({ ok: false, reason: `exit=${code} ${out.trim()} ${err.trim()}`.trim() })
    })
  })
}

/**
 * 把**单个文件**送进回收站。
 *
 * 与 `sendToRecycleBin()` 只差一句 API：目录用 `DeleteDirectory`，文件必须用
 * `DeleteFile`（传目录版会抛「找不到文件」）。幽灵缓存要删的是 `.json` 文件，
 * 所以需要这一份。
 */
async function sendFileToRecycleBin(file) {
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
    `$target = ${psLiteral(file)}`,
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
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.stderr?.on('data', (chunk) => { err += String(chunk) })
    const timer = setTimeout(() => {
      try { child.kill() } catch {}
      resolve({ ok: false, reason: 'timeout' })
    }, 60000)
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, reason: String(error?.message ?? error) })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0 && out.includes('RECYCLED')) resolve({ ok: true })
      else resolve({ ok: false, reason: `exit=${code} ${out.trim()} ${err.trim()}`.trim() })
    })
  })
}

/** 降级通道：把会话目录移入隔离区（同盘 rename，可原路移回）。 */
async function moveToQuarantine(dir, env, stamp) {
  const target = join(env.dshHome, `sessions_quarantine_${stamp}`, basename(join(dir, '..')), basename(dir))
  try {
    await fsRename(dir, target)
    return { ok: true, target }
  } catch (error) {
    return { ok: false, reason: String(error?.message ?? error) }
  }
}

/**
 * 按诊断结果执行处置。**默认 `dryRun = true`**，只回报「会做什么」。
 *
 * @param {object} ctx
 * @param {Array}  plan      `diagnoseUngrouped()` 返回的 `ungrouped` 数组（或其子集）
 * @param {object} [options] `dryRun`(默认 true) / `actions`(允许的动作，默认
 *        `['delete','archive','attach']`) / `maxItems`(默认 50) / `currentSessionId` /
 *        `dshHome` / `sessionsRoot` / `quarantineFallback`(默认 true) / `emitRemoved`(默认 true)
 * @returns {Promise<{dryRun:boolean, deleted:string[], archived:string[], attached:string[],
 *          skipped:Array, failures:Array}>}
 */
export async function cleanupUngrouped(ctx, plan, options = {}) {
  const env = resolveEnv(options)
  const dryRun = options?.dryRun !== false
  const actions = Array.isArray(options?.actions) ? new Set(options.actions) : new Set(['delete', 'archive', 'attach'])
  const maxItems = Number.isFinite(options?.maxItems) ? Number(options.maxItems) : 50
  const quarantineFallback = options?.quarantineFallback !== false
  const emitRemoved = options?.emitRemoved !== false

  const result = { dryRun, deleted: [], archived: [], attached: [], skipped: [], failures: [] }
  const entries = Array.isArray(plan) ? plan : []
  if (entries.length === 0) return result

  let registry = null
  try {
    registry = ctx?.get?.('workspaceRegistry') ?? null
  } catch {
    registry = null
  }

  // 每个动作最多 maxItems 条，避免一次点击横扫整台机器。
  const budget = { delete: maxItems, archive: maxItems, attach: maxItems }

  for (const entry of entries) {
    const sessionId = String(entry?.sessionId ?? '')
    const dir = String(entry?.dir ?? '')
    const advise = String(entry?.advise ?? 'manual')

    if (sessionId.length === 0 || dir.length === 0) {
      result.skipped.push({ sessionId, dir, reason: 'missing-id-or-dir' })
      continue
    }
    if (!actions.has(advise)) {
      result.skipped.push({ sessionId, reason: `action-not-allowed:${advise}` })
      continue
    }
    if (budget[advise] !== undefined && budget[advise] <= 0) {
      result.skipped.push({ sessionId, reason: `budget-exhausted:${advise}` })
      continue
    }
    // 铁律：绝不动当前正在使用的会话。
    const current = env.currentSessionId
    if (current !== null && idKey(current) === idKey(sessionId)) {
      result.skipped.push({ sessionId, reason: 'current-session' })
      continue
    }
    // 铁律：只允许处置 sessionsRoot 之内的目录。
    if (!isInside(env.sessionsRoot, dir)) {
      result.failures.push({ sessionId, dir, reason: 'outside-sessions-root' })
      continue
    }

    if (advise === 'delete') {
      let info = null
      try {
        info = await lstat(dir)
      } catch (error) {
        result.skipped.push({ sessionId, reason: `not-found:${String(error?.code ?? '')}` })
        continue
      }
      if (info.isSymbolicLink()) {
        result.failures.push({ sessionId, dir, reason: 'refused-symlink' })
        continue
      }
      if (!info.isDirectory()) {
        result.failures.push({ sessionId, dir, reason: 'not-a-directory' })
        continue
      }
      if (budget.delete !== undefined) budget.delete -= 1
      if (dryRun) {
        result.deleted.push(sessionId)
        continue
      }
      const recycled = await sendToRecycleBin(dir)
      if (recycled.ok) {
        result.deleted.push(sessionId)
      } else if (quarantineFallback) {
        const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)
        const moved = await moveToQuarantine(dir, env, stamp)
        if (moved.ok) {
          result.deleted.push(sessionId)
          result.skipped.push({ sessionId, reason: `quarantined-instead-of-recycled:${recycled.reason}` })
        } else {
          result.failures.push({ sessionId, dir, reason: `recycle-failed:${recycled.reason};quarantine-failed:${moved.reason}` })
          continue
        }
      } else {
        result.failures.push({ sessionId, dir, reason: `recycle-failed:${recycled.reason}` })
        continue
      }
      // 目录已消失；告知客户端把这一行从列表里去掉（官方 UI 监听该事件）。
      if (emitRemoved) {
        try {
          ctx?.emit?.('api-session/removed', sessionId)
        } catch {
          // 事件发不出去只影响「要不要手动刷新」，不影响文件层结果。
        }
      }
      continue
    }

    if (advise === 'archive') {
      if (registry === null || typeof registry.archiveSession !== 'function') {
        result.failures.push({ sessionId, reason: 'workspaceRegistry.archiveSession-unavailable' })
        continue
      }
      if (budget.archive !== undefined) budget.archive -= 1
      if (dryRun) {
        result.archived.push(sessionId)
        continue
      }
      try {
        await registry.archiveSession(sessionId)
        result.archived.push(sessionId)
      } catch (error) {
        result.failures.push({ sessionId, reason: String(error?.message ?? error) })
      }
      continue
    }

    if (advise === 'attach') {
      const cwd = typeof entry?.cwd === 'string' ? entry.cwd : ''
      let target = null
      try {
        const entities = registry !== null && typeof registry.list === 'function' ? registry.list() : null
        if (Array.isArray(entities)) {
          for (const entity of entities) {
            const record = entity?.record ?? entity
            if (record !== null && typeof record?.path === 'string' && normPath(record.path) === normPath(cwd)) {
              target = entity
              break
            }
          }
        }
      } catch {
        target = null
      }
      if (target === null || typeof target.attachSession !== 'function') {
        result.skipped.push({ sessionId, reason: 'no-workspace-for-cwd' })
        continue
      }
      if (budget.attach !== undefined) budget.attach -= 1
      if (dryRun) {
        result.attached.push(sessionId)
        continue
      }
      try {
        await target.attachSession(sessionId)
        result.attached.push(sessionId)
      } catch (error) {
        // attach 的典型失败是「这个会话的日志不在该 workspace 的目录下」，
        // 属于数据与记录不匹配，不是故障——降级为跳过而不是报错。
        result.skipped.push({ sessionId, reason: `attach-failed:${String(error?.message ?? error)}` })
      }
      continue
    }

    result.skipped.push({ sessionId, reason: `manual:${entry?.reason ?? 'needs-review'}` })
  }

  return result
}

// ---------------------------------------------------------------------------
// 成因解释（供前端展示）
// ---------------------------------------------------------------------------

/**
 * 「未分组」是怎么来的、以及为什么它**不是**删历史对话造成的。
 *
 * @returns {string[]} 中文说明段落
 */
export function explainUngrouped() {
  return [
    '【它是什么】「未分组」是官方侧栏的一个兜底分组，不是你的数据出错。官方组件 @deepseek-ai/dsh-client-ui-workspace 的 groupByWorkspace() 会把「出现在会话列表里、却不被任何 workspace 的 sessionIds 记账、且 sessionVisible() 为真」的会话收进一个标题为空的分组，界面上就显示成「未分组」。',
    '【判定顺序】sessionVisible() 依次排除三类会话：origin === "subagent" 的子代理会话、blank 且非当前会话的空会话、以及当前归档过滤下已归档的会话。排除完之后，只要它不在任何 workspace.sessionIds 里，就会被判成 stray（游离会话），进入「未分组」。',
    '【不是删历史对话造成的】官方删除一条对话时，会把整个会话目录连同日志一起移除；会话目录不存在，就不会出现在会话列表里，也就不可能被判定成 stray。归档同理——归档会把它加进 archivedSessionIds，default 过滤下直接隐藏。本机实测的 289 条归档记录里有 98 条指向早已不存在的会话目录（历史残留），它们全部安静地消失，一条都没有变成「未分组」——这就是反证。',
    '【真实成因】会话目录在磁盘上存在，但从未被登记进 workspace.json 的 sessionIds。本机实测的 6 条正是这样：4 条是官方 e2e 测试跑出来的夹具残留（header 完全一致、无任何用户消息、mtime 同一秒），2 条是「会话所在 cwd 没有任何对应 workspace 记录」的孤儿会话（一条 cwd 在 profiles\\desktop，一条在 Documents\\deepseekharness）。',
    '【为什么会漏登记】官方 session.create() 只有在调用方传了 workspaceId 时才执行 workspace.attachSession()；只传 cwd 的创建路径会落盘但完全不登记。所以凡是「DSH 在某个目录启动、而该目录没有 workspace 记录」时开的会话，天生就是孤儿。另一种窗口是 create() 里 attachSession() 抛错——此时会话已经创建成功，却带着 session/workspace-attach-failed 报错留在磁盘上。',
    '【为什么子代理会话不会出现】子代理会话的 header 带 origin: "subagent"，sessionVisible() 第一句就把它排除了，所以哪怕它同样没被登记，也永远不会出现在「未分组」里。本机 402 条子代理会话正是这样被正确隐藏的。',
    '【怎么彻底不再出现】三条硬门：①插件启动后定期只读巡检，一有未分组就告警；②对 e2e 夹具这类零价值条目自动走回收站清理，对有内容的只归档不删；③在会话创建/登记路径上做拦截提示，发现新会话的 cwd 没有对应 workspace 就记日志提醒，但绝不越权直接写 workspace.json。',
  ]
}

// ---------------------------------------------------------------------------
// 内部导出（仅测试用）
// ---------------------------------------------------------------------------

export const __internals = {
  decodeSeg,
  idKey,
  normPath,
  isInside,
  decompressZstd,
  decompressZstdHead,
  countZstdFrames,
  pickLogFile,
  parseHeaderLine,
  readSessionHeader,
  readSessionLog,
  resolveEnv,
  readMembership,
  adviseEntry,
  listSessionDirs,
  readCacheIdentity,
  readCacheBlank,
  sendFileToRecycleBin,
  ZSTD_MAGIC,
  LOG_PATTERN,
}

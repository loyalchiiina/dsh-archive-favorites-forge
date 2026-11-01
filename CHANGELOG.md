# Changelog

All notable changes to this project are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/);
this project uses [Semantic Versioning](https://semver.org/).

## 0.35.1 — 2026-11-01

### 验证：任何一条删对话的路径都会连带删掉快照，一条不落

0.35.0 之后最常见的追问是「从侧边栏删对话，快照也会一起没吗」——
答案是「会，而且不需要开关」。但这是**目录结构**决定的，不是某个开关
决定的，而目录结构最容易在重构里悄悄改变（把帐本移出去、把整目录删除
改成逐文件 unlink），改坏了没有任何测试会红。

因此新增第七套探针 `test/probe-delete-ledger.mjs`（19 条），只测磁盘上
的真实字节：

| 场景 | 断言 |
| --- | --- |
| 帐本位置 | `fileHistoryDir()` 必须落在 `<会话目录>/history-file`，且与转录文件同级 |
| 删对话 | `handleDelete()` 之后会话目录、`history-file/`、`manifest.jsonl` 全部消失 |
| 收藏保护 | 收藏的对话被拒删，**且它的帐本必须完好** |
| 归档≠删除 | 归档事件即使被观察到，开关关着时转录/帐本/blob 一个字节都不许动 |
| 单一删除点 | 全仓库只有一处 `rm(sessionDir`，两条删除路由都委派给它 |

结论（供用户答复）：

- 插件的两个删除入口 —— 侧边栏菜单「删除对话」（`POST /delete`）与设置页
  「批量删除归档对话」（`POST /archive-delete`）—— 都调用同一个
  `handleDelete()`，它执行的是 `rm(sessionDir, { recursive: true })`，
  删的是**整个会话目录**。
- 快照 `history-file/` 是会话目录的子目录 → 必然一起被删，与「归档删快照」
  那个开关无关。
- 反过来，**归档**只是改注册表状态，不动任何字节（0.35.0 起只有在
  「归档后删快照」开关打开时，才额外把该会话的帐本送回收站）。
- 因此「快照会不会跟着没」取决于动作：删对话 = 一定没（不可恢复）；
  归档 = 默认没（0.35.0 起默认会，但进回收站可恢复）。

七套探针合计 **661 条全绿**（0.35.0 是 642）。

## 0.35.0 — 2026-11-01

### 变更：「归档后删除快照」改为安装后默认开启

用户 2026-11-01 决定：归档一个对话，就是它的撤销历史不再值得那些字节的时刻。所以有用的默认值是「已经在做清理」的那一个，而不是「什么都不做」的那一个。

| | 0.34.1 | 0.35.0 |
| --- | --- | --- |
| 策略文件不存在 | 关 | **开** |
| 显式 `enabled: false` | 关 | 关（不变） |
| 显式 `enabled: true` | 开 | 开（不变） |
| 文件损坏 / 读不出 | 关 | 开 |

**没有变的东西**（三条都不变）：

- 仍然只在「用户刚做的一次归档」这个动作上触发。没有定时器、没有体积上限、没有按天数的策略——自动清理 2026-10 被移除后不会以任何形式回来。
- 仍然送 Windows 回收站，可恢复。
- 从「关」再打开仍然要过风险确认框（`我知道风险，打开`）。只有关闭是一步到位的：改主意关掉一个会删东西的开关，不应该需要读一段警告。

### 修复

| 症状 | 原因 | 修法 |
| --- | --- | --- |
| 卡片刚渲染时开关是空的、下一帧才变勾上 | 客户端把「还没读到策略」当成「关」 | 未读（`null`）按默认的「开」渲染 |
| 宿主版本较旧、答不出 `/archive-purge-policy` 时开关静默变关 | `loadPurgePolicy()` 的兜底写的是 `{enabled:false}` | 兜底改为 `{enabled:true}`，与宿主默认一致 |
| 文案说「默认关闭」但实际默认已开 | 0.33.0 的状态行文字 | 开启时写「默认开启」，关闭时写「已关闭」 |

### 探针

六套合计 **642 条全绿**（0.34.1 是 638）：probe-client 333、probe-snapshot-usage 83、probe-filehistory 39、probe-ungrouped-guard 86、probe-digest 58、probe-sidebar-watch 43。

新增/改写的断言：默认开启时复选框是勾上的、状态行写「默认开启」、只渲染不写盘、关掉一步到位写 `enabled:false`、关掉后文案变「已关闭」、重新打开仍需风险确认；宿主侧新增「策略文件不存在读作开」「显式 `enabled:false` 仍能关闭」两条。

### 与「删除对话」的关系（澄清，非本次改动）

删除一个对话走的是 `handleDelete()` → `rm(sessionDir, {recursive:true, force:true})`，而 `history-file/` 就在会话目录内部，所以**删对话一定会连快照一起删**，与这个开关无关。这条对应关系从 0.29.0 起就是这样，本次只是写进文档。

## 0.34.1 — 2026-11-01

### 修复：重启后第一次归档会被当作「基线」吞掉

用户的实测抓到了两个独立问题。他在 16:41:04 让宿主加载 v0.34.0，16:42:22 在侧栏右键归档了一个对话，结果快照没删、日志里连一行都没有。

**原因一（行为正确，但不够明显）**：`archive-purge-policy.json` 根本不存在，也就是开关从来没打开过。默认关时不该删任何东西，这一半是对的。

**原因二（真缺陷）**：观察器把「第一次看到的归档集合」当作基线，而基线事件本身是不处理的。也就是说**每次重启后，第一个被归档的对话一定会被吞掉**——恰好就是「打开开关、马上归档一个试试」这个动作。原来的探针只测了「先种基线，再归档第二个」，所以没暴露。

修法是启动时就把基线装好，不再等第一个事件：`seedArchiveWatch()` 在 `ctx.effect` 里读取实时注册表的 `archivedSessionIds`，并带短暂重试（服务存在但没就绪时 `archivedSessionIds` 会抛 `not started yet`，最多重试 40 × 250ms）。读不到时基线保持 `null`，退化成原来的首事件种基线路径——降级但不会误删。

同时补了两条日志，让下次实测能直接看出问题在哪：

- `sidebar archive watch armed — baseline of N archived session(s)`：启动时基线已就绪；
- `sidebar archive watch seeded a baseline of N archived session(s)`：退化路径生效（说明启动时没读到）。

### 顺手修掉的一个隐患

重试之间的 `setTimeout` 原来带 `unref()`。`unref` 的定时器不会维持事件循环，所以当它是唯一待办时，node 会在 `await` 中途直接退出——探针当场以 `Detected unsettled top-level await` 挂住。循环本身有上界（最坏 10 秒），改成普通定时器即可，代价为零。

### 验证

`test/probe-sidebar-watch.mjs` 从 30 条增至 **41** 条，新增段落专门钉这次的事故：可读注册表在加载期就装好基线并留日志、启动中（`not started yet`）会重试到可读、读不到时基线留空且首事件仍走种基线、非瞬时错误只报一次 warn 不无限重试、以及**「重启后的第一次归档必须被清理，不能被当作基线吞掉」**这条正向断言。六套探针合计 **638 条全绿**（0.34.0 是 627）。

边界未变：默认关闭；只在「归档」动作发生时触发；仍送 Windows 回收站；除归档外不做任何自动清理。

## 0.34.0 — 2026-11-01

### 修复：侧栏右键「归档」现在也会删快照（同一个开关，两条路径都管）

0.33.0 的开关只在本卡片的「归档」按钮上生效，README 甚至专门写了一条边界：
「你在侧栏手动归档的对话，这个开关管不到」。这一条是错的，本版推翻它。

**为什么以前没法做**：`@deepseek-ai/dsh-workspace` 的 `archiveSession()` 本身确实不发任何
事件（对着出厂 asar 核过，全文 `emit` 命中 0）。但归档集合是存在 storage-domain 的
`workspace` 全局记录里的，每次写入都会发一条

    domain/changed  { domain: "workspace", table: "", operation: "put",
                      value: { archivedSessionIds, pinnedSessionIds, workspaceIds, initialized } }

官方自己的 `@deepseek-ai/dsh-api-workspace-controller` 就是靠这条信号感知归档变化的，
第三方 `@agents-anywhere/dsh-bridge-next` 也直接 `ctx.on("domain/changed")`。`ctx.on` 是
普通总线订阅，不限制在发出方那个 fiber 里——所以本插件也能收。

**做了什么**：宿主侧新增 SIDEBAR ARCHIVE WATCH，订阅 `domain/changed`，命中
`workspace` + 全局记录 + `put` 时把新归档集合与上一次做差，差出来的 id 就是「这一次刚被归档的」。
开关（还是那个 `archive-purge-policy.json`，还是默认关）打开时，逐个删它们的 `history-file/`。

**三条安全设计（都是踩过的坑）**：

| 风险 | 处理 |
| --- | --- |
| 第一次收到事件时没有基线，会看起来像「整机所有对话刚被归档」，把所有快照一次扫光 | 第一次 put **只记基线、不删任何东西**（`action: "seeded"`） |
| 本插件自己的 `/idle-archive` 也会触发同一条事件，导致同一个目录被两次送回收站 | `noteSelfArchived(id)` 打 30 秒标记，watch 看到就跳过（`skipped: "archived-by-this-plugin"`） |
| 开关关着时归档的对话，后来打开开关会不会被补删 | 只处理「本次事件新出现的 id」，基线在关着时也照常更新，所以那批对话永远不会被补删 |

删除路径没变：仍是 `cleanupSnapshotUsage` → `sendToRecycleBin`，仍然要求「严格位于 sessions 根内的
`history-file` 目录」，仍然可恢复。不做定时、不做体积上限、不做年龄扫描。

**探针**：新增 `test/probe-sidebar-watch.mjs`（30 条），覆盖 payload 形状过滤、首次只种基线、
开关关时不删只记日志、开关开时只删新归档的、撤回不触发、撤销归档后再归档会再触发、自己归档不双删、
未知会话报错不抛异常、以及 apply() 里确实挂在 `ctx.effect` 内。

**客户端文案**：风险框里那句「你在侧栏手动归档的对话，宿主不发事件，这个开关管不到」已改为
「本卡片的归档按钮和侧栏右键归档都算」，并保留「除归档这个动作外永远不会自动清理」的承诺。

五套旧探针同批全绿：probe-client 331 / probe-snapshot-usage 83 / probe-filehistory 39 /
probe-ungrouped-guard 86 / probe-digest 58，加新的一套共 **627 条**。

## 0.33.0 — 2026-11-01

### 新增：归档后可以顺带删掉快照（默认关闭，这是你 2026-11-01 的决定）

这个版本改了一条此前写死的产品边界：**0.29.0 时明确写过「只做第 1 项，第 2/3/4 项永久不做」，
自动清理一律不做。** 2026-11-01 你提出——既然快照只是「撤销到某一轮」用的，那对话一旦归档
就不再需要撤销，所以归档时顺手把快照删掉是合理的。这个版本按你的要求做了，但把它锁在一个
很窄的口子里：

| 限制 | 为什么 |
|---|---|
| **默认关闭** | 装上不会自己动任何东西；要开必须先在「超时归档」卡片里勾选，还要再过一道风险确认 |
| **只在「本卡片归档」这一个动作里触发** | 不做定时、不做体积上限、不做年龄扫描——那三样仍然永久不做 |
| **仍然送 Windows 回收站** | 走的是和手动删除同一条 `sendToRecycleBin` 路径，误删可恢复 |
| **只对这一次请求里归档成功的会话生效** | `archived.length > 0` 才算，撤回、查看、统计都不会触发 |

⚠️ **边界（必须知道）**：DSH 的 `@deepseek-ai/dsh-workspace` 的 `archiveSession` **不发任何事件**，
所以「你在侧栏手动右键归档」这个动作本插件收不到通知，这个开关管不到它。它只覆盖
**本插件「超时批量归档」卡片上那个归档按钮**归档成功的会话。

### 新增的落点

- 宿主 `lib/index.js`：新增 `archive-purge-policy.json`（第三个独立策略文件，和快照预勾选、
  归档删除预勾选互不影响）；新增 `GET|POST /archive-purge-policy`；`/idle-archive` 响应新增
  `purged` / `purgeBytes` / `purgeFailures`。
- 客户端 `lib/client.js`：`usePreTickPolicy` 之外新增 `loadPurgePolicy` / `savePurgePolicy`，
  「超时批量归档」卡片里加开关 `归档后删除快照开关` + 两段式风险确认；归档结果区多两行
  「顺带删除了 N 个会话的快照（送回收站，释放 X）」/「有 N 个会话的快照没删成（首个原因：…）」。

### 流畅度：面板改成惰性挂载 + 冻结

设置页五个功能之前是「全部渲染、只显示一个」，切标签时五张卡都会跟着重渲染，其中两张带长列表。
现在：

- **没打开过的面板不挂载**（`body = null`）——首帧只渲染你当前看的那一张。
- **打开过但当前隐藏的面板复用上一次的元素引用**（`paintCache`）——React 直接跳过整棵子树，
  阈值输入每敲一键不再连带重渲染另外四张卡。代价是隐藏面板的内容可能落后一帧，但它在变可见的
  那一刻会立即重建，用户看不到。
- 收藏判断从「每个归档 id 各算一遍」改成「懒建一次归一化集合」（309 × 75 ≈ 23k 次比较 → 一次）。

### 修复

- 面板惰性化之后，`ArchiveFavoritesSection` 的挂载 effect 仍然自己手写了一份 `/archived` 请求，
  只拷 `archivedSessionIds` —— 于是新加的 `entries` 被丢掉，卡片显示「归档共 0 条」，要按刷新才对。
  现在挂载 effect 只调用 `loadArchived()`，`/archived` 全插件只有一个读取点。
- 归档来源 `workspace:3` 这种健康来源曾被渲染成「**不可用**：workspace:3」（卡片只认空串、
  `starting` 和 `registry*`）。现在统一走 `describeSource()`，健康来源正常显示「官方工作区记录（3 条）」。
- 探针 fetch stub 的 `/archive-purge-policy` 分支没走统一的 `payload` 返回形状，导致
  `api()` 抛错被 catch 吞掉，表现成「开关刚打开就自己关掉」——这是探针的 bug，已修。

### 验证

五套探针合计 **596 条全绿**：`probe-client` 330 / `probe-snapshot-usage` 83 /
`probe-filehistory` 39 / `probe-ungrouped-guard` 86 / `probe-digest` 58。
宿主策略冒烟 12 条全绿（三个策略互不影响、`enabled:'yes'` 读回 false、策略写盘落在自己的文件里）。

## 0.32.0 — 2026-11-01

### 改动：五个大功能收成一个「功能切换条」，一屏只显示一个面板

设置页原来是把五张卡竖着摞起来：超时归档、收藏列表、归档清理、快照占用、
未分组体检。每张卡自己带一个列表，于是从页首滚到页尾要滑很久，看设置像在读
一份报告。用户要求照语音插件的做法——「选一个功能，只看那个功能」。

这一版把五张卡收进同一个面板容器：

| | 改动 |
|---|---|
| 顶部 | 一排五个功能按钮（`role="tab"`），当前项高亮、`aria-selected="true"` |
| 下方 | 只显示当前功能的面板，其余 `display:none` |
| 记忆 | 选中的功能写进 `localStorage` 的 `dsh-aff-settings-view`，重启回到上次的位置 |
| 兜底 | 存的值不认识就回落到第一个功能，不会白屏 |
| 未知卡片 | 没被认领的卡（将来新增的）仍然照常渲染，不会被静默丢掉 |

**为什么不用「卸载未选中面板」：** 一次扫描结果、一份勾选状态都是组件自己的
state。切走再切回会把它刚跑完的一次统计扔掉。改成隐藏而不卸载，所有护栏仍在
同一条代码路径上运行——没有第二条路径需要同步。

功能顺序（阅读顺序）：超时归档 → 归档清理 → 快照占用 → 收藏列表 → 未分组体检。
前两个是日常真要做的动作，中间两个是磁盘/健康检查，最后一个是只读清单。

### 修复：设置页两块卡都会渲染「试算删除」，按文字找按钮会拿错卡

探针里所有「按标签找按钮」的定位都改成先按面板再找按钮。两张卡都渲染
「试算删除」「确认删除」，只按文字命中会落到先渲染的那张上，请求打到另一条
路由，随后一串断言雪崩式变红（它们看着像功能坏了，其实只是拿到了别的卡的按钮）。

### 验证

五套探针合计 **578** 条全绿（0.31.0 是 570）：probe-client **312**（+8 条切换器断言）
/ probe-snapshot-usage 83 / probe-filehistory 39 / probe-ungrouped-guard 86 / probe-digest 58。

### 边界不变

自动清理仍然永久不做；收藏仍然既不出现在可删列表也不允许删；两个「超时预勾选」
仍然是预勾选而不是自动删除，阈值也仍然各存一份。

## 0.31.0 — 2026-11-01

### 新增：批量删除归档对话也用上了「时间阈值 + 预勾选 + 试算/确认」

0.30.0 把「该删哪些快照」摆进了设置页，但「该删哪些**对话**」还是老样子：
只有一个「批量删除」按钮，按下就把所有「已归档且未收藏」的对话一次性删掉，
既看不到清单，也没法只删一部分。这一版把两张卡合到同一套外壳上。

| 改动 | 说明 |
|---|---|
| **归档对话列表内联** | 「批量删除归档中「未收藏」的对话」卡现在直接列出每一条：不活跃时长 + 标题 + 工作区。数据来自 `/archived` 新增的 `entries` 字段（宿主侧用 `activityCatalogue` 拼出来的），不再需要先导清单 |
| **逐行勾选 + 试算 + 二次确认** | 以前是一键全删。现在必须先勾选，点「试算删除」拿到计划，再点「确认删除」才真的删；宿主侧 `/archive-delete` 会重建候选集，客户端提交的清单只是「想删什么」，不是「删什么」 |
| **独立的「超时预勾选」开关** | 与快照卡同款外壳，但**策略独立存盘**（`archive-delete-policy.json`，阈值也独立）。理由：两次动作的爆炸半径不同 —— 删快照只是失去「撤销到某一轮」，删对话是对话本身没了。共用一个开关会让「为快照设的谨慎阈值」静默授权删对话 |
| **收藏同样受保护** | 收藏的归档对话不进列表，宿主侧 `/archive-delete` 也会把它们挑出来记 `refusedFavorites` 拒绝执行 |

### 修复

- **挂载时的 `/archived` 请求只拷了 `archivedSessionIds`。** 设置页首次挂载时自己手写了一份请求，
  只取 id 列表，新加的 `entries` 被丢掉了 —— 卡片会一直显示「归档共 0 条」，直到用户手动点刷新。
  现在统一走 `loadArchived()`，只有一个读者，新字段只可能在一个地方被忘掉。
- **健康的归档来源被当成故障报。** `loadArchived()` 把来源写成 `"<source>:<count>"`，
  而卡片只把 `registry` 开头认作正常，于是 `workspace:3` 渲染成「不可用：workspace:3」。
  现在按来源值的**前半段**判定健康，`unavailable` / `request-failed` 才叫不可用，
  其余映射成人话（官方实时注册表 / 官方工作区记录 / 会话日志回推 / 上次快照）。
- **删掉了 section 里已经不可达的一套删除代码。** 0.31.0 之前的分区自带 `candidates` + `runDelete()`，
  现在没有任何按钮会调到它，留着只会让下一个读者以为「这里还有一个一键全删的入口」。

### 验证

五套探针合计 **570 条全绿**（0.30.0 是 545）：

| 探针 | 条数 | 覆盖 |
|---|---|---|
| `test/probe-client.mjs` | 304 | 设置页渲染、手动扫描语义、勾选/试算/确认链路、不活跃时间列、收藏摘除、预勾选开关与风险确认、内联候选列表、归档对话卡（同一外壳、独立策略、独立阈值） |
| `test/probe-snapshot-usage.mjs` | 83 | 字节/条数精度、删除护栏、`metaFromCache` 三级回退、`idleMs`、`clampHours` 两端夹取、策略落盘与「非字面 true 一律当关」 |
| `test/probe-filehistory.mjs` | 39 | 快照写入与回滚字节 |
| `test/probe-ungrouped-guard.mjs` | 86 | 未分组体检/硬门/幽灵缓存 |
| `test/probe-digest.mjs` | 58 | 新窗口继续对话的交接书蒸馏 |

### 边界不变

**没有任何定时器、没有体积上限、没有按天淘汰。** 自动清理这条路以前走过，
因为会静默误删被拿掉了，不会再加回来。预勾选开关只是把「哪些行该看」这件事
预先做好，删除永远需要人手点两次 —— 删快照两次，删对话也是两次。

## 0.30.0 — 2026-11-01

### 新增：不活跃时间、可删列表与「超时预勾选」开关（issue #2 的第 1 项，续）

0.29.0 只做了统计 + 手动删除，但只给数字还不够用。这一版把「该删哪些」
这件事直接摆在设置页里，避免用户自己算时间、自己去翻目录。

| 改动 | 说明 |
|---|---|
| **每行显示不活跃时长** | 列表新增一列「N 分钟 / N 小时 / N 天」，超过阈值的行标黄。数据取自投影缓存的最后活动时间（`sessionListMetadata.lastPromptAt` → `timeContext.lastMessageTime` → `identity.createdAt` 三级回退） |
| **超时批量归档卡内联候选列表** | 以前只有「导出清单」按钮，等于要求用户去文件系统看要归档什么 —— **需要导出才能审阅的归档，就是从不审阅的归档**。现在候选直接列在卡里（时长 + 标题 + 工作区），导出仍保留 |
| **收藏项不进可删列表** | 收藏 = 用户明确在意，一律从列表里摘出去，只在汇总行显示「另有 N 个已收藏会话占用 X（已收藏 = 保护，不列入清理）」。**这条护栏在宿主侧也做了**：`/snapshot-cleanup` 会把请求里的收藏项挑出来拒删并记 `logger.warn`，UI 隐藏勾选框只是约定 |
| **「超时预勾选」开关（默认关）** | 打开后，每次点「立即统计」会自动勾上闲置超过阈值的行。**它不是自动删除开关**：删除仍然要「试算删除」→「确认删除」两次点击。开启必须先看风险确认框（说明会勾上什么、删掉后失去什么、收藏永不参与） |

阈值以小时为单位（默认 720 = 30 天），存在 `<state>/snapshot-policy.json`，
读写走独立的 `GET/POST /snapshot-policy` 路由 —— **翻开关不会触发全树扫描**。

### 修复

- `policyNow` 优先读本地 state 而不是扫描回包里的 `policy`。回包里的策略是扫描
  那一刻的快照，用户刚翻过开关时它就是过期的，会让开关看起来「打开后立刻弹回关闭」。
- 「最大一项」改为取**过滤后列表的首行**。收藏被摘出列表后，报告级最大值很可能
  是用户根本选不到的行，原先的写法会读成「最大的那个却不在表里」。
- `humanIdle(null)` 返回 `-` 而不是 `0 分钟`：未知年龄不能读成「刚创建」，
  否则会被阈值选择静默吸进去。
- `metaFromCache` 加入 `__internals`，让探针能直接钉住「未知年龄必须是 null」这条规则。

### 验证

五套探针合计 **545 条全绿**（0.29.0 是 504）：

| 探针 | 条数 | 覆盖 |
|---|---|---|
| `test/probe-client.mjs` | 279 | 设置页渲染、手动扫描语义、勾选/试算/确认链路、不活跃时间列、收藏摘除、预勾选开关与风险确认、内联候选列表 |
| `test/probe-snapshot-usage.mjs` | 83 | 字节/条数精度、删除护栏、`metaFromCache` 三级回退、`idleMs`、`clampHours` 两端夹取、策略落盘与「非字面 true 一律当关」 |
| `test/probe-filehistory.mjs` | 39 | 快照写入与回滚字节 |
| `test/probe-ungrouped-guard.mjs` | 86 | 未分组体检/硬门/幽灵缓存 |
| `test/probe-digest.mjs` | 58 | 新窗口继续对话的交接书蒸馏 |

### 边界不变

**没有任何定时器、没有体积上限、没有按天淘汰。** 自动清理这条路以前走过，
因为会静默误删被拿掉了，不会再加回来。预勾选开关只是把「哪些行该看」这件事
预先做好，删除永远需要人手点两次。

## 0.29.0 — 2026-11-01

### 新增：快照占用统计 + 手动删除（issue #2 的第 1 项）

报告（@ripley-xl）：文件快照没有存储管理 —— 无配额、无保留期、无用量展示，
随会话数量线性增长。

**只做第 1 项，并且永久不做第 2/3/4 项，这是产品决定不是遗漏。**

报告列了四条（他自己按改动大小排序）：

| # | 建议 | 本版 | 为什么 |
|---|---|---|---|
| 1 | 只读用量接口 + 设置页展示 + 手动清理按钮 | **做了** | 只增加可见性和一次手动动作，不动任何自动行为 |
| 2 | 按时间清理归档会话 | **不做** | 自动删除一旦跑起来，误删就是静默的 |
| 3 | `maxBytesPerSession` 超体积丢最旧条目 | **不做** | 同上，且会破坏 manifest 与 blob 的一致性 |
| 4 | 跨会话内容寻址去重 | **不做** | 把 blob 移出会话目录，会话级回滚就多了一层全局状态 |

第 2 项这条路以前走过 —— 正是**因为容易误删，那个功能被拿掉了**，不会再加回来。
所以本版的边界写死为：**统计只能手动触发，删除只能手动执行，任何定时器、
任何体积上限、任何按天数淘汰都不存在。**

**做了什么**

- 新增 `lib/snapshot-usage.js`：遍历 `~/.dsh/sessions/**/history-file/`，
  每个 ledger 报出 `bytes`（blob 字节 + manifest 字节）、`blobCount`、`entryCount`、
  `skippedCount`（`blob:null` 的行）、`firstSnapshotAt` / `lastSnapshotAt`、`title`。
- 新增两条宿主路由：`/snapshot-usage`（只读扫描）与 `/snapshot-cleanup`
  （默认 `dryRun: true`，只有 `confirm: true` 才真删）。
- 设置页「归档收藏」新增「快照占用」卡片：**渲染时不扫描**，
  点「立即统计」才扫一次；结果停在组件自己的 state 里，不会后台反复扫。
  勾选 → 试算删除 → 二次确认 → 真删，删的是 `history-file/` 整个目录，
  走 Windows 回收站（可恢复）。

**性能（对应「不得实时统计、必须手动」这条要求）**

| 指标 | 实测 |
|---|---|
| 全量扫描（本机 59 个 ledger / 26.7 MB / 588 blob / 1248 行） | **62 ms** |
| 第二次扫描 | 49 ms |
| 3 个并发请求 | 46 ms，且三者拿到**同一个**结果对象 |
| 跳过投影缓存查标题 | 25 ms |
| 并发度 | `CONCURRENCY = 32` |

实现上刻意避开了三件拖慢扫描的事：不发同步 I/O 遍历树（全 `node:fs/promises`
+ 手写 `mapLimit` 并发池）、**完全不 `JSON.parse` manifest**（行数用
`charCodeAt === 10` 数、跳过数用 `'"blob":null'` 计数、时间范围只扫首尾
`"time":` 后的数字）、同一 roots 的并发调用合并成一次飞行中的 promise
（`inflight` 表，完成即释放）。

**删除护栏（三层，缺一不可）**

1. `isPathInside(sessionsRoot, dir)` —— 严格子路径，根目录本身也拒（`t === r` → false）；
2. `basename(dir) === 'history-file'` —— 叶子名必须是 ledger 目录；
3. `lstat` 拒符号链接 —— 防止「字符串在树内、实际指向树外」。

宿主侧在删除前**重新扫描一遍**再和页面传来的 id 求交，不信任页面上的计划
（列表和点击之间会话可能已被删或重建）。回收站失败时降级为**改名到
`snapshot_quarantine_<stamp>/`**（同一卷、可手工恢复），任何路径都不会走到
`rm -rf`。

**探针**：新增 `test/probe-snapshot-usage.mjs`（61 条）覆盖测量精度、
「模块里没有 setInterval/setTimeout」、干跑默认值、三条护栏、真实删除只动勾选项。
`test/probe-client.mjs` 新增 28 条覆盖卡片契约（渲染不扫、一次点击一次扫描、
两段式确认、`dryRun`/`confirm` 取值）。

**验证**：五套探针 client 260 + filehistory 39 + ungrouped-guard 86 + digest 58 +
snapshot-usage 61 = **504 条全绿**；`node --check` 四个 lib 文件通过。

---

## 0.28.9 — 2026-11-01

### 修复：会话菜单里插件的行没有 hover 高亮（issue #1）

报告（@ripley-xl）：官方菜单行（置顶会话 / 重命名 / 分叉 / 归档）鼠标移上去会浮出
一层浅灰背景，危险项是淡红；而本插件插入的那几行 —— 「收藏对话」「复制 ID + 路径」
「新窗口继续对话」，以及同一 `MenuRow` 渲染的「删除对话」—— 移上去背景纹丝不动，
看着不像真菜单项。

**根因：类名是字面量，官方是 CSS Modules 哈希名。**

`MenuRow` 当初写的是：

```jsx
className: "itemWrap"
className: props.danger ? "item danger" : "item"
```

并附了一句注释断言「The class names below are the official ones」。**这句话是错的。**
官方前端是 CSS Modules 打包的，发布产物里这些名字都被哈希过。对照实际发货的
`index-BNyAYEM7.css` 实测：

| 插件里写的字面量 | 发货产物里真实存在的类名 |
|---|---|
| `itemWrap` | `_itemWrap_4ub78_90` |
| `item` | `_item_4ub78_90` |
| `itemIcon` | `_itemIcon_4ub78_148` |
| `itemLabel` | `_itemLabel_4ub78_190` |
| `label` | `_label_4ub78_129` |
| `danger` | `_danger_4ub78_226` |

字面量匹配不到任何规则。这些行之所以**布局还是对的**，是因为每条规则同时被写成了
inline style —— 于是问题被完美掩盖，只在高亮上露头。

**第二层原因（就算前一条修好也还高亮不了）：inline `background` 压掉 `:hover`。**

```js
background: "transparent"   // inline style 的优先级高于任何样式表规则
```

官方那层 hover 背景来自 `._item_4ub78_90:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}`。
行内 `background` 是 inline style，优先级高于样式表 —— 所以哪怕把哈希类名补上，
或者往插件自己的 `<style>` 里补一条 `:hover`，也照样被压掉（除非 `!important`）。

**修法：hover 颜色交给 React state，类名换自己的。**

| 位置 | 旧 | 新 |
|---|---|---|
| 类名 | 官方字面量 `itemWrap` / `item` / `itemIcon` / `itemLabel` / `label` | 自有 `dsh-aff-mi-wrap` / `dsh-aff-mi`（danger 追加 `dsh-aff-mi-danger`）/ `dsh-aff-mi-icon` / `dsh-aff-mi-label` / `dsh-aff-mi-caption` |
| hover 来源 | 期望继承官方样式表 | `onMouseEnter` / `onMouseLeave` 改 `hovered` state，动态算 `background` |
| 键盘可达 | 无 | `onFocus` 判 `:focus-visible` → `focusVisible` state；`onBlur` 清 |
| 背景色 | 写死 `"transparent"` | 静止 `transparent`；悬停 `var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,.14))`，危险项 `var(--dsw-alias-interactive-bg-hover-danger, rgba(255,107,107,.16))` |
| 危险色 | 写死 `#ff6b6b` | `var(--dsw-alias-state-error-primary, #ff6b6b)` |
| 过渡 | 无 | `transition: background-color .12s ease`（官方行是渐变的，瞬亮显得像闪一下） |
| 布局 | inline | **仍然 inline** —— 不依赖任何样式表，宿主换主题/改产物都不影响 |

两类状态分开存（`hovered` / `focusVisible`）是刻意的：鼠标点击会让按钮 focus 但
不匹配 `:focus-visible`，混成一个 state 会导致点过的行一直亮着；反过来只判 hover
又会让键盘 Tab 过来没有反馈。

顺带修掉 4 处**无效 token**：`--dsw-alias-state-warning-primary` 在
`@deepseek-ai/dsh-client-ui-theme` 的 403 个 token 里**不存在**（真名是
`--dsw-alias-state-warn-primary`）。这 4 处（星标颜色 / ADVISE_COLOR.archive /
未分组摘要 / 批量删除告警）一直只靠 `#ffb454` 兜底，颜色永不跟随主题。

**探针同源修复**

`test/probe-client.mjs` 原来的 `assertMenuRowStructure()` **断言字面量
`itemWrap` / `item` / `itemLabel`** —— 也就是说这套测试把 bug 锁死了：谁想改成
正确写法，测试先红。现在改成反向断言（`HASHED_OFFICIAL_CLASSES` 出现即 FAIL）
并新增 4 组行为断言：静止 `background === "transparent"`、行上有
`onMouseEnter`/`onMouseLeave`、悬停后 `background` 含对应 token、移出恢复
`transparent`。

**验证**：四套探针 client 232 + filehistory 39 + ungrouped-guard 86 + digest 58 =
**415 条全绿**；`node --check` 三个 lib 文件通过。

---

## 0.28.8 — 2026-10-30

### 修复：空白会话被误报成「未分组」

0.28.7 重启后开机自检报了一条：

```
⚠ 1 session(s) will appear under 未分组 in the sidebar (session-02c86ef3-…)
```

查下去发现**侧栏根本没画它**，是我们报错了。那条会话 432 字节、5 个事件
（header + permission/preset + sandbox/mode + approval/policy + session/end-seed）、
零条用户消息 —— 是一个刚建好还没说过话的空白会话。

根因：官方的 `sessionVisible()` 用 `session.blank` 排除空白会话，但 **`blank` 不是
header 字段**。harness 把它写在投影缓存里：

```
storages/session_projcache/sessions/<裸uuid>.json
  → record.rows.sessionListMetadata.val.blank = true
```

guard 只读 header 的 `blank`，所以这种会话在 header 看来完全正常，又不在任何
`workspace.sessionIds` 里 → 被判成游离会话。**报的是假警，而且会让人以为未分组
又复发了。**

修法：在「通过四步排除、即将进入未分组」这一步，额外查一次投影缓存的
`sessionListMetadata.blank`（`readCacheBlank()`，两种文件名拼写都试）。
- 只在候选这一步查 —— 正常成员一次额外 I/O 都不付。
- 读到 `null`（缓存不存在/读不出）时保持「不知道」，不隐藏、不猜。
- 明确 `blank:false` 的会话照常报告并给出真实建议。

guard 版本 1.1.0 → **1.2.0**。

测试：`probe-ungrouped-guard.mjs` 新增第 12 节 7 条断言 —— header 里确实没有 blank
标记、`readCacheBlank` 能在裸 uuid 拼写下找到它、没有缓存时返回 `null` 而不是 `false`、
该会话不再出现在未分组里而是计入 `blankCount`、以及反向用例（`blank:false` 的会话
必须照常报告并拿到 `attach` 建议，不能被静默丢掉）。79 → **86** 条。

四套探针合计 client 204 + filehistory 39 + ungrouped-guard 86 + digest 58 = **387 条全绿**。

## 0.28.7 — 2026-10-30

### 修复：删除对话现在会一并删掉它的投影缓存

0.28.5 只是**事后清扫**幽灵，没堵住制造幽灵的那个口子。真机首启告警从 86 降到 1，
剩下那 1 条是 4 小时前刚产生的（`USB 创建方法`，6254 B，无目录）——顺着它查到了源头：

**我们自己的「删除对话」只删了会话目录，没删投影缓存。**

一个会话是两半组成的：磁盘上的 `sessions/<project>/<id>/`，和
`storages/session_projcache/sessions/<id>.json`。旧实现只删前者，于是下一次开机
运行实例仍然知道这个对话存在（有标题、有 token 数、有对话摘要），但目录已经没了
——它被渲染成「未分组」里一条打不开的行，而且任何目录扫描都找不到它，因为根本没有目录。
**每删一次对话就制造一个幽灵**，这就是「清完又冒出来」的真正机制。

修法：`handleDelete` 删除成功后调用新增的 `dropProjectionCache(sessionId)`，
同时尝试裸 uuid 与 `session-<uuid>` 两种文件名（跨代升级的机器两种拼写并存）。
纯 best-effort，失败只 warn、不中断删除。

测试：`probe-filehistory.mjs` 新增 5 条断言 —— 夹具先造一个「目录 + 缓存文件」都在的会话，
删完之后目录与缓存文件都必须不存在，且 `projCacheRoot` / `dropProjectionCache` 已导出。
33 → **39** 条。四套探针合计 client 204 + filehistory 39 + ungrouped-guard 79 + digest 58
= **380 条全绿**。

兼容性：新增 `projCacheRoot` / `dropProjectionCache` 两个导出供探针白盒验证，
`__internals` 37 → **39**；无新路由、无新配置项、无新 UI。

## 0.28.6 — 2026-10-30

### 修复：开机告警不再为「按设计保留」的幽灵刷屏

0.28.5 上线后第一次真机启动就暴露了一个自己埋的坑：开机硬门报

```
⚠ 86 projection-cache ghost(s) with no session directory (4240793 bytes)
```

可那 86 条正是**置顶 1 条 + 已归档 85 条** —— 清理逻辑按设计永远不会动它们。
于是这条告警会每次开机都刷一遍，而用户打开面板也清不掉，属于「不可行动的数字」。

修法：开机硬门改为只统计**可清理**的幽灵（`advise === 'delete'`），字节数也只累加这一部分；
当可清理数为 0 时降级为 info，并附上保留条数：

```
ghost-cache guard — clean (706 cache files vs 671 session dirs, 86 kept as pinned/archived)
```

这样告警重新变成「真有事才响」，保留项只在 clean 行里作为说明出现。

测试：四套探针仍全绿（client 204/0、filehistory 33/0、ungrouped-guard 79/0、digest 58/0）。
兼容性：只改开机告警的统计口径，路由、返回结构、`__internals`（37）均未变。

## 0.28.5 — 2026-10-30

### 根治：清掉投影缓存幽灵，并让「未分组」默认隐藏

0.28.4 只给了个视图开关，没有解决**为什么清完还会再冒出来**。这一版补上真正的
那一半。

**先说结论**：侧栏那个「未分组」分组里，有一类条目**磁盘上根本不存在**。

- 会话目录 `~/.dsh/sessions/<workspace>/<id>/` 早就没了；
- 但 `~/.dsh/storages/session_projcache/sessions/<id>.json` 还在，里面完整存着
  标题、token 用量、上下文压力、对话摘要、模型选择等 28 个投影；
- 运行中的侧栏照样把它画出来（它读的是缓存里的标题，不需要目录），而它不在任何
  工作区的 `sessionIds` 里，于是落进 stray 分支 → 显示在「未分组」下。

**这解释了一个长期矛盾**：`check-ungrouped.js` 扫目录报 `0 条`，插件 guard 读
registry 也报 `clean`，侧栏却明明画着。两者都只看「磁盘 / 注册表」，看不见缓存幽灵。

**本机实测数据**：缓存文件 984 份 vs 会话目录 657 个 → **幽灵 364 条，共 9.77 MB**。
其中置顶 1 条、已归档 85 条。年龄分布：6–24 小时 14 条、1–7 天 32 条、7 天以上 318 条。
最老的一批正是当初「删了会话、缓存没跟着删」的残留——包括 0.28.1 那次我们送进
回收站的 3 个空对话，它们**至今仍在幽灵列表里**，这就是「清完又冒出来」的机制。

**首次清理结果（本机，经用户批准）**：278 条送回收站、**0 失败**、释放 5.28 MB；
缓存文件 984 → 706，剩余 86 条全是置顶 1 + 已归档 85（按默认策略保留）。
侧栏那三条 `1+1` 与 `Session title: "1+1"` 的缓存文件已确认不存在。

**新增：缓存幽灵检测与一键清理**（设置 → 归档收藏 → 未分组体检 → 「缓存幽灵」）

- 「扫描」只读列出孤儿缓存：条数、占用、标题、id，置顶项标注「置顶，保留」。
- 两段式执行：先「试算（不修改任何文件）」→ 再红框「确认清理」。
- 真删走 **Windows 回收站**（`DeleteFile`，可恢复），失败降级到
  `<dshHome>/projcache_quarantine_<stamp>/`。
- **默认跳过置顶项与已归档项**（`includePinned` / `includeArchived` 都默认 false）——
  与诊断给出的「保留」建议保持一致，避免出现「列表写着保留、点确认却删了」这种自相矛盾。
  归档项本来就先被 archived 过滤挡在侧栏之外，清它只省空间、不治症状。
- 清理**不会删除任何对话**——目录都不存在了，本来就没有对话可删。

**新增：开机硬门扩成两道**。原来只在启动 8 秒后跑一次未分组体检；现在紧接着再跑
一次缓存幽灵扫描：有幽灵就 `logger.warn` 报条数/字节并指向设置页，干净就
`logger.info` 打一行 `ghost-cache guard — clean (N cache files vs M session dirs)`。

**变更：「隐藏未分组」默认开启**。0.28.4 需要手动勾选；现在**未设置即为隐藏**，
只有显式写入 `"0"` 才显示。理由：这个分组是官方 UI 里没有主人的兜底桶，用户从没
要求过它，而里面每一条都能从体检卡片里查到并处理。

**实现**：

- `lib/ungrouped-guard.js` 版本 **1.0.0 → 1.1.0**，新增
  `diagnoseGhostCache(ctx, options)` / `cleanupGhostCache(ctx, plan, options)`，
  另抽出 `listSessionDirs` / `readCacheIdentity` / `sendFileToRecycleBin` 三个辅助
  （`readMembership` 也补了 `pinned` 集合）。
- 宿主 `lib/index.js` 新增两条路由 `GET|POST /ghost-cache-diagnose` 与
  `POST /ghost-cache-clean`。后者**不信客户端的 id 列表**：先自己重新诊断一遍，
  再把请求里「已经不再是幽灵」的 id 剔掉并记 warn；且只有
  `confirm === true` 时才允许 `dryRun: false`。
- 客户端新增 `GhostCacheBlock()` 组件，挂在「未分组体检」卡片下方（同一张卡里，
  因为它讲的是同一个问题的另一半）。
- `__internals` 35 → **37** 项。

**性能**：本机 984 份缓存 vs 657 个目录，`diagnoseGhostCache` 实测 **72 ms**
（只读目录名 + 解析每份缓存的 identity，不做 zstd 解压）。

**测试**：`test/probe-client.mjs` 新增 5 条断言（幽灵块已挂载、两条路由都在、
清理必须先进干跑、默认隐藏的 `!== "0"` 语义、localStorage 不可用时仍默认隐藏），
**204 pass / 0 fail**；`test/probe-ungrouped-guard.mjs` 新增 19 条（造 4 份缓存：仍在
磁盘上的一份 + 普通幽灵 + 置顶幽灵 + 已归档幽灵），锁住「目录还在就绝不叫幽灵」、
「只挑出 3 条孤儿」、「置顶/归档单独计数」、「普通幽灵建议删、置顶与归档建议留」、
「干跑不动磁盘也不动 workspace.json」、「`includePinned:true` 才收置顶」、
「`includeArchived:true` 才收归档」、
「越出缓存根的路径拒绝」、「缺 file 的条目只跳过」、「maxItems 封顶」，
**77 pass / 0 fail**；`probe-digest` 58/0、`probe-filehistory` 33/0 全绿。

**兼容性**：两条新路由、guard 新增两个导出、`__internals` 37 项。无新配置项。
宿主与客户端均有改动，**需重启 DSH 生效**。

## 0.28.4 — 2026-10-30

### 新增：在侧栏隐藏「未分组」分组（设置 → 归档收藏 → 未分组体检）

**背景**：0.26.0 的体检能诊断和清理「未分组」，但它只能处理**磁盘上真实存在**的
游离会话。实践中还有一类条目磁盘上根本查不到——它们只存在于投影缓存
（`~/.dsh/storages/session_projcache/sessions/<id>.json`）里，会话目录早已不在。
`check-ungrouped.js` 扫目录、宿主 guard 读 registry，两者都报 `clean`，而侧栏
照样画出这个分组。对这类条目，插件唯一能提供的就是「眼不见为净」的视图开关。

**行为**：设置页「未分组体检」卡片新增一个复选框
「在侧栏隐藏「未分组」分组（连同组头一起隐藏，不删除任何对话）」。
勾选后侧栏底部的「未分组」分组整体消失（组头 + 组内会话行一起），取消勾选立刻恢复。

**为什么是纯视图开关**：

- **不删任何东西**。不调用宿主路由，不写 `workspace.json`，不碰会话目录与缓存文件。
- **不可能误伤真实工作区**。官方给组头打的锚点是 `data-row-key="workspace:<key>"`，
  而未分组桶的 key 是**空字符串**（`UNGROUPED_KEY = ""`），所以选择器
  `[data-row-key='workspace:']` 只可能命中这个无主桶——用户自己建的每个工作区
  key 都非空。
- **隐藏的是容器，不是组头**。官方结构是
  `div.groupSection > [组头 div.projectRow, div[role=group]]`，只藏组头会把会话行
  留在上一个分组下面。插件给组头的 `parentElement` 打 `data-dsh-aff-ungrouped="1"`
  再整块 `display:none`。
- **偏好持久化**。开关状态存 `localStorage['dsh-aff-hide-ungrouped']`，重启后仍生效。
- **卸载即复原**。`stopFilterEnhancer()` 会摘掉 `<html data-dsh-aff-hide-ungrouped>`，
  插件被禁用后分组自动回来，不会出现「藏了但没 UI 能救」的死角。

**实现细节**：三个模块级函数（`readHideUngrouped` / `markUngroupedGroup` /
`applyHideUngrouped`）+ 一条 CSS 规则
`html[data-dsh-aff-hide-ungrouped='1'] [data-dsh-aff-ungrouped='1']{display:none !important}`。
标记函数接进已有的 `markRows()`（侧栏 MutationObserver 每次重绘都会重新打标，所以
分组不会在切换会话/重载列表后闪回）。复选框放在说明段之后、诊断结果之前——想隐藏
的人不需要先跑一次扫描。

**测试**：`test/probe-client.mjs` 新增 4 条断言，分别锁住「只命中空 key 桶」、
「规则受开关属性 gate」、「隐藏容器而非组头」、「偏好持久化」，**199 pass / 0 fail**。

**兼容性**：无新路由、无新配置项、`__internals` 仍为 35 项。纯客户端改动，需重启生效。

## 0.28.3 — 2026-10-29

### 修复：npm 包里混进了两个本地备份文件

**现象**：0.28.2 发布后，`npm pack` 清单里出现 `lib/client.js.bak-20261029-154053`
（86.6 kB）与 `lib/index.js.bak-20261029-154053`（53.2 kB）。这两个文件是改
`lib/` 前留的本地快照，不该出现在公开 tarball 里——内容虽已脱敏（复扫 0 命中），
但多带 140 kB 且暴露内部操作痕迹。

**根因**：`package.json` 的 `files` 里同时写了 `"lib"` 与 `"lib/**/*.js"`。`"lib"`
会把该目录下的**所有**文件都收进去，而 `.gitignore` 里的 `*.bak-*` 对 npm 打包
**无效**（npm 只认 `files` 白名单与 `.npmignore`）。

**修复**：

- `files` 由 `["lib", "lib/**/*.js"]` 收窄为 `["lib/*.js"]` —— 只收 `lib/` 顶层的
  三个真实模块（`index.js` / `client.js` / `ungrouped-guard.js`）。
- 新增 `.npmignore`（`*.bak`、`*.bak-*`、`*.log`、`*.tgz`，以及七个 `.probe-*/`
  探针夹具目录），作为第二道闸门：以后无论 `files` 怎么写，备份与夹具都进不去。

**验证**：`npm pack --dry-run` 清单 19 个文件、**无 `.bak`**；四套探针仍全绿
（`probe-client` 195/0、`probe-digest` 58/0、`probe-filehistory` 33/0、
`probe-ungrouped-guard` 58/0）；`package.json` 严格 JSON.parse 通过。

**为什么升 0.28.3 而不是重发 0.28.2**：npm 同一版本号不可覆盖，`unpublish` 后
24 小时内也不允许重发同号，所以按发布纪律升 patch 版本重发。

## 0.28.2 — 2026-10-29

### 修复：回合进行中插话的消息行上没有撤销 / 编辑 / 删除按钮

**现象**：用户报「撤回等效果按钮怎么不见了」。同一条会话里，一部分用户消息下面
有 `↺ 撤销 / ✏️ 编辑重发 / 🗑 删除` 三个按钮，另一部分完全没有——而且刚发的那条
一定没有。菜单里的「删除对话」「新窗口继续对话」等项都正常，所以不是插件没加载。

**根因**：官方聊天流把人类消息分成两种 flow kind：

| 消息 | `data-chat-flow-kind` | 说明 |
|---|---|---|
| 一个回合开头的提问 | `user` | `turn/start` 之后的第一条 `user/message` |
| 回合进行中的插话 | `steering` | 落在 `next-step` 队列里、被 `inbox-next-step` 领取的消息 |

两种消息**共用同一个 `UserMessageNodeView` 渲染器**（官方
`registerChatNodeRenderers` 里 `key: "user"` 与 `key: "steering"` 指向同一组件），
DOM 结构完全一致，都有 `data-clock="start"` 和 `data-chat-turn`，唯一区别就是
`data-chat-flow-kind` 的取值。而 0.26.0 引入按钮时按 `[data-chat-flow-kind="user"]`
找宿主行，于是所有插话消息都被 `continue` 跳过，永远挂不上按钮。

实测取证（本机一条 13 轮的会话）：日志里 22 条真人消息，按
`agent/inbox/spliced` 的 `data.target` 对齐后是 **13 条 `next-turn`（kind=user）
+ 9 条 `next-step`（kind=steering）**。用户反馈「按钮不见了」的那两条恰好都是
`steering`——不是按钮被删了，是它从来没有出现在插话行上。

**修复**：新增一个共用选择器常量，三处查行的地方全部改用它：

```js
const HUMAN_FLOW = '[data-chat-flow-kind="user"][data-chat-turn], [data-chat-flow-kind="steering"][data-chat-turn]'
```

- `scan()` 挂按钮时用 `row.closest(HUMAN_FLOW)` 找宿主行；
- `enterEdit()` 点击后按轮号现查行时同时匹配两种 kind；
- `openEditor()` 的看门狗 `ensureAttached()` 搬迁编辑器时同样匹配两种 kind
  （否则 React 重渲染后编辑框会搬回不存在的 user-only 节点上，又变成「点编辑没反应」）。

**测试**：`test/probe-client.mjs` 新增 3 条静态契约断言，锁死这个口径——
`HUMAN_FLOW` 常量必须同时含 user 与 steering、`scan()` 必须经它解析宿主行、
并且**源码里不允许再出现任何 user-only 的 `data-chat-turn` 查询**（正则双向检查）。
探针总数 192 → **195**。

### 兼容性

- 无新路由、无新配置项、无 `__internals` 变化（仍 35 项）。
- 仅 `lib/client.js` 与 `test/probe-client.mjs` 改动；宿主 `lib/index.js` 未动。
- 客户端 bundle 无文件监视，**必须重启 DSH 才生效**。

## 0.28.1 — 2026-10-29

### 修复：新窗口继续对话发送失败（`gateway/input-invalid`）

0.28.0 点「开始新对话」后会报：

```
session/prompt: wire field "request" failed boundary validation
(gateway/input-invalid)
```

**原因**：`session.prompt(content, mode)` 的第一个参数会**原样透传**给
`session/prompt` 这条 wire 调用，而它的 `content` 字段在边界上被校验为
**content-block 数组**（`[{ type: 'text', text: '…' }]`）。0.28.0 把 2276 字节的
交接书**字符串**直接传了进去，`z.array(...)` 解析失败，整条请求被网关拒绝。

**表现**：新会话其实已经建好、也已经改名成 `新对话-<原名>`，但交接书没发出去，
窗口里只有一个空对话。

**修复**：发送前把字符串包成单个 text block（数组入参原样保留，编辑重发那条
路径本来就传数组，不受影响）。探针加了一条断言锁住这个包装，防止回归。

**真机验收**：新窗口打开、标题 `新对话-<原名>`、预设继承（`agentPreset` 非空）、
交接书作为第一条消息自动发送、全程 0 条 `gateway/input-invalid` —— 全部通过。

### 已知边界（不修，仅记录）

`新对话-<原名>` 在原标题很长时会丢末尾几个字。这是 DSH 上游
`session-title` 服务的 `maxTitleBytes: 80` 硬上限造成的（按 UTF-8 字节截断，
中文一字 3 字节），**不是本插件加的**：插件原样透传标题。

实测：原标题 `DeepSeek 智能体团队任务：蒸馏消息回滚与侧边栏未分组排查` 为
78 字节，加上 10 字节的 `新对话-` 前缀后 88 字节，被截成 33 字 / 79 字节。
扫描本机全部 574 个会话标题，最长恰好 79 字节 —— 80 是全库天花板。
放宽需改 profile 里 `session-title.config.maxTitleBytes`，会影响所有标题并需重启，
用户判定「侧边栏标题不重要」，故不改。

## 0.28.0 — 2026-10-29

### 新功能：一键新窗口继续对话

长对话最终会走到一个死点：上下文太长，继续聊又慢又贵，还随时可能卡死。
本版给「…」菜单加一行 **新窗口继续对话**，把原对话蒸馏成一份交接书交给新窗口，
**保住用户要求的时间线与任务完成进度，丢掉那 800 次工具调用**。

#### 流程

1. 点菜单里的「新窗口继续对话」→ 宿主只读解析会话日志，生成交接书。
2. 弹窗先告诉你**进度**：「检测到任务进行到 第 N 轮 / 任务清单 2/3 已完成，当前：… / 共 15 条要求 · 812 次工具调用」，
   下面的宽文本框就是**将要发送的全文**，可以直接改。
3. 确认后才真的建会话 —— 建完自动命名为 `新对话-<原名>`、**继承原对话的预设智慧体**、
   打开新窗口并把交接书作为第一条消息发出去。

🔴 **读和写严格分离**：生成交接书是只读的，新建会话只发生在用户点「开始新对话」之后。
只是想看看进度的人，不会莫名其妙多出一个空对话。

#### 交接书里有什么

| 章节 | 内容 | 为什么保留 |
|---|---|---|
| 原对话 | 会话 ID、转录文件绝对路径、工作目录、轮次/要求数/工具调用数 | 需要时能回到原件里翻细节 |
| 用户要求时间线 | **每一条真人消息**（按顺序，标注属于第几轮），单条 600 字符 | 用户要的东西不能丢 |
| 任务进度清单 | 最近一次 `todo/write` 快照，`[x]` / `[~]` / `[ ]` 三态 | 任务完成进度线 |
| 团队任务 | `team/task` 按 id 取最高 revision，含负责人 | 多智能体协作的进度 |
| 最近进展 | 最后一条助手回复 | 接手者知道说到哪儿了 |
| 你现在要做的 | 5 条指令：先复述进度、从进行中的那项接着做、不要重做已完成、关键决策先问、不要复述交接资料 | 让新会话直接干活而不是从头开始 |

#### 交接书里**故意丢掉**什么

工具调用参数、工具返回结果、reasoning 思考块、step/turn 记账、job 帧、subagent 闲聊。
这些占了长日志的绝大部分，而对「继续干活」毫无价值。

#### 两个容易搞错的地方（探针已锁死）

- **steering 注入也是 `user/message`**，但它不是用户要求。只有 `data.source.kind === 'user'`
  才进时间线 —— 否则会凭空多出一条用户从没提过的要求。
- **超长对话的时间线是「中间挖空」而不是「尾部截断」**：保留最早 8 条 + 最近 24 条，
  并在交接书里写明「已省略中间 N 条」。只留尾巴会丢掉最初的立项要求。

#### 新增路由

| 路由 | 方法 | 说明 |
|---|---|---|
| `/session-digest` | POST | 只读。`{sessionId}` → 交接书全文 + 结构化摘要（`turns` / `todoSummary` / `teamSummary` / `timeline` …）。无日志时 404。 |

#### 客户端细节

- 菜单行 id `aff-continue`，order 520（紧跟「复制 ID + 路径」，远离删除）。
- 弹窗复用 `SessionDeleteDialog` 的 state 形状，新增两个字段：`wide`（760px + 等宽字体文本框，
  因为交接书是一篇长文档）与 `confirmDanger`（默认红色只适合删除类动作；「开始新对话」不该被画成危险操作）。
- 预设继承读 `sessions.list.byId[sid].projectionValues.agentPreset`（与官方 `restoreBlank` 同源），
  创建时传 `{workspaceId, agentPreset}`。
- 重命名走官方 `sessions.using(id, {source}, ref => ref.binding.session.rename(title))`，
  失败回退 `sessions.manager.rename`（刚建好的会话可能还没有 retained binding）。
- 发送复用会话管理半边已有的轮询式 `prompt(..., 'queue')`，40 次 × 250ms 等新会话就绪。

### 测试

新增 `test/probe-digest.mjs`（**57 通过 / 0 失败**）：用隔离假 home 造一份「像真对话一样」的多帧
zstd 日志（含 reasoning、tool/call、tool/result、steering 注入、两次 todo/write、两条 team/task
不同 revision、team/member），断言 ①每条真人要求都在时间线、②steering 不进时间线、
③最新 todo 快照胜出且进行中项被点名、④团队任务按 revision 去重、⑤reasoning/tool 结果/工具参数
**都不出现在交接书里**、⑥60 条要求的长对话被挖空并写明省略、⑦交接书不超过 24000 字符预算、
⑧客户端「先读后建」的顺序（`sessions.create` 只出现在 `onConfirm` 内部）。

`probe-client.mjs` 随之从 6 个注册臂变为 7 个（菜单行 3 → 4），断言按新数量更新，**192 通过 / 0 失败**。
`probe-filehistory.mjs` 33/0、`probe-ungrouped-guard.mjs` 58/0 不受影响。

### 兼容性

- `__internals` 由 30 项增至 35 项（新增 `sessionDigest` / `clipText` / `textBlocksOf` /
  `DIGEST_MESSAGE_CLIP` / `DIGEST_PROMPT_BUDGET`），只增不改。
- 不新增插槽：新菜单行挂在已有的 `sidebar.workspaces.session.menu.item` 上。
- 不改官方文件，不写 `workspace.json`。

## 0.27.0 — 2026-10-29

### 菜单精简：删除文案、隐藏官方重复项

- 单会话删除菜单项文案 `永久删除此对话…` → **`删除对话`**。原文案过长，在侧栏「…」菜单里被截断，且末尾省略号让人误以为还有二级页面；真正不可撤销的警示保留在确认弹窗里（「永久删除「xxx」？」/「确认永久删除（不可恢复）」）。
- **隐藏官方内建的「复制 Session ID」行**。该行来自 `@deepseek-ai/dsh-experimental-inspector` 的 `SessionIdMenuItem`（i18n `menu.sessionId`），是本插件「复制 ID + 路径」的重复项。插槽无法移除同级插槽的行，因此在 DOM 层隐藏：按**精确文案**匹配（`复制 Session ID` / `Copy Session ID`，子串匹配会误伤本插件自己的「复制 ID + 路径」），并隐藏整行 wrapper（只藏 button 会留下一条空白 padding），打上 `data-dsh-aff-hidden-official="1"` 保证幂等。

### 测试

`probe-client.mjs` 新增 3 条断言（188 通过 / 0 失败）：重复的官方行被隐藏、隐藏的是 wrapper 而非仅 button、删除行文案为「删除对话」。

## 0.26.0 — 2026-10-29

### 新功能：侧栏「未分组」体检 —— 诊断、一键清理、开机硬门

侧栏底部那个「未分组」分组不是 bug，是官方 `groupByWorkspace()` 的兜底分支：
**任何没有被 workspace 记账的会话都会掉进去**。本版把它变成可诊断、可修、可预警。

先明确一个常被误解的点：**「未分组」和「删除历史对话」没有因果关系。**
官方 `sessionVisible()` 是四步串行判定 —— ① `origin === 'subagent'` 排除 ② 非当前的
blank 排除 ③ 已归档排除 ④ 才轮到「有没有 workspace 记账」。归档集合与未分组是**两条互不相干
的分支**，所以「删了对话 → 归档 id 残留 → 出现未分组」这条链根本不存在。
实测反证：本机 `archivedSessionIds` 里有 98 条 id 指向已经不存在的会话目录，侧栏一直干净。

#### 新增：设置页「未分组体检」卡片

「设置 → 归档收藏」最下方新增一张卡片，三个动作：

| 按钮 | 行为 |
|---|---|
| **诊断** | 只读扫描全部会话目录，按官方四步判定复算出会掉进「未分组」的会话，逐条给出**建议处置 + 理由** |
| **试算（不修改任何文件）** | `dryRun: true`，只回报「将删 / 将归档 / 将登记」清单，磁盘一个字节不动 |
| **确认执行** | 二次确认后才真跑；真跑前**宿主会重新诊断一次**，只处理此刻仍然游离的会话 |

建议处置分四档，卡片按颜色区分：

- **删到回收站** —— e2e 测试夹具，或无任何用户消息且 < 2KB 的空壳
- **归档（保留数据）** —— 有真实内容，但 cwd 没有对应 workspace
- **登记归位** —— 有真实内容，且 cwd 恰好对应某个已存在的 workspace（走 `attachSession`）
- **需人工判断** —— 当前正在用的会话，**永不自动处置**

#### 新增：三条宿主路由（挂在既有 `ROUTE_PREFIX` 下）

| 路由 | 说明 |
|---|---|
| `POST /ungrouped-diagnose` | 只读。返回完整报告（summary / 逐条明细 / unreadable / verdict） |
| `POST /ungrouped-cleanup` | **无 `confirm: true` 时强制干跑**；有则先重新诊断，只对仍游离的 id 执行 |
| `POST /ungrouped-explain` | 返回中文说明「为什么会有未分组、是不是删对话造成的、怎么根治」 |

#### 新增：开机硬门告警

插件启动 8 秒后（`ungroupedCheckDelayMs`，默认 8000）跑一次只读诊断：

- 有游离会话 → `logger.warn`：`⚠ N session(s) will appear under 未分组 in the sidebar`，
  附前 10 个 id，并指路「设置 → 归档收藏 → 未分组体检」
- 干净 → `logger.info`：`ungrouped guard — clean (N session dirs scanned, source=…)`

**为什么是「告警 + 一键可修」而不是「自动删」**：插件无法阻止官方 create 路径产生游离会话
（那是 `WorkspaceRegistry.create()` 的收尾问题），能做的是「每次开机响一次」+「一键可修」。
自动删会话是不可接受的默认行为。该检查**延迟且不 await**，避免把侧栏小瑕疵变成启动失败；
定时器 `.unref()` 并在 `ctx.effect` 里清理。

#### 新增：`lib/ungrouped-guard.js`（自包含模块，763 行）

`diagnoseUngrouped(ctx, options)` / `cleanupUngrouped(ctx, plan, options)` / `explainUngrouped()`。
七道守卫：`missing-id-or-dir`、`action-not-allowed`、`budget-exhausted`（`maxItems`，默认 50）、
`current-session`、`outside-sessions-root`、`refused-symlink`、`not-a-directory`。
删除默认走**回收站**（`Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(..., 'SendToRecycleBin')`），
失败降级为移动到 `<dshHome>/sessions_quarantine_<stamp>/` 隔离区，**绝不硬删**。

#### 新增：`test/probe-ungrouped-guard.mjs` → pass 58 / fail 0

隔离假 home（`DSH_HOME` / `DSH_AFF_SESSIONS_ROOT` / `DSH_AFF_WORKSPACE_FILE` / `DSH_SESSION_ID`
全指向 `test/../.probe-ungrouped`，跑完删除），造 9 条多帧 zstd 会话覆盖四步判定的每一步 + 五类建议 +
两条守卫 + 预算上限。关键断言：默认 dryRun **registry 零调用、emit 零次、9 个目录全在、
`workspace.json` 逐字节相同**；多帧 zstd 只解第一帧的坑有专门回归用例（标记只写在最后一帧）。

#### 性能：诊断从 12.6 s 降到 0.43 s（本机 653 个会话目录实测）

第一版把每个会话日志**逐帧全解**（本机 746 MB / 355 285 帧）才能读到标题，整轮 `diagnoseUngrouped`
耗时 **12 628 ms**，且是同步 CPU 工作 —— 开机自检和点「诊断」都会卡住主线程十几秒。

修复思路：**判定与取正文分开**。四步排除只看 header，而 header 永远在第一帧，所以新增
`readSessionHeader()` 只解第一帧（整轮 50 ms）；只有真正落进未分组桶的那几条（通常个位数）
才调 `readSessionLog()` 解全文取标题。同时保留一条安全兜底：若帧边界没落在行边界上（DSH 自己不会
这么写，手工夹具可能有），第一帧读不出 header 就退回全文解压，**正确性优先于速度**。

`readSessionHeader()` 返回 `{ complete, frames }`：`complete=false` 表示 `text` 只是第一帧，
调用方需要全文须自行升级。新增 6 条断言钉死这条性能契约（含「只解一帧」「不重复解压」「帧边界
切在行中间仍能读到 header」），任何人把全量解压加回来都会立刻红灯。

### 兼容性

0.25.0 的 13 条路由、消息级三按钮、文件快照全部未改动；本版只**新增** 3 条路由与 1 张设置页卡片。
`handleDelete` 的守卫语义**未变**。`__internals` 从 26 项增至 30 项（新增 guard 四个导出）；
guard 内部另导出 5 个读取辅助（`decompressZstdHead` / `countZstdFrames` / `pickLogFile` /
`parseHeaderLine` / `readSessionHeader`）供探针直接白盒验证。

---

## 0.25.0 — 2026-10-29

### 新功能：把 `dsh-session-manager` v1.0.0 的三个能力并入本插件

本版把独立插件 `dsh-session-manager`（v1.0.0）蒸馏合并进来，**一个插件、一套删除实现**。
原插件有三个能力：①侧栏永久删除会话 ②用户消息编辑重发 / 撤销整轮 ③AI 改过的文件自动快照与回滚。
第①项与本插件已有的 `aff-delete` 重复，因此**没有移植**（见下「为什么只留一套删除」）。

#### 新增：消息级操作（转录区 DOM 注入）

在每条**用户消息**的官方复制按钮之后，追加三个按钮（顺序 `[↺ 撤销][✏️ 编辑][🗑 删除]`）：

| 按钮 | 行为 |
|---|---|
| ✏️ **编辑重发** | 内联编辑框，可拖入文件 / 粘贴图片（最多 10 个附件、单个 8MB）；发送后截断到该消息之前并重发 |
| ↺ **撤销整轮** | 回退到该轮之前，**默认同时回滚这一轮被 AI 改过的文件**；确认框列出将被回滚的路径，可取消勾选只回退对话 |
| 🗑 **删除消息** | 只回退对话，**不动文件**（语义上与「撤销」区分开） |

锚点是每条消息上唯一的 `[data-clock="start"]`，归属取 `[data-chat-flow-kind="user"]` 祖先；
配 `MutationObserver` 重扫，流式新消息也会补按钮。**不依赖任何 CSS 模块哈希。**

#### 新增：宿主端文件快照

- 每次 `write` / `edit` / `str_replace_editor`（`command !== 'view'`）调用**之前**，
  把文件当前字节按 **sha256 内容寻址**存进
  `~/.dsh/sessions/<ws>/<session>/history-file/blobs/<sha256>`，
  并往 `history-file/manifest.jsonl` 追加 `{seq,turn,time,tool,path,blob}`。
- `blob: null` = 当时文件不存在 → 「还原」等于**删掉**它。
- 回滚取每个 path 上 `seq > keepSeq` 的**最早一条**记录还原，然后消费掉用过的 manifest 条目
  与因此变孤儿的 blob（回滚过的会话不会越滚越大）。
- 没有快照的老会话走**日志反推**兜底：`edit` 换回 `old_string`、`str_replace_editor create` 删文件、
  `str_replace` 换回 `old_str`、`insert` 移除 `new_str`；`write` 无法反推 → **点名文件的告警**。

#### 新增宿主路由（3 条，全部挂在既有 `ROUTE_PREFIX` 下）

| 路由 | 作用 |
|---|---|
| `POST /session-turn-info` | 某轮的用户原文、该轮改过的文件清单、以及 fork 边界 `beforeSeq` |
| `POST /session-files-restore` | 回滚某个 `keepSeq` 之后被改过的文件（首轮边界为 `-1`） |
| `POST /session-replace` | fork 接替之后退掉原会话（**单 id**，内部走 `handleDelete` 的 `replace` 模式） |

原插件的 `/api/session-delete` 六步逻辑**没有单独保留** —— 删除收尾统一走本插件已有的
`handleDelete`（守卫更全：六道 + EBUSY/EPERM 重试 + 收藏保护）。

#### 新增：`shell.overlay` 插槽（唯一新增插槽）

id `aff-session-confirm`，order 100，承载编辑/撤销共用的确认弹窗。
**没有**移植原插件的删除行内按钮与删除菜单项 —— `aff-delete` 仍是唯一的删除入口。

#### 客户端 `exports.inject` 扩展

`["slots"]` → `["slots", "sessions", "uiWorkspace", "workspaces", "fileUpload"]`。
每个服务只被转录按钮注入器使用；任一缺失时**降级而不崩**（所有调用点都 optional-chain 或守卫）。

#### CSS 命名空间

原插件全部 `dsh-sd-*` 类名统一改为 **`dsh-aff-sd-*`**，避免与既有 `dsh-aff-*` 样式冲突；
样式表注入到独立的 `<style data-plugin="dsh-archive-favorites-forge">`
（这个属性是 hovercard 抑制逻辑的查找键，因此**其它样式表不得占用它**）。

#### 为什么只留一套删除（而不是两套并存）

两个插件都有删除能力，但本插件那份更健壮（六道守卫、symlink 检查、EBUSY 重试、收藏保护、
`api-session/removed` 事件）。并存会得到两个删除按钮、两条代码路径、两套守卫语义。
所以本版**只保留本插件的 `handleDelete`**，并给它加了一个**显式** `options.replace` 参数：

- `replace: true` 时**只跳过「收藏保护」这一条** —— 理由：收藏的语义是「这条对话要留着」，
  而 replace 场景里被退掉的恰恰是**已经被自己的 fork 取代的那一条**，且陈旧的收藏键在读取时本就会被忽略；
- **其余守卫全部保留**：必须在 sessions 根内、不能是根本身、非符号链接、必须是目录、EBUSY/EPERM 重试；
- 它是**独立路由 `POST /session-replace` 上的显式参数**，所以 `/delete` 的请求体无法把它关掉。

### 已知限制（写进 README 了，这里再列一次）

- **只跟踪三个工具**（`write` / `edit` / `str_replace_editor`）。终端命令、脚本、格式化工具
  改的文件**没有快照也没有日志记录**，撤销看不到。
- **只记录绝对路径**；相对路径一律跳过（无法从转录得知正确基准目录，猜错会改错文件）。
- **单文件 > 8MB 跳过**（一个版本一份 blob，上限防止一轮写满磁盘）。
- **回滚会覆盖当前内容** —— 还原的是该轮开始前的字节，此后手改的内容会丢。
- **编辑框只预填消息正文**，原消息附件不带过来（附件句柄按会话隔离，复制会变悬空引用）。
- **撤销会删掉原会话**（fork + 退掉原会话，不保留隐藏分支）。

### 测试

- `node --check lib/index.js` → 0；`node --check lib/client.js` → 0；
  `node -e "import('file:///.../lib/index.js')"` → 导入成功（`inject=["webServer"]`，26 个 internals 键）。
- `node test/probe-client.mjs` → **pass 179 / fail 0**（0.24.4 基线 177；新增 2 条断言：
  overlay 数量、overlay id）。
- 探针同步更新：React stub 补 `useRef`（确认弹窗需要稳定可变盒，真 React 按 hook 槽位绑定，
  stub 返回新对象会静默破坏焦点还原）；插槽计数断言 5→6、distinct slot name 3→4。
- **新增 `test/probe-filehistory.mjs` → pass 33 / fail 0**。`probe-client.mjs` 只能证明客户端契约，
  `node --check` 只能证明语法；而「撤销会把文件也还原吗」是关于磁盘字节的断言，只能拿磁盘字节来验。
  该探针在 `DSH_AFF_*` 覆盖的隔离假 home 里造多帧 zstd 会话日志（**每事件一帧**，与真实写入同形，
  单帧夹具会让只在真会话上失败的解码器蒙混过关），复现「先发 `tool/call` → 快照 → 写入落盘」的真实时序，
  覆盖：日志解码/丢头行、`beforeSeq` 取 `turn/start` 之前一个事件、快照存**改前**字节、
  `blob: null` = 当时不存在（回滚即删除）、边界条目保留（因此可二次更深回滚）、
  从日志反推兜底、`write` 不可反推时只告警不猜、以及 replace 模式只跳过收藏守卫。

### 兼容性

原有 10 条路由、4 处插槽注册、收藏/归档/超时归档/导出/揭示/会话信息/删除/设置页全部未改动。
`/delete` 的守卫语义**未变**（`replace` 只有内部调用者能传）。

---

## 0.24.4 — 2026-10-19

### 文档纠偏（无功能改动）

**纯文档/元数据版本**：`lib/index.js` 与 `lib/client.js` 逐字节未改（与 0.24.3 完全一致），
只修正了与代码真实行为不符的文案，并裁掉一份重复的中文 README。

#### 逐处对照

| # | 位置 | 原写法 | 实际行为 | 代码取证 |
|---|---|---|---|---|
| 1 | `locale/zh.json:4` | 「把**收藏的回复**整理成可浏览的归档，支持**分组、标签**与一键导出。」 | 收藏对象是**对话（conversation/session）**，不是「回复」；**没有分组功能，也没有标签功能** —— 全仓库 `lib/*.js` 里不存在任何 tags/folders 数据结构、路由或 UI | `grep -rn "tags\|folders\|标签\|分组" lib/*.js` 只命中 3 处，全部与插件功能无关：`lib/index.js:1028` 导出时 cwd 为空落 `'未分组'` 兜底；`lib/client.js:743/750` 是识别**官方**视图选项菜单的文案特征串 |
| 2 | `locale/en.json:4` | "Turn your favorite **replies** into a browsable archive with **folders, tags** and one-click export." | 同上：对象是 conversation，folders/tags 不存在 | 同上 |
| 3 | `README-es.md:3` | 同一句错误 slogan（folders, tags, replies） | 同上 | 同上 |
| 4 | `README-pt.md:3` | 同一句错误 slogan（folders, tags, replies） | 同上 | 同上 |
| 5 | `README-hi.md:3` | 同一句错误 slogan（folders, tags, replies） | 同上 | 同上 |
| 6 | `package.json` `description` | "Favorites, copy id+path, per-session delete, idle batch archive …" 中文「为 DSH 对话增加收藏、复制 ID+路径、单条删除、超时批量归档与收藏筛选。」 | 内容基本对，但漏了**导出清单**（`/export-list`）与「永久删除」「带护栏」这些真实措辞 | 路由共 10 条见下；导出 5 列见 `lib/index.js:1010` |
| 7 | `README-zh.md`（862 B，连字符） | 重复的中文 README：无人链接、文案与 `locale` 同源同错，正文全是「本节内容详见 English README」的空壳 | 真正的中文文档是 `README.zh.md`（8386 B，被 `README.md:13` 的 `[简体中文](README.zh.md)` 链接，内容正确完整） | `grep -rn "README-zh"` 除自身外只被 `package.json:25` 的 `files` 与 CHANGELOG 0.24.3 记录提及 |

#### 修正后的事实基线（本次重新逐项核验）

| 项目 | 实测值 | 取证位置 |
|---|---|---|
| 路由前缀 | `/plugins/dsh-archive-favorites-forge` | `lib/index.js:64` |
| 子路由 | 10 条：`/status`、`/favorites`、`/archived`、`/idle-archive`(GET+POST)、`/unarchive`、`/export-list`、`/reveal`、`/favorite`、`/session-info`、`/delete` | `lib/index.js:801/814/824/869/948/975/1052/1090/1107/1115` |
| 批量删除上限 | `maxDeletePerCall` 默认 **500** | `lib/index.js:476` |
| 官方插槽 | 4 处注册：`sidebar.workspaces.session.menu.item`×3、`sidebar.workspaces.session.row.action`×1、`settings.section`×1 | `lib/client.js:1703/1711/1722/1732/1742` |
| 删除护栏 | 6 道：收藏拒删、路径越出 sessions 根拒删、sessions 根本身拒删、符号链接拒删、非目录拒删、单批上限 | `lib/index.js:495/516/520/525/529` + `476` |
| 导出列 | 5 列：对话名称 / 对话ID / 所属工作区 / 闲置时长 / 最后活动时间 | `lib/index.js:1010` |
| 选择器 | 零 CSS 模块哈希，全部走 `data-row-key` / `role` / `aria-*` / `data-dsh-aff-*` | `lib/client.js:596/643/664/685/849` |
| 探针 | `node test/probe-client.mjs` → **pass 177 / fail 0** | 本地实跑 |

#### 教训

**功能清单必须从代码里长出来，不能从上一版文案里继承。**

这五个文件的错误 slogan 是同一句话的五次复制 —— 只要有人先把「分组、标签」写进一处，
`locale/en`、`locale/es`、`locale/pt`、`locale/hi` 就会跟着一起错，而它们互相引用、互相"印证"，
读起来毫无破绽。真正能证伪它的只有一条命令：`grep -rn "tags\|folders" lib/*.js`。
更隐蔽的是，这条 grep **确实会命中**（导出兜底的 `'未分组'`、官方菜单识别用的 `"分组方式"`），
如果只看「命中数 > 0」就断定功能存在，反而会被假阳性骗过去 ——
**判断标准必须是「命中的那行是否实现了这个功能」，而不是「有没有命中」。**

另有一条同源教训：**两份同名（仅差连字符）的 README 必然漂移**。
`README.zh.md` 与 `README-zh.md` 并存期间，正确的那份没有任何人引用错误来源，
错误的那份却进了 `package.json` 的 `files` 白名单，一路发到 npm 上。
包内文档只应有一个真源；重复即负债。

### Documentation corrections (no functional changes)

**Documentation and metadata only** — `lib/index.js` and `lib/client.js` are byte-identical to 0.24.3.
Only prose that contradicted the code was rewritten, and one duplicate Chinese README was retired.

| # | Location | Was | Actually does | Evidence |
|---|---|---|---|---|
| 1 | `locale/zh.json:4` | "…整理成可浏览的归档，支持**分组、标签**与一键导出" | Favourites hold **conversations**, not replies; **there is no grouping and no tagging** — no data structure, route or UI for either | `grep -rn "tags\|folders\|标签\|分组" lib/*.js` hits exactly 3 unrelated lines: `lib/index.js:1028` falls back to `'未分组'` when a session has no cwd; `lib/client.js:743/750` are text markers used to recognise the **official** view-options menu |
| 2 | `locale/en.json:4` | "favorite **replies** … with **folders, tags**" | Same: conversations, and no folders/tags exist | same |
| 3–5 | `README-es.md:3`, `README-pt.md:3`, `README-hi.md:3` | the identical wrong sentence, four times | same | same |
| 6 | `package.json` `description` | omitted the list export and the guarded/permanent wording | now names all six real features bilingually | routes below; export columns at `lib/index.js:1010` |
| 7 | `README-zh.md` (862 B) | duplicate Chinese README, unreferenced, empty shell | the real one is `README.zh.md` (8386 B), linked from `README.md:15` | only `package.json:25` `files` and this changelog mentioned it |

Removed `README-zh.md` from the package (`mv` to `~/.dsh/backups/archive-forge-docs-20261019/`,
not deleted outright) and dropped it from the `files` allowlist.

**Lesson.** A feature list must be derived from the code, never inherited from the previous
release notes. The same sentence was copied five times, so the five files corroborated each other
and read as perfectly consistent. The only thing that could falsify it was one grep — and that grep
*does* match (the `'未分组'` export fallback and the official-menu marker `"分组方式"`), so
"matches > 0" would have been a false positive. **The test is whether the matched line implements
the feature, not whether anything matched.** Second lesson: two READMEs differing by one hyphen
will inevitably drift; the wrong one shipped to npm because it alone was in `files`.

---

## 0.24.3 — 2026-10-14

### 合规性改进（无功能改动）

本次为**纯元数据与文档改动，未触碰任何运行代码**（`lib/*.js` 与上一版逐字节一致）：

- **包元数据**：`engines.node` 对齐 DSH 运行时（`^22.19.0 || >=24.0.0`）；补 `packageManager`；`files` 白名单补上裸目录 `lib`、`locale/*.json`、`icon.svg` 与多语言 README；`exports` 补 `./locale/*.json` 与 `./icon`。
- **交付元数据**（官方插件契约要求）：新增 `locale/en.json` 与 `locale/zh.json`（含 `meta.title` / `meta.description`），新增 `icon.svg`（插件管理器显示用图标，不再显示裸 id）。
- **多语言文档**：新增 `README-zh.md` 中文说明；`README-es/pt/hi.md` 标题与主 README 对齐。

以上改动使插件通过官方 `dsh-plugin-dev check` 全部检查项（`P=12 F=0 W=0`）。

### Compliance improvements (no functional changes)

This release is **metadata and documentation only — no runtime code was touched** (`lib/*.js` is byte-identical to the previous version):

- **Package metadata**: `engines.node` aligned with the DSH runtime (`^22.19.0 || >=24.0.0`); `packageManager` added; `files` allowlist now includes the bare `lib` directory, `locale/*.json`, `icon.svg` and the multi-language READMEs; `exports` gained `./locale/*.json` and `./icon`.
- **Display metadata** (required by the official plugin contract): added `locale/en.json` and `locale/zh.json` with `meta.title` / `meta.description`, plus `icon.svg` so the plugin manager shows a real name and icon instead of a bare id.
- **Multi-language docs**: added `README-zh.md`; `README-es/pt/hi.md` headings aligned with the main README.

With these changes the packages pass every official `dsh-plugin-dev check` item (`P=12 F=0 W=0`).

---

## [0.24.2] — 2026-10-10

### Added

- **Screenshots** of the three surfaces, committed under `assets/` and embedded
  in both READMEs. They are listed in the package `files` whitelist, so the npm
  page shows them too — an asset missing from that list reaches GitHub but not npm.

### Fixed

- The settings card could print 「归档来源：读取中…」 **directly beneath a real
  count**. Both values come from the same response, so a visible count proves the
  read already succeeded; the empty initial state contradicted the number above it
  and read as a stuck spinner. When the list is present but the source string is
  not yet set, it now says so instead.

## [0.24.1] — 2026-10-10

### Fixed

- **`peerDependencies` silently excluded the installed harness.** The range
  `>=0.1.7-rc.1` matches only the `0.1.7` tuple under node-semver's pre-release
  rule, so it rejects `0.2.0-rc.2` — the version this plugin is built and tested
  against — and a consumer would hit `ERESOLVE`. Verified with `semver`:
  `satisfies("0.2.0-rc.2", ">=0.1.7-rc.1")` is **false**, while the corrected
  range `>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1` is **true**. The range now
  carries an explicit pre-release branch on the `0.2.0` tuple.
- The README no longer points at a nonexistent `README.zh-CN.md`; a real
  Chinese README now ships as `README.zh.md`.

### Removed

- The dead `/turn-counts` host route and its helpers. The client stopped calling
  them when the conversation-length sort was removed, leaving an endpoint with
  no consumer.

## [0.24.0] — 2026-10-10

First public release (GitHub + npm).

### Added

- **Favourites** for any conversation, archived or not: a sidebar 「…」 menu row
  plus an inline ☆ star on the row, applied optimistically. Persisted host-side
  to `~/.dsh/data/dsh-archive-favorites-forge/favorites.json`, so the set is
  shared across the desktop shell, a phone view and a remote browser (renderer
  `localStorage` is origin-scoped and would not be).
- **Copy id + path**: one row copying the session id and the transcript's
  absolute path.
- **Per-conversation permanent delete**, behind a confirmation. After a
  successful delete the host emits the harness's own `api-session/removed`
  event, so the sidebar row disappears immediately.
- **Idle batch archive** (超时批量归档): archives every unarchived conversation
  quiet for more than N hours, with one-click undo. The threshold is in hours
  and persists in `localStorage`.
- **Export list**: a tab-separated `.txt` with 对话名称 / 对话ID / 所属工作区 /
  闲置时长 / 最后活动时间, plus **复制路径** and **在文件夹中打开** actions. The
  reveal route is restricted to the plugin's own export folder.
- **Favourites filter** in the official view-options menu: 「仅显示收藏（已归档）」
  and 「仅显示收藏（未归档）」, each delegating the archive axis to the harness's
  own filter row and adding only the favourites axis.
- **Batch delete** of archived-and-unfavourited conversations, with per-id
  reporting, a batch cap, and a dry count shown before acting.
- **Delete guardrails**: favourites refused, resolved paths outside the sessions
  root refused, symlinks refused, the sessions root itself refused.

### Fixed

- Reading `ctx.config` without declaring it threw `cannot get property "config"
  without inject`, which made every delete fail before touching a file.
- The project-directory encoder collapsed separator runs into `C--Users`
  instead of `C-Users`, handing "copy path" a nonexistent file.
- The transcript resolver only tried the bare-uuid directory form, silently
  failing for sessions whose directory carries the `session-` prefix.
- Session ids are spelled both `session-<uuid>` and `<uuid>` in the same store;
  every comparison now normalises both sides.
- The sidebar-hiding rule was not gated on the favourites set having loaded, so
  it could hide the entire conversation list.
- The favourites filter and the archive filter shared one readiness flag, so an
  archive-set failure silently disabled the whole filter. They are now two
  independent gates.
- A row's selection tick is a bare `<svg>` on the selected row only; testing for
  a descendant `svg` never matched, leaving the harness's tick on cloned rows.
- Candidate lists are intersected with what the sidebar actually lists, so an
  archived-but-unrendered session is never counted or acted on.
- Blank sessions (the provisional New Session slot) are excluded from every
  candidate list — they have no content to archive and the sidebar hides all but
  the current one, so a list containing one could not be verified.
- Exported rows now use the sidebar's own wording for untitled conversations
  (`新会话` / `未命名`) rather than a third spelling, and carry the owning
  workspace so an untitled row can still be located.

### Removed

- The conversation-length (turn-count) sort and its `/turn-counts` host route —
  removed on request, and the host route was dead code once the UI was gone.

[0.24.2]: https://github.com/loyalchiiina/dsh-archive-favorites-forge/releases/tag/v0.24.2
[0.24.1]: https://github.com/loyalchiiina/dsh-archive-favorites-forge/releases/tag/v0.24.1
[0.24.0]: https://github.com/loyalchiiina/dsh-archive-favorites-forge/releases/tag/v0.24.0

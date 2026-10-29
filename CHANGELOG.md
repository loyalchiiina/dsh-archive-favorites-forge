# Changelog

All notable changes to this project are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/);
this project uses [Semantic Versioning](https://semver.org/).

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

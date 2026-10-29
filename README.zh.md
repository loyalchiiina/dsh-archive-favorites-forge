# dsh-archive-favorites-forge

**给 DSH 的对话加上收藏、复制 ID+路径、单条删除、超时批量归档、收藏筛选，以及「编辑重发 / 撤销整轮 + 文件自动快照回滚」 —— 全部挂在官方插槽上，不改官方一行代码。**

**Favorites, copy id+path, per-session delete, idle batch archive, a favourites
filter, and edit-resend / undo-turn with automatic file rollback for DeepSeek
Harness — additive slot extensions over the shipped archive feature, editing no
official file.**

[![npm](https://img.shields.io/badge/npm-dsh--archive--favorites--forge-cb3837?logo=npm)](https://www.npmjs.com/package/dsh-archive-favorites-forge)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.0--rc.2-4f46e5)](https://github.com/loyalchiiina/dsh-archive-favorites-forge)

[English](README.md) | 简体中文

---

## 效果图

**① 对话菜单** —— 在官方「…」菜单里新增四行：收藏对话、复制 ID + 路径、新窗口继续对话、带二次确认的删除对话；官方那条重复的「复制 Session ID」被隐藏：

![对话菜单](assets/01-session-menu.png)

**② 收藏筛选** —— 在官方「筛选会话」分组里新增两行，把侧栏收窄到「已归档的收藏」与「未归档的收藏」：

![收藏筛选](assets/02-favourites-filter.png)

**③ 设置页** —— 超时批量归档、带归档状态的收藏清单、以及批量删除归档中未收藏的对话：

![设置页](assets/03-settings-panel.png)

**④ 每条消息下的按钮** —— 复制 → ↺ 撤销 → ✏️ 编辑重发 → 🗑 删除，挂在每一条人类消息下面，**包括回合进行中插话的那些消息**：

![消息按钮](assets/04-turn-actions.png)

---

## 一句话说明

DSH 自带的归档功能只有「归档 / 取消归档 / 筛选已归档」，**没有收藏、没有单条删除、
没有复制 ID 或路径、也没有按时间批量归档**；转录区同样**没有逐条消息的编辑/撤销**，
AI 改过的文件也**没有任何回滚**；长对话聊到上下文爆掉时**没有任何交接手段**；
侧栏那个「未分组」分组**也没有任何解释或修复入口**。
这个插件把这些补上，而且**一个字都不改官方文件**。

## 功能总览

| | 中文 | 位置 |
|---|---|---|
| ① | **收藏对话**：归档或未归档的都能收藏，星标即时生效 | 侧栏行「…」菜单 + 行内 ☆ |
| ② | **复制 ID + 路径**：一键复制会话 ID 与转录文件绝对路径（两行） | 侧栏行「…」菜单 |
| ③ | **单条永久删除**：任意非收藏对话可删，二次确认；删完侧栏**立即移除该行** | 侧栏行「…」菜单 |
| ④ | **超时批量归档**：把闲置超过 N 小时的未归档对话一次性归档，可一键撤回 | 设置 → 归档收藏 |
| ⑤ | **导出清单**：制表符分隔的 txt，含**对话名称 / 对话ID / 所属工作区 / 闲置时长 / 最后活动时间**；可复制路径或直接打开所在文件夹 | 设置 → 归档收藏 |
| ⑥ | **收藏筛选**：「仅显示收藏（已归档）」与「仅显示收藏（未归档）」 | 视图选项 → 筛选会话 |
| ⑦ | **批量删除**：一键永久删除「已归档且未收藏」的对话 | 设置 → 归档收藏 |
| ⑧ | **删除护栏**：收藏项拒删、越出会话根目录拒删、符号链接拒删、逐条报告、批量上限 | 自动生效 |
| ⑨ | **编辑重发**：任意一条用户消息下多一个 ✏️，点开就是内联编辑框（可拖入文件 / 粘贴图片，最多 10 个附件、单个 8MB），发送即截断到该消息之前并重发 | 用户消息下方 ✏️ |
| ⑩ | **撤销整轮**：↺ 把对话回退到该轮之前，并**默认同时还原这一轮里被 AI 改过的文件**（确认框列出将被回滚的路径，可取消勾选只回退对话） | 用户消息下方 ↺ |
| ⑪ | **文件快照**：AI 每次改文件（`write` / `edit` / `str_replace_editor`）前自动留一份内容快照，撤销时按最早的改动记录还原；没有快照的老会话从日志反推 | 自动生效 |
| ⑫ | **未分组体检**：只读诊断侧栏「未分组」里到底有哪几条会话、每条为什么在那儿、该怎么处置；**先试算再执行**，删的一律进回收站 | 设置 → 归档收藏 |
| ⑬ | **未分组硬门**：插件每次启动 8 秒后自检一次，有游离会话就在日志里告警并指路体检卡片；干净则记一行 `clean` | 自动生效 |
| ⑭ | **新窗口继续对话**：把长对话蒸馏成一份交接书（用户要求时间线 + 任务进度清单 + 团队任务 + 最近进展），先弹窗报告「检测到任务进行到 第 N 轮」，确认后新开一个 `新对话-<原名>`、**继承原对话的预设智慧体**并自动把交接书发过去 | 侧栏行「…」菜单 |

## 安装

```powershell
dsh plugin --profile <profile> add dsh-archive-favorites-forge
```

装完**必须完全退出 DSH 再打开**。宿主半边（`lib/index.js`）在**本代 harness 里没有热重载**，
客户端 bundle 也在 DSH 启动时就快照了 —— **所以刷新页面拿不到新版**，必须重启。

## 工作原理

```
lib/index.js   宿主半边 —— 收藏存储、转录路径解析、JSON 路由、带护栏的删除、归档/取消归档、
                          文件快照 + 转录日志解析
lib/client.js  客户端半边 —— 官方插槽注册 + 两条 DOM 规则（收藏筛选、消息按钮）
```

**用到的官方插槽**（全部来自官方客户端契约）：

| 插槽 | 贡献内容 |
|---|---|
| `sidebar.workspaces.session.menu.item` | 4 行：收藏、复制 ID+路径、新窗口继续对话、删除 |
| `sidebar.workspaces.session.row.action` | 1 个行内 ☆ 星标 |
| `settings.section` | 「归档收藏」设置页 |
| `shell.overlay` | 编辑重发 / 撤销共用的那一个确认弹窗 |

**宿主路由**（全部挂在 `/plugins/dsh-archive-favorites-forge` 下）：

| 路由 | 作用 |
|---|---|
| `GET /status` | 版本号与状态文件路径，用于诊断 |
| `GET /favorites`、`POST /favorite` | 收藏集合 |
| `GET /archived`、`POST /unarchive` | 归档集合，以及撤回一次归档 |
| `GET\|POST /idle-archive` | 超时批量归档的预览与实际执行 |
| `POST /export-list` | 写出制表符清单 |
| `POST /reveal` | 在文件管理器里打开某个路径 |
| `POST /session-info` | 单个会话的标题 / 工作区 / 转录路径 |
| `POST /delete` | 带护栏的永久删除（批量） |
| `POST /session-turn-info` | 某一轮的用户原文、该轮改过的文件清单、以及 fork 边界 |
| `POST /session-files-restore` | 回滚某个序号之后被改过的文件 |
| `POST /session-replace` | fork 接替之后，退掉原会话 |
| `POST /session-digest` | 只读：把一段长对话蒸馏成「要求时间线 + 任务进度」交接书，供新窗口继续 |
| `POST /ungrouped-diagnose` | 只读体检：谁会掉进「未分组」、为什么、该怎么处置 |
| `POST /ungrouped-cleanup` | 一键清理；**无 `confirm: true` 时强制干跑**，执行前会重新体检一次 |
| `POST /ungrouped-explain` | 「为什么会有未分组、是不是删对话造成的」的文字说明 |

所有贡献都通过 `ctx.slots.inject` 注册 —— 也就是「等宿主条目挂载后再注册」的官方契约。
所以插件**从不假设侧栏已经起来**，也**从不持有宿主节点的引用**。

有两条 DOM 规则，都是刻意的例外：

- **收藏筛选**：官方那个「视图选项」菜单是**写死的数组，既没有插槽也没有触发器 id**，
  所以这一个控件只能走 DOM —— 做法是**找到官方那条筛选行并克隆它**。
- **消息按钮**：转录区同样**没有**逐条消息的动作插槽，所以 ↺ ✏️ 🗑 是**追加在官方复制按钮之后**的。
  锚点用每条消息上唯一的 `[data-clock="start"]`，归属取它的
  `[data-chat-flow-kind="user"][data-chat-turn]` **或** `[data-chat-flow-kind="steering"][data-chat-turn]`
  祖先 —— 官方把「一个回合开头的提问」标成 `user`，把「回合进行中插话」标成 `steering`，
  两者共用同一个 `UserMessageNodeView`、DOM 结构完全一样，只认 `user` 会让所有插话消息行
  永远没有按钮（0.28.2 修复）。**绝不依赖 CSS 模块哈希**（那些类名每次构建都会重新哈希）。
  配一个 `MutationObserver` 重扫，所以后流式进来的消息也会补上按钮。

### 为什么收藏存在文件里，不用 localStorage

渲染进程的 `localStorage` 是**按 origin 隔离**的：桌面端、手机端、远程浏览器是三个不同 origin，
各自只会看到自己的星标。所以宿主半边把它们持久化到：

```
~/.dsh/data/dsh-archive-favorites-forge/favorites.json
```

这样**换 profile、重装、两端之间都共享同一份收藏**。

### 为什么删除放在宿主端并带护栏

本代 harness **没有官方的会话删除 RPC** —— 官方 UI 从来不删会话。
所以「删除这条对话」在这里的物理含义是：**删掉该会话自己那个产物目录**（`~/.dsh/sessions/` 下）。
这个操作不可逆，因此宿主端在动手前逐项拦：

1. **收藏的 id 直接拒删**（在宿主端判定，不只是 UI 不显示）；
2. 解析出来的路径**越出 sessions 根目录**的拒删；
3. **符号链接**拒删；
4. **sessions 根目录本身**拒删；
5. 单次批量受 `maxDeletePerCall` 上限约束。

每个 id 单独回报结果，所以**一条失败不会中断整批**。
删除成功后宿主会发出 **harness 自己的 `api-session/removed` 事件**，
所以侧栏那一行会**立刻消失**，而不是挂到下次刷新。

### 为什么「编辑重发 / 撤销」是「先 fork，再退掉原会话」

本代 harness 同样**没有「原地截断这条对话」的 RPC**。官方唯一能保留前缀的通道是
`sessions.fork({ sessionId, atSeq })` —— 它会产出一个**新**的子会话，装下 `atSeq` 之前的内容。

所以两个按钮走的是同一套三步：

1. **fork** 到边界处（首轮没有前缀可保留，改用 `sessions.create` 在同一工作区开新会话）；
2. **可选地回滚文件** —— `POST /session-files-restore` 还原该边界之后 AI 碰过的每个文件；
3. **退掉原会话** —— `POST /session-replace`，因为原会话此刻已被它自己的 fork 取代，
   留着会让侧栏每一行都翻倍。

第 3 步是**唯一**允许删掉「已收藏」对话的地方，也正是 `handleDelete` 新增显式 `replace`
参数、而不是让客户端直接调 `/delete` 的原因：收藏的语义是「这条对话要留着」，
而这里被退掉的恰恰是**已经被自己的 fork 取代的那一条**。**只有收藏守卫被跳过**，
其余守卫（必须在 sessions 根内、不能是根本身、非符号链接、必须是目录、EBUSY/EPERM 重试）
**全部照旧** —— fork 产出的就是一个普通会话目录，上面这些条件没有一条因此变安全。
这个标志是**独立路由上的显式参数**，所以 `/delete` 的请求体永远无法把它关掉。

`beforeSeq`（fork 边界）取的是该轮 `turn/start` **前一个事件**的序号，而不是 `turn/start` 自己。
若切在 `turn/start` 与首条用户消息之间，子会话里会留下一个没闭合的 `turn/start`，
而 fork 会补一条「已完成的轮次」把它闭合 —— 那就是一个幽灵空轮。

### 为什么文件快照按内容寻址

每次 `write` / `edit` / `str_replace_editor` 调用**之前**，宿主会把文件当前字节拷到

```
~/.dsh/sessions/<工作区目录>/<会话目录>/history-file/blobs/<sha256>
```

并往 `history-file/manifest.jsonl` 追加一行：

```json
{"seq": 412, "turn": 7, "time": "...", "tool": "edit", "path": "C:\\...", "blob": "<sha256>"}
```

`blob: null` 表示那一刻文件**还不存在**，所以「还原」它等于**删掉**它。
按内容哈希存的好处是：同一轮里改了五次的文件只占一份；而回滚会消费掉它用到的 manifest 条目
（以及因此变成孤儿的 blob），所以回滚过的对话不会越滚越大。

快照写在**工具执行之前**，所以对一个全新文件的第一次 `write` 记下的是「原本不存在」，
而不是写完之后的内容。

### 为什么还要一条「从日志反推」的兜底

本插件装上之前的对话没有 manifest。对这些会话，宿主重读转录
（`session[.vN].jsonl.zstd`，多帧 zstd，丢掉 header 行）并按相反顺序对每条工具调用求逆：
`edit` 把 `new_string` 换回 `old_string`；`str_replace_editor create` 删掉文件；
`str_replace` 把 `new_str` 换回 `old_str`；`insert` 移除 `new_str`。

`write` 是**无法求逆**的 —— 整文件覆盖不会留下任何痕迹 ——
所以「只被 `write` 改过」的会话拿到的是一条**点名文件的告警**，而不是静默失败。
这条告警会显示在确认框里，这也是文件清单必须在弹窗**之前**就取回来的原因。

### 为什么「未分组」不是删对话造成的

官方侧栏的 `sessionVisible()` 是**四步串行**判定：

```js
if (session.origin === "subagent") return false           // ① 子代理排除
if (session.blank && session.id !== current) return false  // ② 非当前空白排除
case "default": return !archived.has(session.id)           // ③ 已归档排除
// ④ 才轮到「有没有 workspace 记账」
```

第③步一旦命中就直接返回 `false`，**根本走不到**后面的 `stray` 分支。
所以「删掉对话 → 归档 id 残留 → 冒出未分组」这条链在代码上不存在。
实测反证：本机 `archivedSessionIds` 里有 **98 条 id 指向已经不存在的会话目录**，
侧栏却一直干净。

真正的成因只有一个：**会话被创建了，但没有被任何 workspace 记账**。
`WorkspaceRegistry.create()` 的收尾如果漏了 `attachSession`，或者会话的 `cwd`
指向一个从未登记为 workspace 的目录，它就会永久游离。插件管不到官方 create 路径，
所以做法是「开机响一次」+「一键可修」，而不是偷偷自动删。

### 为什么「新窗口继续对话」是先读后建

长对话的痛点是**每一轮都要重发整段历史**：聊到几百万 token 之后，继续聊又慢又贵，
甚至直接把窗口拖死。正确的解法不是「想办法塞更多上下文」，而是**换一个窗口，
但把工作交接过去**。

交接书里只保留两类东西 —— **用户要求的时间线**和**任务完成的进度线** —— 因为这两样
一旦丢了，新会话就会重复劳动或者做错方向。工具调用的参数、工具返回的结果、
reasoning 思考块、step/turn 记账、job 帧，占了长日志的绝大部分，而对「继续干活」
毫无价值，所以全部丢掉。

两个刻意的设计：

- **读和写严格分离**。生成交接书是纯只读（`POST /session-digest`），
  新建会话只发生在用户点「开始新对话」之后。否则一个只想看看进度的人，
  会莫名其妙多出一个空对话。
- **时间线超长时挖中间，不砍尾巴**。保留最早 8 条 + 最近 24 条，并在交接书里写明
  「已省略中间 N 条」。只留最近几条会丢掉最初的立项要求 —— 而立项要求恰恰是最不能丢的。

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 宿主路由总开关 |
| `maxDeletePerCall` | `500` | 单次删除请求的硬上限 |
| `ungroupedCheck` | `true` | 开机未分组自检总开关；`false` 关掉告警（体检卡片仍可用） |
| `ungroupedCheckDelayMs` | `8000` | 启动后多久跑一次未分组自检（毫秒） |

```yaml
- id: dsh-archive-favorites-forge
  config:
    maxDeletePerCall: 200
```

## 注意事项与边界

- **会话 id 有两种拼写**：`session-<uuid>`，但**磁盘上的产物目录两种都有**
  （老机器升级后 `<uuid>` 与 `session-<uuid>` 并存）。插件所有比较都经过归一化，
  路径解析也两种都试，所以新老对话都能正确复制出路径。
- **已归档的对话打不开** —— 这是 DSH 官方行为，不是本插件造成的。想读就先取消归档。
- **删除是永久的**，会连同转录一起删掉。**不会碰你的项目工作目录。**
- **空白会话永不作为候选。** 「空白」= 从没发过消息的「新会话」占位槽。
  它没有内容可归档，而且官方侧栏**只显示当前那一个空白会话、其余全部隐藏** ——
  所以候选清单里出现它的话，你**根本无法在界面上核对**。
  插件已把空白会话从超时归档候选和批量删除集合里**都排除**，
  导出时其余对话的命名也**与侧栏用词一致**（`新会话` / `未命名`）。
- **候选清单会与「侧栏真正列出的会话」求交集**：已归档但侧栏不渲染（没有 `cwd`）的会话，
  **既不会被统计，也不会被操作**。
- 插件会读 Workspace 注册表来判断会话归属哪个文件夹，但**归档/取消归档只走注册表自己的
  `archiveSession` / `unarchiveSession` 方法**，绝不手写状态文件，也绝不改其他插件的内部实现。
- **`新对话-<原名>` 在原标题很长时会丢末尾几个字** —— 这是 DSH 上游的硬上限，不是本插件加的：
  `session-title` 服务配置了 `maxTitleBytes: 80`（见 `@deepseek-ai/dsh-base/cordis.patch.yml`），
  `rename()` 会按 **UTF-8 字节**把标题截到 80 字节（中文一字 3 字节，且不会切半个字符）。
  例如原标题 `DeepSeek 智能体团队任务：蒸馏消息回滚与侧边栏未分组排查` 是 78 字节，
  加上前缀 `新对话-`（10 字节）后 88 字节，被截成 33 字 / 79 字节。
  全库 574 个会话标题最大恰好 79 字节，说明 80 就是全局天花板。
  插件原样透传标题、不自造长度限制；想放宽只能改 profile 里的
  `session-title.config.maxTitleBytes`（会影响全库所有标题，且需重启）。

### 文件快照的边界（信它之前先读这段）

- **只跟踪三个工具**：`write`、`edit`、`str_replace_editor`。其余任何动文件的方式 ——
  终端/命令行命令、助手跑过的 Python 脚本、格式化工具、`git checkout` ——
  **既没有快照也没有日志记录**，撤销看不到它们。若某一轮只通过终端改了文件，
  撤销只会回退对话，文件保持原样。
- **只记录绝对路径**。工具参数里的相对路径会被跳过：单凭转录无法得知正确的基准目录，
  猜错就会快照/还原到错误的文件上。
- **单文件超过 8MB 会被跳过**（一个版本一份 blob，这个上限防止一整轮把磁盘写满）。
  跳过会写日志；撤销不会还原那个文件。
- **回滚会覆盖当前内容**。它还原的是该轮开始前的字节，所以此后你手改过同一个文件的话，
  那些手改会丢。这正是「撤销」的语义，但勾选前值得知道。
- **编辑框只预填消息正文**，原消息上的附件**不会**带过来 —— 需要就重新挂。
  这是刻意为之：附件句柄是按会话隔离的，把它复制进新会话会得到一个悬空引用。
- **撤销会删掉原会话**。回退实现是「fork + 退掉原会话」，所以撤销前的那条对话**不会**
  作为隐藏分支留下来。里面有想保留的东西，先复制出来。
- **空白会话不受影响**：它没有轮次，也没有工具调用。

### 未分组体检的边界

- **它只治标不治本**：官方 create 路径漏登记会话这件事，插件拦不住。体检能做的是
  「告诉你哪几条游离、为什么、一键处置」+「每次开机响一次」。
- **删的一律进回收站**（`Microsoft.VisualBasic.FileIO.FileSystem.DeleteDirectory(..., 'SendToRecycleBin')`）；
  回收站调用失败时降级为移动到 `<dshHome>/sessions_quarantine_<stamp>/` 隔离区，
  **绝不硬删**。隔离区要你自己清理。
- **当前正在用的会话永不自动处置**，只标「需人工判断」。
- **单次最多处置 50 条**（`maxItems`），超出记 `budget-exhausted`，再点一次即可。
- **真跑前宿主会重新体检一次**：页面上看到的是几秒前的快照，期间可能有会话被登记回去，
  所以实际执行的是「此刻仍然游离」的那部分，而不是客户端提交的清单。
- **体检很便宜**：只解每个会话日志的**第一帧**取 header（四步排除只用得到 header），
  只有真正落进未分组桶的那几条才解全文取标题。本机 653 个会话目录、746 MB 日志实测
  **0.43 s**（第一版逐帧全解是 12.6 s，会卡住主线程十几秒）。

## 开发

```
lib/index.js                 宿主半边
lib/ungrouped-guard.js       未分组体检/清理的自包含模块（可单独 import）
lib/client.js                客户端半边（__ModuleLoader__ bundle）
test/probe-client.mjs        客户端契约的 DOM stub 探针
test/probe-filehistory.mjs   文件快照/回滚字节的端到端探针
test/probe-ungrouped-guard.mjs 未分组体检/清理的隔离探针（假 home，9 条夹具 + 性能契约）
test/probe-digest.mjs        交接书蒸馏的隔离探针（假 home，18 条事件 + 60 条要求的长对话）
```

四个都跑：

```sh
node test/probe-client.mjs
node test/probe-filehistory.mjs
node test/probe-ungrouped-guard.mjs
node test/probe-digest.mjs
```

它们回答的是**两个不同的问题**，谁也替代不了谁。`probe-client.mjs` 拿真实 bundle 跑在 stub 出来的
DOM 上，证明**客户端契约**（注册了哪些插槽、每个组件渲染出什么、侧栏增强器不会把侧栏吃掉）。
`probe-filehistory.mjs` 造一个一次性的假 DSH home（**多帧 zstd** 会话日志 + 磁盘上真实的文件），
去证明契约测试根本证不了的那一条：**撤销一轮之后，之前的字节是不是真的回来了**。它会复现真实时序
（`tool/call` 事件在工具执行**之前**发出，所以快照必须存到改动前的字节），也会跑到 fork 出来的子会话
所用的「从日志反推」兜底路径 —— 这类会话是重放父会话事件继承来的，从未发过 `session/event`，
因此一条快照都没有。

两个套件都只写本仓库内的 `.probe-*` 目录，跑完自行删除。

`probe-ungrouped-guard.mjs` 把 `DSH_HOME` / `DSH_AFF_SESSIONS_ROOT` / `DSH_AFF_WORKSPACE_FILE` /
`DSH_SESSION_ID` 全指到假 home，造 9 条多帧 zstd 会话覆盖四步判定的每一步 + 五类建议 +
两条守卫 + 预算上限。它证明的是「**干跑真的不写盘**」：默认 `dryRun` 下 registry 零调用、
`emit` 零次、9 个目录全在、`workspace.json` 逐字节相同。

`probe-digest.mjs` 造一份「像真对话一样」的日志（reasoning、`tool/call`、`tool/result`、
**steering 注入**、两次 `todo/write`、同一 `team/task` 的两个 revision），证明交接书的两条核心承诺：
**每条真人要求都在时间线上**、**最新的任务进度快照胜出并被点名「从这里接着做」**；
同时证明该丢的确实丢了（reasoning / 工具参数 / 工具结果都不出现在正文里），
以及「steering 注入不算用户要求」「60 条要求的长对话挖中间而不是砍尾巴」。
它还断言客户端「先读后建」的顺序 —— `sessions.create` 只出现在 `onConfirm` 内部。

这套探针**不是走过场** —— 它反复抓出了「语法检查通过、人工读码也通过」的真 bug，包括：

- 项目目录名编码器把分隔符折叠成 `C--Users`（正确是 `C-Users`），
  **会让每一次「复制路径」都指向一个不存在的文件**；
- 路径解析只试了裸 uuid 目录形式，对**目录带 `session-` 前缀的那些会话静默失败**；
- 隐藏规则**没有**等收藏集合加载完成就生效，**可以把整个侧栏清空**；
- 归档集合读取失败会**连带整个收藏筛选静默失效**，因为两个本该独立的闸门共用了同一个标志位。

它**对着机器上真实的目录和真实的注册表**断言，同时 DOM fixture **逐项照抄官方结构**
（包括「选中标记是选中行上那个裸 `<svg>`」这一条）—— 上面每个 bug 都是这么暴露出来的。

## 许可

MIT。

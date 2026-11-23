# 贡献与来源说明 / Credits & Provenance

本仓库默认著作权归 loyalchiiina（见 `LICENSE`）。本文件把**非原创**的代码与设计逐段标注来源，
并写清「原来是怎么实现的」，让读者能追溯每一部分是谁写的，而不是把它们混进「作者自研」。

---

## 0. 原创边界（先划清）

| 能力 | 归属 | 时间线证据 |
|---|---|---|
| ① 侧栏永久删除 / 批量删除 | **loyalchiiina 原创，早于并入 MX** | `CHANGELOG.md:2130` 0.24.4（2026-10-19）`package.json` 已写 `per-session delete`；`:2139` 批量删除上限 `maxDeletePerCall=500`；`:2141` 六道删除护栏（收藏拒删 / 路径越界 / sessions 根 / 符号链接 / 非目录 / 单批上限）。`CHANGELOG.md:2016`（0.25.0）明写「第①项与本插件已有的 `aff-delete` 重复，因此**没有移植**」。 |
| ② 用户消息「编辑重发 / 撤销整轮」 | **来自 MX**（0.25.0 并入），0.39.0 起由 loyalchiiina 全面重写 | 全仓库首次出现即 `CHANGELOG.md:2015`、`:2024`、`:2025`（0.25.0，2026-10-29） |
| ③ AI 改文件「自动快照 + 回滚」 | **首版来自 MX**（0.25.0 并入），此后 loyalchiiina 大幅扩展 | 首次出现即 `CHANGELOG.md:2031–2048`（0.25.0）；0.25.0 之后有 32 个版本动过快照相关代码 |
| 归档 / 收藏 / 批量归档 / 未分组体检 / 新窗口交接书 | loyalchiiina 原创 | 与 MX 无关 |

---

## 1. MX —— 「编辑重发 / 撤销」与「文件快照」的初版实现

- **贡献者**：MX（GitHub: [@MX2546140156](https://github.com/MX2546140156)）
- **载体**：独立插件 `dsh-session-manager` v1.0.0（**未公开发布**，作者直接提供源码包；
  该 GitHub 账号下无对应公开仓库，与「作者没有上传 GitHub」一致）
- **并入时间**：0.25.0（2026-10-29），见 `CHANGELOG.md:2010`
- **范围**：**仅第 ②③ 项**。原插件的第 ① 项（侧栏永久删除）本仓库早已自研，未采纳。

### 1.1 他是怎么实现的（原设计）

**② 消息级按钮：不注册插槽，直接往 DOM 里注入**

1. 每条消息行上有唯一的 `[data-clock="start"]`（官方时间元素），用它做锚点；
2. 归属判定取该锚点的 `[data-chat-flow-kind="user"]` 祖先，只给用户消息挂按钮；
3. 挂在官方「复制」按钮**之前**，顺序为 `[↺ 撤销][✏️ 编辑][🗑 删除]`；
4. 官方操作行平时 hover 才显形，注入的按钮需要常驻，所以用一段命名空间 CSS 覆盖显隐规则；
5. React 重渲染会抹掉注入节点，所以配 `MutationObserver` 监听列表变化并**重扫补挂**，
   流式新增的消息也能补上按钮（不依赖任何 CSS 模块哈希，只认官方 `data-*` 锚点）。

**② 编辑重发 / 撤销：先问宿主「这一轮从哪开始」，再决定怎么退回去**

- 点按钮 → `POST /api/session-turn-info {sessionId, turn}`：
  返回该轮用户原文、该轮改过的文件清单、以及 fork 边界 `beforeSeq`（取 `turn/start` 之前一个事件）；
- 编辑 → 消息节点原地换成内联编辑框（原文预填、可拖文件、可粘贴图片、最多 10 个附件）；
- 撤销 → 先 `POST /api/session-files-restore {sessionId, keepSeq}` 把文件还原，
  再把原文用 `setDraft()` 预填进底部输入框，交给应用自己的发送键；
- 提交 → 回滚文件 → `pluginCtx.sessions.fork({sessionId, atSeq: beforeSeq})` 开一个**截断的子会话**
  → 在子会话里 `prompt()` 重发 → 删掉原会话（`POST /api/session-replace`）。
  **这是 fork 方案：每次撤销都在制造一条全新对话**（新 sessionId、新工具清单顺序）。

**③ 文件快照：在工具执行之前，把「改前字节」抢存下来**

1. 监听宿主 `session/event` 的 `tool/call`——它在工具**执行之前**发出，这是整套机制的关键；
2. 对 `write` / `edit` / `str_replace_editor` 解析出目标路径；
3. 读目标文件当前字节，按 **sha256 内容寻址**存进 `<会话目录>/history-file/blobs/<sha256>`
   （同内容只存一份），再往 `manifest.jsonl` 追加一行 `{seq, turn, time, tool, path, blob}`；
4. `blob: null` 表示当时文件**不存在** → 「还原」等于删掉它；
5. 回滚时取每个 path 上 `seq > keepSeq` 的**最早一条**记录还原，然后消费掉用过的 manifest 条目
   与因此变孤儿的 blob（回滚过的会话不会越滚越大）；
6. 对没有快照的老会话走**日志反推**兜底：`edit` 换回 `old_string`、`str_replace_editor create` 删文件、
   `str_replace` 换回 `old_str`、`insert` 移除 `new_str`；`write` 无法反推 → 输出点名文件的告警。

### 1.2 采纳清单（逐项 → 当前落点）

| # | 采纳内容 | 当前落点（本仓库） | 结构相似度 | 状态 |
|---|---|---|---|---|
| 1 | 用户消息后追加「撤销 / 编辑 / 删除」三按钮；`[data-clock="start"]` 锚点；`MutationObserver` 重扫补挂 | `lib/client.js` `injectTurnActions()` L8216–8905 | 77.4% | 保留（0.28.2 起扩充到 `steering` 插话行） |
| 2 | 三按钮语义：撤销=连文件回滚、编辑=回滚后重发、删除=只退对话不动文件 | `lib/client.js` `doUndoTurn` L8388 / `doDeleteMessage` L8407 / `submitEdit` L8700 | — | 保留 |
| 3 | 内联编辑器六函数：`teardownEdit` / `readFileBase64` / `addEditorFiles` / `enterEdit` / `openEditor` / `submitEdit` | `lib/client.js` L8469 / 8480 / 8491 / 8524 / 8554 / 8700 | — | 保留并重写 |
| 4 | 删除确认弹窗 `SessionDeleteDialog` | `lib/client.js` `SessionDeleteDialog()` L8055–8190 | 78.9% | 保留（承载本仓库自己的删除逻辑） |
| 5 | 宿主路由「某轮用户原文 + 该轮改过的文件 + 截断边界」 | `lib/index.js` `POST /session-turn-info` L4580（`turnInfo()` L2481） | 88.9% | 保留 |
| 6 | 宿主路由「按 keepSeq 回滚文件」 | `lib/index.js` `POST /session-files-restore` L4605（`restoreFilesBefore()` L2364） | 61.9% | 保留 |
| 7 | 文件快照：内容寻址 blob + `manifest.jsonl` 记账 + 回滚消费已用版本 | `lib/index.js` `fileHistoryDir()` L1901 / `recordToolCall()` L2043 | 59.8% | 保留，后被重写扩展 |
| 8 | 无快照老会话「从日志反推」兜底 | `lib/index.js` `reverseApplyFromLog()` L2289 / `collectLogChanges()` L2242 / `affectedFiles()` L2447 | 83.3% / 88.0% / 45.7% | 保留并扩展 |

> 相似度 = 两边函数体去空行/去注释后按行序列的同比例（`difflib.SequenceMatcher`）。

### 1.3 已被重写、不再是 MX 原设计的部分

| 原设计（v1.0.0） | 处置 |
|---|---|
| 撤回 = `sessions.fork({sessionId, atSeq})` 开子会话（`openTruncatedChild`）+ `promptChild` 重发 + `clearInheritedQueue` + 删原会话 + `POST /api/session-replace` | **0.39.0 整体删除**（`CHANGELOG.md:528-536`），改为同会话遮蔽尾部：`rewindSession()`（`lib/index.js:2580`）+ `POST /session-rewind`（`lib/index.js:4649`） |
| `doUndoTurn` / `doDeleteMessage` / `submitEdit` 内部走 fork 三步 | 改为直接 `postJson('/session-rewind', {sessionId, beforeSeq})` |

> 结论：**只有「按钮长什么样、挂在哪、点了弹什么」这套交互骨架来自 MX；
> 「怎么真的把会话退回去」是本仓库 0.39 自己重写的**（动机：fork 会让整段前缀缓存作废，
> 实测命中率 99.4%→2.5%、首包 5.7s→14.5s，见 `CHANGELOG.md:526`）。

### 1.4 未采纳 MX 的部分

- MX 的 `POST /api/session-delete` 六步删除逻辑（本仓库用自己早有的、守卫更全的 `handleDelete`）
- MX 的删除行内按钮 / 删除菜单项（避免出现第二个删除入口）

---

## 2. 在 MX 首版之上，loyalchiiina 自己的改动（时间线）

### 2.1「编辑重发 / 撤销」——共 9 个版本迭代

- **0.28.1**：发送前把字符串包成单个 text block（数组入参原样保留）
- **0.28.2**：`steering` 插话行也挂按钮（此前只认 `user`，用户实测「按钮不见了」）
- **0.39.0**：撤回语义整体重写为同会话遮蔽尾部，删除 fork 三步（**最核心的改写**）
- **0.39.1 / 0.39.2 / 0.39.3**：拒绝原因细分、回退提示、undo marker 写成 `user/message`（`isRewindMarker` 认 `rewind-` 前缀）
- **0.42.0**：撤销/删除的永久删除预警按卡片换名词等

### 2.2「文件快照」——0.25.0 之后 32 个版本迭代（关键节点）

- **0.29.0–0.33.0**：快照占用统计、手动删除、保留期与配额（社区 issue #2，`CHANGELOG.md:1360`）
- **0.34.0 / 0.34.1**：侧栏右键「归档」也连带删快照（两条路径共用开关）
- **0.35.0 / 0.35.1**：删除对话时连带清 `history-file/`、`manifest.jsonl`（`test/probe-delete-ledger.mjs` 钉死）
- **0.40.0**：默认走回收站，永久删除（跳过回收站）另设入口
- **0.42.0**：永久删除改为三条件全显式（`permanent:true` + `confirm:true` + `dryRun:false`）
- **0.43.x / 1.0.0**：快照三档口径、大小分档筛选等

---

## 3. 社区 issue 贡献

| issue | 作者 | 内容 | 落地 |
|---|---|---|---|
| #1 | @ripley-xl | 插件注入的行在会话菜单里没有 hover 高亮 | `CHANGELOG.md:1431` |
| #2 | @ripley-xl | 文件快照没有存储管理（无配额 / 保留期 / 用量展示） | `CHANGELOG.md:1360` |
| #3 | @cyt7732 | 「复制 ID + 路径」拆开 | `lib/client.js` `copyId()` L580 / `copyPath()` L586 |

---

## 4. 如何引用

如你在衍生作品中复用上述「消息级撤销 / 编辑」交互或快照机制，请同时保留对 MX
（`dsh-session-manager` v1.0.0）的署名与本仓库的 MIT 许可声明。
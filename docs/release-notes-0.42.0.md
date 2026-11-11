# dsh-archive-favorites-forge 0.42.0 — 2026-11-11

0.42.0 是一个「补齐仪表盘、补上时钟、收口侧栏」的版本：归档时删快照其实一直都在跑，本版让日志不再谎报 `bytes=0`；后台定时清理第一次让这个插件有了自己的时钟（**默认关闭，必须显式开启**）；批量删除从「一帧进度都没有」变成流式 NDJSON 进度；侧栏筛选从「两个 ✓ 同时亮」改成一组 5 个互斥单选。

**本版没有破坏性变更。** 升级后如果你不主动开启后台清理，行为与 0.39.x 完全一致。

## 亮点

1. **后台定时清理（新功能，默认关闭）**：插件过去只有一个触发源 —— 归档事件；用户不再打开设置页，快照就会一直涨。本版补上真正的定时器：`background.enabled` **默认 false，且只认字面 `true`**（`"true"` / `1` 一律不算），必须在设置页显式开启才生效。开启后启动 90 秒首跑、之后每 60 秒 tick 一次，改配置不需要重启（每次 tick 重新读策略）。参数：`scheduleMinutes` 15–1440（默认 60）、`hours` 1–24（不填则继承快照策略的 1 小时）、`maxItems` 1–500（默认 50）。安全边界写死在代码里：**收藏永不清**、**只删 `history-file/` 目录**（会话本体与 `messages.json` / `meta.json` 一个字节都不动）、量不出 `idleMs` 的会话永不删、单轮有 `maxItems` 上限、**默认**走 Windows 回收站（永久删除 / 跳过回收站：宿主 API 与界面**均已支持**，入口在快照清理卡的二次确认块内 —— 次级勾选项「⚠ 永久删除（不进回收站，无法恢复）」**默认未勾选**、两段式确认、勾选本身不发请求；不勾选时现状仍是全部走回收站）、上一轮没结束就跳过这一轮。关着时不存在任何定时器。
2. **删除进度的流式上报（新）**：以前点删除界面直接卡住，进度条一帧都不动 —— 根因是每个会话目录都要冷启动一次 `powershell.exe` 调回收站 API（约 255 ms/次、占单目录成本约 40%）且完全串行，路由要等整批结束才响应。现在 `POST /snapshot-cleanup` 支持 `stream: true` → `application/x-ndjson`，**扫描开始前先发 `start`**，所以首帧 0~1 ms；20 个目录从 12571 ms 降到 1720 ms（约 7.3×），并发 `workers` 默认 2。客户端进度条 `role=progressbar`，收不到 `done` 会退化成 400 ms 轮询。**关窗继续**：关掉设置页或切走 tab 不会中断删除，任务在宿主侧继续跑完；`jobId` 存在 localStorage，**10 分钟内重新打开能续看进度**。**90 秒的真实语义**：客户端监视的不是「一刀切 90 秒就失败」，而是「**90 秒没有任何新进展**才暂停监视」；暂停时只提示「后台可能仍在删除，10 分钟内重新打开可续看」，**不判失败、不清 `jobId`、不把任务当错误**；另设 **8 分钟总兜底**。
3. **侧栏筛选改成 5 个互斥单选（新交互）**：过去「仅显示已归档 ✓」和「仅显示收藏（已归档）✓」能同时亮 —— 语义自相矛盾，还要勾两个才生效。现在是一组互斥选项，任意时刻只有一个 ✓，**点一下立刻生效**：`隐藏已归档`（默认）/ `全部对话（含已归档）` / `仅显示已归档` / `仅显示收藏（已归档）` / `仅显示收藏（未归档）`。
4. **收藏清单：默认「最近收藏」倒序，可筛选可排序**：以前清单按扫描顺序排，刚收藏的排在最后。现在默认 `{ key: 'saved', dir: 'desc' }`，最新收藏排最前；排序键覆盖最近收藏 / 最近更新 / 文件大小 / 时长 / 文件数量 / 对话名称，方向可切，**空值恒沉底**（不管升序降序都不浮到第一屏）；另有关键词（对话名 / 工作区 / cwd，忽略大小写）、大小区间、时长区间、只看有快照的筛选，计数显示「共 N 条 / 筛出 X / N 条」。
5. **两个小入口：GitHub Star 与隐藏定时任务**：① **GitHub Star 入口（新）** —— 设置页「快照清理」标题行右端（统计按钮左侧）、「归档助手」页头右侧（刷新按钮左侧）各一个小尺寸星标；地址取自 `package.json` 的 `repository.url`（回退 `homepage`），**不硬编码**，点击经宿主 `shell.openExternal` 打开，白名单只放行 `https:` + 精确 `github.com` / `www.github.com`。② **隐藏定时任务（新开关，默认开）** —— **只要某个会话与定时任务有关（为任务预留、是任务的投递目标、或被任务触及），该会话就隐藏**；判定与时间无关 —— **未到点、刚到点、早已到点都一样隐藏，不会弹回来**，也不会因为某个定时器触发而自己出现在侧栏里。它是**独立开关，不与上面那 5 个互斥项混在一起**（那 5 个是「筛选」，这个是「藏起来看不着」）；**只对未归档会话生效**（归档过的会话走另一套过滤）。想看的时候把开关关掉，被隐藏的会话即刻全部恢复显示，无需刷新。

## 修复

- **归档删快照的「统计缺陷」**：症状是宿主日志里 `sidebar archive purge — sessions=1 deleted=1 bytes=0 problems=0`，看着像一个字节都没删。实际删除链路（侧栏归档 → `domain/changed` → `handleWorkspaceArchiveChange` → `purgeSnapshotFor` → `cleanupSnapshotUsage({ dryRun: false })` → 回收站）**一直生效**，问题在 `lib/snapshot-usage.js` 的一行兜底：`Number.isFinite(Number(entry?.bytes)) ? Number(entry.bytes) : 0`，而归档这条路径的调用方只传了 `{ sessionId, dir }`，`bytes` 根本没传，于是每条都落进 `: 0`。现在 `purgeSnapshotFor` 删之前先 `measureLedger(dir)` 量一次，把 `files / bytes / toRecycleBin` 一起返回并逐条打印，形如 `sidebar archive purge — session=<id> files=3 bytes=8394 toRecycleBin=true`。
- **修掉一个真 bug（表现为「功能时好时坏」）**：原来的单布尔节流器会让多个观察者互相吞活，导致同一功能有时生效、有时不生效；本版随性能收敛一并修正（详见「内部改进」）。
- **收藏星标改为黑白**：去掉金色，已收藏 = 实心（取当前前景色）、未收藏 = 空心描边；同时修正与相邻官方按钮的间距（9px → 5px，与官方一致），不再因为自己多插一个按钮而破坏对齐。
- **npm 发布包瘦身**：仓库根曾留下 4 个 `README*.bak-*` 备份，因 npm 的 `README*` always-include 规则被打进包（合计 218,406 B）；本版已把它们移出仓库根，发布包不再包含这些备份。

## 内部改进（无用户可见变化）

- **启动扫描 `diagnoseUngrouped`**：967.8 ms 降到 warm 23.4 ms，靠新增缓存 `ungrouped-cache.json`（可随时删，删了自动重建，不影响正确性）。
- **三个 `MutationObserver` 收敛为 60 ms 单飞 + 廉价早退**：同一批 50 条 DOM 变动从 50 次扫描降到 1 次。
- **同步读盘热点 `metaFromCache` 加 mtime 记忆化**：取标题段 44.6 ms → 0.2 ms。
- 以上三项均为内部实现调整，**不改变任何用户可见行为**（唯一的例外是上面「修复」里那条被一并修掉的节流器真 bug）。

## 升级提示

- **宿主端改动需要重启客户端**：本版改动了 `lib\index.js`、`lib\snapshot-usage.js`、`lib\ungrouped-guard.js`、`lib\ungrouped-cache.js`（以及 `package.json` / `cordis.patch.yml`）。宿主是 Node 进程、没有热重载，所以必须**彻底退出 DSH 客户端再启动**（不是只关窗口、也不是只刷新页面），否则后台清理路由、统计字段与新的缓存逻辑不会生效。
- **客户端改动通常会自动生效**：本版改动了 `lib\client.js`（侧栏互斥单选、进度条、Star 按钮、星标样式、收藏清单排序/筛选 UI）。宿主会轮询客户端 bundle 并热替换，所以**通常不用手动操作就会生效**；不确定是否已生效时，以**彻底退出 DSH 客户端再启动**为准。Windows 桌面端没有 Ctrl+Shift+R 这类重载加速键，真要整页重载只有桌面菜单「重新加载界面 / Reload Interface」这一个入口。
- **后台定时清理升级后不会自动开**：默认关闭，需要在设置页显式开启；不开启时与 0.39.x 行为一致，不存在任何定时器。
- 本版 `peerDependencies` 仍是范围式（`@deepseek-ai/dsh`: `>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1`），没有钉精确版本。

## 已知未验证项

以下七项**均因本轮没有重启 DSH、没有实机点过**，属于诚实标注的未验证范围，不要当作已验证结论：

1. 后台清理开关的端到端点击流程（在设置页开启 → 到期真的跑一轮）没有实机走通。
2. 进度条在真实设置页里的渲染效果（首帧、`role=progressbar`、完成态）没有实机确认。
3. Star 按钮实际打开浏览器这一步没有实机点击；白名单拒绝逻辑（`http://`、`evil.example.com`、`github.com.evil.com`、`javascript:` 全部拒绝）只有探针覆盖。
4. 5 项互斥单选的视觉 ✓ 唯一性（任何时候只有一个 ✓）没有实机确认。
5. **关窗继续 / 10 分钟续看**：关掉设置页或切走 tab 后删除在宿主侧继续跑完、`jobId` 存 localStorage、10 分钟内重新打开能续看进度这条链路没有实机走通；「90 秒没有任何新进展才暂停监视」与 8 分钟总兜底同样只有代码与探针覆盖。
6. **单任务互斥与勾选 0 个会话**：第二个清理请求被拒（HTTP 409 / `already-running`，中文「已有清理任务在运行，请等待它完成后再试。」）、以及勾 0 个会话点删除返回 `accepted:false, reason:'nothing-to-do'`（界面上什么都不发生）都没有实机点过 —— 「先提示已接单、随后变错误」是否真的消失，目前只有代码层证据。
7. **永久删除（跳过回收站）**：宿主 API 与界面**均已支持** —— 界面入口在快照清理卡的两段式确认块里，是一个**默认未勾选**的次级勾选项「⚠ 永久删除（不进回收站，无法恢复）」；勾上只换样式与文案（确认按钮变红、文字变「确认永久删除（不可恢复）」、并显示「即将永久抹掉 N 个会话的快照，共 X」），**勾选本身不发请求**；再点那个红按钮才发请求（`permanent:true`，且必须同时 `confirm:true`、`dryRun:false` 三条件）；点「预览」时无论勾没勾都只试算、绝不带 `permanent`；删完回执首行是「【已永久删除：不进回收站，无法恢复】…｜永久抹除 N」；只对本次请求有效、不写进任何策略文件，后台定时清理永不使用永久删除；不勾选则默认仍走回收站。

---

**English version — same content as the Chinese section above.**

## Highlights

1. **Background scheduled cleanup (new, off by default).** Until now snapshot cleanup had exactly one trigger: the archive event. `background.enabled` is `false` by default and only a literal `true` counts (`"true"` / `1` do not); you must enable it explicitly on the settings page. Once enabled it runs 90 seconds after startup and then ticks every 60 seconds, re-reading the policy each tick, so config changes need no restart. Parameters: `scheduleMinutes` 15–1440 (default 60), `hours` 1–24 (defaults to the snapshot policy's 1 hour), `maxItems` 1–500 (default 50). Safety rules are hard-coded: favourites are never cleaned, only `history-file/` is deleted (session body, `messages.json` and `meta.json` are untouched), a session whose idle time cannot be measured is never deleted, each run is capped by `maxItems`, everything goes to the Windows Recycle Bin **by default** (permanent delete, which skips the Recycle Bin, is supported by both the host API and the UI — the entry is the unchecked-by-default sub-checkbox inside the snapshot cleanup card's two-step confirmation block, and leaving it unticked keeps everything in the Recycle Bin), and a run is skipped while the previous one is still going. While it is off, no timer exists at all.
2. **Streaming delete progress (new).** Deleting used to freeze the UI with not a single progress frame: each session directory cold-starts a `powershell.exe` call to the Recycle Bin API (~255 ms each, roughly 40% of per-directory cost) and the work was fully serial, so the route only answered after the whole batch finished. `POST /snapshot-cleanup` now supports `stream: true` → `application/x-ndjson`, and a `start` frame is emitted before scanning, so the first frame arrives in 0–1 ms; 20 directories went from 12571 ms to 1720 ms (~7.3×), with `workers` defaulting to 2. **Closing the UI does not stop the work**: closing the settings page or switching tabs leaves the deletion running inside the host process, the `jobId` lives in localStorage, and reopening within **10 minutes** resumes the progress view. **What the 90 seconds really mean**: the client monitor does not give up after a flat 90 seconds — it pauses monitoring only after **90 seconds with no new progress**, and then merely says the deletion may still be running in the background and can be resumed by reopening within 10 minutes. It does **not** report a failure, does **not** clear the `jobId`, and does **not** treat the job as an error; there is also an **8-minute total fallback**.
3. **Sidebar filter is now five mutually exclusive options.** Previously "archived only ✓" and "favourites (archived) ✓" could both light up — contradictory semantics, and you had to tick two boxes. Now exactly one option is checked at a time and a single click takes effect immediately: `Hide archived` (default) / `All conversations (incl. archived)` / `Archived only` / `Favourites (archived)` / `Favourites (not archived)`.
4. **Favourites list: newest first by default, sortable and filterable.** The list used to follow scan order, so a fresh favourite landed at the bottom; the default is now `{ key: 'saved', dir: 'desc' }`. Sort keys cover recently saved / recently touched / file size / duration / file count / conversation name, direction is switchable, and **empty values always sink to the bottom** in either direction. Filters cover a keyword (conversation name / workspace / cwd, case-insensitive), size range, duration range and has-snapshot-only.
5. **Two smaller entries: GitHub star link and hidden scheduled conversations.** (a) A **GitHub star link** sits at the right end of the 「快照清理」 card header and in the 归档助手 page header; its URL comes from `package.json`'s `repository.url` (falling back to `homepage`) and is **never hard-coded**, opened through the host's `shell.openExternal` and allow-listed to `https:` plus the exact hosts `github.com` / `www.github.com`. (b) **Hide scheduled tasks** is a separate switch (default on, not part of the five exclusive filter rows): when it is on, **any session tied to a scheduled task — reserved for one, delivered into by one, or merely touched by one — is hidden**. The rule is time-independent: **a session stays hidden whether its task is not yet due, just became due, or long overdue, and nothing pops back into the sidebar when a timer fires.** It applies to unarchived conversations only (archived ones are filtered separately). Turn the toggle off whenever you want to look — every hidden session reappears immediately, no refresh needed.

## Fixes

- **The archive-time snapshot purge was reporting `bytes=0`.** The deletion path itself had always worked (sidebar archive → `domain/changed` → `handleWorkspaceArchiveChange` → `purgeSnapshotFor` → `cleanupSnapshotUsage({ dryRun: false })` → Recycle Bin); the defect was one fallback line in `lib/snapshot-usage.js`, `Number.isFinite(Number(entry?.bytes)) ? Number(entry.bytes) : 0`, combined with a caller that passes only `{ sessionId, dir }` — so `bytes` was never supplied and every record landed on `: 0`. `purgeSnapshotFor` now calls `measureLedger(dir)` before deleting and returns `files / bytes / toRecycleBin`, logging lines such as `sidebar archive purge — session=<id> files=3 bytes=8394 toRecycleBin=true`.
- **A real bug that made features "work sometimes".** The previous single-boolean throttler let several observers swallow each other's work, so the same feature appeared to work intermittently; it is fixed as part of this release's performance work.
- **The favourite star is now black-and-white.** The gold colour is gone; a favourite is solid (current foreground colour) and a non-favourite is an outlined star. The spacing to the neighbouring official button was corrected (9px → 5px) so the extra button no longer breaks alignment.
- **Leaner npm package.** Four `README*.bak-*` backups had been left in the repository root and were pulled into the published package by npm's `README*` always-include rule (218,406 B in total); they have been moved out of the repository root.

## Internal improvements (no user-visible change)

- Startup scan `diagnoseUngrouped`: 967.8 ms down to 23.4 ms warm, via a new `ungrouped-cache.json` cache (safe to delete; it rebuilds itself).
- Three `MutationObserver`s collapsed into a 60 ms single-flight pass with a cheap early exit: 50 DOM mutations in one batch now cause 1 scan instead of 50.
- The synchronous disk-read hot spot `metaFromCache` gained mtime memoisation: title extraction went from 44.6 ms to 0.2 ms.
- All three are internal, and change no user-visible behaviour — except the throttler bug fixed above.

## Upgrade notes

- **Host-side changes need a full client restart.** This release changes `lib\index.js`, `lib\snapshot-usage.js`, `lib\ungrouped-guard.js` and `lib\ungrouped-cache.js` (plus `package.json` / `cordis.patch.yml`). The host is a Node process with no hot reload, so you must **quit the DSH client completely and start it again** — closing the window or refreshing the page is not enough.
- **Client-side changes usually take effect on their own.** This release changes `lib\client.js` (exclusive filter rows, progress bar, star button, star styling, favourites sorting/filtering). The host polls the client bundle and swaps it in, so the change **normally lands without any manual step**; when you are unsure whether it did, treat **quitting the DSH client completely and starting it again** as the authoritative check. The Windows desktop app registers no reload accelerator such as Ctrl+Shift+R — for a full page reload the only entry point is the desktop menu item "Reload Interface".
- **Background cleanup stays off after upgrading.** It must be enabled explicitly on the settings page; while off, behaviour matches 0.39.x and no timer exists.
- `peerDependencies` remain range-based (`@deepseek-ai/dsh`: `>=0.1.7-rc.1 <0.2.0-0 || >=0.2.0-rc.1`); no exact version is pinned.

## Known unverified items

The following seven items were **not exercised on a running DSH in this round** (no restart, no real clicks), and are listed honestly rather than presented as verified:

1. The end-to-end click flow of the background-cleanup switch (enable on the settings page → a run actually fires when due).
2. How the progress bar actually renders on the real settings page (first frame, `role=progressbar`, completion state).
3. The star button actually opening a browser; only the allow-list rejections (`http://`, `evil.example.com`, `github.com.evil.com`, `javascript:`) are probe-covered.
4. The visual single-check-mark behaviour of the five exclusive options.
5. **Close-and-continue / 10-minute resume**: the path "close the settings page or switch tabs → the deletion finishes in the host → reopen and resume the progress view" was not exercised end to end; the "pause after 90 seconds with no new progress" rule and the 8-minute total fallback are covered by code and probes only.
6. **One job at a time and zero-selection**: the second request being rejected (HTTP 409 / `already-running`, with the Chinese message 「已有清理任务在运行，请等待它完成后再试。」) and pressing delete with 0 sessions ticked returning `accepted:false, reason:'nothing-to-do'` (nothing happens in the UI) were not clicked through — so that the old "accepted first, error later" behaviour is really gone is currently backed only by the code.
7. **Permanent delete (skipping the Recycle Bin)**: supported by **both the host API and the UI** — the entry is a sub-checkbox in the snapshot cleanup card's two-step confirmation block, 「⚠ 永久删除（不进回收站，无法恢复）」, **unchecked by default**; ticking it only swaps styling and copy (the confirm button turns red, its label becomes 「确认永久删除（不可恢复）」, and it shows 「即将永久抹掉 N 个会话的快照，共 X」) — **ticking alone sends no request**; the red button then sends `permanent:true`, which still requires `confirm:true` and `dryRun:false`; 「预览」 only ever dry-runs and never carries `permanent`; the receipt's first line is 「【已永久删除：不进回收站，无法恢复】…｜永久抹除 N」; it applies to that request only and is never written into a policy file, and the background timer never uses permanent delete; leaving it unticked keeps the default Recycle Bin behaviour.

---

## 发布前备忘（草稿用，发布时删除）

- **口径自查已通过**：本稿量化数字均已能在 `CHANGELOG.md` 找到对应 —— 星标间距 `9px → 5px`（0.40.0「收藏清单」节末条）、内部性能组三项（0.40.0「内部性能组」小节：`967.8 ms → 冷扫 988.2 ms / 热命中 23.4 ms`、`60 ms` 合并调度、`44.6 ms → 0.2 ms`）、仓库清理 `218,406 B`（0.40.0「仓库清理 218,406 B」小节）、后台 `hours 1–24`（0.40.0「后台定时清理」参数条）、「两段式确认」（0.40.0 与 0.42.0 均有原文）。此前判「查无对应」是因为只扫了 `###` 标题，漏掉了 0.40.0 里两个 `####` 小节。
- 本稿中的 Star 落点按 `README.md` 第 102 行与 CHANGELOG 口径写为「设置页『快照清理』标题行右端 + 『归档助手』页头右侧」，与任务简报里「设置页顶部」的表述不同，以文档为准。
- 「已知未验证项」七项需在实机重启 DSH 点击确认后回填结果；确认后本节可删除或改为「已验证」。

# Changelog

All notable changes to this project are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/);
this project uses [Semantic Versioning](https://semver.org/).

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

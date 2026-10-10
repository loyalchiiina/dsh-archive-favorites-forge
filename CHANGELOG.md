# Changelog

All notable changes to this project are documented here.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/);
this project uses [Semantic Versioning](https://semver.org/).

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

[0.24.1]: https://github.com/loyalchiiina/dsh-archive-favorites-forge/releases/tag/v0.24.1
[0.24.0]: https://github.com/loyalchiiina/dsh-archive-favorites-forge/releases/tag/v0.24.0

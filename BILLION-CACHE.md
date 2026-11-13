# billion-context 缓存清理（插件内集成）

本功能集成在归档插件的「缓存与未分组」标签页，位于「孤儿缓存」区块下方，区块标题为 **billion-context 缓存**。

## 它清理什么

billion-context（上下文压缩插件）在长期使用中会在用户目录下堆积可清理的缓存。本模块按三类处理：

| 分类 | 位置 | 处理 |
| --- | --- | --- |
| 会话检索图片缓存 | `~/.local/state/billion-context/retrieve/img/<session>/` | 超过 `keepDays`（默认 7 天）的可删除（进回收站，按需重建） |
| 日志轮转文件 | `bili.log.old` / `*.log.N` | 可安全删除（进回收站） |
| 可重建缓存 | `~/.cache/billion-context/models-dev.json`、`~/.dsh/storages/dsh-context/overview-cache*.json`、`remote-notices-snapshot.json` | 仅在勾选「含可重建」时清理（进回收站） |
| 运行状态（保留） | `instances/`、`writers/`、`session-order.json`、`prefix-affinity.json`、`plugin-conversations.json`、`bili.log` 等 | **只报告，不删除** |

> 说明：本清理**不会删除任何对话/会话历史**，只清理可重建的检索缓存与日志轮转。删除一律走 Windows 回收站。

## 依赖

- Node 内置模块：`node:fs/promises`、`node:os`、`node:path`、`node:child_process`
- 本插件既有模块：`lib/ungrouped-guard.js` 导出的 `sendToRecycleBin`（目录 → 回收站）
- 文件 → 回收站使用 `lib/billion-cache.js` 内置的 PowerShell 调用（`Microsoft.VisualBasic.FileIO.FileSystem::DeleteFile`）
- 运行环境：Windows（回收站依赖 PowerShell；非 Windows 会返回 `not-windows` 并跳过删除）
- **不新增任何 npm 依赖，也不 import `@deepseek-ai/*` 官方包**

## 后端接口（lib/index.js 已接线）

- `GET/POST /billion-cache-diagnose` → 只读报告 `{ok, version, scannedAt, keepDays, roots, entries, summary}`
- `POST /billion-cache-clean`（job）→ 传入 `{ entryIds?, dryRun?, confirm?, keepDays?, includeRebuild? }`，返回/流式推送进度帧，最终 `{state:'done', result:{ok,dryRun,deleted,skipped,failures,bytesFreed,bytesTotal}}`

安全：清理前强制 `dryRun` 试算；真实删除需 `dryRun:false` + `confirm:true`；服务端重新扫描目录、校验路径必须落在白名单根目录内，绝不信任前端传来的路径。

## 命令行监测脚本（无需打开 DSH）

```bash
# 只读诊断（默认保留最近 7 天图片缓存）
node scripts/billion-cache-monitor.mjs

# 机器可读
node scripts/billion-cache-monitor.mjs --json

# 真实清理（进回收站）
node scripts/billion-cache-monitor.mjs --clean --yes

# 连可重建缓存一起清理，并放宽保留窗口到 30 天
node scripts/billion-cache-monitor.mjs --clean --yes --include-rebuild --keep-days 30
```

## 建议的定时监测（可选）

若希望定期巡检，可用任务计划程序执行只读诊断并落日志：

```
node "<从源码仓库 scripts/ 复制出来的 billion-cache-monitor.mjs 路径>" --json > "%LOCALAPPDATA%\billion-context\billion-cache-report.json"
```

（本插件不会自动添加计划任务；如需自动化清理，请用户在插件界面确认后再执行。）

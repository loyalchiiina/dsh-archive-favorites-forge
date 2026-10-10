# dsh-archive-favorites-forge

**给 DSH 的对话加上收藏、复制 ID+路径、单条删除、超时批量归档和收藏筛选 —— 全部挂在官方插槽上，不改官方一行代码。**

**Favorites, copy id+path, per-session delete, idle batch archive and a favourites
filter for DeepSeek Harness — additive slot extensions over the shipped archive
feature, editing no official file.**

[![npm](https://img.shields.io/badge/npm-dsh--archive--favorites--forge-cb3837?logo=npm)](https://www.npmjs.com/package/dsh-archive-favorites-forge)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![DSH](https://img.shields.io/badge/DSH-%E2%89%A5%200.2.0--rc.2-4f46e5)](https://github.com/loyalchiiina/dsh-archive-favorites-forge)

[English](README.md) | 简体中文

---

## 效果图

**① 对话菜单** —— 在官方「…」菜单里新增三行：收藏对话、复制 ID + 路径、带二次确认的永久删除：

![对话菜单](assets/01-session-menu.png)

**② 收藏筛选** —— 在官方「筛选会话」分组里新增两行，把侧栏收窄到「已归档的收藏」与「未归档的收藏」：

![收藏筛选](assets/02-favourites-filter.png)

**③ 设置页** —— 超时批量归档、带归档状态的收藏清单、以及批量删除归档中未收藏的对话：

![设置页](assets/03-settings-panel.png)

---

## 一句话说明

DSH 自带的归档功能只有「归档 / 取消归档 / 筛选已归档」，**没有收藏、没有单条删除、
没有复制 ID 或路径、也没有按时间批量归档**。这个插件把这些补上，而且**一个字都不改官方文件**。

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

## 安装

```powershell
dsh plugin --profile <profile> add dsh-archive-favorites-forge
```

装完**必须完全退出 DSH 再打开**。宿主半边（`lib/index.js`）在**本代 harness 里没有热重载**，
客户端 bundle 也在 DSH 启动时就快照了 —— **所以刷新页面拿不到新版**，必须重启。

## 工作原理

```
lib/index.js   宿主半边 —— 收藏存储、转录路径解析、JSON 路由、带护栏的删除、归档/取消归档
lib/client.js  客户端半边 —— 官方插槽注册 + 一条 DOM 规则
```

**用到的官方插槽**（全部来自官方客户端契约）：

| 插槽 | 贡献内容 |
|---|---|
| `sidebar.workspaces.session.menu.item` | 3 行：收藏、复制 ID+路径、删除 |
| `sidebar.workspaces.session.row.action` | 1 个行内 ☆ 星标 |
| `settings.section` | 「归档收藏」设置页 |

所有贡献都通过 `ctx.slots.inject` 注册 —— 也就是「等宿主条目挂载后再注册」的官方契约。
所以插件**从不假设侧栏已经起来**，也**从不持有宿主节点的引用**。

**唯一的例外是收藏筛选**：官方那个「视图选项」菜单是**写死的数组，既没有插槽也没有触发器 id**，
所以这一个控件只能走 DOM —— 做法是**找到官方那条筛选行并克隆它**。
定位只依赖 `role` / `aria` / `data-row-key` 这些稳定属性，**绝不依赖 CSS 模块哈希**
（那些类名每次构建都会重新哈希）。

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

## 配置

| 键 | 默认 | 含义 |
|---|---|---|
| `enabled` | `true` | 宿主路由总开关 |
| `maxDeletePerCall` | `500` | 单次删除请求的硬上限 |

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

## 开发

```
lib/index.js             宿主半边
lib/client.js            客户端半边（__ModuleLoader__ bundle）
test/probe-client.mjs    DOM stub + 宿主探针测试
```

跑测试：

```sh
node test/probe-client.mjs
```

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

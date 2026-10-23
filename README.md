# dsh-unsent-drafts

DeepSeek Harness（DSH）插件：**找回切换会话后丢失的未发送草稿**。

## 解决什么问题

DSH 的侧栏规则是「只有当前那一行空白会话显示，其他空白会话行被隐藏」。
于是这个操作序列会让用户丢掉正在写的内容：

1. 新建一个会话（侧栏出现一行空白会话）
2. 在输入框里打了字，**没有发送**
3. 切到另一个会话

切走之后，那个会话从侧栏消失了——既切不回去，也看不到自己打了什么。

但草稿和会话其实都还在，只是 UI 没给入口：

| 东西 | 实际状态 |
|---|---|
| 草稿文本 | 持久化在浏览器 `localStorage`，键形如 `dsh.conversation.<sessionId>`，值 `{ draft, view }` |
| 会话本身 | 空白会话也会被持久化，仍在会话目录里（`blank: true`） |
| 草稿恢复机制 | DSH 自己就有——切回该会话会自动回填 |

本插件做的就是补上那个入口。

## 功能

- 侧边栏新增一个「草稿」行（与「费用」等第三方行并列），点开是一个主面板
- 面板列出所有**有草稿但还没发消息**的会话：
  - 草稿前 60 字预览（截断加省略号）
  - 会话标题 / `#sessionId` 前 8 位
  - 所属目录（工作区）、字数、引用 chips 数
  - 未发送会话带橙色小圆点；目录里查不到的叫「孤立草稿」，灰点
- **草稿备份**：插件在加载后就**常驻后台**采集（每 2 秒），与面板是否打开无关。
  即使 DSH 在切换会话时清空了源草稿，面板仍能列出这些历史条目，并标注
  「仅存于备份」及相对时间。支持「仅看现存」过滤、单条删除、一键清空。
- **搜索**：按草稿内容、会话标题或会话 ID 过滤
- **跳回**：点某条即切回该会话；仍存在于 DSH 的草稿会被自动回填
- **复制**：每条都带复制按钮——万一会话真找不回来，至少能把文字救出来
- 空态、错误态、诊断区都有明确提示，不会出现「面板一片空白不知道发生了什么」

## 安装

需要 DSH 0.2.1 或更高版本（`engines.dsh` 写作 `>=0.2.1-0` 以兼容
`0.2.1-rc.2` 这类预发布版本号——semver 里 `0.2.1-rc.2 < 0.2.1`，
写 `>=0.2.1` 会被拒装）。

```bash
dsh plugin --profile desktop add link:<本插件目录的绝对路径>
```

或走 GUI：Plugins 页面 → Add plugin，填本目录路径。

装完**必须刷新浏览器页面**（或重启客户端）。Client 半身的模块表是页面加载时
拉取的，安装只更新 Host 侧，旧页面不会重新拉取。

### 安装后自检

浏览器控制台执行：

```js
window.__dshUnsentDraftsDiag
```

期望看到 `{ panellist: 'registered', panel: 'registered' }`。

| 值 | 含义 |
|---|---|
| `pending` | inject gate 没被触发——页面没刷新，或宿主太老没有 `sidebar.panellist` |
| `failed: ...` | register 抛了，读后面的错误信息 |
| `registered` | 注册成功，侧栏应该出现「草稿」行 |

## 用法

1. 新建会话，输入几个字，**不要发送**
2. 切到别的会话
3. 点侧栏「草稿」行 → 看到刚才那条
4. 点「跳回」→ 回到该会话，输入框里就是刚才的字

面板默认 1.2 秒轮询一次，草稿变化会自动反映，不需要手动刷新
（也可以点面板右上角的「刷新」）。

## 数据与隐私

| 项 | 说明 |
|---|---|
| 读什么 | 只读浏览器自己的 `localStorage`（DSH 的草稿存储） |
| 写什么 | **什么都不写**。不删草稿、不改草稿、不新建/归档会话 |
| 网络请求 | 无。所有数据来自本机 localStorage 与会话目录服务 |
| 状态文件 | 无 |
| 上传 | 无 |

## 设计取舍

**为什么扫 `localStorage` 而不是找 Host 服务。**
DSH 没有把「草稿」作为 Host 侧可查询的数据暴露出来（草稿是纯客户端输入态），
而它恰好就存在浏览器自己的存储里。插件跑在同一个页面里，读它是距离最近的路径。

**为什么不硬编码键名前缀。**
`dsh.conversation.` 是当前版本的前缀，但这是实现细节，升级可能变。
所以扫描逻辑是前缀自适应的：遍历全部键，只认「解析后是对象且 `.draft`
有非空白文本」的那些；sessionId 优先取对象字段，取不到再退回键名最后一个
`.` 之后的部分。默认前缀只作为面板诊断区里的一行提示。

**草稿格式双兼容。**
`draft` 字段有两种历史格式，解析时都支持：

```js
// 早期：纯字符串
{ draft: "abc", view: {...} }

// 新格式：结构化对象（含文件/目录/会话引用 chips）
{ draft: { text: "abc", references: [...] }, view: {...} }
```

**跳转用尝试链而不是赌一个 API。**
`SessionTarget` 的确切形状没有公开文档，所以按
`uiWorkspace.openSession(string)` → `openSession({sessionId})` →
`sessions.retain(string)` → `retain({sessionId})` 逐个试，
成功的那一步会显示在面板的提示里，全部失败时把每步的错误原因列出来。
不会因为猜错形状就整个功能不可用。

**为什么有「复制」按钮。**
跳回依赖会话还在。如果会话已被归档/清理，跳回会失败——这时「复制」
是唯一能救出内容的路径，所以它是一等功能而不是附属品。

## 健壮性

- 整个 `apply` 包在 try/catch 里：前端插件抛异常会让 DSH 判定启动失败并弹出
  「禁用第三方插件」恢复界面，绝不能冒泡
- 三个注册点（locale / 面板 / 侧栏行）各自独立 try/catch，任一失败不连累其他
- 扫描设上限（500 条键、单值 512KB），超大 localStorage 不会卡死面板
- 单个键 JSON 解析失败 → 跳过并计入诊断，不崩溃
- 只读：不存在误删用户草稿的可能

## 已知限制

| 限制 | 说明 |
|---|---|
| `client.js` 改动需升版本号 | DSH 的 clientModules 按包名缓存 bundle，不升 version 会持续加载旧 bundle，症状是「改了什么都没反应」 |
| 同页面输入不触发 `storage` 事件 | 所以用 1.2 秒轮询兜底，不是实时 |
| 草稿恢复依赖 DSH 自身 | 插件只负责切回会话，回填由 DSH 完成。若某版本改了回填时机，跳回后可能需要多点一下输入框 |
| 跨工作区草稿 | 面板能列出并显示工作区名，但跳转走的是 `uiWorkspace.openSession`，跨工作区时由宿主决定是否切换工作区 |
| 空白会话切走后草稿可能被清空 | DSH 自身在切换会话时会把草稿搬到新会话并清空源会话（`from.setDraft("")`）。插件用**草稿备份**兜底，但仍有两个前提下恢复不了：插件当时未运行、或备份被手动清空 |
| 备份有容量上限 | 每个会话最多保留 5 个历史版本，全局最多 200 条（约几十 KB），超出后丢弃最旧的 |
| 备份是本机的 | 存在浏览器 localStorage 里，换浏览器/换 profile/清理站点数据都会丢失 |

## 开发注意事项

**必须声明 inject，不能直接读 ctx 属性。** Cordis 的 `Context` 是 Proxy，
访问未在 `inject` 里声明的服务属性会**直接抛**
`cannot get property "xxx" without inject`，表现为面板白屏。本插件需要
`sessions` / `uiWorkspace` / `layout`，已写进 `exports.inject`；取值统一走
内部 `svc(name)`（即 `ctx.get(name)`，未挂载时返回 null）。

**hooks 不要在模块级解构。** `const { useState } = require('react')` 会让
React 实例被替换后拿到过期引用，调用即抛 `Invalid hook call`，同样白屏。
应在组件每次渲染时从当前 `React` 对象现取。

**面板必须包错误边界。** 否则任何渲染异常都被宿主吞掉，只留一片白屏，
连诊断按钮都不渲染，无法排查。`PanelBoundary` 会把错误信息和堆栈直接
画在面板里。

**扫描 localStorage 不能用 `Object.keys`。** `Storage` 的键是「具名属性」，
不是自有可枚举属性，部分 Chromium/Electron 构建里 `Object.keys(localStorage)`
返回空数组，症状是面板永远显示「没有未发送草稿」。必须用
`localStorage.length` + `localStorage.key(i)` 枚举，`Object.keys` 仅作并集兜底。

**改 UI 前先确认渲染者。** 若侧栏行没出现，先看诊断：
浏览器控制台执行 `window.__dshUnsentDraftsDiag`，应看到
`{ panellist: 'registered', panel: 'registered' }`。显示 `failed: ...` 说明
register 抛了（读错误信息）；显示 `pending` 说明 inject gate 没被触发。

**必须用 `ctx.slots.inject` gate。** `apply` 早期 `sidebar.panellist`
还没建立，裸调用 `ctx.slots.register` 会返回 disposer 但注册被静默丢弃
（dsh-cost-tracker 2026-10-21 实测踩坑：inspect 的 occupants 里没有本插件）。

**`main` 是 keyed slot。** 面板注册必须给 `key`，且点击行的切换由宿主自己
完成（它知道 `activePanelId`），插件不需要调 `layout.selectPanel`。
可用 key 可在 `cordis_inspect_query` 的 Client `Slots` 里查 `keyDomain`——
注册成功后自己的 key 会出现在 "already taken" 列表里。

**`engines.dsh` 要兼容预发布号。** 写 `>=0.2.1` 装不上 `0.2.1-rc.2`，
必须写 `>=0.2.1-0`。

## 文件结构

```
dsh-unsent-drafts/
├── package.json          # dsh.bundle.patch + dsh.client（platform: web）
├── cordis.patch.yml      # insert: id=unsent-drafts
├── lib/
│   └── index.js          # 宿主入口：空 apply（纯客户端插件）
├── client.js             # 前端：草稿扫描 + 会话目录 + 跳转尝试链 + 面板
├── locale/
│   ├── zh.json           # 中文显示名与描述
│   └── en.json           # 英文显示名与描述
├── icon.svg
├── README.md
└── LICENSE
```

## 版本

- **1.0.0** — 首个版本：草稿扫描（前缀自适应 + 双格式兼容）、会话目录匹配、
  跳转尝试链、复制兜底、诊断区
- **1.0.1** — 修复面板永远为空：改用 `length`/`key(i)` 枚举 localStorage；
  诊断区增加页面 origin、前几个键名、解析失败计数
- **1.0.2** — 修复面板白屏：hooks 改为每次渲染现取（不在模块级解构）；
  新增错误边界，渲染异常直接显示在面板里
- **1.0.3** — 修复 `cannot get property "uiWorkspace" without inject`：
  补全 inject 声明（`sessions`/`uiWorkspace`/`layout`），服务取值统一走
  `ctx.get()` 包装的 `svc()`，未挂载时返回 null 而非抛错
- **1.1.0** — 草稿备份：解决「切走会话后 DSH 把草稿清空、事后无法找回」。
  插件持续记录出现过的非空草稿（存于 `dsh.unsent-drafts.backup.v1`），
  面板合并展示「实时草稿 ∪ 历史备份」，标注哪些仅存于备份，并提供
  「仅看现存」过滤与「清空备份」。同时修正三处 API 误用：改用
  `sessions.list` 快照读标题（`search` 要求 query 非空且结果不含标题）、
  `sessions.retain` 补上必填的 `source`、`openSession` 直接传字符串而非对象
- **1.1.1** — 备份真正生效的两个修正：①采集改为**插件加载后常驻后台运行**
  （原先只在面板打开时扫描，而 DSH 在切走时已清空草稿，等于永远采不到）；
  ②修掉 `collectItems` 里被注释吞掉的 `mergeIntoBackup` 调用。
  另新增：搜索框（内容/标题/会话 ID）、相对时间显示、备份条目可单条删除

## 许可证

MIT

# DSH-better-sidebar 源码分析

分析日期：2026-08-20；源码快照：[`6c891514b544b6e2da51fdab2eb3436cc02da246`](https://github.com/omdsh-dev/DSH-better-sidebar/tree/6c891514b544b6e2da51fdab2eb3436cc02da246)（`v0.14.0`）。

## 一句话结论

它是面向 `dsh web` 的「VS Code 式右侧栏 + 底部工作台」**双半 Cordis 插件**，适合借鉴其会话隔离工作台、注册服务和安全围栏；但不能直接移植到本项目 Chrome sidepanel，更不应复制其文件/Git/PTY 宿主能力或其对 DSH Web DOM 的注入实现。

## 定位、运行与依赖

- 产品定位是文件资源管理器/编辑器、浏览器、终端、Git、子代理任务组成的会话级工作台；内置 tab 与第三方 tab/viewer 都经 `ctx.betterSidebar` 注册，见 [README 功能与服务声明](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/README.md#L22-L35)。
- 正常接入是 `dsh plugin --profile web add dsh-better-sidebar@latest`，包的 bundle patch 自动把插件写入 web profile；本地开发才手工改 `~/.dsh/profiles/web/cordis.patch.yml`。重复走两个通道会双挂载，见 [安装说明](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/README.md#L102-L181) 和 [bundle patch](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/cordis.patch.yml#L1-L49)。
- 运行时是 host/client 双半：host 注入 `webServer/sessions/webRuntime/tools` 并注册 `/sidebar/*` 路由；client 注入 slots、sessions、connection、workspaces、locale、modules，提供 `betterSidebar` 服务后才挂载 UI，见 [host 依赖](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/index.ts#L68-L71) 与 [client 激活](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/index.tsx#L31-L97)。
- 依赖 DSH `0.1.0-rc.8` 世代的公开包（含 Cordis、webserver、session、client UI slots/conversation/runtime）以及 React；Node 20+；`node-pty` 是运行时本机依赖，见 [package manifest](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/package.json#L1-L129)。这说明它不是可单独嵌入浏览器的 React 组件库。

## 目录与数据流

```text
src/index.ts (DSH Web host)
  -> trusted /sidebar/api, /sidebar/file, /sidebar/html, /sidebar/ws/*
  -> session cwd fence -> fs / git / jobs / PTY
src/client/index.tsx (DSH Web client)
  -> official slots + `ctx.betterSidebar` registry
  -> Sidebar / tabs / viewers / persisted session layout
third-party client plugin
  -> inject betterSidebar -> registerTab/registerFileViewer -> disposer on HMR
```

Host 端以 `webRuntime.trustedHosts` 做请求围栏；媒体/HTML 还把路径限制在会话 cwd 内，HTML 响应另加 CSP sandbox，见 [路由与路径约束](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/index.ts#L592-L742)。终端则经受围栏保护的 WebSocket 连接 UI tab 或 agent tab 的 PTY，见 [终端通道](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/index.ts#L744-L785)。

布局状态按会话写入 `localStorage`（键为 `dsh-sidebar:v1:<sessionId>`），并支持右栏/底栏、分屏和窄屏合并，见 [状态模型](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/state.ts#L1-L5)。

## 关键 UI/交互（源码事实）

| 能力 | 一手证据 | 对本项目的意义 |
| --- | --- | --- |
| 右栏 + 底栏、tab 拖拽拆分/合并、移动端抽屉 | [README 功能清单](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/README.md#L22-L33) | 可借鉴信息架构和窄屏降级，不照搬容器注入。 |
| 文件树、CodeMirror、预览器、链接/产物文件拦截 | [client 文件结构](https://github.com/omdsh-dev/DSH-better-sidebar/tree/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client)；[slot 拦截](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/intercept.tsx#L61-L109) | Browser Target 的产物入口可参考，但所有浏览器读写仍须通过 Browser Connector。 |
| tab/viewer 注册、能力探测、独立设置、生命周期 disposer | [服务注册实现](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/service.ts#L469-L556) | 值得作为 `packages/` 插件间 UI 扩展的参考模式。 |
| 重型编辑器/终端/Mermaid 按需 chunk | [bundle 路由](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/index.ts#L625-L629) | 可借鉴分包与失败退化策略；实现须适配 WXT/Native Host 生命周期。 |
| `node-pty` 缺失时保持插件可用，且 agent terminal tool 默认受设置门控 | [PTY 退化与工具门控](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/index.ts#L482-L550) | 高价值可靠性思路；不应让 Chrome UI 直接拥有本机 shell。 |

## 适配矩阵

| 结论 | 适配项 | 原因与边界 |
| --- | --- | --- |
| 可借鉴 | 会话级状态模型、tab/viewer registry、声明式开关、HMR disposer、懒加载与可见错误条 | 都是产品无关的 UI 插件工程模式；在本仓库实现时放入 `packages/*`，并以 Harness Run/Browser Target 的真实身份绑定取代泛化 session/cwd。 |
| 不宜复制 | `fixed` 面板宿主、对 DSH Web conversation slot/workspace openPath 的拦截、右栏 DOM 推挤 | 这是 DSH Web shell 的布局契约；Chrome sidepanel 有自身 MV3/WXT 容器与现有产品 UX。复制会制造双侧栏、升级脆弱性，并违背“保留原 Chrome sidepanel UX”。 |
| 不宜复制 | `fs.*`、`git.*`、`terminal_*`、`/sidebar/file`、`/sidebar/html` 的完整 host 面 | 它们直接操作会话 cwd 与本机进程；本项目应只通过 Native Server 的 Connector 能力边界，写入必须走 Verified Write，且不能把 Connector Credential 暴露给 UI。 |
| 需要 seam 才做 | 如果产品插件需要在官方 Harness 会话内容/设置页内提供可注册的 UI 区域或受控产物入口 | 先查现有 `upstream-contributions/README.md` 的通用 slot；缺失时才新增产品中立 seam patch，绝不改 `upstream/deepseek-harness`，也不把产品名写入 patch。 |

## 许可证、维护活跃度、风险与建议

- **许可证**：MIT（版权声明为 `dsh-external`），可参考或复用合规代码，但保留原许可与版权文本；见 [LICENSE](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/LICENSE#L1-L21)。
- **维护活跃度（截至分析日的事实）**：该快照的最新提交为 2026-08-20，且 [v0.14.0 Release](https://github.com/omdsh-dev/DSH-better-sidebar/releases/tag/v0.14.0) 发布于 2026-08-19；活跃但版本演进极快。公开 [Issues](https://github.com/omdsh-dev/DSH-better-sidebar/issues) 同时显示大量近期布局、HMR、桌面端和 iframe 兼容议题。因此“活跃”不等于“稳定”。
- **主要风险**：① 强绑定 rc.8 与 DSH Web slots/模块服务，升级会有 API/DOM 破坏风险；② 本机文件、Git、PTY、HTML/iframe 的攻击面远大于本项目所需；③ 双挂载会重复注册 `/sidebar/api` 并导致整个插件树启动失败，源码已有明确防御但仍依赖 bundle 顺序，[见 patch 注释](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/cordis.patch.yml#L33-L45)。
- **建议**：把它当作“设计与公开 API 参考”，优先提炼 registry、状态持久化、按需加载和错误降级的测试用例；不要引入该包作为当前产品 runtime 依赖。任何选定交互先以 sidepanel 原型和真实 `connectNative()`/action readback 验收，再决定是否需要通用 seam。

## Markdown预览与选区送入AI源码链路

以下结论来自本地源码 `/Users/zhanglt21/Downloads/DSH-better-sidebar-main`，不是运行时猜测。

### 1. 文件加载、预览与 Mermaid

数据流是：`builtinViewers()` 把 `.md/.markdown` 注册为 `markdown` viewer、策略为 `fsRead`，组件是 `LazyTextEditor`；`EditorHost` 通过 `matchFileViewer()` 选 viewer 后调用 `api.fsRead(scope, path)`，再把 `content/truncated` 传给 viewer（`src/client/builtins/viewers.tsx:74-80`、`src/client/EditorHost.tsx:192-250,329-346`、`src/client/api.ts:97-145`）。客户端请求是 POST `/sidebar/api/fs.read`；host 路由要求受信任的 POST，再由 `buildApi` 解析 session cwd、读取文件并返回 text/binary（`src/index.ts:592-623,223-261`）。`readText()` 默认最多读 `readLimit = 512 * 1024` 字节，超出只返回前缀并置 `truncated`（`src/index.ts:131-167`、`src/config.ts:39-43,69-73,99-103`）。

`TextEditor` 的 `mdText = draft ?? content ?? ''`，所以 CodeMirror 未保存修改会立即成为预览源；Markdown 预览用一次完整的 `MarkdownText` 渲染（`src/client/TextEditor.tsx:251-265,379-397`）。`splitMermaidBlocks()` 只负责识别是否存在 Mermaid fence（支持反引号/波浪号及未闭合 fence），其拆分结果只用于 `hasMermaid`，并不把文档拆成多次 Markdown 渲染（`src/client/mermaid-blocks.ts:55-109`）。有 Mermaid 时加载 `/sidebar/bundle/mermaid.js`，失败可重试；host 通过 `/sidebar/bundle` 提供 chunk（`src/client/lazy-chunk.tsx:25-68,71-88`、`src/client/chunk-loader.ts:235-279`、`src/index.ts:625-629`）。`MermaidMarkdown` 仍对全文做一次 `MarkdownText`，然后在 layout effect 中查找 `.md-code-block`，保留 React host、替换其 children 为 `MermaidDiagram`；Mermaid 输出经 sanitizer 后作为 SVG 注入（`src/client/mermaid.tsx:215-301,312-399`）。

### 2. 两种选区如何得到行号

| 选区位置 | 取文本/行号 | 生成浮层 payload |
| --- | --- | --- |
| 源码编辑区（CodeMirror） | 仅 `code`/`markdown` viewer 的 focused、非空 selection 触发；`sliceDoc(sel.from, sel.to)` 取源码，`doc.lineAt(sel.from/to).number` 取 1-based 起止行，`coordsAtPos(sel.head)` 定位按钮（`src/client/TextEditor.tsx:161-203`） | 直接 `buildSelectionInsert(path, scope.cwd, {start,end}, text)` |
| 渲染预览区（DOM） | `window.getSelection()` 后要求 anchor/focus 都在 `mdRef` 内；`sel.toString()` 取浏览器渲染文本，`getBoundingClientRect()` 定位按钮。DOM 没有源行映射，改用 `linesOfSelection(mdText, text)`（`src/client/TextEditor.tsx:267-297`） | 反向匹配成功才带行号，否则只带路径 |

`linesOfSelection()` 先去掉 DOM 块选区常见的一个尾部换行，再在当前 `mdText` 中做精确 substring 搜索：找不到或出现第二次即返回 `null`；唯一命中时按字符索引统计换行，得到 1-based 起止行（`src/client/selection-payload.ts:59-85`）。因此编辑区行号是 CodeMirror 的直接事实，预览区行号只是“渲染文本恰好能在源文本中唯一反查”时的 best effort。

### 3. 送入 AI 实际做的是追加 draft

`buildSelectionInsert()` 先把绝对路径投影为相对 session cwd 路径（无 cwd 则保留绝对路径），行号格式为 `path:12` 或 `path:12-15`。选中文本长度按 JS UTF-16 `.length` 计算：`<=500` 生成 ```` ```path:line\nselected\n``` ````；`>500` 丢弃正文，只生成一行路径/行号（若预览反查失败则只有路径），不是截取前 500 字符（`src/client/selection-payload.ts:21-57`）。

点击浮层时 `commitPopup()` 只把已保存的 `insert` 交给 `appendToDraft()`；按钮的 `mousedown.preventDefault()` 用来保持原选区直到 click（`src/client/TextEditor.tsx:103-109,422-434`）。`appendToDraft()` 通过 `ctx.sessions.scope(sessionId)` 找到目标会话，再懒取 `ctx.get('conversation')`，读取 `input.state.getSnapshot().draft`，以一个空格拼接后调用 `input.setDraft()`；缺 service/scope 或异常时只记录 warning 并返回 false（`src/client/conversation-draft.ts:1-29`；其结构契约见 `src/context-types.ts:265-281,318-332`）。这里没有发送 AI 请求、没有提交消息 API；用户仍需在会话 composer 中自行点击发送。文件保存是另一条 `api.fsWrite()` → `/sidebar/api/fs.write` 路径（`src/client/TextEditor.tsx:235-249`、`src/client/api.ts:142-145`、`src/index.ts:263-277`），与“选区送入 AI”无关。

### 4. 可靠性边界

- 预览反向匹配会被 MarkdownText 的 DOM 换行/格式化影响；重复段落、缺失文本、或选区跨越渲染结构后不再等于源 substring 时，payload 不报行号，但仍可带路径。
- Mermaid 图是 sanitizer 后的 SVG `<text>`/图形，不是原始 fence DOM；能否选出 SVG 文本取决于浏览器，且生成的标签通常不能唯一匹配完整 `mdText`，所以不要把 Mermaid SVG 选区当作可靠的源码行引用。图的放大 modal 是 portal 到 `document.body`，落在 `mdRef` 外，预览 handler 会主动忽略其选区（`src/client/mermaid.tsx:263-272`、`src/client/TextEditor.tsx:275-285`）。Mermaid 渲染失败时才显示原始 `code` 的 `<pre>`（`src/client/mermaid.tsx:290-300`），此时反查机会更高但仍受重复文本规则约束。
- 文件超过 host `readLimit` 时预览看到的就是截断前缀；`TextEditor` 只在编辑模式显示截断提示，预览模式没有额外标注（`src/client/TextEditor.tsx:370-377`）。因此预览行号最多对截断源文本成立，不能证明完整文件中的后续行。

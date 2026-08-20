# Markdown 独立审阅 Tab：与 DSH-better-sidebar 的集成研究设计

研究日期：2026-08-20。外部源码固定为
[`6c891514b544b6e2da51fdab2eb3436cc02da246`](https://github.com/omdsh-dev/DSH-better-sidebar/tree/6c891514b544b6e2da51fdab2eb3436cc02da246)。

## 结论

**建议采用“窄 Side Panel + 独立 extension Tab 的 Markdown Review Surface”**：Side Panel 只保留文件入口和 Harness Workspace；点击 Markdown 时由 Extension background 创建或聚焦一个审阅 Tab。该 Tab 绑定打开时的 Harness 会话、工作区文件身份和内容指纹，显示源码/渲染预览、选区和批注；用户点击“送入当前会话”后，把受限的选区上下文送进该会话的 composer。文件能力的权威实现应是新的 **Harness Host+Client Cordis 产品插件**，由 Host 从 `session.header.cwd` 得到唯一 workspace；Extension background 仅代理受限的 Host review capability，绝不自行猜 cwd 或把本机权限交给 UI。

这不是 Browser Target：Browser Target 仍是由 Harness Run 绑定的用户浏览器页面；审阅 Tab 是 Harness Workspace 的产品界面。混淆两者会让模型错误地把本机 Markdown 当成可任意选择的浏览器写入目标。

下文用 **事实**、**推断**、**建议** 明确区分；“当前仓库”结论是本次工作区快照，且扩展/Native Host 文件已有并行未提交修改，不能视为冻结接口。

## 2026-08-20 实施状态与下载源码二次审计

M0 与 M1 已经落地，不再只是设计：`harness-ui-workspace-review` Host+Client 插件、Side Panel 懒加载 Markdown 树、独立 `markdown-review.html`、CodeMirror 源码选区锚点、安全预览、固定会话投递、统一 `ReviewFeedbackStore`、background capability/rehydrate 以及 Browser Target 隔离均已实现。M2 手工写盘仍明确不做。

对用户下载的 `/Users/zhanglt21/Downloads/DSH-better-sidebar-main` 再做源码级对照后，新增价值主要在体验层，而不是改变现有架构：

| 优先级 | 外部源码事实 | 当前 M1 对照 | 决策 |
| --- | --- | --- | --- |
| P0 | 文件树按目录缓存、refresh tick 清缓存，并把目录错误限制在当前层（[FileTree.tsx L67-L99](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/FileTree.tsx#L67-L99)）。 | 已有按目录懒加载、会话切换清缓存和旧请求隔离；缺少显式刷新按钮。 | 保留现有安全模型；增加“刷新树”属于低风险体验项。 |
| P1 | `TreePanel` 提供 300ms debounce、下一次输入 abort 上一次搜索，Host 搜索有 200 个结果/100000 个访问项上限且不跟随目录 symlink（[TreePanel.tsx L35-L62](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/TreePanel.tsx#L35-L62)，[fs-search.ts L46-L85](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/fs-search.ts#L46-L85)）。 | 当前只有懒加载树，没有全局 Markdown 文件名搜索。 | 值得作为下一步 P1，但必须复用 workspace root fence，只搜索 Markdown，并设更小预算；不能复制其任意文件搜索面。 |
| P1 | 文件行支持“引用到对话”、复制相对路径、打开新 Tab/侧边分屏（[FileTree.tsx L101-L147](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/FileTree.tsx#L101-L147)，[L256-L280](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/FileTree.tsx#L256-L280)）。 | 当前点击 Markdown 会按 `(sessionId, resourceId)` 复用独立 Review Tab；批注通过统一待发区进入对话。 | 不再增加第二种“直接塞路径到 composer”通道；可借鉴复制相对路径与刷新，继续保持单一 Review Tab 打开语义。 |
| P1 | CodeMirror 精确源码选区后把路径、行号与小于 500 UTF-16 单元的 quote 加入对话；预览选区仅在反向搜索唯一命中时给行号（[selection-payload.ts L23-L56](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/selection-payload.ts#L23-L56)，[L68-L85](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/selection-payload.ts#L68-L85)）。 | 当前锚点更强：UTF-16 range + quote/prefix/suffix + fingerprint，并在投递前重新 snapshot 核对；编辑草稿后禁用权威锚点。 | 现有实现优于外部项目，不能退化成纯文本插入或预览 DOM 反向猜测。 |
| P2 | EditorHost 支持树/编辑器合并、分屏、拖动宽度和 tab meta 持久化（[EditorHost.tsx L49-L84](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/EditorHost.tsx#L49-L84)，[L113-L149](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/EditorHost.tsx#L113-L149)）。 | 产品约束是窄 Side Panel + 独立浏览器 Tab。 | 不引入其 pane/split 布局状态机；会与浏览器 Tab 生命周期和现有 sidepanel UX 重复。 |
| 不采用 | TextEditor 带 Ctrl/Cmd+S 并直接走其 Host `fs.write`，同时支持 HTML iframe/终端/Git 等本机能力。 | M1 不写盘；文件能力只由 Workspace Review Host 授权，UI 不持有通用本机路径权限。 | 不复制。未来 M2 必须单独做 prepare/commit/readback、冲突与 uncertain 状态。 |

结论：下载源码**有用**，最值得吸收的是“有预算、可取消的文件名搜索”“显式刷新”“路径复制”和局部错误/加载状态；现有 capability、精确锚点、固定会话投递与 Browser Target 隔离应保持，因为它们比外部实现更适合 Chrome sidepanel 的安全边界。源码可按 MIT 参考，但当前没有必要复制其组件或把它作为 runtime 依赖。

## 1. 目标用户流程（建议）

1. 用户在当前 Harness Workspace 的紧凑顶栏点“文件”图标；窄 Side Panel 打开一个覆盖式/抽屉式的 Markdown 文件树，不再挤出第二列。树只按需展开目录，点击 `.md`/`.markdown` 后自动收起。
2. Host 先把用户点选的 session-relative path 换成 `{ reviewId, resourceId, capability, displayPath }`；Side Panel 再请求 background “打开审阅”。background 以 `(harnessSessionId, resourceId)` 去重，创建或聚焦 `chrome-extension://…/markdown-review.html?reviewId=…`。**不**切走或关闭 Side Panel，也不把 capability 放进 URL。
3. 审阅 Tab 经 background 代理向 Harness Host 请求受限文件快照，显示源码与安全渲染预览。M1 只承诺源码区选区能稳定映射到 Markdown offset；预览区选区要等 renderer 保留 mdast source position 后再开放，不用纯 DOM 文字伪造锚点。首次版可有本地编辑草稿，但“保存”必须显式走 Verified Write。
4. 用户框选文本、填写批注，审阅 Tab 生成批注项（引用、锚点、创建时指纹），并可点“送入会话”。M1 默认锁定“打开文件时的 Harness session”并显示会话标题；如 Side Panel 已切到另一会话，不得暗中改投，只能继续送回原会话或让用户显式重选。批注进入 composer 上方的结构化待发区，仍由用户按正常发送确认；不要静默替用户发消息。M1 的待发区是 Client-local：Side Panel 重载后如丢失，Review Tab 保留用户批注并明确提供“重新送入”，不假称已持久投递。
5. AI 在同一 Harness 会话读取该上下文并提出修改。若用户选择“应用修改”，Harness Host 重读并核对文件身份/指纹，再写入并回读；冲突时展示三方差异，不覆盖新版本。
6. 审阅 Tab 刷新、HMR 或 Native 重连后仅恢复 `reviewId` 和 UI 位置，重新取得权威快照；不能从浏览器持久化内容直接续写。若只是 MV3 background 重启，仍存活的 loopback Harness Client 可经 nonce/origin/sequence 验证后请求 Host 重签 capability；若 Harness Host/review record 也已重启或 Side Panel 不在，页面必须显示“请从文件树重新打开”，不承诺自动恢复授权。

## 2. 外部快照：可借鉴的机制与不能照搬的部分

### 事实：值得复用的工程模式

| 机制 | 固定快照一手证据 | 可吸收的原则 |
| --- | --- | --- |
| 惰性文件树 | [FileTree 在展开时每目录一次加载、局部错误显示](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/FileTree.tsx#L72-L99)，文件行可打开且不阻塞树 ([L193-L215](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/FileTree.tsx#L193-L215))。 | 使用按目录、分页/上限的懒加载；失败只降级该目录。 |
| 受限的本机路径处理 | [目录枚举限制条数、仅对 symlink 探测且有并发上限](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/fs-tree.ts#L46-L105)，路径包含判断避免 `startsWith` 误判 ([L120-L153](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/fs-tree.ts#L120-L153))。 | 文件树服务要有数量、深度、大小、符号链接和工作区围栏。 |
| tab/viewer registry | [注册唯一 id 并返回 disposer](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/service.ts#L511-L556)，viewer 按优先级、类型/内容探测匹配 ([L567-L595](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/service.ts#L567-L595))。 | M1 只借鉴“唯一 id + disposer + 局部错误隔离”；只有 Markdown 一个 adapter 时不先造通用 viewer registry。等 M3 出现第二种 viewer 再抽 seam。 |
| Markdown 编辑/预览 | [CodeMirror editor 在预览时仍保留，预览读取 `draft ?? saved`，Mermaid 按需加载](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/TextEditor.tsx#L122-L216)，保存成功才清 dirty ([L235-L259](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/TextEditor.tsx#L235-L259))。 | 可借鉴“本地草稿与预览共享状态、失败不清草稿”；保存语义必须升级为 CAS + Verified Write。 |
| 会话作用域状态 | [按 conversation id 存布局、展开节点和 tab，reload 隔离恢复](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/state.ts#L1-L10)。 | 本地只保存布局和 `reviewId`；业务权威状态仍在 Harness Host。 |
| 链接/打开拦截的克制 | [仅拦截普通左键、只接管 http(s)、同源和修饰键放行，并返回 disposer](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/link-intercept.ts#L22-L72)；`openPath` wrapper 在拒绝接管时回落原实现 ([L44-L61](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/openpath-intercept.ts#L44-L61))。 | 只对本工作区的 Markdown 文件入口接管；外链、二进制文件和带修饰键的操作必须保持原行为。 |
| HMR 与错误隔离 | [注册随 fiber disposal 清理、重激活只重验 changed chunk](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/index.tsx#L52-L53) ([L119-L124](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/index.tsx#L119-L124))；[per-tab boundary 不让一个 viewer 清空整个 shell](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/RenderBoundary.tsx#L21-L48)。 | 每个 preview/editor 包独立 boundary；重载后的 Tab 重新取快照并可重试。 |

### 事实：不能直接移植

- 外部项目的客户端把文件打开改路到其边栏编辑器（[intercept 的 `openSidebarFile`](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/intercept.tsx#L17-L26)），与本需求“点击 Markdown 必须独立 Chrome Tab”相反，不能照搬。
- 它的 `fs.read`/`fs.write` 是 DSH Web host 路由的直接文件系统 API（[API 面](https://github.com/omdsh-dev/DSH-better-sidebar/blob/6c891514b544b6e2da51fdab2eb3436cc02da246/src/client/api.ts#L120-L145)），并以会话 `cwd` 驱动。这里的 UI 没有该本机权限边界，不能让 extension Tab 直接模仿。
- 它把外部链接接管到 Sidebar；本产品的审阅 Tab 应只处理已验证的 workspace 文件，不应用 URL 规则把普通网页塞进 Markdown renderer。
- 它的布局持久化适合 UI；**推断**：若把 Markdown 内容、写入许可或旧指纹也放进 localStorage，刷新后可能对已变化文件写入，违反本仓库的 Write Fence 原则。

## 3. 当前仓库基线与缺口

### 已有能力（事实）

- Side Panel 已把 Harness 放进受 nonce 和 loopback 限制的 iframe bridge；只有显式 handoff 才携带 session ([harness-frame.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/sidepanel/harness-frame.ts:39))，且 loopback URL 被检查 ([同文件](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/sidepanel/harness-frame.ts:63))。
- 已有“完整 Harness Workspace 在 Side Panel/extension Tab 间切换”的事务；它会把关闭/打开交给 background，避免 Side Panel 自己关闭后继续执行 ([fullscreen-handoff.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/sidepanel/fullscreen-handoff.ts:9))。这可复用 background 负责 Tab 生命周期的原则，但不能复用“替换 Side Panel”的行为。
- UI 保存所选 Harness session，并把它作为 iframe 查询参数传递 ([main.tsx](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/sidepanel/main.tsx:163))；同时已对 iframe `postMessage` 校验 source、origin、nonce ([同文件](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/sidepanel/main.tsx:327))。
- Extension background 已用 `connectNative()` 维护 Native Messaging 生命周期，并按 request 类型路由 connector 请求 ([background.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/background.ts:2986))。Browser Target 转移前还会重新读取 Chrome tab 并比对 ([同文件](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/background.ts:3038))。
- Native Connector 已将 Run、Browser Target 集合冻结/关联 ([connector.mjs](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/native-server/src/connector.mjs:1152))，并拒绝 `runId`/generation/Browser Target 不匹配的回包 ([同文件](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/native-server/src/connector.mjs:1181))。
- 已有选择批注的 UI 先例：`AnnotationStore` 以 Harness session 隔离、只在 accepted ids 后删除 ([AnnotationStore.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-message-annotations/src/client/AnnotationStore.ts:17))。这适合借鉴“待发送、确认后清除”的状态机，而其 `messageId + selectedText` 不足以锚定文件版本。
- 已存在通用 seams：composer 文件接入、ordered composer submission transform、稳定 assistant-message marker ([upstream-contributions README](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/upstream-contributions/README.md:29)) ([同文件](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/upstream-contributions/README.md:38))；产品行为必须留在 `packages/`，upstream 保持干净 ([ADR-0007](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/docs/adr/0007-keep-deepseek-harness-as-clean-upstream.md:9))。
- `harness-ui-document-intake` 已是最接近的 Host+Client 先例：Host inject `sessions`、只从 `session.header.cwd` 取工作区并注册 exact Web route ([index.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-document-intake/src/index.ts:6))；Client 同源 fetch 后通过 `conversation.input.for(binding.ctx)` 把结果写回对应 composer ([intake.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-document-intake/src/client/intake.ts:40))。该模式比 Native Server 猜 cwd 更符合单一 agent workspace。
- `harness-ui-message-annotations` 已实际 inject `composerSubmissionTransforms`，prepare 只在 accepted send 后同步清除本地批注；应复用此“发送成功才清本地 snapshot”的语义，而不是新建 prompt 注入通道或假定它已是 Host receipt ([client/index.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-message-annotations/src/client/index.ts:7))。
- 已有 `sidebar.compact.action` 注入点（Browser Target 插件正在使用），所以文件图标可放此处，不需新 seam ([browser-target client](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-browser-target/src/client/index.ts:70))。

### 缺口（事实与推断）

- **事实**：当前 background 的 Native 请求判别面涵盖 Browser Target、`read_work_tab`、轻文档、知识等，而没有 workspace Markdown tree/snapshot/review 消息类型（[background.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/background.ts:600)）。
- **事实**：当前正式轻文档写入已经有 challenge、资源指纹、idempotency record、核验结果与不确定写入禁止自动重试的模式 ([connector.mjs](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/native-server/src/connector.mjs:1690))；Extension 侧同资源写入也串行化 ([background.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/background.ts:1837))。
- **推断**：Markdown 工作区审阅应新增一个专门的 Harness Host+Client Cordis 产品插件，而不是误用 Office Connector 或 Browser Target 工具。Host 从 session 的受控 cwd 导出 resource identity；不能接受 UI 提供的任意绝对路径。
- **事实/风险**：`availableTabs()` 直接把 `targetFromActionTab()` 的结果放进 Browser Target roster ([background.ts](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/chrome-extension/entrypoints/background.ts:1205))。当前需明确拒绝 `chrome-extension:` 审阅 Tab，否则用户聚焦 review Tab 时可能污染 follow-active-tab 或 pinned target 候选。

## 4. 推荐跨层模块、接口和消息协议（建议）

```text
packages/harness-ui-workspace-review (Host + Client Cordis 双半)
  Host: session.header.cwd fence + tree/snapshot/CAS routes + review capability
  Client: sidebar.compact.action 文件入口 + review context/composer transform
             │ origin+nonce-checked postMessage: markdown-review-open/v1
Chrome Side Panel shell ──► Extension background ──► Markdown Review Tab
                    same trusted cap │                (render/editor/anchors)
                                    background proxy  │
                                      to exact Host route┘
```

### 模块责任

| 层 | 新模块/接口 | 责任与边界 |
| --- | --- | --- |
| `packages/` Host | `harness-ui-workspace-review` | inject `sessions`，以 `ctx.sessions.get(sessionId).header.cwd` 为唯一 root；注册 exact Host routes：`open/list/snapshot/prepare-write/commit-write/readback`，签发短时 opaque review capability。结构以现有 document-intake Host half 为模板。 |
| `packages/` Client | `harness-ui-workspace-review/client` | 通过既有 `sidebar.compact.action` 放文件图标与覆盖式懒加载树；从当前 session 调 Host `open`，仅将 `{ reviewId, resourceId, capability, displayPath }` 通过既有 nonce/origin bridge 交给 extension；接收 background 转发的有界 feedback bundle 并幂等导入本地 store。 |
| `packages/` Client | 通用 `ReviewFeedbackStore` | 将现有 assistant-message 批注和 workspace-markdown 批注建模为两个 adapter，共用一个 Client-local 待发条、一个 `composerSubmissionTransforms` 注册和 accepted-only 本地清理。这里已有两种真实来源，共享 seam 比并排两套 store/prompt 更深；M1 不把同步 `accept()` 假装成 Host 异步 receipt。 |
| Extension UI | `markdown-review` entrypoint | 纯视图：源码/预览、选区锚点、草稿和批注。所有数据由 background 请求；renderer 禁止执行 HTML/脚本。 |
| Extension background | `MarkdownReviewTabRegistry` + `WorkspaceReviewBridge` | `tabs.create/update`、去重和 `reviewId` 路由；验证 extension sender、session/窗口关联、消息版本和大小；仅按固定 Host 路径代理含 bearer capability 的请求，不接受 UI path/CWD。capability 只留内存；丢失时走受验证的 `rehydrate-review` 或明确要求重开。 |
| Native Server | 不拥有文件 adapter | 保留 Native Messaging/Harness 生命周期与协助 background 访问当前 loopback Host 的职责；不得重复推导 session cwd、实现第二个文件授权体系或暴露 token。 |
| 可选 seam | 本方案无需新增 seam | `sidebar.compact.action` 与 `composerSubmissionTransforms` 已存在；只有其公开契约确实无法支持时，才提产品中立 seam。 |

### 最小消息协议

所有消息带 `v: 1`、随机 `requestId`，并设置严格 schema、最大长度和超时。`reviewId`、`resourceId`、`fingerprint` 与 capability 均由 Host 返回，UI 不得自造；workspace/cwd 保持在 Host 实现内部。

```ts
type OpenReviewHandoff = {
  v: 1; type: 'markdown-review-open'; requestId: string
  harnessSessionId: string; reviewId: string; resourceId: string; displayPath: string
  capability: string // parent 交给 background 后留在内存，不进 Tab URL/storage
}
type FileSnapshot = {
  v: 1; type: 'markdown-review-snapshot'; reviewId: string
  resource: { resourceId: string; displayPath: string; revision: string; fingerprint: string }
  content: string; truncated: boolean; readOnly: boolean
}
type SelectionAnchor = {
  version: 1; startUtf16: number; endUtf16: number; quote: string
  prefix: string; suffix: string; sourceFingerprint: string
}
type DeliverAnnotation = {
  v: 1; type: 'markdown-review-deliver'; reviewId: string
  harnessSessionId: string; deliveryId: string
  annotation: { id: string; anchor: SelectionAnchor; comment: string }
}
type PrepareWrite = {
  v: 1; type: 'markdown-review-prepare-write'; reviewId: string
  expected: { resourceId: string; revision: string; fingerprint: string }
  contentHash: string
}
type CommitWrite = {
  v: 1; type: 'markdown-review-commit-write'; reviewId: string
  approval: string; idempotencyKey: string; content: string
}
```

Host 的同源 `open` route 可接收 `{ harnessSessionId, relativePath }`，但必须重新从 `session.header.cwd` 解析并验证。从 Host 返回 capability 之后，Tab/background 界面只使用 `reviewId/resourceId`；`workspaceId` 和绝对 cwd 不必成为浏览器协议的一部分。`FileSnapshot.content` 是 Bounded Result：超过上限时返回 `truncated: true`、页/段落范围和可继续读取的 opaque handle；不可把整个仓库装进 iframe 或模型 prompt。

`deliver` 先由 background 调固定 Host route 复核 review/session/fingerprint，只返回一个已验证、有界、带 `deliveryId` 的 feedback bundle；background 再转发给 Side Panel，外层通过已有 nonce/origin bridge 交给指定 session 的 `ReviewFeedbackStore`。Client 按 annotation id 去重，导入成功即向 Review Tab 返回“已送入待发区”；composer 成功受理后的同步 `accept()` 只清本地 snapshot。Review Tab 保留原批注，所以 Side Panel 重载后可由用户显式重送。若未来要求“跨 Client 重载也精确一次”，必须新增可等待、可观测的异步 completion/outbox seam，不能用当前 `() => void` 的 accept 隐式实现。

`rehydrate-review` 不由 Review Tab 自己重签：background 在内存 capability 丢失后，向当前 Side Panel 请求恢复；外层只接受已验证 iframe source/origin/nonce/sequence 的回复，再由 loopback Client 同源调 Host 重签与原 `reviewId/resourceId/sessionId` 一致的短时 capability。Host record 不存在、session/cwd 变化、Side Panel 不在或超时都不降权，只返回“从文件树重开”。Host 的同源 `open/rehydrate` route 与 background 代理的 bearer route 要分开定义 guard；不能原样复制 document-intake 的 same-origin 检查。

## 5. 身份、锚点、冲突与 Verified Write（建议）

### 身份和打开 Tab

- Tab 路由键是 `reviewId`；去重索引是 `(harnessSessionId, resourceId)`，但每次聚焦都经 background 代理向 Harness Host 重新确认 `revision/fingerprint`。同一文件在不同 Harness session 可开不同 review。
- background 保存 `{ reviewId, tabId, harnessSessionId, resourceId, displayPath }` 到 `chrome.storage.session`；Tab 恢复时先验证这个记录，再调用 `snapshot`。不把内容、capability/grant 或 Connector token 写入 storage；Host/Harness 重启后旧 capability 失效，页面明确要求从文件树重开。
- 手工改 URL、另一个 extension sender、过期/不存在 reviewId 返回明确错误并关闭或显示“重新从文件入口打开”；不要把 query path 当成权限。
- Side Panel 的既有 Workspace 全屏切换使用单会话 handoff；Markdown Tab 不应复用此切换事务，否则会关闭用户保持窄侧栏的需求。

### 选区与批注投递

- 以 UTF-16 range 作快速定位，同时存 `quote + prefix + suffix` 作为漂移后重锚定证据，且每个 anchor 存 `sourceFingerprint`。
- M1 选区只从 CodeMirror/source surface 产生，因为它能给出精确 offset。预览区批注必须先将 mdast `position` 传到渲染节点，并定义跨节点选区映射；这是 M3，不得只靠 `selection.toString()` 猜源码位置。
- 发送时 Harness Host 重新读取同 resource；指纹相同则带 quote/range/comment 的紧凑上下文投递 composer。指纹不同则先用 quote/prefix/suffix 重锚；唯一匹配可标记为 `rebased` 并要求用户确认，零/多匹配标记 `stale/ambiguous`，不自动送 AI。
- 投递消息应包含 `resourceId/displayPath/revision/fingerprint` 和最多 N 个批注、每条 quote/批注长度上限；默认不传整个文档。Client 导入 ack 后 Review Tab 把该批注标为“已送入待发区”但保留可重送副本；composer accepted send 后只从 `ReviewFeedbackStore` 本地 snapshot 删除该次冻结的 ids。

### 编辑和写入

M1 的 AI 优化走 Harness 既有本地文件工具：批注 prompt 只携带相对路径、指纹、有界 quote/上下文和修改意图，要求 Agent 先重读再修改。下面的 Host write 流程只服务于 M2 中用户在 Review Tab 手工保存，不额外替代或包装 Agent 的官方工具。

1. `snapshot` 返回 resource identity、revision、fingerprint 和正文；编辑仅是 Tab 本地草稿。
2. “保存”先 `prepareWrite`：Harness Host 从 `reviewId/resourceId` 找回其内部绑定的 session header cwd 与相对路径、重新 realpath/重读、核对 fingerprint，生成短时一次性 approval，其中绑定 `harnessSessionId`、`reviewId`、资源、预期 revision、内容 hash。
3. `commitWrite` 进入按 `resourceId` 串行的 Write Fence，重复核验审批和当前 fingerprint，原子写入，重读并比较内容 hash/new revision。
4. 仅 `(write succeeded && readback matches)` 返回 `verified_write`。超时/中断为 `uncertain`：保留记录、禁止自动重试，要求用户重新读并合并。与既有 Office 写入的 uncertain 处理一致。
5. 若 preflight 发现版本不同，返回 `{ status: 'conflict', latestSnapshot }`；UI 展示 base/ours/theirs，并要求用户选择重新载入、手工合并后新 preflight，绝不 last-write-wins。

## 6. 里程碑与验收矩阵（建议）

| 里程碑 | 范围 | 自动验收 | 真实验收/回读 |
| --- | --- | --- | --- |
| M0 协议与 Host+Client 骨架 | schema、`session.header.cwd` root fence、树/快照 Bounded Result、review registry、bearer/same-origin route guards、`rehydrate-review` 降级语义 | 路径穿越、symlink、超大文件、无效 sender/reviewId、capability TTL/重放、schema/timeout 单测 | `connectNative()` 后 background 可代理固定 Host route 并创建 Tab；只重启 background 可受验证重签，Host 重启则明确要求重开；审阅 Tab 不能进入 Browser Target roster。 |
| M1 只读审阅 MVP | Side Panel 文件入口、独立 Tab、源码/安全预览、选区/批注、送入 composer | renderer XSS、anchor 序列化、Tab 去重、HMR reload、单 session 隔离 | 保持 Side Panel 窄栏，点 `.md` 打开 extension Tab；选择文本+批注后在**同一** Harness 会话 composer 看见结构化上下文并正常发送。 |
| M2 可控写入 | local draft、prepare/commit、冲突 UI、readback | 同资源并发、指纹变化、approval 重放、崩溃后的 uncertain、readback mismatch | 修改 Markdown，核对磁盘/adapter readback/new fingerprint；外部改文件后保存必须冲突而非覆盖。 |
| M3 体验完善 | 多预览 viewer、差异、批量批注、恢复 | viewer registry disposer、每 pane boundary、性能/内存 | Chrome 重载、Native 重启、Tab 关闭重开、升级后旧 `reviewId` 的降级提示。 |

以下是上线前不可替代的 P0：实际加载 unpacked extension；Native Host 指向当前 extension ID；真实 `connectNative()`；Side Panel + 审阅 Tab 同时存在；同会话 composer readback；一次真实写入的 Native 回读；一次外部修改后的冲突 readback。仅 build、ZIP、ping 或打开空 Tab 都不是验收。

## 7. 安全、性能和升级风险

| 风险 | 控制措施 |
| --- | --- |
| 任意本机路径/符号链接逃逸 | Host-only `session.header.cwd` root fence，规范化相对路径，realpath/符号链接策略，禁止 UI absolute path。 |
| renderer XSS / Markdown 链接跳转 | Markdown sanitize，禁用脚本/内联 event handler/危险 URL；外链显式用 Chrome 新页打开，不能借 renderer 权限。 |
| 跨会话或重放投递 | review 绑定 `harnessSessionId`，background sender/origin 验证，nonce/requestId、TTL、`deliveryId` 与 Client 导入去重；M1 明确不承诺跨重载 exactly-once。 |
| 脏读、覆盖外部修改 | fingerprint + revision + Write Fence + short-lived approval + readback；uncertain 禁止自动 retry。 |
| 巨大文档/树卡死 | 分级 listing、页/字节上限、懒加载、worker/按需 renderer；预览和搜索可取消。 |
| HMR/Tab/NM 断线 | Tab registry 只恢复 identity/UI；background 独自重启时可经存活 Side Panel 受验证重签，Host 重启/无 Side Panel 则要求重开；per-viewer ErrorBoundary；不将缓存草稿标为已保存。 |
| upstream 升级 | 新能力首先放 `packages/`、extension、Native Server；只在通用 Composer slot 真缺失时做 product-neutral seam，持续跑 `verify:upstream`。 |

M0 还必须把新包加入四个已有物化入口：`harness-process.mjs` 的 `productUiPackages()`、`register-native-host.mjs` 的安装清单、`build-harness-client-plugins.mjs` 的构建清单、根 `package.json` 的 `typecheck:plugins`。配套包契约测试，然后 `pnpm dev:refresh -- --fast` 并重新注册/重启 Native Host；否则源码存在也会静默不生效或丢出安装包。

## 8. 明确推荐的 MVP 与暂缓项

**推荐 MVP（M1）**：工作区 Markdown 树入口、一个独立审阅 Tab、CodeMirror 源码 surface + sanitize preview、源码选区/批注、以打开时 Harness session 为边界的“插入 composer 上下文”、单文件/单会话去重、Harness Host 权威 snapshot 与断线/渲染失败恢复。源码 surface 在 M1 可先保留本地草稿供继续问 AI，但不显示“已保存到磁盘”；手工写盘放 M2。

**暂缓**：任意本机路径、Git/终端、自动写盘、批量跨文件变更、浏览器链接接管、把审阅 Tab 当 Browser Target、后台自动发送 prompt、从浏览器持久化恢复写入许可、照搬 DSH-better-sidebar 的 DSH Web DOM/`openPath` takeover。

M2 才允许显式保存，前提是上述 prepare/commit/readback 与冲突验收都已完成。这样先实现用户最需要的“独立审阅 + 选区批注送回当前会话”，而不引入不可回读的本机文件写入面。

## 9. 最重要的五条结论与残余未知

1. 独立 extension Tab 是正确容器；现有 full-screen handoff 的 background-owned 事务可借鉴，但它会替换 Side Panel，不能直接复用。
2. 外部项目最有价值的是可撤销 registry、session-scoped UI state、局部错误隔离和克制拦截；直接 `fs.write`/DSH Web DOM 注入不符合本仓库信任边界。
3. Markdown review 不是 Browser Target；文件能力应由新的 Host+Client `WorkspaceReview` 产品插件管理，background 仅代理 opaque capability，所有 UI 路径只是 identity。
4. 批注必须同时带 range、quote、上下文和 source fingerprint；发送/写入前重读，漂移要显式重锚或冲突。
5. MVP 应只读并将用户确认的上下文送回当前会话；写入放到有 preflight、Write Fence 和 readback 的下一里程碑。

### Browser Target 防污染（必须纳入 M0）

**事实**：当前 `targetFromActionTab` 是 Browser Target roster 的入口，`availableTabs()` 直接依赖它。**建议**：在它或更早的 tab-filter 增加硬拒绝：`chrome-extension:` 审阅页面、Harness sidepanel/fullscreen extension 页面和其空 URL 都不能成为 Browser Target；若一个已绑定 target 导航到这些 URL，则按 `closed_or_changed` 处理并要求用户重新选择真实网页。

仅“过滤 roster”还不够：`follow-active-tab` 在 Connector 请求时会重读当前 Chrome tab。background 打开 Review Tab 前必须记住该窗口最后一个 eligible Browser Target；当活动页是产品内部 Tab 时，`activeBrowserTarget()`/实时 Connector 转移仍解析这个经重读验证的 eligible target，而不是把审阅页作为 target 或突然返回泛化错误。测试要覆盖 follow-active-tab、pinned-tabs、转移前复查以及 review Tab 被聚焦后的 Browser Connector 请求。

### 路径选择：推荐与备选

**推荐路径**：新建 `packages/harness-ui-workspace-review` Host+Client 双半。Host 借鉴 document-intake 的 route/`session.header.cwd` 边界；Client 复用 annotations 的 submission-transform accepted-only 本地清理。WXT review page 保持 extension HTML Tab，由 background 以固定的 Host review route + in-memory capability 代理，避免放宽 loopback Host 的 CORS 或让 Tab 获取通用 Host 访问权。

**备选路径（不推荐作为首选）**：由 Native Server 新建 `WorkspaceReviewAdapter` 后在 Native Messaging 上传输树/文件/CAS。它可行，但会重复 session-to-cwd 解析和 write authorization，容易与 Harness Host workspace 语义分叉；仅当 Host 插件无法可靠服务当前 session，且能证明 Native 层拥有同一权威 session identity 时再评估。

残余未知（需 M0 钉死）：Harness Host 到 extension-background 的最小 capability 交接方式；Harness workspace 的正式稳定 identity/根目录来源；当前并行中的 background/Native Host 改动最终会保留的 Tab/session handoff API；大文件预览的确定字节上限与渲染库选择；M3 预览 DOM 选区到 mdast source position 的映射策略。

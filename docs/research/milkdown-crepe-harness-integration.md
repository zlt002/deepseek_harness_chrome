# Milkdown Crepe × Harness Workspace：可执行整合研究

> 研究日期：2026-08-24。官方仓库以 shallow clone 固定在
> [`bb9b3867`](https://github.com/Milkdown/milkdown/tree/bb9b3867edc535c0aea31bdd15e7110808b26324)
> （`@milkdown/crepe` `7.22.1`）；本地副本：`/Users/zhanglt21/Desktop/accrnew/vendor-research/milkdown`。
> 本文只给出设计与验收建议，不改变产品实现。

## 结论

**保留现有“选区批注 → Harness 会话 → `propose_workspace_markdown_edit` → Milkdown Diff”的主链，
不要把 Crepe 内置 AI 当成第二个直连模型入口。**

当前实现已经用官方 streaming/diff 在一个 detached `EditorState` 中把 Harness 已完成的候选变成
可接受/拒绝的 Diff；这正好隔离了 Harness 的会话、权限和工具调用。Crepe 的 AI feature 应先作为
**可选的 Harness streaming adapter** 加在同一条链上：其 `provider` 只转发到受控的 Extension
background/当前 Harness 会话，不保存模型密钥、不绕过选区登记、更不写文件。

这样分工清晰：Milkdown 管编辑器事务、流式显示和本地 Diff；Harness Workspace 管 AI 会话、上下文、
取消可见性和模型选择；Workspace Review Host 管 Resource Identity、Approval Grant、Write Fence 与
Verified Write。

## 已核实的能力与边界

| 能力 | 官方事实 | 对本项目的结论 |
| --- | --- | --- |
| Crepe AI feature | `AI` 默认关闭；启用后装配 diff、diff component、streaming、AI instruction UI、streaming indicator 和 Diff actions。没有 provider 也仍装配 diff/streaming。 | 当前仅 `{ [CrepeFeature.AI]: true }` 是合法的“手工 streaming/Diff”用法；不应让一个会注定失败的内置 AI 菜单暴露给用户。 |
| Provider 契约 | `AIProvider(context, signal) => AsyncIterable<string>`；上下文只有 `document`、`selection`、`instruction`；`runAICmd` 无 provider 时返回 `false`。 | Harness adapter 必须在 UI/bridge 层另带 `reviewId`、`selectionId`、Resource Identity、base fingerprint 和 invocation id；它们不能被伪装成 Markdown 或放入模型凭据。 |
| 流式替换 | `runAICmd` 有选择时以 `insertAt: 'selection'` 开流；streaming 保存原文，默认每 100ms parse/diff/apply；结束可 `diffReview: true`，abort `{ keep: false }` 恢复原文。 | 可以直观显示 token；取消或 provider 失败必须恢复编辑器原文，并向 Harness 发 cancel。流式可中间显示，绝不意味着磁盘已改。 |
| Diff 审阅 | Diff 比较两份 ProseMirror 文档；审阅期间锁编辑；支持块/范围/全部接受或拒绝；Crepe 已把 `table`、`image-block`、`code_block` 设为 custom block types。 | 应把“接受 AI 建议”和“保存文件”拆开。接受只更新本地 draft；保存仍走已有 prepare → explicit approval → commit → same-resource readback。 |
| 参考 provider | 官方 OpenAI adapter 用浏览器 `fetch`、AbortSignal 和 SSE，且注释明确 BYOK provider 不可整体记录/序列化。 | 不能复用此 adapter 把 API key 或 Harness credential 放进 review tab；只可借鉴 async-generator 和 abort 形态。 |

主要官方证据：

- [Crepe feature configuration](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/docs/api/crepe.md#L1-L28)
- [AI types and provider contract](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/packages/crepe/src/feature/ai/types.ts#L14-L105)
- [AI command orchestration, cancellation and error rollback](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/packages/crepe/src/feature/ai/commands.ts#L128-L290)
- [streaming API and context-dependent insertion](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/docs/api/plugin-streaming.md#L1-L170)
- [Diff API and custom block handling](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/docs/api/plugin-diff.md#L1-L144)
- [official OpenAI browser adapter](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/packages/crepe/src/llm-providers/openai/index.ts#L44-L96)

## 当前状态、已具备部分与真实缺口

| 层 | 已具备（本工作树审阅） | 缺口 / 不应误判为已具备 |
| --- | --- | --- |
| 编辑器 | `VisualMarkdownEditor` 启用 `CrepeFeature.AI`；普通候选直接 `startDiffReviewCmd`；选区候选在 detached state 依次 `startStreaming(selection)`、`pushChunk`、`endStreaming(diffReview)`。 | 未配置 Crepe `provider`，因此内置 `runAICmd` 不能调用 AI；没有原生 Harness token streaming。 |
| 选区 | 传出 `quote`、ProseMirror `from/to`、`editorRevision`、block 摘要和文件 fingerprint；返回时以 revision、范围和 quote 复核。 | `from/to` 不是 Markdown 文件 offset；`nodesBetween` 会把 table cell 与其 paragraph 都列为 block，且没有行/列/整表结构契约。 |
| Harness 回路 | `propose_workspace_markdown_edit` 只排队候选，绑定调用会话与 selection；Tab 再拉取并显示 Diff。 | 这是非流式候选回传，尚无 invocation 级的 progress、cancel、retry/sequence 协议。 |
| 保存 | Host 复核 fingerprint、一次性 approval、按 Resource Identity 的 Write Fence、content-hash 幂等，再原子写和同资源 readback。 | AI Diff accept 不是 Verified Write；不可在 accept 后显示“已保存”。 |
| Mermaid | 当前自定义 decoration 将 Mermaid code block 渲染为受限可视预览，渲染失败保留源码。 | 流式/候选更改 Mermaid 时只能以源码作为真相；不可把生成 SVG 当 Markdown round-trip 的权威表示。 |

对应本地定位：

- [`visual-markdown-editor.tsx`](../../apps/chrome-extension/entrypoints/markdown-review/visual-markdown-editor.tsx) 第 202–419 行：Crepe 生命周期、diff/streaming candidate 及 accept/reject。
- [`visual-selection.ts`](../../apps/chrome-extension/entrypoints/markdown-review/visual-selection.ts) 第 13–104 行：视觉选区模型明确不是 source offset。
- [`workspace.mjs`](../../packages/harness-ui-workspace-review/src/workspace.mjs) 第 181–304 行：selection/proposal 与 Verified Write 事务。

## 推荐架构：一个 AI 会话事实源，两个可选呈现方式

```text
Crepe visual selection / comment
  │  anchor {reviewId, selectionId, editorRevision, quote, structure, baseFingerprint}
  ▼
Review Tab ──versioned request──► Extension background ─► current Harness session
  │                                      │                         │
  │                                      └─ cancel/progress ◄──────┘
  │
  ├─ A. 默认：Harness tool proposal ─────────► queued candidate ─► Milkdown Diff
  └─ B. 可选：Harness streaming adapter ────► AsyncIterable chunks ─► Milkdown streaming → Diff
                                                                         │
                                                                    user accepts
                                                                         ▼
                                                                local Markdown draft
                                                                         │ explicit save only
                                                                         ▼
Host: Resource Identity → fingerprint check → Approval Grant → Write Fence
      → atomic write → same-resource readback = Verified Write
```

### A. 默认链：继续使用 tool proposal（首选、先上线）

1. 用户稳定选区后写批注；Review Tab 向 Host 登记带 fingerprint 的 anchor，并把有界的批注送到**当前绑定的 Harness 会话**。
2. 模型只用 `propose_workspace_markdown_edit` 返回候选 Markdown；该工具的语义保持“queued proposal”，禁止把它描述为文件写入。
3. Review Tab 验证 proposal 的 `selectionId`、base fingerprint、editor revision、range 和 quote，之后以现有 detached streaming + Diff 审阅。
4. 用户接受/逐项拒绝后，再由显式“保存”触发既有 Verified Write。

该路径已经匹配项目的 Connector/会话边界，不需要新 provider，也不会在 Extension renderer 暴露 Connector Credential。

### B. 原生流式模式：只作为同一 Harness 链的适配器

适用条件是 Harness 能为一次“修改此选区”的生成提供按 token/小块的事件流，并可取消。不要令 Crepe 直接请求模型服务。

`HarnessAIProvider` 的职责应很窄：

1. 点击自有“让 AI 修改”入口时，先注册 selection，生成 `invocationId`，冻结 `baseFingerprint` 和 editor revision；这些是 bridge metadata，非 prompt 文本。
2. `provider(context, signal)` 通过 background 发起 `markdown-review-ai-start/v1`。`context` 只贡献经过 Bounded Result 策略后的 selection/document/instruction；background 负责校验 sender、review/session binding 和请求大小。
3. background 将事件按 `(invocationId, sequence)` 转成 `AsyncIterable<string>`。只接受当前 invocation 的单调序号；断线、过期 capability、session 不匹配或超出长度上限都以真实、可行动的错误终止。
4. `signal.abort` 必须向同一 invocation 发送 cancel；本地立即 `abortStreaming({ keep: false })`。迟到 chunk 直接丢弃，不能复活已取消的编辑。
5. 正常结束才 `endStreaming({ diffReview: true })`。Harness 失败、格式损坏、超时均恢复原文，保留批注和“重试”入口；错误文案保留具体根因，不能泛化成“AI失败”。

不要把 `AIPromptContext.document` 当作任意大小的全文件上传通道。默认 `buildContext` 会序列化整个文档与选区（[source](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/packages/crepe/src/feature/ai/context.ts#L7-L45)）；Harness adapter 应设自定义 `buildContext`，并以当前 anchor、有限前后文和服务器重新读取为准。全文件只有在已获授权、未截断且在模型上下文预算内才发送。

### 会话、取消、失败与幂等规则

| 情形 | 必须行为 |
| --- | --- |
| 第二次点击 / Diff active | 禁止并显示当前任务状态。官方 `runAICmd` 也会拒绝 active streaming/diff；产品层应让原因可见。 |
| 用户取消 | 同时取消 Harness Connector Job 和 Milkdown streaming；默认回滚到开流前文档；不得生成 proposal、不得写盘。 |
| 可重试失败 | 新建 `invocationId`，但复用同一冻结 anchor 仅在 fingerprint/revision/quote 仍成立时；否则要求重新选择。 |
| 网络 ACK 丢失 | `start` 携带客户端 request id；Host/background 对同一 `(sessionId, reviewId, invocationId)` 返回同一 Job/状态，不能开始两份生成。 |
| 迟到 chunk / 重放 | 按 invocation + sequence 去重；已 ended/cancelled 的 invocation 永不再接收 chunk。 |
| 接受 Diff | 仅更新编辑器 draft；不生成 Write idempotency key。 |
| 保存 retry | 只在同一内容 hash 使用同一 write idempotency key；`uncertain` 不自动重试，先重新读取并让用户决定。 |

## Markdown round-trip 与复杂块：上线前必须封口的风险

| 内容 | 风险事实 | 产品规则 |
| --- | --- | --- |
| Markdown 原格式 | Milkdown 是 parse → ProseMirror → serialize，不是 source-byte preserving；视觉位置不能反推旧 Markdown offset。 | 保存以“当前导出的完整 Markdown + 当前 fingerprint”为目标；对 front matter、HTML、reference links、空白/换行制定是否允许规范化的明确测试基线。 |
| 表格 | streaming 在 table cell 的默认策略是 plain text，换行折成空格；Diff 虽将 table 作为 custom block，仍不保证部分单元格候选的列数、对齐或分隔行语义正确。 | M1：选区触及表格时只接受**整表**候选，anchor 携带 table/row/cell 边界；校验表头、分隔行和每行列数，否则拒绝进入 Diff。不要把 cell 与 inner paragraph 作为同级 blocks。 |
| Mermaid | Mermaid 是 `code_block` 的一种源码方言；预览是派生、异步且可能失败。 | AI 只替换 Mermaid 源码块；接受后重渲染。SVG sanitize/渲染失败不改变 source，且失败状态不能阻断手工保存。 |
| code block / HTML / 自定义 node view | 官方 custom-block diff 是 block replacement 的显示策略；并非对任意 Markdown 扩展的语义证明。 | 按类型 allowlist：M1 先覆盖 CommonMark+GFM、table、fenced code、Mermaid；未知 HTML/自定义块走只读或整块候选，并保留原文。 |
| 大文档 | streaming 每次 flush 会 parse/diff/apply，官方类型注明默认 100ms；diff 实现也在大容器（>500 children）退化为单步路径。 | 限制一次编辑块数/字符、支持 cancel、为大文档改为非流式候选。量测真实扩展 bundle/内存，而非仅依赖单测。 |

官方具体依据：[streaming configuration/types](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/packages/plugins/plugin-streaming/src/types.ts#L19-L75)、[streaming final handoff](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/packages/plugins/plugin-streaming/src/streaming-commands.ts#L121-L160)、[diff LCS guard](https://github.com/Milkdown/milkdown/blob/bb9b3867edc535c0aea31bdd15e7110808b26324/packages/plugins/plugin-diff/src/diff-compute.ts#L21-L32)。

## 紧凑 PRD 审阅/编辑 UI

目标是让“生成、审阅、保存”三个状态清楚且不挤占正文；侧边栏继续是 Harness Workspace，对话不被 Review Tab 替代。

```text
┌ 文件名 · 当前版本              [外部更新] [保存草稿] ┐
│ 状态：未保存 / AI 生成中 / 待审阅 / 正在确认写入 / 已 Verified Write │
├──────────────────────────────────────────────────────┤
│                        Crepe 正文                      │
│  选中稳定后： [添加批注]  （不自动弹出大面板）          │
│  批注浮层：引用摘要 + 指令输入 + 发送 / 取消             │
│  Diff 内嵌：逐项接受/拒绝；页脚 [全部拒绝] [全部接受]    │
├──────────────────────────────────────────────────────┤
│  变更摘要 N 项 · 未保存                              [保存草稿] │
└──────────────────────────────────────────────────────┘
```

- **选区入口**：至少稳定 500ms 后显示小型“添加批注”按钮；选区变化重置计时。输入框保持用户 draft；取消只关闭浮层。
- **生成中**：在受影响选区附近显示“正在请求 Harness… / 停止”，而不是另起整页 loading。Harness progress/tool 仍在侧边栏可见。
- **Diff**：优先保留 Crepe 的行内 accept/reject；顶部或底部只有“全部接受 / 全部拒绝 / 重试”，不再复制一个第二套全文 diff viewer。
- **保存**：按钮文案根据状态精确变化。`prepare` 后显示“确认写入”；只有 same-resource readback 成功后才显示“已 Verified Write”。外部变化显示冲突，不提供 last-write-wins。
- **窄屏**：正文优先，批注 editor 改为 anchored bottom sheet；文件身份、dirty 状态和停止按钮始终可见。键盘可完成批注、取消和 Diff accept/reject，所有 icon 有中文 accessible name。

## 分阶段实施与验收

| 阶段 | 交付 | 不做什么 | 自动验证 | Edge UAT / readback gate |
| --- | --- | --- | --- | --- |
| P0（当前） | 保留已有 tool proposal → Diff → Verified Write；关闭或隐藏无 provider 的 Crepe AI palette。 | 不做直连模型。 | selection stale、proposal fingerprint、Diff accept/reject、write fence/idempotency/readback 回归。 | 加载当前 unpacked extension，打开真实 `.md`，确认候选只进入 Diff，accept 后仍显示未保存。 |
| P1 | 表格结构 anchor/validation；Mermaid 与 round-trip fixture corpus。 | 不支持半表/未知 node 自动修改。 | 2×3、合并/空 cell、重复文本、代码、Mermaid、front matter、外部改写冲突。 | Edge 中选整表和 Mermaid，拒绝畸形候选；接受后确认预览与源代码一致。 |
| P2 | `HarnessAIProvider` 和 versioned start/chunk/end/cancel bridge。 | 不暴露 API key，不新建第二条 AI 会话。 | AbortSignal、chunk reorder/replay、late chunk、timeout、retry、provider error rollback、single active invocation。 | 在真实 Harness 侧边栏启动生成、停止、断线重连；确认工具进度可见，取消后正文严格回到基线。 |
| P3 | 紧凑 UI、性能阈值、可访问性与恢复。 | 不把 review Tab 作为 Browser Target。 | bundle/CSP、large doc throttle、focus/keyboard、screen reader labels、Tab reload。 | Edge 刷新/关闭重开、外部编辑冲突、一次真实保存的 same-resource readback；写入后重读磁盘与 UI identity。 |

每个代码阶段按仓库验证链执行：`pnpm verify:upstream`、`pnpm typecheck`、`pnpm typecheck:plugins`、`pnpm test`、`pnpm build`；涉及 `packages/` 时用 `pnpm dev:refresh -- --fast`，并重开侧边栏。静态构建或 HTTP 200 不替代 Edge 的已加载扩展、实际 Harness 会话、写入回读三项证据。

## 最终决策建议

现在应批准 **P0 + P1**：继续把 Milkdown 当可视编辑/Diff 引擎、把 Harness 当唯一 AI 编排面，并先堵住表格和 round-trip 风险。只有在真实 Edge UAT 证明“用户需要看见 token 逐步生成”且 Harness 能提供可取消事件流时，再做 P2 provider adapter。这样不会破坏现有 Verified Write 边界，也不会将一个 editor UI feature 误升级成新的凭据、权限或写入通道。

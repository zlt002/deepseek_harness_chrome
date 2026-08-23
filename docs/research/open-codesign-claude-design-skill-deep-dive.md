# Open CoDesign 与 claude-design-skill：源码级迁移评估

审查对象固定为：

- Open CoDesign：`/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign`，`b94d7156bf4aeb2c79892c91dc9934911a4e3741`。
- claude-design-skill：`/Users/zhanglt21/Desktop/accrnew/open-source-research/claude-design-skill`，`35a20e5ada2c9e768d1bc094ce1ef3218f48684b`。

结论先行：**迁移协议与交互思路，不迁移 Open CoDesign 应用/运行时。** 第一个版本只接受静态、离线的 HTML/CSS，拒绝模型生成的 JavaScript；`claude-design-skill` 改写成 Harness Skill。Open CoDesign 的 React/Babel 预览器是 Electron 桌面应用模型，且明确执行生成代码，不满足本仓库的 MV3「不得运行远程运行时代码」及最小能力面目标。

## 1. Open CoDesign 实际架构

它不是可嵌入插件，而是完整 Electron 应用：main process 创建开启 `sandbox`、`contextIsolation` 且关闭 Node integration 的窗口；preload 再把被许可的 IPC API 暴露给 renderer。证据：

- `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/main/index.ts:83-104`
- `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/preload/index.ts:1-29`

其生成链路是：renderer 的 prompt（含待处理 Pin）→ Electron IPC → `@open-codesign/core` agent → 允许读写工作区的文本编辑工具 → `fs_updated` 事件 → renderer 读取生成源并预览。agent 的工具集合与流式运行入口在：

- `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/packages/core/src/agent.ts:1-20`
- `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/packages/core/src/agent.ts:99-119`
- `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/main/ipc/runtime-fs.ts:109-165`

它把工作区写穿到本机磁盘，失败时抛错；这不是 Harness iframe 可以照搬的授权模型。`persistMutation` 使用安全子路径校验、写文件并回填 DB，但仍是 Electron main-process 文件权限：

- `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/main/ipc/runtime-fs.ts:167-231`

### 各项能力是否真的有源码

| 能力 | 源码结论 | 可迁移内容 |
| --- | --- | --- |
| Prompt → 文件 | 已实现；agent 使用 editor/scaffold 等工具写工作区 | 采用 Harness Tool + session 受限 artifact store，不采用 Electron 文件系统 |
| 预览 | 已实现；renderer `<iframe sandbox="allow-scripts" srcDoc>` | 采用 iframe 分层和消息协议，重写渲染器 |
| Tweaks | 已实现；EDITMODE JSON + schema + iframe `postMessage` + 防抖持久化 | 采用更小、显式 versioned 的 JSON contract |
| Pin & Comment | 已实现；预览 overlay 选 DOM、postMessage、保存 selector/rect/comment | 采用“选区快照 + pin”的交互；不能把 DOM selector 当永久身份 |
| 版本 | 已实现；design/snapshot JSON store、按内容去重、parent id | 采用 artifact revision（内容哈希 + 父 revision） |
| 导出 | 已实现；HTML/PDF/PPTX/ZIP/Markdown Electron 保存对话框 | MVP 仅下载 HTML；其余格式后置且需要本地依赖与真实读回 |

关键证据：预览 frame 在 `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/renderer/src/components/PreviewPane.tsx:203-261`；Tweaks 面板会把 token 消息发进 iframe、400ms 后写回源文件，见 `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/renderer/src/components/TweakPanel.tsx:160-275`；Pin UI 只是将 selector 的 iframe rect 映射到宿主按钮，见 `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/renderer/src/components/comment/PinOverlay.tsx:54-92`；生成 prompt 的 Pin 内容被包为不可信数据，见 `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/renderer/src/store/slices/generation.ts:286-359`；快照有每设计串行化及同内容去重，见 `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/renderer/src/store/slices/snapshots.ts:74-115`；导出实际是 main process 调保存对话框及 exporter，见 `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/main/exporter-ipc.ts:220-258`。

## 2. 预览安全：不能直接搬的原因

`sandbox="allow-scripts"` 能让 `srcdoc` 获得不透明 origin，且没有 `allow-same-origin`，这是一个正确起点；但它**不等于安全执行器**。生成内容仍可运行任意 JS，发网络请求、使用 Blob/Worker、耗尽 CPU/内存，并向父窗口发送伪造业务消息。父端的主要校验只是 `event.source === iframe.contentWindow`，并非加密能力令牌：

- `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/renderer/src/components/PreviewPane.tsx:237-254`
- `/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/apps/desktop/src/renderer/src/preview/helpers.ts:20-25`

更重要的不可迁移点：

- 运行时主动删除产物写入的 CSP meta：`/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/packages/runtime/src/index.ts:595-623`。这与本项目应由宿主强制 CSP 的原则相反。
- JSX 路径主动注入 Google Fonts：`/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/packages/runtime/src/index.ts:345-369`。不符合离线/无远程运行时要求。
- JSX 通过 vendored Babel 编译，再用 `new Function` 执行模型代码：`/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/packages/runtime/src/index.ts:283-313`。这应明确禁止于 Harness MVP。
- overlay 用 `postMessage(..., '*')`，且允许来自相同 iframe window 的任意生成脚本仿造 envelope；虽然有类型/条数校验，业务边界仍不应用通配 target origin：`/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/packages/runtime/src/overlay.ts:190-199`、`:393-422`。
- 生成 HTML 保留外部 `<script>`、`fetch`、Worker 等能力；本次源码未发现一条统一、强制的 CSP/网络拦截策略。故“生成物无法联网”的说法为 **unverified/不成立**，不能继承。

建议的替代：MVP iframe 使用空 `sandbox`（不含 `allow-scripts`），只渲染宿主校验后的 HTML/CSS；Tweaks 由宿主改写顶层 CSS custom properties 后重新设置 `srcdoc`，不需要执行产物脚本。CSP 至少为 `default-src 'none'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; worker-src 'none'; child-src 'none'; form-action 'none'; base-uri 'none'`。MVP 拒绝所有 `<script>`、`import()`、module、`iframe/object/embed`、网络 URL、event-handler attributes 和危险 CSS URL。V2 为 Pin overlay 确需脚本时，只加载随产品固定打包的本地 runtime，并加入 nonce、严格双向消息 schema 与长度上限；不能用字符串过滤假装任意用户 JavaScript 安全。

## 3. claude-design-skill：可拿的是方法，不是运行时

`SKILL.md` 是较完整的“设计流程提示词”：要求事实核验、设计上下文、提前声明视觉系统、变体与真实浏览器验证；核心规则在 `/Users/zhanglt21/Desktop/accrnew/open-source-research/claude-design-skill/SKILL.md:20-55`、`:98-142`。它的 10 种风格是参考文档，不是执行代码；适合作为按需加载的设计方向库，而不是每轮完整塞进系统提示词。

Tweaks 文档所说的 `__activate_edit_mode` / `__edit_mode_set_keys` 是对“某些宿主（如 Claude.ai）”的协议建议，非 DeepSeek Harness 可直接兼容协议：`/Users/zhanglt21/Desktop/accrnew/open-source-research/claude-design-skill/references/variations-and-tweaks.md:43-64`。因此应**重新定义**为 `accrui.design-artifact/v1`，不能照抄事件名。

还需删除或改写的内容：

- WebSearch-first 与写 `product-facts.md` 需要映射到 Harness 已有研究/文件权限；没有可靠 tool 时，应让 agent 声明“未核验”，不能假设可搜索（`SKILL.md:26-39`）。
- 文档建议的 React/Babel、unpkg 和跨文件 `<script>`，不符合 MV3 本地静态依赖（`references/output-formats.md:129-161`）。
- “先问 4–10 个问题”的默认策略会阻塞产品流；只在缺少会改变产物类型的必要约束时问，其他信息使用保守默认值（`references/workflow.md:20-69`）。

## 4. 逐文件 take / adapt / avoid

| 来源文件 | 决定 | 原因 |
| --- | --- | --- |
| Open CoDesign `packages/shared/src/editmode.ts` | adapt | flat JSON token 与 schema 校验值得采用；改成 `ArtifactTweakSetV1`，限制 2–12 项并给每项稳定 id。 |
| Open CoDesign `runtime/overlay.ts` | adapt | 选中元素、rect 回传的思路可用；重写为 nonce + allow-list message + 明确大小上限，pin 同时存结构锚点与 fallback rect。 |
| Open CoDesign `renderer/.../TweakPanel.tsx` | adapt | “即刻预览，防抖持久化”正确；持久化必须走 Harness Verified Write，读/指纹/写/回读。 |
| Open CoDesign `store/slices/snapshots.ts` | adapt | revision parent + 内容去重可取；不要带 Electron JSON store。 |
| Open CoDesign `exporter-ipc.ts` 与 `packages/exporters` | avoid（MVP） | 依赖 Electron 保存路径和 Chromium/PDF/PPTX 工具；先用下载 HTML。 |
| Open CoDesign `packages/runtime/src/index.ts` | avoid | 删除 CSP、远程字体、Babel + `new Function` 执行均不可接受。 |
| claude-design-skill `SKILL.md` / `design-principles.md` / `design-styles.md` | adapt | 提炼反 AI-slop、设计方向、验证清单；改为 Harness skill 分层引用。 |
| claude-design-skill `assets/*.html` 和 demos | avoid 直接复制 | 示例含宿主假设、外网/运行时依赖；可只当视觉测试用例。 |

两项目均是 MIT，可复制或改造，但若复制实质代码/文档必须保留 MIT notice 与版权声明：`/Users/zhanglt21/Desktop/accrnew/open-source-research/open-codesign/LICENSE:1-13`、`/Users/zhanglt21/Desktop/accrnew/open-source-research/claude-design-skill/LICENSE:1-13`。许可证允许不代表应复制不兼容架构。

## 5. 映射到 deepseek_harness_chrome

拟新增：

```text
packages/harness-ui-design-artifacts/  # host tool、会话 artifact/revision/tweak/pin contracts
packages/harness-ui-design-artifacts/src/client/ # Harness 内 UI：预览、Tweaks、Pin
skills/design-artifact/                # 改写后的设计指令和按需 references
```

不触碰 `upstream/deepseek-harness`。现有 slot 足以放 MVP 入口和轻量浮层：`conversation.composer.above`、`conversation.input.overlay` 已由通用 seam 提供，见 `/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/upstream-contributions/README.md:8-11`；composer submission transform 能把已选择的 Pin 摘要附到这一次 prompt，见 `.../README.md:38-40`。没有现成的“全尺寸 artifact canvas / 右侧分栏”公共 slot，故全屏独立设计工作台属于 **V2 seam 需求，当前 slot 不够**；不能用 DOM 注入绕过。

建议 contracts：

| 边界 | contract |
| --- | --- |
| Host Tool → agent | `create_design_artifact`, `propose_design_artifact_patch`：只接受 schema v1、session id、artifact id、base revision/hash、完整静态 HTML 或受限 patch。 |
| Host storage | `ArtifactRevisionV1 { artifactId, parentRevisionId, contentHash, html, tweakSchema, createdAt }`；仅限 session cwd 的 `artifacts/` 子目录。变更必经 Verified Write。 |
| Client → sandbox（V2） | `{ v:1, nonce, type:'apply-tweaks', tokens }`；固定本地 runtime 只改 CSS custom properties。MVP 直接重写 `srcdoc`，没有消息通道。 |
| sandbox → client（V2） | `{ v:1, nonce, type:'select', anchor, rect }` 或 `{..., type:'runtime-error'}`；客户端按当前 iframe `contentWindow`、nonce、完整 schema、长度/坐标限制验证。 |
| Pin → agent | `{ revisionId, anchor, rect, selectedText, htmlSnippet, instruction }`，全部作为不可信数据包裹；提交确认后才标记 applied。 |

## 6. 分期与验收

### MVP：安全静态 artifact

1. Skill 输出单页静态 HTML + CSS variables + `ArtifactTweakSetV1`。
2. 会话内预览、全屏（若用现有浮层则是临时全屏）、三个 Tweaks、保存 revision、下载 HTML。
3. 使用空 `sandbox`，禁止任意 JS 与联网资源；Tweaks 通过重新生成仅含 HTML/CSS 的 `srcdoc` 生效。

验收：类型/契约测试；恶意 HTML（remote script、fetch、event handler、iframe、CSS URL）被拒绝；同一 session 可回读已保存 revision 的 hash；Chrome 实际侧边栏中 slider 即刻变化、刷新后仍为同一 revision。

### V2：Pin & 局部修改

1. 注入本地 overlay，选择元素并创建 Pin。
2. 将 Pin 作为不可信上下文随当前 prompt 提交；agent 只能提交 patch proposal。
3. 展示 diff，用户确认后 Verified Write、回读、建立 child revision。

验收：Pin 在缩放/滚动下仍对齐；过期 revision 的 patch 被拒绝；拒绝/取消不写文件；确认后源文件和预览 hash 一致。

### V3：多页面与正式工作台

只有确认产品需要持久左右分栏时，提出一个**产品中立** Harness slot seam；再加入页面路由、revision 时间线、PDF/PNG/PPTX 导出。每种导出需从新写入的文件/下载结果做独立 readback，不能以 HTTP 200 或 build 成功代替。

## 最终建议

先实施 MVP。它已经交付 Claude Design 最关键的体验：生成、看见、调色/间距/圆角、保存、导出；同时不把 Electron、完整 agent runtime、远程字体、Babel 或任意代码执行引入浏览器扩展。Pin、局部编辑和多格式导出在 V2/V3 再做，且以 Verified Write 与真实 Chrome 验收为门槛。

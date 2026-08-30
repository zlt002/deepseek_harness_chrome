# `dsh-chat-import` 对 Claude Code 导入的源码评估

核验日期：2026-08-31。外部仓库固定在 [`73ea0122b533e43adb17e5b18f52025751826b99`](https://github.com/Nwflower/dsh-chat-import/tree/73ea0122b533e43adb17e5b18f52025751826b99)，下文所有外部链接均固定到该提交。当前仓库已按评估结论完成产品插件改造，没有修改 `upstream/deepseek-harness`。

## 结论

**可以借鉴，而且推荐方案已经落地：没有把第三方插件整套装进产品，只在现有 Workspace Picker 插件中实现 Claude JSONL 转换，并通过 Harness 公开 Session/Persistence/Workspace 服务创建原生历史会话。**

它能补强“历史文本、思考、工具调用和结果迁入 Harness 后继续聊”的能力；**不能**完整恢复 Claude Code 的运行位置、正在执行的工具、授权、子代理关系、缓存、原模型上下文或附件文件。这不是实现缺口，而是两套运行时没有可移植执行状态的边界。

还要纠正外部 README 的一个宣传口径：当前提交并没有逐条保留 Claude 消息时间。转换器只取首个源时间作为 `meta.createdAt`，事件合成器再把这个同一时间写给全部事件，因此要由我们另行实现 record-level timestamp 映射。[首个时间提取](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/claude.mjs#L86-L90) [统一事件时间](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/core.mjs#L70-L79)

改造后的产品仍保留原来的选择界面、路径约束和显式目标 Workspace，但不再把整段历史塞进一次 `session.prompt`。Host 会把所选 JSONL 转换为合法的 Harness seed，持久化为冷会话，再绑定到 Workspace；导入本身不会触发模型请求。

## 外部插件：架构与真实格式

`dsh-chat-import` 是一个 MIT、Node 22+ 的 DSH 插件，而非独立的 Claude 导入器；其 package 声明 Cordis bundle patch、Web client 注入以及 DSH peer dependencies。[package.json](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/package.json#L1-L60)

它声明 `@deepseek-ai/dsh-tools ^0.1.0-rc.6`，而当前产品物化的是 `0.1.0-rc.5`。当前源码虽然已有它所用的关键 symbol，但版本契约仍不匹配；这也是“不整体安装、只移植经过验证的纯转换逻辑”的原因之一。[外部 peer 版本](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/package.json#L56-L60) [当前 Harness 版本](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/upstream/deepseek-harness/packages/core/tools/package.json:4)

其 Host 入口注入 `sessionPersistence`、`fs`、`tools`，再按可选 `webServer` 注册面板/同步路由；导入逻辑同时暴露为工具、命令、面板和 CLI，而不只是一处对话框。[index.mjs](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/index.mjs#L35-L85)

### Claude 输入

输入是 Claude Code 项目目录下的 JSONL。转换器逐行读取记录：以 `type: "user"` 的字符串或纯文本块作为新 turn；`type: "assistant"` 的内容块映射文本、thinking、`tool_use`；后续 user `tool_result` 通过 `tool_use_id` 回挂到原调用步骤，避免工具结果贴错调用。[Claude 转换器](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/claude.mjs#L24-L30) [核心解析](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/claude.mjs#L104-L178)

它还读取 `sessionId`、`cwd`、首个时间、`ai-title`/`summary` 标题和模型；只让文件名等于记录 `sessionId` 的主 transcript 成为会话，以排除 `subagents` 辅助记录。[元数据与主记录筛选](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/claude.mjs#L86-L100) [辅助记录排除](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/claude.mjs#L181-L205)

### DSH 输出

输出不是原 Claude JSONL。它先变成 `{ meta, turns, events }`，再合成 DSH event log：`session/imported`、环境变更说明、`turn/start`、`user/message`、`assistant/message`、`tool/call`、`tool/result`、`step/end` 与 `turn/end`。缺失工具结果会补一个空结果以满足消息 wire 约束。[事件合成](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/core.mjs#L61-L127) [工具结果关联与兜底](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/core.mjs#L154-L220)

落盘阶段优先调用 `agents.create({ seed: events })`，失败才直接 `sessionPersistence.create` / `append`；之后可把会话按 `cwd` 或源目录挂至 Workspace。[创建与回退](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/import-core.mjs#L149-L193) [项目归组](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/import-core.mjs#L88-L131)

## 当前项目落地链路

当前实现位于产品插件 `@accrui/harness-ui-workspace-picker`，并被唯一产品插件清单加载；没有改 `upstream/deepseek-harness`。[manifest](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/apps/native-server/src/product-plugin-manifest.mjs:11) [package](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/package.json:1)

1. `ClaudeImportModal` 默认列出 `~/.claude/projects`，允许显式绝对目录；按项目分页读取会话，按需打开详情，用户明确选择目标 Workspace 后才可“导入并继续”。[界面](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/src/client/ClaudeImportModal.tsx:45) [导入按钮与状态](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/src/client/ClaudeImportModal.tsx:163)
2. Host 只接受 loopback same-origin `POST`；路径先 `realpath`，项目/会话名受限于 canonical root。列表预览最多读 64 KiB；所选 JSONL 流式读取，限制 20,000 行、2,000 个原生记录、128 个工具块及总内容大小。[路由](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/src/index.ts:20) [转换器](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/src/claude-import.mjs)
3. 转换器保留逐条时间、标题、每条助手模型、thinking、`tool_use` 与按 id 配对的 `tool_result`；工具参数、结果和普通文本统一脱敏并限长。图片、附件、权限和子代理明确标为未迁移。[测试](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/test/claude-import.test.mjs)
4. Host 使用 `sessions.prepare(seed)`、`sessionPersistence.create/append` 和 `Workspace.attachSession` 创建带 `seedLength` 的冷会话；Client 刷新会话列表后打开。导入前先登记稳定 session id，attach、登记或连接中断后可继续完成，不会因重试再造一份。[原生导入](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/src/native-history.mjs) [客户端](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/src/client/index.ts)
5. 来源仅追加且 Harness 会话尚未续聊时可安全增量；来源改写、会话已续聊或出现部分持久化时会明确要求“导入为副本”，不猜测、不改写旧历史。

## 差距与取舍

| 项目 | 当前产品 | 外部插件 | 结论 |
| --- | --- | --- | --- |
| 消息/时间 | 原生事件逐条保留时间；标题和模型也保留 | 有完整 turn/step，但当前实现把首个时间写给全部事件 | 已借鉴事件投影，并自行修正逐条时间。 |
| 工具记录 | 映射 thinking、`tool_use`/`tool_result`，统一脱敏、限长，缺失结果标“未知” | 映射 `tool_use`/`tool_result`、thinking，保持 call-result 关联 | 已借鉴配对思路，并补足安全边界。 |
| 附件/图片 | 不处理 | `mapContentBlock` 仅 text/thinking/tool_use，也不复制本地附件/图片 | 两者都不能解决，需单独设计附件复制、权限和引用重写。 |
| 项目映射 | 用户在 UI 选目标 Workspace | 读 `cwd`，并用 `~/.claude.json`/slug/source-dir 回退自动归组 | 可作为“建议目标 Workspace”，不应覆盖用户已选目标。 |
| 去重 | 稳定来源键 + 原子 registry + pending 恢复；重复时打开已有或显式副本 | 源路径 registry + session 持久化检查 | 当前实现额外覆盖了写到一半后的安全重试。 |
| 增量导入 | 来源仅追加且会话未续聊时 append；改写/缩短/续聊则冲突 | 用已导入 turn/event 数决定 append、变更/缩短则报告 | 已落地，并保守拒绝不可安全插入的情况。 |
| 续聊 | 原生历史冷会话重开后按普通 Harness 生命周期续聊 | 历史事件落为 DSH 会话后重开 | 两者都不是 Claude 进程状态恢复。 |
| 错误 | 逐行动作超时、原始 Host 错误、取消、路径错误 | 批量状态、畸形行/孤儿 result/permission 计数 | 可借鉴结构化导入摘要；保留当前端到端透明错误。 |
| 安全 | same-origin、canonical path、预览/行/字符边界、0600 registry | 环境变更提示，registry 原子写；会写入 DSH 持久化 | 当前默认更小暴露面；事件导入必须先做兼容性和敏感内容审计。 |
| 跨平台 | registry 分别落 macOS/Windows/Linux data directory | Node 实现；支持 Windows 原子 rename 的假设 | 当前路径更贴合发行包；两者仍需 Windows Native Host/侧栏实测。 |

## 三类清单

### 可直接借鉴

- **JSONL 转换的测试向量和算法思路**：主 transcript 过滤、纯文本 user 数组、tool result 按 `tool_use_id` 回挂、title 优先级、`cwd`/model/time 提取。
- **增量判定状态机**：源增加才 append；源缩短或历史被原地改写时明确提示而不是悄悄覆盖。外部 registry 将源路径、大小、mtime、turn/event 记录持久化。[registry 契约](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/imports.mjs#L1-L23)
- **迁移环境声明**：明确当前工具、授权和运行环境以 Harness 为准，防止模型虚构继承 Claude 的工具状态。[声明](https://github.com/Nwflower/dsh-chat-import/blob/73ea0122b533e43adb17e5b18f52025751826b99/lib/convert/core.mjs#L43-L58)

外部仓库在固定提交上执行其完整测试为 **620/620 通过**；这说明转换器自身成熟，但不等于已通过当前产品的 pinned Harness、Native Host、侧栏和 Windows 发行链验证。

### 落地时已经做的改造

- **事件级历史投影**：已用当前 pinned Harness 的公开 Session/Persistence/Workspace 服务实现并用真实 JSONL persistence 探针回读；实现只在 `packages/`，没有触碰 upstream 或直接改写 `.dsh` 文件。
- **自动 Workspace 映射**：外部 `cwd` 映射只能作为推荐项，与当前已选择的目标 Workspace 冲突时以用户选择为准；不应静默新建大量 Workspace。
- **增量导入**：已使用 size/hash/mtime、seed signature 和 Harness seq 游标；正常 Harness 后续对话存在时禁止交错追加。
- **工具内容**：已统一对参数、结果、thinking 与文本做秘密检测和长度上限，详情页只展示计数和迁移限制。

### 不应照搬

- 整个外部插件的 19 源、导出、同步、CLI、面板、删除/恢复功能：超出 Claude Code 导入问题，且与当前专用 UI 重叠。
- 直接复制/写入 `.dsh` 会话文件或依赖其私有存储布局。应走公开 `agents.create({ seed })` / Workspace 服务，而不是碰磁盘格式。[ADR-0007](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/docs/adr/0007-keep-deepseek-harness-as-clean-upstream.md:7)
- “full-fidelity resume”的宣传表述。外部自己也会用环境变更提示承认迁移后工具/权限不同；这证明其所谓 resume 是已投影历史的 DSH 续聊，不是恢复 Claude 的进程状态。

## 已落地方案

只增强现有产品插件，没有引入整套第三方插件依赖：

1. 保留 [`ClaudeImportModal.tsx`](/Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome/packages/harness-ui-workspace-picker/src/client/ClaudeImportModal.tsx) 的索引、详情、显式目标 Workspace、取消和重复导入交互。
2. Claude 专用转换器是项目内纯模块并保留 MIT 参考归因；支持 user 数组、thinking、并行/乱序工具结果、标题、模型、`cwd` 与逐条时间，没有引入外部 19 种来源。
3. Host 通过公开服务创建、持久化并绑定冷会话；Client 只刷新并打开返回的 session id，导入不会启动模型。
4. 工具参数和结果统一限长、脱敏；详情明确显示裁剪/跳过项。图片、附件、子代理和权限记录不宣称已迁移。
5. Registry 保存 source revision、seed signature、事件游标和 pending 恢复状态；来源追加可增量，冲突时提示导入副本。
6. 包测试覆盖转换、HTTP 路由、真实冷会话打开、并发首次/增量、失败恢复和安全边界；另有 pinned Harness 的真实 Session + JSONL persistence 临时目录回读探针。

## 是否高度同源/已移植？

**没有找到可证明“原实现直接移植自外部仓库”的代码级证据；但两者主题相同，外部仓库在时间上更早，值得作为参考实现。** 外部仓库的[首个 Claude 导入提交](https://github.com/Nwflower/dsh-chat-import/commit/e791dbe205711a6fe1ad96f1282a872c620f2ae7)为 2026-08-13，而当前仓库把 `ClaudeImportDirectory` 加入历史的提交是 2026-08-20（本地 Git 历史）。改造前，两者的落盘策略明显不同：外部把 JSONL 变成 DSH events 并通过 Host 持久化，本仓库则把文本包装后通过客户端 `session.prompt`。本次改造只借鉴其经过验证的事件转换思路，仍使用本仓库现有入口、Host 路由和安全边界，没有把外部仓库当作可直接同步的上游，也没有照搬其代码。

## 最关键证据

1. 当前转换器能精确保留 tool-call/result 关系，包括跨 JSONL 记录反序；缺失结果明确标“未知”。
2. 当前通过 Harness 公开服务落为原生 event log，不再用一次 `session.prompt` 伪装历史。
3. 路径约束、限量、同源限制、脱敏、原子 registry 和失败恢复都保留。
4. 增量 append 已落地，但只有来源严格追加且 Harness 会话未续聊时才允许。
5. 两者都不能导入附件/图片，也都不能恢复运行中工具、授权、子代理或缓存。
6. 没有安装外部包，也没有修改上游 Harness。

**最终结论：保留现有 UI，只借鉴 Claude 转换思路并走公开 Harness 服务，是适合当前产品的方案；该方案及保守增量/失败恢复已经落地。**

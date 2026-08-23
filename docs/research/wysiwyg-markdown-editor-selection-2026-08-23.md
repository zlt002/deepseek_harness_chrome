# 可视化 Markdown 编辑器选型调研（2026-08-23）

## 结论先行

当前项目的首选 PoC 是 **Milkdown 7.22.x（先用 Crepe 验证体验，再决定是否下沉到可组合插件）**。

它是本轮候选中唯一同时提供以下开源、第一方能力的方案：

1. 在渲染后的富文本正文里直接选择和手工编辑；
2. 监听 ProseMirror 选区，可把选中文本及结构上下文送入 Harness；
3. AI 可流式替换当前选区；
4. 流式结束后恢复原文，在富文本正文内展示 Diff，并逐项接受或拒绝；
5. 最终仍可序列化为 Markdown，再接入项目既有的 Verified Write。

官方文档明确展示了 `insertAt: 'selection'`、`endStreaming({ diffReview: true })`，以及单项/全部接受、拒绝命令：[streaming plugin](https://github.com/Milkdown/milkdown/blob/main/docs/api/plugin-streaming.md)、[diff plugin](https://github.com/Milkdown/milkdown/blob/main/docs/api/plugin-diff.md)。这比“选区发给 AI 后直接覆盖”更贴合当前产品所需的人在回路体验。

但不能直接宣布定版：Milkdown 核心长期活跃，而 `plugin-diff` / `plugin-streaming` 是 **2026 年 4 月才加入**的年轻能力；必须用真实文档语料和 Extension CSP 做 PoC。若该 PoC 不过关，第二选择是 **MDXEditor**；若更重视成熟的中文开箱体验、能接受较大包体与自建 Diff 层，则第三选择是 **Vditor**。

不建议把 BlockSuite/Yjs 作为本需求的首选。这里的第一问题是 Markdown 可视化编辑与 AI 审查，不是多人 CRDT 协作。

## 需求拆分：四种能力不能混为一谈

| 能力 | 本项目真正需要什么 | 常见误判 |
| --- | --- | --- |
| 视觉编辑 | 用户在排版后的正文中选择、打字、格式化，不看 Markdown 标记 | “有预览区”不等于预览区可编辑 |
| Markdown round-trip | 打开现有 `.md`，编辑后仍能可靠输出兼容 Markdown | “可以导出 Markdown”不等于原始字节/空白/方言无损 |
| source-position selection | 从视觉选区得到可持久引用的原 Markdown 范围 | ProseMirror/Lexical/DOM 的位置通常不是 Markdown 字符偏移 |
| AI patch transaction | AI 提议先作为可审查事务，接受后才进入正式文档与写盘流程 | `replaceSelection()`、undo 或 CRDT 都不等于审批与 Verified Write |

**本轮没有发现任何候选能在持续编辑后，原生、稳定地维护“视觉选区 → 原始 Markdown 字符偏移”的映射。** ProseMirror position、Lexical RangeSelection、DOM Range、BlockNote Block ID 都属于编辑器内部模型；Markdown 经 parse/serialize 后空白、列表标记、转义和方言节点可能规范化，旧 source offset 会失效。

因此，本项目应继续采用“选中文本 + 前后文 + 当前编辑器版本/指纹 + 结构路径”的锚点，而不是把内部 position 伪装成磁盘 Markdown offset。真正写盘前仍以最新导出的 Markdown 和当前文件指纹执行 Verified Write。

## 推荐排序

### 1. Milkdown：最符合完整 AI 编辑闭环

**为什么排第一**

- Markdown-first 的所见即所得编辑器，底层为 ProseMirror，解析/序列化经 remark/transformer；MIT 许可，仓库与 npm 均在 2026 年持续发布。[仓库](https://github.com/Milkdown/milkdown)、[npm `@milkdown/crepe`](https://www.npmjs.com/package/@milkdown/crepe)
- `plugin-listener` 同时提供 `selectionUpdated`、文档更新和序列化后的 `markdownUpdated` 事件，适合向现有 Review Tab/Host 通道发布选区与草稿状态。[官方源码](https://github.com/Milkdown/milkdown/blob/main/packages/plugins/plugin-listener/src/index.ts)
- `plugin-streaming` 可在 cursor、selection 或指定 ProseMirror position 流式插入；中止时可恢复原始文档；结束时可进入 Diff Review。[官方文档](https://github.com/Milkdown/milkdown/blob/main/docs/api/plugin-streaming.md)
- `plugin-diff` 在富文本正文中标出结构变化，支持单项/范围/全部接受与拒绝；Diff 期间锁住编辑，处理完再解锁。[官方文档](https://github.com/Milkdown/milkdown/blob/main/docs/api/plugin-diff.md)
- Diff 直接比较 ProseMirror 文档并用 transaction 应用，不必先做字符串正则替换；官方也提供 `startDiffReviewFromDocCmd` 避免多一次 serialize→parse。[官方实现](https://github.com/Milkdown/milkdown/blob/main/packages/plugins/plugin-diff/src/diff-compute.ts)

**局限与风险**

- Markdown 往返是“解析到结构树、再序列化”，不是原字节无损。remark AST 的初始 `position` 没有作为持续编辑后的 source map 保存在 ProseMirror 文档中；视觉选区得到的是 ProseMirror `from/to`。
- 官方流式插件默认 100ms 批量 parse+diff+apply；复杂表格、代码块和自定义 node view 有专门降级规则，不能假设任意 Markdown 方言都稳定。[streaming types](https://github.com/Milkdown/milkdown/blob/main/packages/plugins/plugin-streaming/src/types.ts)、[diff docs](https://github.com/Milkdown/milkdown/blob/main/docs/api/plugin-diff.md#custom-block-types)
- Diff/streaming 首次进入仓库约为 2026-04，虽已有测试和后续修复，但历史仅约四个月；这是首选 **PoC**，不是免验证的成熟定案。
- `@milkdown/crepe` npm 7.22.1 的 unpacked size 约 3.47 MB；这不是最终 gzip bundle 大小，但说明必须实测 tree-shaking、首屏和 Review Tab 内存。[npm](https://www.npmjs.com/package/@milkdown/crepe)

**与当前项目的推荐接法**

```text
视觉选区（ProseMirror selection）
  → 选中文本 + 所在块 Markdown + 前后文 + editorRevision
  → 通过既有 Review Port / Host capability 送入固定 Harness 会话
  → AI 返回替换 Markdown（先不写盘）
  → startStreaming(selection) 或解析为 newDoc
  → endStreaming(diffReview: true)
  → 用户逐项接受/拒绝
  → 导出完整 Markdown
  → prepareWrite + approval + commit + 同资源回读
```

建议先以 Crepe 验证完整 UX；若默认 UI/样式不合适，再采用 Milkdown core + commonmark/GFM + listener + diff + streaming 组装，避免一开始就自制编辑器框架。

### 2. MDXEditor：React 集成最直接，但 AI 审查需自建

**优势**

- React 组件、MIT，基于 Lexical，并围绕 Markdown/MDAST import/export；4.2.1 于本次快照前仍在发布。[仓库](https://github.com/mdx-editor/editor)、[npm](https://www.npmjs.com/package/@mdxeditor/editor)
- `getMarkdown`、`setMarkdown`、`insertMarkdown`、连续 `onChange` 都是公开 API，嵌入现有 React Review Tab 很直接。[官方入门](https://github.com/mdx-editor/editor/blob/main/docs/getting-started.md)
- 支持 CommonMark 功能及表格、代码块、MDX/JSX、HTML 等插件；遇到缺插件或解析失败会显式报错，并可切回 source mode 恢复。[错误处理](https://github.com/mdx-editor/editor/blob/main/docs/error-handling.md)
- Lexical 本身有 selection、离散 update 与 history，可定制“选区发给 AI”和局部替换。

**为什么不是第一**

- 第一方 `diffSourcePlugin` 展示的是 Markdown source/diff 模式，而不是在富文本正文中逐项接受/拒绝 AI 修改。[官方 Diff/source 文档](https://github.com/mdx-editor/editor/blob/main/docs/diff-source.md)
- 官方 search 插件能返回当前渲染投影的 DOM Range，但明确提示 DOM Range 不能跨后续 mutation 当作持久位置；这正说明它不是 Markdown source range。[官方 Search 文档](https://github.com/mdx-editor/editor/blob/main/docs/search-replace.md)
- 对未注册 Markdown 节点会失败或需要 catch-all；“MDAST ↔ Lexical”不能被表述成所有 Markdown 方言的无损往返。
- 若要达到 Milkdown 现成的富文本 Diff/accept/reject，需要自行实现 Lexical 节点 diff、decorations/marks、事务分组和审查 UI，工程量明显更大。

**适合条件**：Milkdown PoC 的交互或兼容性不达标，同时团队愿意自行建设 AI 变更审查层；或者 MDX/JSX 文档是一等需求。

### 3. Vditor：最成熟的开箱式中文体验，但需要自建审查层

**优势**

- MIT，浏览器原生 TypeScript；同时提供 WYSIWYG、Typora 风格即时渲染和分屏模式，3.11.3 在 2026-08 仍发布。[仓库 README](https://github.com/Vanessa219/vditor/blob/master/README_en_US.md)、[npm](https://www.npmjs.com/package/vditor)
- API 直接提供 `select`/`unSelect` 回调、`getSelection(): string`、`updateValue()`、`insertValue()`、`deleteValue()` 和 undo/redo 栈，完成“视觉选区 → 发 AI → 替换选区”的基础闭环很快。[官方 API 表](https://github.com/Vanessa219/vditor/blob/master/README_en_US.md#methods)
- CommonMark/GFM、数学、Mermaid 等功能丰富，并默认开启 Markdown sanitize。

**风险**

- `getSelection()` 只返回选中文本，不返回稳定 Markdown offset；重文时仍需 quote/context/fingerprint 锚点。
- 没有第一方 AI Diff accept/reject 事务。`updateValue()` 是直接改当前选区，undo 只能作为补救，不能替代显式审批。
- npm unpacked size 约 23.7 MB，默认还采用按需 CDN 资源。MV3 禁止远程可执行代码，必须把相关 JS/WASM/worker/theme 全部固定版本、自托管进扩展包并核验 CSP；不能照搬 CDN 示例。[CDN 说明](https://github.com/Vanessa219/vditor/blob/master/README_en_US.md#cdn-switch)
- 功能面很大、内部 DOM/Lute 转换较专用，二次定制 AI decorations 和 Review Tab 样式的成本高于 Milkdown/MDXEditor。

**适合条件**：目标是最快交付一个功能完整、中文体验成熟的 WYSIWYG Markdown 编辑器，并接受“AI 审查层另建”和更大的扩展包。

## 其余候选为什么不选

| 候选 | 视觉编辑 | Markdown 往返 | 选区/AI 事务 | 结论 |
| --- | --- | --- | --- | --- |
| TipTap + `@tiptap/markdown` | ProseMirror WYSIWYG 很成熟 | 官方 Markdown extension 在 2026-08 仍标 **Beta**，并明确不支持 comments、表格单元只容一个子节点 | transactions/selection 很强，但 Markdown Diff/AI 审查需自建；不要把付费/闭源能力算入 OSS | 若团队本就采用 TipTap 可考虑，否则 Milkdown 已提供更 Markdown-first 的封装与开源 AI 插件。[官方 Markdown 文档](https://tiptap.dev/docs/editor/markdown) |
| BlockNote | Notion 风格视觉编辑优秀 | 官方明确称 import/export **lossy**，只覆盖 CommonMark + GFM 基础，复杂结构会丢失或展平 | Block API 易用；`xl-ai` 有流式建议/接受拒绝，但许可证为 `GPL-3.0 OR PROPRIETARY` | 产品体验强，但不适合把现有任意 `.md` 作为权威格式；闭源产品还需先解决 AI 包许可。[导入](https://www.blocknotejs.org/docs/features/import/markdown)、[导出](https://www.blocknotejs.org/docs/features/export/markdown)、[AI](https://www.blocknotejs.org/docs/features/ai) |
| BlockSuite | Block/whiteboard 视觉编辑与 Yjs 协作强 | 权威状态是 block/Yjs 文档，Markdown 是各 block adapter 的交换格式，不是原文件模型 | selection/CRDT 强，但 AI Markdown patch 与 Verified Write 仍需另建 | 对当前问题过重；只有明确要多人实时协作 + 白板时再评估。[仓库](https://github.com/toeverything/blocksuite)、[selection guide](https://github.com/toeverything/blocksuite/blob/main/docs/guide/selection.md) |
| TOAST UI Editor | 真 WYSIWYG + Markdown 双模式 | CommonMark/GFM，内部 ToastMark/ProseMirror 转换；不是原文本无损 | `getSelection`/`replaceSelection` 可用，但无第一方 AI Diff review | 历史成熟、MIT，但 npm 最新 3.2.2 修改于 2023-02、仓库最后 push 快照为 2024-08，维护风险高于前三。[仓库](https://github.com/nhn/tui.editor)、[核心 API 源码](https://github.com/nhn/tui.editor/blob/master/apps/editor/src/editorCore.ts) |
| Cherry Markdown | 主要是源码编辑 + 预览；README 所称 WYSIWYG 集中在图片/表格 | Markdown-first、功能丰富、支持 AI 流式**渲染** | 不是整篇正文富文本编辑器，不能满足“不编辑 Markdown 代码”的核心要求 | 淘汰；可借鉴流式渲染/XSS处理，不作为编辑内核。[README](https://github.com/Tencent/cherry-markdown) |

## 许可证、维护与体积快照

快照时间为 2026-08-23。GitHub “push”仅表示仓库最近提交活动；npm `unpackedSize` 是安装包解压体积，**不是**最终 tree-shaken/gzip bundle。它只用于提前暴露扩展包体风险。

| 项目 | OSS 许可证 | 本次观测版本/活动 | npm unpacked size（代表包） |
| --- | --- | --- | --- |
| Milkdown | MIT | 7.22.1，npm modified 2026-08-12，repo pushed 2026-08-22 | Crepe 约 3.47 MB；core 约 0.20 MB；插件可组合 |
| MDXEditor | MIT | 4.2.1，npm modified/repo pushed 2026-08-21 | 约 0.61 MB（依赖仍需另计） |
| Vditor | MIT | 3.11.3，npm modified 2026-08-11，repo pushed 2026-08-19 | 约 23.66 MB |
| TipTap Markdown | MIT | 3.30.2，npm modified 2026-08-18；官方仍标 Beta | `@tiptap/markdown` 约 0.43 MB，另需 core/extensions |
| BlockNote core | MPL-2.0 | 0.54.0，npm modified 2026-08-13 | core 约 9.18 MB；AI 包约 6.93 MB |
| BlockNote XL AI | GPL-3.0 OR PROPRIETARY | 0.54.0 | 闭源分发必须先做许可证审查 |
| BlockSuite | MPL-2.0（仓库） | repo pushed 2026-08-14 | 多包体系，必须以实际选取包构建测量 |
| TOAST UI Editor | MIT | 3.2.2，npm modified 2023-02；repo pushed 2024-08 | 约 3.27 MB |
| Cherry Markdown | Apache-2.0 | 0.11.9，npm modified 2026-08-04，repo pushed 2026-08-22 | 约 55.35 MB（含多构建/资源，非最终 bundle） |

来源：[GitHub REST repository API](https://docs.github.com/en/rest/repos/repos#get-a-repository)、各项目仓库、各 npm 包的 registry metadata。所有候选仓库在快照时均未标记 archived；未发现项目级 deprecation/sunset banner。TipTap Markdown 的 Beta 标识与 BlockNote AI 的 early preview 必须保留，不能以版本号掩盖。

## MV3 / Extension CSP 专项判断

### 共通原则

- 编辑器及其 parser、worker、WASM、syntax highlighter、Mermaid/KaTeX 等依赖必须随扩展打包；禁止运行时从 CDN 加载可执行代码。
- 禁止依赖 `eval` / `new Function` 的插件；在 WXT production bundle 上跑 CSP/static scan，并在真实 Chrome/Edge extension page 启动。
- AI 请求仍由现有 Host/Harness 通道完成，编辑器页面不直接持有模型 token，也不另开第三方模型 SDK。
- HTML/链接/图片/diagram 必须延续 safe preview 的 URL 与内容安全策略。富文本编辑器的 schema 不是 XSS 边界。

### 候选风险

- Milkdown/MDXEditor/TipTap：核心可本地 ESM 打包，MV3 方向可行；第三方 node view、代码高亮、Mermaid 插件逐个审查。
- Vditor：默认 CDN 和大量可选 renderer 是主要风险；必须配置本地资源根并验证离线运行。
- BlockSuite/BlockNote：包体、动态模块和协作依赖较重，需更多加载/内存验证。
- Cherry：多构建产物可选，但完整包解压体积很大；且不满足核心视觉编辑要求。

## PoC 验收门槛（建议 2～3 天，不先改写盘接口）

仅验证 Milkdown，不同时实现多个候选：

1. 在独立 Markdown Review Tab 中用本地依赖挂载 Crepe，支持正文直接编辑。
2. 视觉选中跨 inline mark、跨段落、列表、表格单元、代码块，读取选中文本与所在块上下文。
3. 把结构化选区送入现有固定 Harness 会话；不自动触发发送。
4. 用模拟 AI 流对当前 selection 替换，结束后进入富文本 Diff；逐项 accept/reject、reject all、abort 均能恢复正确内容与光标。
5. 对项目真实语料做 round-trip fixture：空白、不同列表 marker、GFM table、task list、HTML、脚注、数学、Mermaid、frontmatter、中文标点、CRLF、超长文档。将 `serialize(parse(md)) !== md` 的差异显式分类，不能笼统称无损。
6. 对不支持语法采取三选一且需明确：保留为 opaque/source block、只读提示、或回退 source mode；绝不静默丢失。
7. 测量 production JS/CSS gzip、首次打开耗时、10k/50k/200k 字文档输入延迟和内存。
8. 执行 MV3 CSP/offline 测试，确认无远程脚本、无 eval、无未打包 worker/WASM。
9. PoC 只停留在编辑器本地草稿。接入写盘时仍必须经过 resource identity、fingerprint、一次性 approval、串行 commit 和同资源 readback；Milkdown accept 只是“接受 AI 提议”，不是“已经 Verified Write”。

### Go / No-Go

满足以下条件才选 Milkdown进入 M2：

- 真实语料无静默丢失；可接受的规范化差异有清晰预览；
- 选区 AI → 富文本 Diff → accept/reject 全链路稳定；
- Extension production bundle 与真实 Chrome/Edge CSP 通过；
- 大文档性能满足目标；
- 编辑器接受后的 Markdown 能无缝进入现有 Verified Write，而不绕开 capability/approval/readback。

若 Milkdown 失败：优先判断失败原因。若是默认 UI，继续用 Milkdown core 重组；若是解析/序列化兼容性，再转 MDXEditor；若主要诉求变成“最快得到成熟中文 WYSIWYG，接受大包和自建 Diff”，再选 Vditor。


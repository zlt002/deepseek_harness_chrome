# Claude Design / Artifacts 开源方案核验

核验日期：2026-08-23。以下只采信项目自己的 GitHub README、LICENSE、源码或官方文档；“支持”表示项目作者明确写出的能力，不等于已验证能嵌入 DeepSeek Harness。

## 结论总表

| 项目 | 结论 | 证据与边界 |
|---|---|---|
| [nexu-io/open-design](https://github.com/nexu-io/open-design) | **confirmed（但集成表述 overstated）** | README 明确声称 `dsh` 为 native runtime，并列出 sandboxed iframe、HTML/PDF/PPTX/MP4 导出；还要求本机先安装官方 `dsh`，再执行 `od agent setup deepseek-harness`。[README](https://raw.githubusercontent.com/nexu-io/open-design/main/README.md#L7-L7)、[Agent 集成](https://raw.githubusercontent.com/nexu-io/open-design/main/README.md#L113-L137)、[LICENSE](https://raw.githubusercontent.com/nexu-io/open-design/main/LICENSE) 为 Apache-2.0。它是 Electron/桌面 + sidecar IPC（README 架构图），不是可直接放入 MV3 iframe 的组件；“可直接借用 DeepSeek Harness 适配插件”没有证据，且应先审查其实现许可和边界。 |
| [OpenCoworkAI/open-codesign](https://github.com/OpenCoworkAI/open-codesign) | **confirmed（作为参考架构）；直接嵌入 overstated** | README 明确列出 DeepSeek/OpenAI-compatible provider、sandboxed iframe、AI-generated sliders、comment pin，以及 HTML/PDF/PPTX/ZIP/Markdown 五种导出。[README](https://raw.githubusercontent.com/OpenCoworkAI/open-codesign/main/README.md#L54-L70)、[能力清单](https://raw.githubusercontent.com/OpenCoworkAI/open-codesign/main/README.md#L225-L255)。MIT 许可：[LICENSE](https://raw.githubusercontent.com/OpenCoworkAI/open-codesign/main/LICENSE)。它是 Electron + React 19 + Vite 桌面应用，模型调用和文件/导出管道不是独立 iframe 包；可借鉴数据协议和交互，不能假定复制一个组件即可接入 MV3。 |
| [jiji262/claude-design-skill](https://github.com/jiji262/claude-design-skill) | **confirmed（Skill）；DeepSeek 原生支持 wrong/unverified** | README 说明这是环境无关的 Markdown Skill，包含 10 种设计哲学、输出格式骨架和 Tweaks-enabled 模板；它没有 DeepSeek Harness 适配器、运行时代码或 pin/comment 实现。[README](https://raw.githubusercontent.com/jiji262/claude-design-skill/main/README.md#L1-L20)、[Tweaks 协议](https://raw.githubusercontent.com/jiji262/claude-design-skill/main/variations-and-tweaks.md)、[LICENSE](https://raw.githubusercontent.com/jiji262/claude-design-skill/main/LICENSE) 为 MIT。可改写为 Harness 的产品 Skill，但不能说“原生支持 dsh”。 |
| [Nutlope/llamacoder](https://github.com/Nutlope/llamacoder) | **confirmed（技术参考）；适用性 overstated** | README 明确写出 `esbuild-wasm` + `esm.sh` 的浏览器预览渲染、sandboxed iframe。[README](https://raw.githubusercontent.com/Nutlope/llamacoder/main/README.md#L1-L20)、[LICENSE](https://raw.githubusercontent.com/Nutlope/llamacoder/main/LICENSE) 为 MIT。它是完整应用而非可插拔渲染器，原始方案依赖网络 CDN/构建加载；在扩展 CSP 下必须改为扩展本地打包资源，不能照搬 `esm.sh`。README 没有支持 DeepSeek Harness、Tweaks、Pin & Comment 或 HTML/PDF/PPTX 导出的证据。 |
| [wandb/openui](https://github.com/wandb/openui) | **confirmed（UI 生成项目）；适用性 overstated** | README 说明自然语言生成并实时渲染 HTML，可转 React/Svelte/Web Components；模型配置走 OpenAI/Anthropic/LiteLLM/OpenAI-compatible 环境变量。[README](https://raw.githubusercontent.com/wandb/openui/main/README.md#L1-L30)、[LICENSE](https://raw.githubusercontent.com/wandb/openui/main/LICENSE) 为 Apache-2.0。它是独立应用/服务（README 提供 Docker 运行方式），不是 Harness Skill，也没有文档证明 Tweaks、Pin & Comment、导出或 MV3 iframe 嵌入。 |
| [LibreChat](https://github.com/danny-avila/LibreChat) Artifacts | **confirmed（存在 Artifacts）；原回答功能 overstated** | 当前官方 README 明确 Code Artifacts 可在对话中创建 React、HTML、Mermaid，并支持预览/全屏等工作流。[README](https://github.com/danny-avila/LibreChat/blob/main/README.md#L58-L66)、[中文说明](https://github.com/danny-avila/LibreChat/blob/main/README.zh.md#L86-L94)。这只是成熟应用中的功能，不是可独立嵌入的“Artifacts 模块”；未找到官方证据证明其提供 Tweaks、Pin & Comment、HTML/PDF/PPTX 全套导出，或可直接接入 dsh。许可证为 MIT：[LICENSE](https://github.com/danny-avila/LibreChat/blob/main/LICENSE)。 |
| [@codesandbox/sandpack-react](https://github.com/codesandbox/sandpack) | **confirmed（渲染/编辑组件）；不是 Claude Design 项目** | Sandpack 官方文档定位为 React 组件，用于在浏览器中创建交互式编码环境和预览：[docs](https://sandpack.codesandbox.io/docs)。仓库 LICENSE 为 Apache-2.0：[LICENSE](https://github.com/codesandbox/sandpack/blob/main/LICENSE)。它可作为 iframe 预览层候选，但不能提供 Agent、设计提示词、Tweaks 或导出。 |

## 对原建议的具体纠偏

- “OpenDesign 原生支持 DeepSeek Harness”在其 README/官方文档层面是 **confirmed**；但这是 OpenDesign 桌面应用的 native runtime 适配，不是证明 Harness 侧边栏 iframe 可以直接加载 OpenDesign。应把它定位为参考实现/独立产品，先看其 `dsh` 适配和 sidecar IPC，再决定是否复刻公开协议。
- “Open CoDesign 支持 Tweaks、Pin & Comment、HTML/PDF/PPTX”有 README 一手证据，**confirmed**；它仍是 Electron 应用，不能把“功能存在”推导成“可直接移植”。
- “Claude Design Skill 有 Tweaks”是 **confirmed**（模板和协议文件）；“有 Pin & Comment”是 **unverified**，仓库 README/列出的文件没有该实现证据；“原生支持 DeepSeek Harness”是 **wrong**。
- LlamaCoder 的 `esbuild-wasm`/`esm.sh`/sandboxed iframe 是 **confirmed**；但 “适合扩展只需移植”是 **overstated**。`esm.sh` 运行时网络依赖与 MV3 CSP、远程代码执行策略冲突，需本地化依赖并重新设计沙箱边界。
- LibreChat 的 Artifacts 存在，但不能据此宣称有完整 Claude Design 的 Tweaks、Pin & Comment、导出链；这些在当前官方 README 中 **unverified**。

## MV3 侧边栏的三条候选路线

1. **推荐：Harness Skill + 自建本地 HTML 预览器。** 借鉴 `claude-design-skill` 的设计方向/Tweaks JSON 协议；模型输出受限的 artifact manifest（HTML/CSS/JS 或单 HTML），扩展用 `iframe sandbox="allow-scripts"` 加载本地 `srcdoc`/扩展资源。所有 React/Babel/esbuild 依赖随扩展打包，避免 `esm.sh`、远程 CDN 和 `unsafe-eval`。导出先做 HTML；PDF/PPTX 单独实现并设定能力边界。Skill MIT，适合改写；不复制任何 Harness 私有实现。
2. **参考 Open CoDesign/OpenDesign 的数据模型，不嵌整个桌面应用。** 复刻“生成文件 → 预览 → 注释/局部修改 → 版本”的协议和 UI seam。两者分别 MIT/Apache-2.0，但仍需保留许可证、第三方模板许可证，并避免 Electron、sidecar、文件系统权限带入扩展。
3. **需要多文件 React 运行时才选 Sandpack/esbuild。** Sandpack 组件本身可研究，但 MV3 CSP、worker/blob URL、`eval`/`new Function`、远程依赖解析和 iframe `postMessage` 都要在目标 Chrome 中实测；默认不把 `esm.sh` CDN 作为生产依赖。OpenUI/LlamaCoder/LibreChat 更适合作为独立应用参考，不建议直接打包进侧边栏。

## 最小验收清单

先在扩展真实构建产物中验证：`manifest.json` CSP、iframe 是否只加载本地资源、无远程脚本/`eval`、跨 iframe 消息的 origin/nonce 校验、生成文件是否持久化且可读回、Chrome 侧边栏窄宽度下预览是否可用。`pnpm build` 或静态 iframe 测试不能替代真实 Chrome acceptance。

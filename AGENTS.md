改任何代码前，必须完整读取 `docs/agents/development-loop.md`，按其中的刷新规则验证最新效果。

### 领域文档

本仓库是单上下文仓库，使用根目录 `CONTEXT.md` 与 `docs/adr/`。详见 `docs/agents/domain.md`。

## 开发实践

以下实践对本仓库内所有 AI 驱动的开发都是强制性的。
它们来自本代码库真实调试会话中验证过的教训。

### 1. 插件开发是主要的定制路径

大部分产品工作就是通过在 `packages/` 下编写外挂（out-of-tree）插件来定制
Harness —— 这是主要开发活动，不是边缘场景。
以官方上游文档为权威教程来源；不要凭记忆猜 Cordis/DSH API：

- 先读 `upstream/deepseek-harness/docs/cookbook/extension-cookbook.zh.md`，
  了解插件原型（工具插件、钩子插件、UI 插件）。
- 工具插件：`upstream/deepseek-harness/docs/cookbook/adding-a-tool.md`。
- UI 插件 / 会话节点：
  `upstream/deepseek-harness/docs/cookbook/adding-a-conversation-node.md`。
- 包结构清单：
  `upstream/deepseek-harness/docs/cookbook/adding-a-package.md`。
- Cordis 入门与 API 参考在 `upstream/deepseek-harness/docs/` 下
  （`cordis-primer.zh.md`、`cordis-api/`）。

本仓库特有的插件编写规则：

- 照抄一个现有兄弟插件（如 `packages/harness-ui-browser-target`）作为结构
  模板：`src/` + `tsdown.config.ts` + `lib/` 产物 + `test/` 包含包契约测试
  + `package.json` 里的 `dsh.client.inject` 声明。
- 新插件必须加入唯一清单
  `apps/native-server/src/product-plugin-manifest.mjs`；构建、安装、注入、
  类型检查和测试均从该清单派生。
- 对着物化产物树（`.generated/harness-product`）做校验，绝不直接对着
  `upstream/` 源码（见红线）。
- 新 UI 插件通常还需要一个 seam：先查
  `upstream-contributions/README.md` 的通用插槽注册表，
  不要自造临时 DOM 注入。

### 2. 验证链（每次提交前按顺序执行）

```sh
pnpm verify:upstream        # submodule 钉住的提交 + 干净工作树
pnpm typecheck              # 扩展类型检查
pnpm typecheck:plugins      # 插件类型检查
pnpm test                   # 全量回归测试
pnpm build                  # 构建产物
```

行为变更必须有配套测试。整套测试由跨层契约测试构成；
没有测试的行为变更会在评审中被标记出来。

### 3. 架构红线（ADR 强制）

- 绝不修改 `upstream/deepseek-harness`。`pnpm verify:upstream` 是 CI
  不变量；违反者阻塞合并。
- 产品行为归 `packages/`。只有官方 Harness 缺失的、通用且产品中立的
  seam 才能以补丁形式进 `upstream-contributions/`；
  补丁里不得出现产品名。
- 插件不得 import `upstream/deepseek-harness/packages/**/src` 下的文件。
  只能用公开的 Service Definitions。
- 使用 `CONTEXT.md` 的词汇（Browser Target，不是"当前标签页"；
  Verified Write，不是"写入成功"）。见 `docs/agents/domain.md`。

### 4. Connector 规则

- 错误必须端到端透明。绝不用泛化消息替换具体错误；
  下游模型无法恢复它从未收到的信息。如果失败是快的（约 20 毫秒），
  真实原因在 Extension 的回复里；如果是慢的（约 15 秒），
  就是管道超时。
- 变更类操作必须走 Verified Write：读、核指纹、写、回读。
  一步都不能省（ADR-0004、ADR-0006）。
- 改完 `apps/native-server` 后，先同步安装副本并停掉旧 host 进程，
  再做浏览器验证。重开侧边栏即启动新代码。

### 5. 调试实践

- 注册 Native Host 时带上
  `DSH_NATIVE_LOG=/tmp/deepseek-harness-native-host.log`
  可获得帧级诊断日志（已脱敏）。
- 疑似行为 bug 时，在 `output/repro-*.mjs` 下写一个自包含复现脚本，
  直接实例化 `BrowserConnector` / `NativeHost`（不需要 Chrome）。
  `output/` 里的现有脚本可作模板。
- 超时错误与瞬时错误的区分，等价于管道超时与 Extension 失败的区分；
  先查工具调用耗时再猜原因。

### 6. 发布与上游升级

- Mac 安装包：`pnpm release:mac-production-poc`。
- Windows 运行时必须在 Windows x64 构建机上物化
  （`pnpm materialize:windows-harness-runtime`）；
  绝不从 macOS 拷贝原生依赖。CI 会跑安装、注册、升级、回滚
  与用户数据保全检查。
- 升级上游：只移动 submodule 钉住的提交，然后依次
  `pnpm verify:upstream`、`pnpm build:harness-product`、
  `pnpm typecheck:plugins`、`pnpm test`、`pnpm build`。
  冲突时更新 `upstream-contributions/*.patch`；
  绝不在 submodule 内部修补丁。

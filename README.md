# DeepSeek Harness Chrome

这是一个独立的 Chrome MV3 产品仓库。官方 DeepSeek Harness 作为干净的上游底座保存在
`upstream/deepseek-harness`；Chrome、Native Messaging、远程知识库/代码库和产品 UI
能力由本仓库维护。

## 架构

```text
deepseek_harness_chrome/
├── apps/
│   ├── chrome-extension/       WXT Chrome 扩展和 sidepanel
│   └── native-server/          Native Messaging Host 和 Connector
├── packages/                   产品拥有的 Harness Host/Client 插件
├── upstream/
│   └── deepseek-harness/       固定版本的官方 Git submodule，不直接修改
├── upstream-contributions/     官方暂缺的通用、最小插件 seam
├── release/                    Mac/Windows 安装包构建
├── scripts/                    按 build/dev/native/checks/shared/skills 分类的工具
├── skills/                     产品技能；_shared 保存 Office 公共源码
├── test/                       跨层回归测试与 fixtures
├── examples/                   演示文档、数据、工作区和历史验收资料
├── output/                     本地诊断输出；仅复现脚本纳入版本管理
└── docs/                       架构决策、开发规则和目录导航
```

运行链路：

```text
Chrome sidepanel
  -> background: chrome.runtime.connectNative()
  -> apps/native-server
  -> 生成的产品 Harness（官方底座 + 通用 seam + 产品插件）
  -> Harness Web UI + /api + WebSocket
```

根目录只负责编排，不保存重复的扩展或 Native Host 源码。不要修改
`upstream/deepseek-harness`；产品功能放入 `packages/`，确实通用且官方缺少的插件 seam
才放入 `upstream-contributions/`。

完整目录职责与安装兼容约定见 [项目目录导航](docs/project-layout.md)。
所有原有 `pnpm` 命令、插件名称、浏览器消息协议和安装后用户数据位置保持不变。

## 安装依赖与构建

```sh
pnpm install
pnpm build:harness-product
pnpm build
```

不需要预先构建相邻的 `deepseek-harness` 仓库。`pnpm build:harness-product` 会从固定的
官方提交生成 `.generated/harness-product`，顺序应用通用 seam，并构建增强版 Harness。
`pnpm build` 会构建产品插件和 Chrome 扩展。

在 `chrome://extensions` 开启“开发者模式”，选择：

```text
apps/chrome-extension/.output/chrome-mv3
```

然后复制扩展 ID，并注册 Native Host：

```sh
DEEPSEEK_HARNESS_EXTENSION_ID=<扩展ID> pnpm register-native-host
```

需要同时允许生产版和开发版时，可以传入逗号分隔的多个 ID：

```sh
DEEPSEEK_HARNESS_EXTENSION_ID=<生产ID>,<开发ID> pnpm register-native-host
```

注册脚本默认使用 `.generated/harness-product`。只有调试其他 Harness 构建时才设置
`DSH_ROOT` 或 `DSH_CLI_PATH`；使用其他工作目录时设置 `DSH_CWD`。

## 开发和一键重启

```sh
pnpm dev:restart
```

该命令会按需启动 WXT、生成产品 Harness、同步 Native Host 并结束旧进程。若命令启动了
WXT，需要保持终端运行。只修改扩展或 Native Server、确定不需要重建 Harness 时：

```sh
pnpm dev:restart -- --skip-harness-build
```

需要让所有层级的修改一起生效时，使用一键完整刷新：

```sh
pnpm dev:refresh
```

它会重新生成 Harness、构建产品插件、同步 Web 资源，并重启 WXT 和 Native Host。
如果只修改了产品插件、扩展或 Native Server，可跳过较慢的 Harness 重生成：

```sh
pnpm dev:refresh -- --fast
```

扩展页面和样式由 WXT 热更新；Native Server、Harness Host 插件和配置变更需要执行上面的
一键重启。排查 Native Messaging 时可以设置日志文件：

```sh
DSH_NATIVE_LOG=/tmp/deepseek-harness-native-host.log \
DEEPSEEK_HARNESS_EXTENSION_ID=<扩展ID> \
pnpm register-native-host
```

## 验证

```sh
pnpm verify:upstream
pnpm typecheck
pnpm typecheck:plugins
pnpm test
pnpm build
```

`pnpm verify:upstream` 必须显示官方 submodule 干净。扩展生产产物位于
`apps/chrome-extension/.output/chrome-mv3`。

## Mac 生产包

```sh
pnpm release:mac-production-poc
```

Mac 包包含无 `node_modules` 的 Harness/Native Server 运行时、扩展和安装脚本。生成包通过
自动化启动验证后才会完成构建；正式交付仍应在目标 Mac 上完成安装、Chrome Native
Messaging 和升级验收。

## Windows AccrUI 兼容包

Windows 发行模块保留 AccrUI 更新器的外层契约：

```text
accr-ui-windows-lite-x64.zip
└── accr-ui-windows-lite-x64/
    ├── install.ps1
    ├── install.vbs
    └── payload.zip
```

Windows x64 Runtime 必须在 Windows x64 构建机上物化，不能从 macOS 复制原生依赖：

```sh
pnpm materialize:windows-harness-runtime -- \
  --source <built-harness-checkout> \
  --out <runtime-directory> \
  --revision <git-revision>

pnpm release:windows-lite -- \
  --harness-runtime <runtime-directory> \
  --version 1.1.63
```

随后运行：

```sh
pnpm test:windows-release
```

GitHub Actions 的 `Build Windows Lite` 工作流会在 `windows-latest` 上构建。ZIP 和自动化测试
会递归检出固定版本的官方 submodule，构建 `.generated/harness-product`，再从该产品树物化
Windows Runtime。它不再检出第二份 Harness，也不再应用产品级大补丁。Windows Runner 会
在隔离的用户目录中执行安装、Chrome/Edge Native Messaging 注册、`ping`/`pong`、升级、
回滚和用户数据保留验收。自动化不包含真实浏览器侧边栏的可视化操作，因此候选包交付前仍需
在目标 Windows 机器完成 Chrome/Edge 侧边栏人工 UAT。

## 上游升级

升级时只更新 `upstream/deepseek-harness` 的固定提交，然后依次执行：

```sh
pnpm verify:upstream
pnpm build:harness-product
pnpm typecheck:plugins
pnpm test
pnpm build
```

若通用 seam 无法应用，应更新对应的 `upstream-contributions/*.patch`；不要直接在 submodule
中修复。Windows 和 Mac 构建都只消费由该流程生成的产品 Harness。

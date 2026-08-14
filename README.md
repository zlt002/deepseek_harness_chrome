# DeepSeek Harness Chrome

这是一个独立的 Chrome MV3 扩展项目，参考 `accr-ui` 的组织方式：`sidepanel` 负责用户入口，background service worker 负责 Native Messaging，`native-server` 负责启动和监管 DeepSeek Harness Web 进程。

当前第一阶段的实际链路是：

```text
Chrome sidepanel
  -> background: chrome.runtime.connectNative()
  -> native-server: Chrome Native Messaging
  -> dsh --profile web --host 127.0.0.1 --port 0
  -> DeepSeek Harness Web UI + /api + WebSocket
```

sidepanel 会在 iframe 中直接加载 Native Host 返回的 `http://127.0.0.1:<port>` Harness Web UI，因此 Harness 的页面、会话、设置、模型、工具和流式事件都继续使用原项目实现。native-server 不复制 Harness 核心逻辑，只负责进程生命周期和本地地址发现。

## 当前状态

- 已有 MV3 sidepanel/background/native-server 链路。
- Native Host 只返回它实际启动的、带端口的 `127.0.0.1` Harness Web 地址。
- Native host 注册脚本覆盖 macOS/Linux；Windows 仍需要后续增加 launcher/安装器。
- 当前已完成源码、协议/代理测试、真实 Harness 启动和 `host.describe` 命令行端到端验证；Chrome 加载扩展后的可视化验收仍需在本机浏览器中完成。

## 本地运行

在 `deepseek-harness` 仓库中先构建 Web 和 host artifacts：

```sh
cd /Users/zhanglt21/Desktop/accrnew/deepseek-harness
pnpm run build
```

安装并构建扩展：

```sh
cd /Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome
pnpm install
pnpm run build
```

打开 `chrome://extensions`，开启“开发者模式”，选择 `.output/chrome-mv3`，复制扩展 ID。扩展图标会直接打开 Chrome side panel。然后注册 native host：

```sh
DEEPSEEK_HARNESS_EXTENSION_ID=<扩展ID> \
DSH_ROOT=/Users/zhanglt21/Desktop/accrnew/deepseek-harness \
pnpm run register-native-host
```

需要同时使用生产构建和 `chrome-mv3-dev` 时，用逗号同时传入两个扩展 ID，避免其中一个被 Native Messaging 白名单拒绝：

```sh
DEEPSEEK_HARNESS_EXTENSION_ID=<生产ID>,<开发ID> \
DSH_ROOT=/Users/zhanglt21/Desktop/accrnew/deepseek-harness \
pnpm run register-native-host
```

重新加载扩展，点击扩展图标或打开 side panel。若 native host 找不到 Harness CLI，可直接指定：

```sh
DSH_CLI_PATH=/absolute/path/to/deepseek-harness/apps/cli/lib/bin.js \
DEEPSEEK_HARNESS_EXTENSION_ID=<扩展ID> \
pnpm run register-native-host
```

Native Host 的工作目录默认跟随 `DSH_ROOT`；需要使用其他工作区时设置 `DSH_CWD`。

排查 Native Messaging 启动问题时，可以把 `DSH_NATIVE_LOG` 传给注册命令；Native Host 会把启动、协议帧和退出原因追加到该文件：

```sh
DSH_NATIVE_LOG=/tmp/deepseek-harness-native-host.log \
DEEPSEEK_HARNESS_EXTENSION_ID=<扩展ID> \
pnpm run register-native-host
```

## 验证

```sh
pnpm test
pnpm typecheck
pnpm build
```

`pnpm build` 当前仍会同步旧的扩展内置 Harness 资源，后续可在 localhost iframe 完成真实 Chrome 验收后删除这部分兼容构建。native-server 是无依赖的 Node ESM launcher，注册脚本会把它作为 Chrome Native Messaging executable 运行。开发环境默认从相邻的 `deepseek-harness/apps/cli/lib/bin.js` 启动 Harness，也可以通过 `DSH_CLI_PATH` 指向已安装的 CLI。

## 后续迁移方向

下一阶段可以补充用户安装包、Windows Native Host launcher、版本升级和真实模型验收。当前 iframe 只访问 Native Host 启动的本机 `127.0.0.1` Harness 服务，不会把 Harness UI 请求发到公网。

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

sidepanel 会把 Harness 完整 Web UI 加载到扩展自己的 iframe 中，因此 Harness 的会话、设置、模型、工具和流式事件仍然使用原项目实现。native-server 不复制 Harness 核心逻辑，只负责进程生命周期和本地地址发现。

扩展页面使用 MV3 允许的外部脚本加载 Harness boot manifest、主题初始化和 Native bridge，不依赖 `unsafe-inline`。Harness 的绝对 `/assets`、`/plugins` 路径都指向扩展自身资源。

## 当前状态

- 已有 MV3 sidepanel/background/native-server 链路。
- Harness Web 主包和运行时读取到的 38 个 client bundle 会被同步进扩展，不依赖浏览器访问 Harness 的外部 Web 页面。
- `/api/*` HTTP 请求、`/api/events.mux`、`/api/events.host` WebSocket 和 `client-hmr` 使用的 `/plugins/events` SSE 由 native-server 的 loopback proxy 转发；proxy 会移除扩展 Origin，让 Harness 原有信任栅栏继续生效。
- 扩展只接受 Native Host 返回的带端口 `127.0.0.1` 地址，阻止被手工修改的 `native` 参数把 Harness 请求转发到外部站点。
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

`pnpm build` 会先从已构建的 DeepSeek Harness Web 运行时同步主页面和 client bundles，再构建扩展；native-server 是无依赖的 Node ESM launcher，注册脚本会把它作为 Chrome Native Messaging executable 运行。开发环境默认从相邻的 `deepseek-harness/apps/cli/lib/bin.js` 启动 Harness，也可以通过 `DSH_CLI_PATH` 指向已安装的 CLI。

## 后续迁移方向

下一阶段可以补充用户安装包、Windows Native Host launcher、版本升级和真实模型验收。当前 iframe 只是扩展内部资源加载方式，不会把 Harness UI 请求发到公网。

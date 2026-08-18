# Chrome DevTools MCP 直连现有浏览器（--autoConnect）配置教程

让 DSH 的 Chrome DevTools MCP **接管你正在使用的 Chrome**，而不是每次都新开一个浏览器实例。

## 适用场景

- 已在 Chrome 里打开 `chrome://inspect/#remote-debugging` 的 "Remote debugging" 开关，看到类似 `Server running at: 127.0.0.1:59375` 的提示；
- 希望 MCP 复用当前浏览器的登录态、Cookie、已打开的标签页；
- 环境要求：**Chrome 144+**，chrome-devtools-mcp **v1.7.0+**（`--autoConnect` 自该版本引入）。

## 原理：两种"远程调试"不是一回事

| | 传统 `--remote-debugging-port` | Chrome 144+ Remote debugging 开关 |
|---|---|---|
| 开启方式 | 命令行 flag 启动 Chrome | `chrome://inspect/#remote-debugging` 页面开关 |
| HTTP 发现接口 (`/json/version` 等) | ✅ 有 | ❌ 没有（curl 返回 404，**属正常**） |
| 连接方式 | HTTP 拿 `webSocketDebuggerUrl` | 读用户数据目录下 `DevToolsActivePort` 文件（端口 + 带令牌的 WS 路径） |
| MCP 对应参数 | `--browserUrl http://127.0.0.1:9222` | `--autoConnect` |

`--autoConnect` 的工作机制：

1. 根据 channel（默认 stable）定位 Chrome 用户数据目录（macOS 为 `~/Library/Application Support/Google/Chrome/`）；
2. 读取其中的 `DevToolsActivePort` 文件，内容两行：端口号 + `/devtools/browser/<uuid>` 令牌路径；
3. 用 `ws://127.0.0.1:<port><path>` 直连现有浏览器进程，**不启动新实例**；
4. 首次连接时 Chrome 会弹授权对话框，用户点"允许"后建立连接。

因为每次连接都重新读文件，Chrome 重启后端口/令牌变化不影响使用，无需改配置。

## 配置步骤

### 1. 打开 Chrome 的远程调试开关

地址栏进入 `chrome://inspect/#remote-debugging`，开启 "Allow remote debugging for this browser instance"。

> ⚠️ 此开关赋予外部程序完整的浏览器控制权（含已存密码、Cookie 的读取），仅在你信任发起连接的应用时开启。

### 2. 修改 DSH 桌面端 profile 补丁

编辑 `~/.dsh/profiles/desktop/cordis.patch.yml`，在 MCP 启动参数里追加 `--autoConnect`：

```yaml
# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; `!!js` expressions allowed).
- insert:
    - id: mcp-chrome-devtools
      name: '@deepseek-ai/dsh-mcp-client'
      config:
        serverName: chrome-devtools
        transport: stdio
        command: npx
        args: ['-y', 'chrome-devtools-mcp@latest', '--autoConnect']
        env:
          PATH: /usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
```

唯一改动是 `args` 从 `['-y', 'chrome-devtools-mcp@latest']` 变为 `['-y', 'chrome-devtools-mcp@latest', '--autoConnect']`。

> 注意：`--autoConnect` 与 `--isolated`、`--executablePath` 互斥（conflicts），与 `--browserUrl`/`--wsEndpoint` 是替代关系，不要同时配。

### 3. 重启 DSH Desktop

**完全退出（⌘Q）后重新打开**，并重开会话。

为什么必须重启：`dsh-mcp-client` 的连接监督器（connection supervisor）在 MCP 进程意外退出时，会用**内存中已解析的旧配置**按退避策略重启；只有宿主进程重启才会重新读取 `cordis.patch.yml`。

### 4. 首次连接时点"允许"

Chrome 会弹出授权对话框（"外部应用请求控制此浏览器"之类），点允许即可。同一浏览器后续连接不会再弹。

## 验证

配置生效后，在 DSH 会话里调用任意 Chrome DevTools MCP 工具（如 `list_pages`），应能看到你**当前 Chrome 里真实打开的标签页**，而不是一个空白 `about:blank`。

也可以在终端手动验证连接链路：

```sh
# 读取 DevToolsActivePort（应输出两行：端口 + 令牌路径）
cat "$HOME/Library/Application Support/Google/Chrome/DevToolsActivePort"

# 用 node 直连 WS 端点（替换成上一步读到的端口和路径）
node -e '
const [port, path] = require("fs")
  .readFileSync(process.env.HOME + "/Library/Application Support/Google/Chrome/DevToolsActivePort", "utf8")
  .trim().split("\n");
const ws = new WebSocket("ws://127.0.0.1:" + port + path);
ws.onopen = () => { console.log("OPEN ✓"); ws.send(JSON.stringify({id:1, method:"Browser.getVersion"})); };
ws.onmessage = m => { console.log(String(m.data).slice(0, 200)); process.exit(0); };
ws.onerror = () => console.log("error ✗");
setTimeout(() => process.exit(0), 4000);'
```

返回 `Chrome/xxx` 版本信息即链路通畅。整个验证过程 Chrome 主进程数应保持不变（`pgrep -f "MacOS/Google Chrome$" | wc -l` 恒为 1）。

## 常见问题

**Q: `curl http://127.0.0.1:<port>/json/version` 返回 404，是不是坏了？**
不是。Chrome 144+ 的 Remote debugging 开关不提供传统 HTTP 发现接口，这是它和老式 `--remote-debugging-port` 的核心区别。404 恰恰说明你用的是新机制，配 `--autoConnect` 就对了。

**Q: 连接的是哪个 Chrome profile？**
默认 profile（由 Chrome 决定）。如果你开多个 profile 窗口，MCP 只能看到默认 profile 的窗口。

**Q: Chrome 重启后端口变了要改配置吗？**
不用。`--autoConnect` 每次连接都重新读 `DevToolsActivePort` 文件，自动跟随新端口和令牌。只需保证 Remote debugging 开关保持打开。

**Q: 怎么退回"每次新开浏览器"的行为？**
把 `--autoConnect` 从 args 里删掉，重启 DSH Desktop。

**Q: 想连非 stable channel 的 Chrome？**
`--autoConnect` 按 channel 定位用户数据目录（默认 stable），可配合 `--channel` 参数指定 beta/dev/canary。

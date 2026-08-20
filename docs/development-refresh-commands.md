# 开发改动生效命令速查

本文用于判断修改代码或 Skill 后应该执行哪条命令。所有命令都在仓库根目录执行：

```sh
cd /Users/zhanglt21/Desktop/accrnew/deepseek_harness_chrome
```

## 最常用：让 Skill 修改生效

只修改了 `skills/` 下的 Skill、模板或校验脚本时，执行：

```sh
pnpm dev:restart -- --skip-harness-build
```

这条命令会：

1. 把最新 Skill 和 Native Server 同步到 macOS 的 `Application Support/DeepSeekHarness` 安装目录。
2. 重新注册 Chrome、Edge 的 Native Host。
3. 停止仍在使用旧文件的 Native Host 和 Harness 进程。
4. 在需要时启动扩展开发服务。

命令完成后重新打开侧边栏，并且必须新建会话。Skill 内容在会话开始时注入，旧会话不会自动换成新版 Skill。

## `/pmd-prd` 为什么必须同时刷新两层

`/pmd-prd` 有两层规则同时生效：

1. **Skill** 负责需求对话、分析过程和双文档生成。
2. **Native Server** 负责在交付前校验双文档格式，并执行 Team Knowledge 预览、创建和回读。

因此，“重新打开侧边栏 + 新建会话”只能让新 Skill 进入会话；如果 Native Server 仍是旧版，新版六段式交接文档仍可能被旧合同拒绝。标准做法是先执行：

```sh
pnpm dev:restart -- --skip-harness-build
```

再重新打开侧边栏并新建会话。不要只手工复制 Skill，也不要在旧会话中继续重试。

如果旧批次已经创建过文档，不要用同一个批次标识改成另一套正文；批次会用目标和正文指纹防止误覆盖。应先确认旧文档如何处理，再用新会话和新批次重新交付。

## 根据修改位置选择命令

| 修改位置 | 使用命令 | 作用 |
| --- | --- | --- |
| `skills/*` | `pnpm dev:restart -- --skip-harness-build` | 同步 Skill、重新注册并重启 Native Host，不重建 Harness 基座 |
| `apps/native-server/*` | `pnpm dev:restart -- --skip-harness-build` | 安装最新 Native Server，并停止旧进程 |
| `packages/*` 产品插件 | `pnpm dev:refresh -- --fast` | 保留现有 Harness 基座，重建产品插件、同步 Web 资源并重启运行环境 |
| `apps/chrome-extension/*` | 开发时使用 `pnpm dev` | 启动 WXT 开发服务，页面和样式保存后自动热更新 |
| `upstream-contributions/*`、上游版本或 Harness 物化逻辑 | `pnpm dev:refresh` | 从头生成 Harness 产品树，再重建插件、同步资源并重启全部运行环境 |
| 仅修改 `docs/*` | 不需要运行时刷新 | 文档不会影响扩展或 Skill 运行时 |

不确定改动属于哪一层时，优先检查文件路径。不要为了普通 Skill 修改执行耗时较长的完整刷新。

## 各命令具体做什么

### `pnpm dev:restart -- --skip-harness-build`

适合日常 Skill 和 Native Server 修改。它复用现有 `.generated/harness-product`，因此速度最快。

如果扩展开发服务尚未运行，该命令会启动它并保持当前终端运行；此时不要关闭终端。

### `pnpm dev:refresh -- --fast`

适合修改 `packages/*` 产品插件，或者需要重新同步扩展内的 Harness Web 资源时。

执行内容包括：

1. 保留现有 Harness 产品树。
2. 重新构建产品插件。
3. 同步 Harness Web 资源到扩展。
4. 重新启动 WXT 和 Native Host。

### `pnpm dev:refresh`

这是完整刷新，适合修改 Harness seam、上游提交或物化流程时使用。

它会重新生成 `.generated/harness-product`、构建全部产品插件、同步扩展资源并重启运行环境。该命令最慢，不用于普通 Skill 修改。

### `pnpm dev:watch`

持续监听 `apps/native-server/`。保存 Native Server 文件后，会自动同步安装副本并停止旧 Host。

```sh
pnpm dev:watch
```

注意：它不监听 `skills/`、`packages/` 或 Harness 基座。修改 Skill 后仍需执行 `pnpm dev:restart -- --skip-harness-build`。

### `pnpm register-native-host`

用于首次安装，或手动更新浏览器扩展 ID 白名单：

```sh
DEEPSEEK_HARNESS_EXTENSION_ID=<扩展ID> pnpm register-native-host
```

同时允许生产版和开发版扩展时：

```sh
DEEPSEEK_HARNESS_EXTENSION_ID=<生产ID>,<开发ID> pnpm register-native-host
```

该命令负责复制安装文件和写入 Native Messaging manifest，但不会可靠地结束所有已经加载旧代码的进程。日常修改完成后优先使用 `dev:restart`。

## 如何确认改动真的生效

命令成功只说明文件已同步，不代表当前旧会话已经使用新版内容。按下面顺序确认：

1. 等待命令执行完成。
2. 重新打开侧边栏；如果侧边栏已打开，等待它自动重连。
3. 新建 Harness 会话。
4. 运行 `/pmd-prd` 或对应 Skill，检查新流程、新文案是否出现。
5. 涉及浏览器能力时，再验证真实 Browser Target、Native Messaging 和业务结果。

对于 `/pmd-prd`，可以展开会话里的 `上下文注入 pmd-prd`，确认 Skill 基础目录来自：

```text
/Users/zhanglt21/Library/Application Support/DeepSeekHarness/skills/pmd-prd
```

## 提交前验证

运行时刷新和代码质量验证是两件事。准备提交前执行：

```sh
pnpm verify:upstream
pnpm typecheck
pnpm typecheck:plugins
pnpm test
pnpm build
```

这些命令用于检查上游状态、类型、测试和构建；它们不能替代“重新打开侧边栏并新建会话”的实际生效验证。

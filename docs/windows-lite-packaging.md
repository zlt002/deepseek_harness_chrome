# Windows Lite 打包教程

本文说明如何通过 GitHub Actions 快速、稳定地生成 AccrUI 兼容的 Windows x64
Harness Workspace 安装包。

Windows 原生依赖必须在 Windows x64 构建机上物化。不要在 macOS 上生成 Windows
runtime，也不要把完整 `node_modules` 放进安装包。

## 最终产物

工作流成功后，会在草稿 GitHub Release 中生成：

- `accr-ui-windows-lite-x64.zip`
- `accr-ui-windows-lite-x64.zip.sha256`

同一版本重复构建会覆盖同一草稿 Release 的旧文件。Release tag 为：

```text
windows-lite-v<版本号>-candidate
```

ZIP 内部主要结构：

```text
accr-ui-windows-lite-x64/
├── install.vbs
├── install-ui.ps1
├── install.ps1
├── payload.zip
└── README.zh-CN.md
```

双击 `install.vbs` 会打开 `install-ui.ps1` 提供的可视化安装界面；它负责环境检查、
选择目录、覆盖确认和进度显示。真正的安装、升级、数据保留和回滚都由
`install.ps1` 完成。`payload.zip` 包含扩展、静态 Harness JavaScript bundle、Native Server 和少量
Windows x64 原生文件，不包含 `runtime/harness/node_modules`。用户后来安装的插件
保存在 `%APPDATA%\accr-ui-harness\profile`，升级主程序不会删除。

## 方式一：日常快速出包

适合开发联调或快速给测试人员一个新包。它会生成 ZIP 和 SHA256 并上传草稿
Release，但不会执行完整安装、升级和回滚验收。

在 GitHub 仓库页面操作：

1. 打开 **Actions**。
2. 选择 **Build Windows Lite**。
3. 点击 **Run workflow**。
4. 选择需要打包的分支。
5. 填写三段式版本号，例如 `1.1.63`。
6. 保持 `full_validation` 关闭并运行。

也可以使用 GitHub CLI：

```sh
gh workflow run build-windows-lite.yml \
  --ref codex/windows-lite-1.1.63 \
  -f version=1.1.63 \
  -f full_validation=false
```

查看最新运行：

```sh
gh run list --workflow "Build Windows Lite" --limit 5
gh run watch <RUN_ID> --interval 10 --exit-status
```

推送到 `codex/windows-lite-*` 分支也会自动出包，但自动推送使用工作流中的默认
版本。目前默认值是 `1.1.63`。发布新版本时应手动传入 `version`，或者同步修改
[build-windows-lite.yml](../.github/workflows/build-windows-lite.yml) 中的默认版本，避免
包内容和预期版本不一致。

## 方式二：正式交付前完整验收

候选包准备交给 Windows 用户前，必须至少运行一次完整验收：

```sh
gh workflow run build-windows-lite.yml \
  --ref codex/windows-lite-1.1.63 \
  -f version=1.1.63 \
  -f full_validation=true
```

完整验收会自动检查：

- `install.vbs` 能在 CI 无界面模式调用 `install.ps1` 完成安装。
- 包含 `install-ui.ps1` 可视化安装壳，支持 Node.js 22+ 和 Chrome/Edge 检测、选择目录、覆盖确认与进度显示。
- Chrome、Edge 的 Native Messaging 注册正确。
- Native Host 能完成 `ping/pong` 并正常停止。
- Harness Web 能启动并激活全部 10 个产品 UI 插件。
- Windows 目录选择器能加载 Koffi 并进入 `showing` 状态。
- 从旧版本升级后，工作区、日志和用户数据仍然存在。
- 回滚能恢复旧版本，再次回滚能恢复候选版本。
- ZIP 结构、扩展 ID、版本号和 SHA256 正确。

只有该步骤显示绿色的
`Windows install, Native Messaging, upgrade, rollback, and restore acceptance passed.`，
才表示自动化 Windows 验收通过。

自动化通过后，仍需在真实 Windows Chrome/Edge 中做一次侧边栏视觉和交互确认。
构建成功不能代替真实界面的 Parity Gate。

## 打包前本地检查

提交前按仓库标准执行：

```sh
pnpm verify:upstream
pnpm typecheck
pnpm typecheck:plugins
pnpm test
pnpm build
```

其中 `pnpm verify:upstream` 必须证明官方
`upstream/deepseek-harness` submodule 没有产品修改。产品 UI 应来自 `packages/`
中的外挂插件。

## CI 实际执行顺序

工作流定义在
[build-windows-lite.yml](../.github/workflows/build-windows-lite.yml)，主要顺序如下：

```text
checkout + pnpm install
→ 验证干净的 Harness upstream
→ 恢复 Windows release-ready 缓存
→ 缓存未命中时物化 Harness、构建 10 个产品插件和 Windows runtime
→ 构建扩展
→ 组装 AccrUI 兼容 ZIP
→ 可选完整 Windows 验收
→ 写 SHA256
→ 覆盖上传草稿 Release
```

Windows 静态 runtime 由
[build-static-harness-runtime.mjs](../release/windows-lite/build-static-harness-runtime.mjs)
生成；外层 AccrUI 兼容包由
[windows-release.mjs](../release/windows-lite/windows-release.mjs) 组装；完整验收逻辑位于
[acceptance-windows.ps1](../release/windows-lite/acceptance-windows.ps1)。

## 缓存和耗时

- 缓存未命中：通常约 5–8 分钟，主要时间用于从零物化和构建 Harness。
- 缓存命中：通常约 1–2 分钟，只需组装 ZIP、写校验和并上传。
- 修改扩展、Native Server、`packages/*`、打包脚本、Harness 补丁、submodule、
  `package.json` 或锁文件都会使缓存失效，这是正常现象。

不要因为日志里步骤多就合并构建步骤。独立步骤让缓存命中时可以安全跳过四个慢步骤。

## 如何确认包真的成功

不能只看 ZIP 文件是否存在。至少确认：

1. GitHub Actions 运行整体为绿色。
2. `Build AccrUI-compatible Windows package` 成功。
3. `Write checksum` 成功。
4. `Upload Windows package to draft release` 成功。
5. Release 中 ZIP 和 `.sha256` 的更新时间对应当前提交。
6. 正式交付时，`full_validation=true` 的验收也为绿色。

查看 Release：

```sh
gh release view windows-lite-v1.1.63-candidate \
  --json tagName,isDraft,targetCommitish,assets,url
```

下载后可以校验：

```powershell
Get-FileHash -Algorithm SHA256 .\accr-ui-windows-lite-x64.zip
Get-Content .\accr-ui-windows-lite-x64.zip.sha256
```

两个 SHA256 值必须一致。

## 常见问题

### 四个构建步骤显示跳过

如果 `Build materialized Harness product`、`Bundle static Windows Harness runtime`、
`Build release-ready extension` 和 `Save release-ready Windows inputs cache` 同时显示
跳过，通常表示 release-ready 缓存命中，不是打包遗漏。

### 每次都需要 5–8 分钟

先确认上一次相同代码的运行已经执行到 `Save release-ready Windows inputs cache`。
如果运行在保存缓存之前失败，下一次仍然必须从零构建。

### Windows 界面仍然像官方默认界面

正式验收日志必须出现：

```text
Harness Web activated 10 product client plugins.
```

没有这行时，不要发布。它表示产品 UI 插件没有进入 Harness Web 启动清单。

### 目录选择器失败

正式验收日志必须出现：

```text
Directory-picker worker loaded Koffi and reported showing.
```

出现 Koffi、Worker 或原生文件错误时，应修复 Windows runtime，不能从 macOS
复制原生依赖，也不能用完整 `node_modules` 绕过问题。

### `install.vbs` 闪退

优先查看包目录内的 `install-launch.log` 和 `%TEMP%\accr-ui-harness-install.log`。
正常双击会打开可视化安装界面，不再直接弹出 PowerShell 黑窗口。CI 完整验收会用
`cscript.exe` 执行同一个 `install.vbs`；交付前应保证完整验收通过。

## 已验证基准

2026-08-18 在提交 `9eeea12` 上完成了两次验证：

- 完整 Windows 验收成功，运行耗时 7 分 39 秒。
- 随后的缓存命中快速打包成功，运行耗时 1 分 38 秒。
- ZIP 大小约 26.5 MiB。

这些数字用于判断流程是否明显异常，不是固定性能承诺。

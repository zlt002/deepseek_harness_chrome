# Windows Lite 打包教程

本文说明如何通过 GitHub Actions 快速、稳定地生成 AccrUI 兼容的 Windows x64
Harness Workspace 安装包。

Windows 原生依赖必须在 Windows x64 构建机上物化。不要在 macOS 上生成 Windows
runtime，也不要把完整 `node_modules` 放进安装包。

## 最终产物

同时完成 `full_validation=true`、真实 Windows Chrome/Edge 侧边栏 UAT，并在再次运行时明确开启 `publish_public=true` 后，工作流才会在不可覆盖的公开版本 Release 中生成：

- `accr-ui-windows-lite-x64.zip`
- `accr-ui-windows-lite-x64.zip.sha256`

客户端固定读取公开 `windows-lite-current` Release 中的
`accr-ui-windows-lite-update.json`。该 manifest 带版本、公开版本 Release URL、SHA256 和不可变的包 URL；它只在完整 Windows 验收通过后覆盖更新。

每次公开发布必须使用高于已发布 Windows Lite 版本的三段式版本；重复版本会被 CI 拒绝。版本 Release tag 为：

```text
windows-lite-v<版本号>
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
`install.ps1` 完成。`payload.zip` 包含扩展、静态 Harness JavaScript bundle、Native Server、
产品 UI 插件、产品 skill 根目录和少量 Windows x64 原生文件，不包含
`runtime/harness/node_modules`。其中 `runtime/skills/pmd-prd` 是内置 `/pmd-prd`，
`runtime/skills/{pptx,xlsx,docx,pdf}` 是产品内置 Office skill；
`run_native_host.bat` 必须设置 `DSH_PRODUCT_SKILLS_ROOT=%PACKAGE_DIR%skills`，
这样即使用户电脑已有 `%USERPROFILE%\.claude\skills` 同名目录，也走产品合同。
四个 Office skill 由独立 provider 以 rank 1 发布，项目根和用户端同名 skill 不能覆盖它们。
用户后来安装的插件保存在安装目录的 `profile`（`<InstallRoot>\profile`）；升级主程序不会删除。

## 方式一：日常快速出包

适合开发联调或快速给测试人员一个新包。它只生成 ZIP、SHA256 并上传草稿候选
Release；即使开启完整自动验收，只要未开启 `publish_public` 仍不会生成更新 manifest，也不会成为客户端默认更新源。

在 GitHub 仓库页面操作：

1. 打开 **Actions**。
2. 选择 **Build Windows Lite**。
3. 点击 **Run workflow**。
4. 选择需要打包的分支。
5. 填写三段式版本号，例如 `1.1.96`。
6. 保持 `full_validation` 关闭并运行。

也可以使用 GitHub CLI：

```sh
gh workflow run build-windows-lite.yml \
  --ref codex/windows-lite-1.1.63 \
  -f version=1.1.96 \
  -f full_validation=false \
  -f publish_public=false
```

查看最新运行：

```sh
gh run list --workflow "Build Windows Lite" --limit 5
gh run watch <RUN_ID> --interval 10 --exit-status
```

推送到 `codex/windows-lite-*` 分支也会自动出包，但自动推送使用工作流中的默认
版本。目前默认值是 `1.1.96`。发布新版本时应手动传入 `version`，或者同步修改
[build-windows-lite.yml](../.github/workflows/build-windows-lite.yml) 中的默认版本，避免
包内容和预期版本不一致。

## 方式二：正式交付前完整验收

候选包准备交给 Windows 用户前，必须至少运行一次完整验收：

```sh
gh workflow run build-windows-lite.yml \
  --ref codex/windows-lite-1.1.63 \
  -f version=1.1.96 \
  -f full_validation=true
```

完整验收会自动检查：

- `install.vbs` 能在 CI 无界面模式调用 `install.ps1` 完成安装。
- 包含 `install-ui.ps1` 可视化安装壳，支持 Node.js 22.19.x 或 24+ 和 Chrome/Edge 检测、选择目录、覆盖确认与进度显示。
- Chrome、Edge 的 Native Messaging 注册正确。
- Native Host 能完成 `ping/pong` 并正常停止。
- Harness Web 能启动并激活产品插件唯一清单中的全部 UI 插件。
- 安装树里存在 `runtime/skills/pmd-prd/SKILL.md` 以及 `pptx` / `xlsx` / `docx` / `pdf`，且 launcher 指向该产品 skill 根。
- Windows 目录选择器能加载 Koffi 并进入 `showing` 状态。
- 从旧版本升级后，工作区、日志和用户数据仍然存在。
- 回滚能恢复旧版本，再次回滚能恢复候选版本。
- ZIP 结构、扩展 ID、版本号和 SHA256 正确。

只有该步骤显示绿色的
`Windows install, Native Messaging, upgrade, rollback, and restore acceptance passed.`，
才表示自动化 Windows 验收通过。

自动化通过后，仍需在真实 Windows Chrome/Edge 中做一次侧边栏视觉和交互确认。
构建成功不能代替真实界面的 Parity Gate。

UAT 已完成后，先从草稿候选 Release 取得其精确提交和 ZIP SHA256。两项都必须来自
同一个 `windows-lite-v<版本号>-candidate`，不能使用本机重新组装包的 SHA：

```sh
gh release view windows-lite-v1.1.96-candidate \
  --json targetCommitish,assets
gh release download windows-lite-v1.1.96-candidate \
  --pattern accr-ui-windows-lite-x64.zip --dir /tmp/accr-ui-candidate
shasum -a 256 /tmp/accr-ui-candidate/accr-ui-windows-lite-x64.zip
```

UAT 已完成后，才以相同版本、同一提交和上一步得到的 SHA 重新运行下列命令公开发布。
`publish_public=true` 会被拒绝，除非同时保留 `full_validation=true`，并传入
`uat_candidate_commit` 与 `uat_candidate_sha256`：

```sh
gh workflow run build-windows-lite.yml \
  --ref codex/windows-lite-1.1.63 \
  -f version=1.1.96 \
  -f full_validation=true \
  -f publish_public=true \
  -f uat_candidate_commit=<candidate-targetCommitish> \
  -f uat_candidate_sha256=<candidate-zip-sha256>
```

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
中的外挂插件。产品 skill 应来自仓库根目录 `skills/`，由
[windows-release.mjs](../release/windows-lite/windows-release.mjs) 在组装 ZIP 时拷进
`payload/runtime/skills`，不要指望 Windows 静态 runtime 或用户 `~/.claude/skills`
自动带上它。

本机在已有 Windows runtime 闭包和扩展产物时，可只组装外层包：

```sh
node release/windows-lite/windows-release.mjs \
  --harness-runtime release/windows-lite/harness-static-win32-x64 \
  --version 1.1.96
```

没有 Windows x64 runtime 时，不要在 macOS 上跑
`pnpm materialize:windows-harness-static-runtime`。可用测试夹具验证 ZIP 结构，
或走 GitHub Actions 出正式包。组装成功后至少确认：

```sh
unzip -Z1 release/accr-ui-windows-lite-x64/payload.zip | grep -E 'runtime/skills/(pmd-prd|pptx|xlsx|docx|pdf)/SKILL.md'
unzip -p release/accr-ui-windows-lite-x64/payload.zip runtime/run_native_host.bat \
  | grep DSH_PRODUCT_SKILLS_ROOT
```

## CI 实际执行顺序

工作流定义在
[build-windows-lite.yml](../.github/workflows/build-windows-lite.yml)，主要顺序如下：

```text
checkout + pnpm install
→ 验证干净的 Harness upstream
→ 恢复 Windows release-ready 缓存
→ 缓存未命中时物化 Harness、构建产品插件唯一清单中的全部 UI 插件和 Windows runtime
→ 构建扩展
→ 组装 AccrUI 兼容 ZIP
→ `publish_public=false` 时可选验收本地候选包
→ 写 SHA256
→ `publish_public=false` 时上传草稿候选 Release
→ 真实 Windows Chrome/Edge UAT 完成后，手动重跑并传入候选 commit/SHA；先下载并核对该候选 ZIP，再验收该 ZIP，才晋级不可变公开版本 Release，并更新稳定 manifest 通道
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
- 只改仓库根目录 `skills/` 不会让 release-ready 缓存失效；外层
  `Build AccrUI-compatible Windows package` 每次都会从当前 `skills/` 重新拷贝。

不要因为日志里步骤多就合并构建步骤。独立步骤让缓存命中时可以安全跳过四个慢步骤。

## 如何确认包真的成功

不能只看 ZIP 文件是否存在。至少确认：

1. GitHub Actions 运行整体为绿色。
2. `Build AccrUI-compatible Windows package` 成功。
3. `Write checksum` 成功。
4. 先完成真实 Windows Chrome/Edge 侧边栏 UAT；随后以 `full_validation=true`、`publish_public=true`、`uat_candidate_commit` 和 `uat_candidate_sha256` 重跑，`Accept exact downloaded UAT candidate` 与 `Promote exact UAT candidate to published release` 成功。
5. 不可变版本 Release 中 ZIP、`.sha256` 的更新时间对应当前提交；`windows-lite-current` 中的 `accr-ui-windows-lite-update.json` 指向该版本。
6. 正式交付时，`full_validation=true` 的验收也为绿色。

查看 Release：

```sh
gh release view windows-lite-v1.1.96 \
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

### `/pmd-prd` 仍在写 `req_*` 或做原型

先确认 ZIP 和安装树里有 `runtime/skills/pmd-prd/SKILL.md` 以及
`runtime/skills/{pptx,xlsx,docx,pdf}/SKILL.md`，并且
`run_native_host.bat` 含 `DSH_PRODUCT_SKILLS_ROOT=%PACKAGE_DIR%skills`。
缺这些项时，本机 `%USERPROFILE%\.claude\skills` 里的同名目录会变成唯一命中，
跑的是旧 AccrUI skill，不是产品内置合同。有产品根时，同名 Claude skill
排在后面；四个 Office skill 还由独立 provider 以 rank 1 发布，项目根和用户端都不能覆盖。

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

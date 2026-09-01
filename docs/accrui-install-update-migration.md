# AccrUI 安装与远程更新迁移说明

本文记录旧 AccrUI 的安装/更新实现，以及迁入 Harness Workspace 的目标结构。

## 结论

旧 AccrUI 有两套相互独立的能力：

1. Windows 安装壳：负责环境检查、选择目录、进度和提示。
2. 运行中远程更新：负责检查远程包、下载、校验、退出旧进程、覆盖和重启。

Harness Workspace 不直接复制旧的大脚本。安装壳继续保持三层，远程更新则作为
Native Server 内的独立深模块；两者最终共用同一套事务安装、数据保留和回滚实现。

## AccrUI 的远程更新是怎么做的

旧实现位于：

```text
/Users/zhanglt21/Desktop/accrnew/accr-ui/apps/agent-backend-v2/src/system-update/webmcp-lite-update.ts
/Users/zhanglt21/Desktop/accrnew/accr-ui/apps/agent-backend-v2/src/routes/system-update.ts
```

对外提供：

```text
GET  /api/system/update-info
POST /api/system/update
```

完整流程：

```text
扩展查询更新
→ 后端对远程 ZIP 执行 HEAD
→ 服务不支持 HEAD 时使用 Range GET
→ 用 ETag / Last-Modified / 文件名生成 packageId
→ 与本地 .webmcp-update.json 比较
→ 下载并拒绝 HTML 假下载页
→ 检查 ZIP 路径穿越和必要文件
→ 解压到临时目录
→ HTTP 响应完成后启动独立更新脚本
→ 更新脚本等待/停止旧进程
→ 覆盖程序并保留 workspace、logs、.webmcp 等用户数据
→ 写入更新状态并重启
```

默认下载地址硬编码为旧 GitLab raw ZIP，也允许安装目录中的
`.webmcp-update-source.json` 覆盖。这套实现的优点是有安全校验、独立更新进程和用户
数据保留；不足是发布源、产品名称、端口和旧 Agent Backend 耦合较深，Windows 更新
还使用固定端口强制停止进程。

## AccrUI 的 Windows 安装壳是怎么做的

旧生成器位于：

```text
/Users/zhanglt21/Desktop/accrnew/accr-ui/scripts/build-windows-lite.mjs
```

旧包通过 `install.vbs` 静默启动 HTA 或 Windows Forms PowerShell 界面，界面完成：

- Node.js、Git、Chrome/Edge 检查；
- 浏览或手填安装路径；
- 目录已有内容时确认；
- 后台解压并轮询进度文件；
- 注册 Native Messaging；
- 显示完成页、错误和日志。

旧项目曾禁止 C 盘和中文路径。Harness 当前的路径传递、文件操作和 Native Host
launcher 都有完整引号，没有证据需要继续保留这个产品限制，因此迁移时已删除。
静态 Harness 包也不需要 Git，所以只把 Node.js 22.19.x 或 24+ 和 Chrome/Edge 作为运行环境检查。

## 当前已经迁入 Harness 的部分

Windows 包现在是：

```text
accr-ui-windows-lite-x64/
├── install.vbs       双击入口；CI 时切换为无界面入口
├── install-ui.ps1    可视化安装壳
├── install.ps1       安装、升级、数据保留、注册和回滚核心
├── payload.zip       扩展、静态 Harness Runtime、产品插件和产品 skills
└── README.zh-CN.md
```

`payload.zip` 内的 `runtime/skills/pmd-prd` 是内置 `/pmd-prd`，
`runtime/skills/{pptx,xlsx,docx,pdf}` 是产品内置 Office skill。安装后由
`runtime/run_native_host.bat` 的 `DSH_PRODUCT_SKILLS_ROOT` 指向它们，避免用户
`%USERPROFILE%\.claude\skills` 里的同名旧 skill 成为唯一来源。四个 Office
skill 还会以独立 provider 优先发布，用户端同名目录不能覆盖。

`install-ui.ps1` 已迁入以下体验：

- 检测 Node.js 22.19.x 或 24+；
- 检测 Chrome/Edge；
- 浏览和手填安装目录；
- 已有内容时确认；
- 实时显示准备、解压、配置、注册和完成进度；
- 安装失败显示真实错误并指向日志；
- 自定义安装目录；
- 保留工作区、日志、用户配置和上一版本回滚树。

安装核心仍由原先已经通过 Windows CI 的 `install.ps1` 负责，没有把关键文件交换和
回滚逻辑复制到 UI 中。

## 远程更新在 Harness 中的目标结构

推荐结构：

```text
apps/native-server/src/release-update/
├── index.mjs              checkUpdate / prepareUpdate / launchPreparedUpdate
├── release-source.mjs     GitHub Release、GitLab raw、本地测试源
├── package-verifier.mjs   SHA256、ZIP 路径和包结构校验
└── updater-launcher.mjs   退出 Native Host 后启动独立更新进程
```

外部只暴露三个动作：

```text
checkUpdate()
prepareUpdate()
launchPreparedUpdate()
```

实现要求：

- 正式源固定读取公开 `windows-lite-current` Release 的版本 manifest；manifest 指向不可覆盖的公开版本 Release。草稿 GitHub Release 需要登录凭据，不能作为普通用户自动更新源。
- CI 只在完整 Windows 自动验收和真实 Chrome/Edge UAT 均确认后，才发布 ZIP、SHA256 和机器可读的版本元数据。公开 dispatch 必须传草稿候选的 `uat_candidate_commit` 和 `uat_candidate_sha256`；CI 下载并核对该候选 ZIP 后验收和晋级，绝不以当次重建包替代候选。
- 下载后必须校验 SHA256、固定扩展 ID、版本递增和包结构。
- 更新必须复用 `install.ps1 -InstallRoot <当前目录>`，不能另写一套覆盖逻辑。
- 更新启动后先让 Native Host 正常退出，再替换可能被 Windows 锁定的原生文件。
- 失败自动恢复 rollback，成功后由扩展重新建立 Native Messaging 连接。
- `workspace`、`logs`、`.webmcp`、Harness profile 和用户后装插件都不得被删除。

## 迁移状态

| 能力 | 状态 |
| --- | --- |
| 可视化安装壳 | 已迁入 |
| 环境检测、路径选择、覆盖确认、进度和日志 | 已迁入 |
| 自定义目录下的安装、升级和回滚 | 已接入现有核心 |
| Windows CI 无界面安装兼容 | 已保留 |
| 远程发布源和包校验模块 | 已接入稳定公开 manifest 通道、不可覆盖版本 Release、强制 SHA256、ZIP 防穿越、扩展身份和三段式版本校验；缺少 manifest SHA256 或包版本不匹配时拒绝更新 |
| Harness 设置页中的检查/更新入口 | 已接入 Windows Lite 设置页；下载、校验、正常退出 Native Host 后复用 `install.ps1` |
| 真实 Windows 更新中断、失败回滚和重连验收 | 待完成 |

远程更新最后三项必须一起交付。只实现下载按钮、只看到 ZIP 下载成功，或只通过单元
测试，都不能视为可发布的在线更新。

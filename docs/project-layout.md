# 项目目录导航

本次整理只调整源码位置和公共资源的维护方式。Browser Target、Verified Write、
知识检索、Office、审阅、原型工作台、账号、会话导入和升级功能均继续提供。

## 产品源码

- `apps/chrome-extension/entrypoints/`：WXT 页面和后台入口，页面地址不变。
- `apps/chrome-extension/entrypoints/background/office/`：Office frame 探测、路由、预算和内容脚本恢复。
- `apps/chrome-extension/entrypoints/background/team-knowledge/`：在目标页面执行的知识库文档操作。
- `apps/chrome-extension/src/`：扩展各入口共享的契约和能力。
- `apps/chrome-extension/public/office-*-runtime.js`：注入页面的 Office 运行时代码，文件名与发布契约不变。
- `apps/native-server/bin.mjs`、`src/native-host.mjs`、`src/connector.mjs`：启动、Native Messaging 和 Connector 入口。
- `apps/native-server/src/transport/`：消息格式、工具清单和回环代理。
- `apps/native-server/src/browser/`：Run 与 Browser Target 绑定。
- `apps/native-server/src/runtime/`：Harness 进程与运行版本身份。
- `apps/native-server/src/knowledge/`：知识传输、批量交付记录和来源路由。
- `apps/native-server/src/office/`：Office 写入记录。
- `apps/native-server/src/workbench/`：HTML 工作台及其纯校验函数。
- `apps/native-server/src/telemetry/`：脱敏与业务事件记录。
- `apps/native-server/src/release-update/`：已有升级流程，保持原位。
- `packages/`：产品插件；包名和加载顺序仍由 `apps/native-server/src/product-plugin-manifest.mjs` 统一管理。
- `packages/harness-ui-workspace-review/src/markdown-review-delivery.ts`：审阅请求的等待、确认与重放；侧边栏继续负责来源和 nonce 校验。

后台入口中有共享运行状态的队列、授权、恢复和事件初始化保持集中。本轮只抽取自包含职责，
避免为了缩短文件打断已验证的状态流程。

## 开发与交付

| 目录 | 职责 |
| --- | --- |
| `scripts/build/` | 物化 Harness、构建插件、同步资源 |
| `scripts/dev/` | 开发服务器、端口、刷新与监听 |
| `scripts/native/` | 注册和同步 Native Host |
| `scripts/checks/` | 上游检查、诊断、测试准备及插件校验编排 |
| `scripts/shared/` | 构建锁和运行身份计算 |
| `scripts/skills/` | 将技能公共源码物化成独立分发目录 |
| `release/windows-lite/`、`release/mac-lite/` | 平台安装包及验收 |
| `upstream/deepseek-harness/` | 固定提交的只读官方底座 |
| `upstream-contributions/` | 全部保留的通用扩展补丁 |
| `.generated/` | 本机生成的 Harness、缓存和验证日志，不提交 |

日常继续使用根 `package.json` 中的 `pnpm` 命令；脚本的文件路径已按上述目录调整。
构建顺序与检查项目保持原有约定，不因目录迁移跳过检查。

## Office 技能源码与分发

DOCX、PPTX、XLSX 共享的 50 个文件集中于 `skills/_shared/office/`，清单位于
`skills/_shared/office-files.json`。三个技能的原 Python 路径保留兼容入口，因此在
完整源码仓库中仍可按现有技能说明运行。共享实现包含原脚本和全部 XSD，未删减能力。

安装、Mac 和 Windows 打包统一调用
`scripts/skills/materialize-product-skills.mjs` 的 `materializeProductSkills(source, destination)`。
其输出为每个技能补齐原始文件，不包含 `_shared`，不依赖其他技能或软链接。
单独分发技能时应从物化后的目录选取，不能直接复制源码中的兼容入口目录。

新增公共 Office 文件时同步清单，并运行 `test/product-skill-layout.test.mjs`。
该测试同时检查完整性、原始文件指纹、源码入口、独立分发和缺失资源报错。

## 测试、样例和工作产物

- `test/`：跨层回归测试；插件各自的测试继续放在 `packages/*/test/`。
- `test/fixtures/claude-import/`：会话导入样例。
- `examples/documents/`：原演示文档和 HTML 样例。
- `examples/data/`：原采集样例数据。
- `examples/workspaces/pmd-workspace/`：历史需求工作区样例；不作为用户当前工作区。
- `examples/qa/markdown-review/`：历史审阅界面截图和验收记录，不代表本次重新验收。
- `output/repro-*.mjs`、`output/repro-*.mts`：继续保留可重用的复现脚本，符合开发约定。
- `output/` 其他文件及根 `pmd-workspace/`：新产生的本地结果，不纳入版本管理。

原有演示资料全部迁移保留。空的 `bundles/` 占位目录已移除；当前插件装配并不依赖它。

## 不变的交付约定

Native Host 名称、扩展标识、插件包名、工具名称、消息格式、上游提交及所有补丁保持不变。
安装后的 `profile`、`workspace`、`connector-state` 和 `runtime/skills` 位置也保持不变。
源码目录迁移不执行用户数据迁移、不禁用现有功能、不改变升级与回滚流程。

## 本轮验证记录（2026-09-05，Windows x64）

基线为 `codex/gitlab-zip-upgrade-test-20260901` 的
`37309deb85e759e6b09a5deea0daf2b1f657f4cf`，改动保留在本地工作区。

- 上游校验、扩展类型检查、插件类型检查、最终扩展构建均通过。
- 跨层测试 789 项：781 通过、8 项按原有条件跳过、0 失败；全部插件测试另有 389 项通过。
- 首次全量测试中的旧路径断言已更新；Windows 测试使用目录 junction 验证链接拒绝，并将已有 Git 解压工具加入测试进程 PATH。未修改生产安全检查。
- Office 验证使用临时安装的 Python 测试依赖；新增路径、分发、页面脚本隔离测试 10 项全部通过，没有跳过。
- 原有 876 个文件路径均找到对应保留位置（空占位 `bundles/README.md` 除外）；演示资料内容、插件清单、技能说明和上游补丁未改变。
- 相对导入和迁移前路径检查未发现失效引用。源码审查发现的两处脚本路径问题已修复；独立外部审查未取得有效结果，不计为通过。

当前 `dev:refresh -- --fast` 在 Windows 会被原有的 macOS 平台限制拒绝，
因此本轮未完成真实浏览器侧边栏刷新与人工验收。构建和自动化安装契约检查不能替代这一步。
详细本地日志位于 `.generated/test-all-final.log`、`.generated/test-plugins-final.log`、
`.generated/build-final.log` 和 `.generated/dev-refresh-final.log`。

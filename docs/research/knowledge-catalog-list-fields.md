# 知识库和代码库列表接口字段核验

核验日期：2026-09-01。本文只做源码和接口文档核对，没有修改知识中台、AccrUI 或 Harness 产品代码，也没有实测 UAT 网络响应。

## 结论

有概要信息，但分布在不同接口里：

1. **代码库列表 `/api/repos` 有 `description`**，但没有单独的 `summary` 字段。
2. **知识范围目录 `/api/domains` 有 `description`**；系统目录 `/api/domains/systems` 只有 `id`、`name`、`domain`，没有描述。
3. **知识文档列表 `/api/wiki/pages` 有真正的文档概要**：`summary`、`retrievalDescription`、`retrievalTriggers`、`negativeDescription`、`negativeTriggers`。
4. 当前 Harness 只加载领域、系统和代码库目录，没有调用 `/api/wiki/pages`；并且目录转换只保留名称和关联 ID，所以 `description` 等字段目前会被丢掉。

这里要区分“知识范围目录”和“知识文档列表”：前者用于选择领域/系统，后者才是一篇篇可检索知识文档的列表。

## 知识中台接口字段

| 接口 | 用途 | 当前源码确认的概要/元数据 | 备注 |
| --- | --- | --- | --- |
| `GET /api/repos` | 代码库目录 | `id`、`system_key`、`domain`、`repo_type`、`name`、`repo_url`、`branch`、`description`、`created_at`、`updated_at`、`last_synced_at`、`has_architecture`、`has_code`、`local_path` | 返回 `{ data: [...] }`；列表主动排除 `architecture`、`function_map` 大字段 |
| `GET /api/repos/:id` | 单个代码库详情 | 列表字段加完整 `architecture`、`function_map` | 不适合为了列表逐条调用 |
| `GET /api/domains` | 领域目录 | `id`、`name`、`description`、`doc_path`、`system_count`、`doc_count` | 返回领域级说明和统计 |
| `GET /api/domains/systems` | 系统目录 | `id`、`name`、`domain` | 当前实现没有系统描述字段 |
| `GET /api/tags/controlled-vocabulary` | 受控选择器数据 | `domains` 使用领域对象（含 `description`）；`systems` 没有描述；另有 `dimensions`、`valuesByDimension` | 这是 Harness 当前优先调用的目录接口 |
| `GET /api/wiki/pages` | 知识文档列表 | `title`、`summary`、`retrievalDescription`、`retrievalTriggers`、`negativeDescription`、`negativeTriggers`、`domain`、`system`、时间、标签等 | 支持 `domain`、`system`、`q`、`limit` 等过滤；主动排除 `content`、`raw` |
| `GET /api/wiki/pages/:id` | 知识文档详情 | 列表元数据加正文 `content`、反向链接等 | 需要用户打开文档或确实要读正文时再调用 |
| `GET /api/search?q=...&limit=...` | 知识文档关键词搜索 | 每项返回 `id`、`name`、`description`（实际取 `page.summary`）、`score` | 这是搜索结果接口，不是完整目录；适合快速展示命中摘要 |

### 代码库列表的一个容易误解点

`has_code` 不是“远程仓库一定有代码”的判断，而是后端检查该仓库是否已经克隆到知识中台本地目录：`repo_url` 存在且本地仓库目录存在才为真。因此 UI 可以把它展示成“已克隆/未克隆”，不要把它解释成远程仓库可用性证明。

## 当前 Harness 为什么看不到概要

当前实际链路在 `apps/chrome-extension/entrypoints/background/knowledge-transport.ts`：

- `loadCatalog` 请求 `/api/auth/me`、`/api/tags/controlled-vocabulary` 和 `/api/repos`；目录接口失败时才回退 `/api/domains`、`/api/domains/systems`。
- `KnowledgeCatalog` 的类型只有 `id`、`name`、`domainId`、`systemId`、`type`。
- `/api/repos` 返回的 `description`、`repo_url`、`branch`、`has_code`、`has_architecture`、`last_synced_at` 没有映射进目录对象。
- 当前没有请求 `/api/wiki/pages`，所以知识文档的 `summary` 等字段根本不会进入 Harness。

选择器 `packages/harness-ui-knowledge-scope/src/client/KnowledgeScope.tsx` 也只渲染名称、数量和代码库类型，没有概要展示位置。

## AccrUI 对照

AccrUI 新的知识查询链路在 `apps/extension/entrypoints/background/src/services/knowledge-api.ts` 同样只规范化代码库的 `id`、`name`、领域/系统、仓库类型和 `hasCode`，也丢弃了 `description`。其知识代码库选择器主要显示仓库名称、“未克隆”和“前端/后端”。

知识中台自身的管理端 `web/src/components/repo/RepoSearchSelector.tsx` 则保留了仓库地址和仓库说明，并通过 tooltip 展示。这说明“接口有说明”和“查询选择器是否展示说明”是两个独立问题。

## 最佳接入建议

### 第一阶段：保留目录概要，改动小、收益直接

扩展 Harness 目录类型和 `loadCatalog` 映射，至少保留：

- 领域：`description`；
- 代码库：`description`、`repoType`、`hasCode`、`hasArchitecture`、`lastSyncedAt`；
- 如需辅助操作，再保留 `repoUrl`、`branch`，但不要把凭据或带凭据 URL 放入模型上下文。

选择器仍以名称为主，说明用一行截断文本或 hover/popover 展示；这样不会把列表撑得很宽，也不会拉取大字段。

### 第二阶段：单独增加知识文档概要列表

如果需求是让用户选择或浏览“一篇篇知识文档”，新增独立的 `loadKnowledgeDocuments` 请求 `/api/wiki/pages`，按已选领域/系统过滤并设置 `limit`。前端类型可以保留：

```ts
type KnowledgeDocumentSummary = {
  id: string;
  title: string;
  summary?: string;
  retrievalDescription?: string;
  domain?: string;
  system?: string;
  tags?: Record<string, string[]>;
};
```

不要把文档摘要混进领域/代码库 `Catalog`，也不要在目录加载时拉正文；目录负责“选范围”，文档列表负责“看有哪些知识”，职责分开后更快、更稳定。

### 性能和安全边界

- 列表继续使用轻量字段，不能为了显示摘要调用每个仓库详情接口。
- `summary`、`description` 做长度限制；正文、`architecture`、`function_map` 通过详情或检索结果按需获取。
- 查询结果仍要保留稳定的 `id` 作为 Resource Identity，名称只用于显示。
- 知识查询返回应保持带来源的 Sourced Answer，不把列表概要当作正文依据。

## 源码依据

- 知识中台代码库列表投影：`/Users/zhanglt21/Downloads/annto-knowledge-annto-dev-deploy/backend/lib/repo-store.ts:47-65`、`backend/routes/repos.ts:37-80`
- 知识中台领域/系统目录：`backend/routes/domains.ts:40-53,148-182`、`backend/lib/config-loader.ts:10-20,40-57`
- 知识中台知识文档列表/详情：`backend/routes/wiki.ts:562-629,830-871`、`backend/lib/wiki-index.ts:16-35,453-467`
- Harness 目录类型和转换：`apps/chrome-extension/entrypoints/background/knowledge-transport.ts:8-12,107-115,143`
- Harness 选择器渲染：`packages/harness-ui-knowledge-scope/src/client/KnowledgeScope.tsx:181-200`
- AccrUI 代码库规范化和选择器：`/Users/zhanglt21/Desktop/accrnew/accr-ui/apps/extension/entrypoints/background/src/services/knowledge-api.ts:220-258`、`apps/extension/entrypoints/sidepanel/components/knowledge/CodeRepositoryFilter.tsx:250-283`

本轮未运行测试；报告结论来自上述源码静态核对。

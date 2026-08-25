# PrototypeDocument V1

原型文档不是网页源码。固定运行器只识别下面的 JSON 结构：

```json
{
  "v": 1,
  "id": "signup-prototype",
  "title": "注册流程",
  "designSpecId": "design-main",
  "initialScreenId": "welcome",
  "stateVariables": [
    { "id": "approval-status", "initialValue": "pending", "allowedValues": ["pending", "approved"] }
  ],
  "shell": {
    "productName": "供应商平台",
    "placement": "sidebar",
    "items": [{ "id": "nav-home", "label": "首页", "targetScreenId": "welcome" }]
  },
  "screens": []
}
```

`stateVariables` 是可选的有限业务状态。每个状态最多只能取 `allowedValues` 中的值。任意节点都可带
`visibleWhen: { "stateId": "approval-status", "equals": "approved" }`，用于安全地展示操作前后的固定页面结果。

`shell` 是可选的产品导航外壳。`placement` 只能是 `top` 或 `sidebar`；每个导航项只能跳转到文档中真实存在的页面。两页以上的后台、看板或管理系统应优先使用它，运行器会在手机尺寸自动把侧栏折叠为顶部导航。

页面使用 `screen`（`id`、`title`、`nodes`）。节点只能是：

- `text`: `id`、`text`、可选 `tone`（`heading` / `body` / `caption`）
- `button`: `id`、`label`、可选 `variant`、`disabled` 和 `action`
- `input`: `id`、`label`、可选 `placeholder`、`value`、`inputType`；支持 `text` / `email` / `password` / `checkbox` / `search` / `number` / `date` / `textarea` / `select`，下拉框必须提供 `options`；可用 `bindStateId` 把选择值绑定到有限业务状态；提交表单的关键字段用 `required: true` 和 `errorText`，固定运行器会阻止空表单成功并显示错误
- `card`: `id`、可选 `label`、`children`
- `group`: `id`、可选 `label`、`layout`、`children`；布局只能是 `row` / `column` / `grid-2` / `grid-3`
- `metric`: `id`、`label`、`value`、可选 `detail` 和 `tone`，用于看板指标卡
- `badge`: `id`、`text`、可选 `tone`，用于业务状态标签
- `alert`: `id`、`title`、可选 `detail` 和 `tone`，用于页面提示、风险和成功反馈
- `progress`: `id`、`label`、0–100 的 `value`、可选 `detail` 和 `tone`
- `chart`: `id`、`label`、`bars`；每个柱包含 `label` 和非负数值，用于固定数据图表
- `table`: `id`、可选 `label`、`columns`、`rows`；每行 `values` 数量必须与列数一致，可带固定 `action`。最多 12 列、50 行；单元格只能是普通文本，不能放 HTML、CSS、URL 或代码
- `tabs`: `id`、可选 `label`、`tabs`；每个 tab 有 `id`、`label`、`children`
- `list`: `id`、可选 `label`、`items`；每项有 `id`、`title`、可选 `detail`、`action`
- `breadcrumb`: `id`、`items`；每项有唯一 `id`、`label`，可选 `targetScreenId` 用于返回真实页面
- `empty-state`: `id`、`title`、可选 `detail`；可成对提供 `actionLabel` 和固定 `action`
- `pagination`: `id`、`pageCount`、`bindStateId`、可选 `label`；页码状态必须预先在 `stateVariables` 中声明，例如 `allowedValues: ["1", "2", "3"]`
- `modal`: `id`、`title`、`children`，可选 `placement`（`dialog` / `drawer-left` / `drawer-right`）

动作只能是：

- `navigate` / `submit-success`: `{ "targetScreenId": "..." }`
- `open-modal` / `close-modal`: `{ "targetId": "..." }`
- `set-value`: `{ "targetId": "...", "value": "..." }`
- `set-state`: `{ "targetId": "approval-status", "value": "approved" }`
- `toggle`: `{ "targetId": "..." }`
- `set-tab`: `{ "targetId": "tabs-id", "value": "tab-id" }`
- `sequence`: `{ "actions": [固定动作, 固定动作] }`；只用于按钮、表格行或列表项，包含 1–4 个非嵌套动作。例如审批按钮先 `set-state`，再 `close-modal`。
- `add-row`: `{ "tableId": "project-table", "fieldMap": [{ "fieldId": "project-name", "columnKey": "name" }] }`；由同页表单按钮触发，运行器生成安全行 id。
- `edit-row`: 同 `add-row` 的 `tableId` 与 `fieldMap`；只能写在该表既有行的 `action` 上，运行器只编辑用户点击的那一行。
- `delete-row`: `{ "tableId": "project-table", "businessName": "项目" }`；只能写在该表既有行的 `action` 上。运行器固定显示“确认删除项目？”确认框；不要提供任何确认文案或 rowId。

CRUD 映射最多 12 项，`fieldId` 和 `columnKey` 必须唯一，且都在同一页面已经声明。运行器只接受普通文本值，最多保存 50 行；不会执行模型生成的 JavaScript。选择模式只选中元素，绝不会新增、编辑或删除数据。

所有 id 使用小写字母开头的 `kebab-case` 或下划线形式。不要输出未列出的字段、组件或动作；不要输出任何脚本、样式、网络请求、文件路径、事件处理器或动态表达式。

首次原型至少使用 10 个真实组件，并包含表单、表格、列表、图表或空状态中的至少一种。常见产品后台优先使用 `group + metric + chart + table + badge + progress + alert + breadcrumb + empty-state + pagination` 表达真实信息架构，不要用大段文字和几个按钮冒充完整页面。表单使用真实字段、下拉选项和多行说明；关键列表行可以打开详情弹窗、左右详情抽屉或进入详情页。三个及以上页面必须提供 `shell` 产品导航。

筛选和审批不能只显示静态文案：使用 `stateVariables` 声明有限值，用 `bindStateId` 或 `set-state` 改变状态，再用 `visibleWhen` 显示对应的固定结果。所有状态和值都必须预先声明；不能使用表达式、脚本或网络请求。

## 表格筛选、排序和分页

表格可选用下面三个声明字段，让固定运行器提供真实交互；模型只提供数据和配置，不提供事件代码：

```json
{
  "id": "project-table",
  "type": "table",
  "columns": [{ "key": "name", "label": "项目" }, { "key": "owner", "label": "负责人" }],
  "rows": [{ "id": "project-a", "values": ["供应商准入", "张三"] }],
  "filters": [{ "inputId": "project-search", "columnKey": "name", "operator": "contains" }],
  "sort": { "columnKey": "name", "direction": "asc" },
  "pagination": { "pageSize": 10 }
}
```

- `filters` 最多 5 条，全部同时生效（AND）；`operator` 只能是 `contains` 或 `equals`。
- `inputId` 必须指向同一文档中真实的非 checkbox `input`；`columnKey` 必须是本表真实列。筛选输入值按普通文本比较，空值不筛选。
- `sort` 只允许一列；运行器的表头按钮在升序/降序之间切换。`direction` 只决定初始方向。
- `pagination.pageSize` 只能是 `5`、`10` 或 `20`；固定的上一页/下一页按钮管理页码。
- 选择元素模式下，筛选、排序、分页控件只选中表格，不改变数据状态。

## 表单字段联动与文本变量

在 document 顶层可选使用 `fieldRules`。每条规则由 1–3 个 AND 条件和一个固定效果组成；最多 10 条。条件的 `operator` 只允许 `equals`、`not-equals`、`empty`、`not-empty`。效果只允许：`show`、`hide`、`enable`、`disable`、`set-options`。

`targetId` 与每个 `fieldId` 必须是同一页面中已声明的节点/输入框；`set-options` 只能作用于 `select`，选项必须写在 JSON 中的普通字符串。运行器会拒绝未知引用、循环依赖、URL、HTML、CSS 或代码形态的固定值。

文本节点可写 `当前类型：${kind}`；每段文本最多 5 个变量，变量只能引用同页面的 input。运行器只用文本节点渲染结果，不解析其为 HTML 或脚本。选择元素模式不会改变任何字段、联动或文本状态。

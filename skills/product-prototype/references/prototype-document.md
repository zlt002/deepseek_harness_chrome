# PrototypeDocument V1

原型文档不是网页源码。固定运行器只识别下面的 JSON 结构：

```json
{
  "v": 1,
  "id": "signup-prototype",
  "title": "注册流程",
  "designSpecId": "design-main",
  "initialScreenId": "welcome",
  "screens": []
}
```

页面使用 `screen`（`id`、`title`、`nodes`）。节点只能是：

- `text`: `id`、`text`、可选 `tone`（`heading` / `body` / `caption`）
- `button`: `id`、`label`、可选 `variant` 和 `action`
- `input`: `id`、`label`、可选 `placeholder`、`value`、`inputType`
- `card`: `id`、可选 `label`、`children`
- `tabs`: `id`、可选 `label`、`tabs`；每个 tab 有 `id`、`label`、`children`
- `list`: `id`、可选 `label`、`items`；每项有 `id`、`title`、可选 `detail`、`action`
- `modal`: `id`、`title`、`children`

动作只能是：

- `navigate` / `submit-success`: `{ "targetScreenId": "..." }`
- `open-modal` / `close-modal`: `{ "targetId": "..." }`
- `set-value`: `{ "targetId": "...", "value": "..." }`
- `toggle`: `{ "targetId": "..." }`
- `set-tab`: `{ "targetId": "tabs-id", "value": "tab-id" }`

所有 id 使用小写字母开头的 `kebab-case` 或下划线形式。不要输出未列出的字段、组件或动作；不要输出任何脚本、样式、网络请求、文件路径、事件处理器或动态表达式。

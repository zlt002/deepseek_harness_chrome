---
name: webedit-spreadsheet
description: "在已绑定的美的 WebEdit / Team Knowledge 电子表格中稳定读取当前选区、活动单元格、区域值，并做 Verified Write。用户提到表格、单元格、选中区域、上色、公式、筛选时使用。"
---

# 表格 Verified Write

只用 `mcp__chrome__office_spreadsheet`。`list_work_tabs` 的 `documentIdentity=null` 只表示快探没回，不是“没有表格”。先重试 `context` 或 `selection`。

## 读当前选区

不要用 `view` 判断有没有选区。`view.supported=false` 只表示冻结/缩放窗口字段不完整。

1. `action=selection`
2. 看 `selection.address`、`rowsCount`、`columnsCount`、`value2`
3. `singleCell=true` 时这只是活动单元格；用户说“这一片/选中区域”时先停，不要按单格覆盖

`context` 只带选区地址和尺寸；要看单元格值必须再调 `selection`。看整张已用区域用 `used_range`，不要猜 `A1:Z200`。

## 写之前

- 连续矩形：`inspect_write` + `set_values` / `set_formula` / `format`
- 离散格：`batch_write`，`cells` 必须能拼成完整矩形
- 必须带新的 `challenge` 和 `idempotencyIdentity`，payload 与 inspect 完全相同
- 写完只信 `observed.verified=true`；不确定就重读，不要重放同一 identity

## 不要做

- 不要把 `view.supported=false` 说成“读不到选中单元格”
- 不要用 `selection.text` 代替 `value2`
- 不要对空地址当成整表
- 不要在 1x1 选区上批量清空或整列改写

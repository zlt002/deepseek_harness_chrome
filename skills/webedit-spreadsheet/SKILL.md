---
name: webedit-spreadsheet
description: "当 Browser Target 是美的 WebEdit 在线表格（documentIdentity.kind=webedit_spreadsheet）时使用；优先 spreadsheet_get_context/read_range/search，在线写入必须 write_preview→用户明确确认→write_commit→同目标回读。本地 .xlsx/.xlsm/.csv/.tsv 文件改用 xlsx。"
---

# WebEdit 在线表格 Verified Write

先分流：只有绑定的 Browser Target 返回 `documentIdentity.kind=webedit_spreadsheet` 才走本 Skill；本地 `.xlsx`、`.xlsm`、`.xltx`、`.csv`、`.tsv` 文件走 `xlsx` Skill，不能把本地 OOXML 工具当成在线编辑器 API。

## 读取

1. 调用 `mcp__chrome__list_work_tabs({})`，按返回的 `pages` 序号确认 Browser Target 和 `documentIdentity.kind`。
2. 在线表格上下文使用 `mcp__chrome__spreadsheet_get_context({})`。
3. 读取单个有界范围使用 `mcp__chrome__spreadsheet_read_range({ range, sheetName? })`；查找使用 `mcp__chrome__spreadsheet_search({ query, range, sheetName?, matchCase?, matchEntireCell?, searchBy?, offset?, limit? })`。
4. 其余只读能力统一用 `mcp__chrome__spreadsheet_inspect({ action, ... })`。`action` 必须是下表枚举，不能传 Browser Target、frame、resource 或 precondition：

| 目标 | `action` | 需要的附加字段 |
|---|---|---|
| 活动表、选择、已用区域、工作簿、工作表、视图 | `active_sheet` / `selection` / `used_range` / `workbook` / `sheets` / `view` | `sheetName?` |
| 保护、写前状态、筛选与筛选候选值 | `protection` / `preflight` / `filter` / `filter_values` | `range`（`filter_values` 可分页） |
| 单元格功能、特殊单元格、定义名称 | `range_features` / `special_cells` / `defined_names` | 前两者需要 `range`；特殊单元格还要 `cellType` |
| 图表和透视表 | `charts` / `chart` / `pivots` / `pivot` / `pivot_field_items` | 先分页列表；单项用列表返回的 1-based `index`，字段项另用 `fieldName` |
| 打印、分组、行列尺寸、能力和诊断 | `print_settings` / `outline` / `dimensions` / `capabilities` / `debug_runtime` / `probe_range_api` | `outline`/`dimensions` 需要整行或整列 `range` 与 `axis`；`capabilities` 与 `probe_range_api` 用有界 `range` |

运行时会对每项返回 `supported:false` 或精确 `unsupported` 原因；这不是可绕过的错误，也不能改用脚本或另一张表。
4. `documentIdentity=null` 只表示快探没有回答；重新读取工作标签，不把它解释为没有表格。

## 在线写入

所有变更都走同一条门槛：

1. 先读取当前上下文和目标范围，明确目标、操作、影响范围及预期回读。
2. 调用 `mcp__chrome__spreadsheet_write_preview({ operation, payload })`。Preview 只读，返回操作摘要、当前资源指纹和一次性 `challenge`。
3. 把 preview 摘要展示给用户，等待明确确认；没有确认就停止，不提交。
4. 确认后只调用 `mcp__chrome__spreadsheet_write_commit({ challenge })`。Commit 不再传 `operation`、`payload`、Browser Target 或资源身份；它只能提交这一次 preview 冻结的挑战。
5. 成功后用同一 Browser Target 调用 `spreadsheet_get_context`，并按需要调用 `spreadsheet_read_range`，核对资源指纹、工作表、目标范围和值/公式/文本。没有同目标结构化回读就不能报告完成。

如果 preview 或 commit 返回 `fingerprint_mismatch`、目标不可用、超时或回读不确定：保留真实错误并停止；重新读取、重新 preview、重新展示并重新确认后才能重试。不要复用旧 challenge，也不要用一份 payload preview、另一份 payload commit。

完成标准：用户确认过当前 preview；commit 使用的只有对应 challenge；同一 Browser Target 的上下文和目标范围回读与预期一致。

## 完整写操作映射

所有操作都只能作为 `mcp__chrome__spreadsheet_write_preview({ operation, payload })` 的 `operation`；payload 的精确字段以工具 schema 和预览返回的校验错误为准。预览必须返回具体目标：范围/源范围/目标范围、工作表或名称；图表/透视表必须有稳定 id/index/name、类型/来源/位置/字段；筛选必须有字段和条件/值；视图、结构、格式、导出必须有对应的 zoom/freeze、count/shift、header/border 或 scope。矩阵和文本会截断展示。若缺少能让人确认的目标字段，preview 会直接拒绝，不能用“字段列表”代替确认。必须将该 summary 展示给用户，等待明确确认，再 `spreadsheet_write_commit({ challenge })`。

| 类别 | `operation` |
|---|---|
| 单元格和公式 | `set_values`, `set_formula`, `batch_write`, `clear`, `format`, `apply_table_style`, `clear_formats`, `merge`, `unmerge`, `row_height`, `column_width` |
| 结构和填充 | `insert_rows`, `insert_columns`, `delete_rows`, `delete_columns`, `insert_cells`, `delete_cells`, `fill_range`, `auto_fill`, `auto_fit`, `set_rows_hidden`, `set_columns_hidden` |
| 数据整理 | `sort`, `set_auto_filter`, `clear_filters`, `apply_filter`, `replace_range_text`, `text_to_columns`, `remove_duplicates` |
| 复制与转移 | `copy_range`, `move_range`, `paste_special` |
| 单元格功能 | `set_data_validation`, `clear_data_validation`, `add_hyperlink`, `delete_hyperlinks`, `add_comment`, `delete_comments`, `add_conditional_format`, `clear_conditional_formats`, `insert_cell_image` |
| 工作簿与工作表 | `create_defined_name`, `delete_defined_name`, `activate_worksheet`, `sheet_add`, `sheet_rename`, `copy_worksheet`, `move_worksheet`, `set_worksheet_visibility`, `sheet_delete`, `undo`, `redo`, `recalculate` |
| 图表 | `create_chart`, `update_chart`, `set_chart_data_source`, `resize_chart`, `delete_chart` |
| 透视表 | `create_pivot_table`, `refresh_pivot_tables`, `add_pivot_field`, `remove_pivot_field`, `refresh_pivot_table`, `delete_pivot_table`, `sort_pivot_field`, `set_pivot_subtotals`, `set_pivot_value_function`, `set_pivot_show_values_as` |
| 页面与导出 | `set_zoom`, `set_freeze_panes`, `set_print_settings`, `set_outline_group`, `export_pdf`, `export_range_image`, `export_worksheet_image` |

旧 AccrUI 的 107 个已注册表格工具在这里均有语义入口：`get_context/get_active_sheet/get_selection/get_used_range/get_workbook_info/debug_runtime/probe_range_api/read_cell/read_range/find_text/get_formula` 分别收敛到 context、`spreadsheet_inspect`、`spreadsheet_read_range`、`spreadsheet_search` 或 `debug_runtime/probe_range_api/capabilities`；全部变更操作收敛到上表的 preview/commit 门槛。Sparkline 和正式 ListObject 从未在旧 profile 注册，不在此承诺中。

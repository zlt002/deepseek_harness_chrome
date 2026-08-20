---
name: webedit-spreadsheet
description: "当前表格只作为参考资料阅读。用户提到表格、单元格、已用区域时，先 list_work_tabs，再 read_work_tab 看摘要；不要改格子、不要下载。"
---

# 表格只读参考

当前模型面不再提供表格写入工具。

1. 先 `list_work_tabs` 确认当前页是表格。
2. 用 `mcp__chrome__read_work_tab({ tab })` 读取已用区域摘要。
3. 不要改单元格、不要筛选、不要下载。

`documentIdentity=null` 只表示快探没回，不是“没有表格”。先再读一次工作标签。

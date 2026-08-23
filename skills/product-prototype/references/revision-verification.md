# 原型版本保存

`save_product_prototype` 在可信代码中创建 `PrototypeRevisionV1`。模型不生成 revision id、时间或指纹。

保存流程固定为：

1. 使用请求中的 `project_id`。
2. 首次保存省略 `expected_revision_id`；修改已有原型时传入请求中的当前 revision id。
3. 传入完整 `design_spec`、完整 `document` 和 `change_summary`。
4. 调用 `save_product_prototype`。
5. 只把 `status: verified_write` 当作保存完成。

工具会校验会话归属、父版本、参考证据、设计规范、全部动作引用和大小预算，再写入并回读。冲突、超时或回读不匹配时报告“未保存”；保留较新的版本，不用新的父 revision 强行重试。

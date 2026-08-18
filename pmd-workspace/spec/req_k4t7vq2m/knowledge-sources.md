# 资料来源 — req_k4t7vq2m（优化司机接单流程）

## 本 Run 资料范围（来自会话顶部范围回显）

- 回显时间：2026-08-19T00:18:34+08:00（`mcp__chrome__selected_source_scope`）
- 代码库侧：已选 → `H5_前端`
- 知识库侧：未选（knowledge 为空数组）

## 授权与查询状态

| 侧 | 授权状态 | 查询状态 |
|---|---|---|
| 代码库 H5_前端 | 已回显，用户已确认（2026-08-19） | 已查询 1 次 |
| 知识库 | 未选，禁止派生子查询 | 不适用 |

## 查询记录

### 查询 #1（2026-08-19，阶段 2→3）

- 工具：`search_selected_remote_code`（父会话，run_in_background: false）
- description：检索司机接单流程实现证据
- prompt 摘要：在 H5_前端 中调研司机接单流程的入口/触发方式、状态流转与 API、关键交互与已知限制、公共模块，要求逐条附文件路径+符号证据，无法确认标「未找到」。
- 回执结论：仓库存在两套接单链路（货源大厅主动接单 / 任务详情派单+自动接单），证据结构化完整；「未找到」项：派单弹窗组件、前端推送触发接单、前端超时自动取消、WebSocket/SSE、接单专用 store、接单链路 TODO。

### Evidence 清单（本 Run 追踪链使用）

| Evidence ID | 内容 | 来源（文件+符号/行） |
|---|---|---|
| EV-01 | 货源大厅列表入口：`freightType` 按钮分支 0抢单/1报价/2认领/3一口价，`goDetail()` 跳详情 | `src/views/SupplyHall/components/SupplyStatusItem.vue` L161-190、L219-234 |
| EV-02 | 详情页按钮区与 `submit()` 路由分派：抢单/认领/一口价→`takeOrder`，报价→`tuotation`（iOS 内置组件） | `src/views/SupplyHall/SupplyHallDetail.vue` L289-338、L1276-1418 |
| EV-03 | 抢单确认页 `preSubmit`；防重为 `isLoading`(L961)/`isLock`(L927-930) 状态锁，无防抖 | `src/views/SupplyHall/TakeOrder.vue` L188、L961、L927-930 |
| EV-04 | 报价确认页 `preSubmit`；`loadingFlag` 防重；`driverOffer`/`driverOfferModify` 提交 | `src/views/SupplyHall/Tuotation.vue` L162、L871、L1447-1461、L1582 |
| EV-05 | 接单 API 集：`driverTakeOrder`(L50)、`driverOffer`(L86)、`driverOper`(L103)、`newDriverOrderOffer`(L111)、`newPricePayCashApply`(L121)、`getPayStatus`(L59) | `src/api/supplyHallDetail.ts` |
| EV-06 | 链路 B 手动接单：`confirmReceivingOrders`，调用于 `handleAccept` | `src/api/index.ts` L130、`src/views/TaskInfo/index.vue` L1545 |
| EV-07 | 链路 B 自动接单：`orderAutoAcceptFlag=='1'`+`expectedAutoAcceptTime`，`startCountdownTimer()` 500ms 刷新展示，结束后 3s 刷新页面；实际接单在服务端 | `src/views/TaskInfo/components/TaskInfoQrCodeCard.vue` L356-387、`docs/taskInfo/auto-acept-flow.md` |
| EV-08 | 状态枚举：`driverConfirmStatus`(''→'20'已接/'30'拒绝)、`driverTaskStatus`(60/70/50，API 注释过期 L167)、`driverOrderStatus`(0/1) 与任务列表分流 | `src/api/supplyHallDetail.ts` L167、`src/views/TaskList/Index.vue` L270-343 |
| EV-09 | 命令式弹窗体系：协议确认/押金支付/拒绝认领/去认证/车型校验 | `src/components/ZtbDialog/showZtbDialog.ts` L41-125 |
| EV-10 | 倒计时：详情页 4 定时器（服务器时间/货源结束/抢单倒计时/竞价），超时归零仅恢复按钮，无前端主动取消 | `src/views/SupplyHall/SupplyHallDetail.vue` L464-467、L673-681、L812-873；`src/utils/tools.ts` L89-110、L2027-2103 |
| EV-11 | 请求封装：axios 60s 超时、token/X-Device-Info 注入、401 清 token 跳登录、无自动重试；业务错误码 `handleBusinessError`+`codeMap` | `src/utils/request.ts` L48-183、`src/utils/tools.ts` L115-146、L635-788 |
| EV-12 | 实时性：全仓库无 WebSocket/EventSource；原生能力走 dsBridge；5 处轮询均非接单场景 | `src/utils/platform.ts`；`TaskInfo/index.vue` L3102-3121、`sign/qrCode.vue` L321-345 等 |
| EV-13 | 接单成功流转：押金判断→支付弹窗（'抢单成功'/'报价成功'）→`goSupplyRecord()` 跳找货记录 | `TakeOrder.vue` L989-993、L1085-1148；`Tuotation.vue` L944-998 |
| EV-14 | 状态管理：无接单专用 store；相关 `stores/user.ts`(appointmentDispatch)、`stores/task.ts`(taskInfoData/detail)、`stores/queryParams.ts`(rejectOrder) | `src/stores/` 各文件 |

> 本 Run 后续阶段（分析/PRD/影响地图/任务/验收）只引用上表 Evidence，不引用本地推测。

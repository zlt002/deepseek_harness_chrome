# 开发后查看最新效果

每次代码任务先确认改动层；改完按对应方式刷新，完成后重开侧边栏。
日常保持 `pnpm dev` 和 `pnpm dev:watch` 各运行一个：前者自动刷新 `apps/chrome-extension`，后者同步并重启 `apps/native-server`。
产品插件（`packages/*`）执行 `pnpm dev:refresh -- --fast`。
修改 `upstream-contributions/`、升级上游，或 `.generated/harness-product` 损坏/缺失时，执行完整 `pnpm dev:refresh`。
`dev:refresh` 同时只能运行一个实例。

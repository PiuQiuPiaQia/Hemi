# 用量历史

独立“使用记录”页通过 `window.hemiVoice.getUsageHistory` → `usage:get-history` → Agent runtime 查询运行事实库，不再拼接各会话的展示账本。每个真实 HTTP attempt 独立一行；重试和回退的失败行保留，token 只归属于实际承载用量的末次 attempt。

URL 仅保留协议、主机和路径；错误文本去除 URL 用户信息、查询参数和片段。未知旧字段显示为空；重启中断的请求显示失败，不能恢复为进行中。TTFT 从首个有效模型输出起算，TPS 使用首输出至结束的生成窗口。推理 token 作为输出子集单独展示，不重复计入合计。

筛选同时作用于记录、总量和每日统计，分页仅切记录。页面重取时忽略过期响应；搜索和状态变化回到第一页，收到用量变更事件后刷新。热力图按本地日历填齐最近 12 周的空白日期。总 token 包括未缓存输入、输出、缓存读和缓存写。

## 验证

2026-10-28，基线 `487743f1b5d5b7a960d75d46a37823454bb05870` 加工作树改动，macOS arm64 / Node 22.22.3：

- `node scripts/verify-usage-history.mjs` 在真实 Electron 的 Vite 开发 renderer 和构建 renderer 中分别通过。使用隔离 userData 和合成 journal，不复制个人配置，不调用外部模型。
- 验证生产导航、preload/IPC、123 行投影、跨页后搜索复位、状态筛选、键盘展开详情、URL 脱敏、空白日期，以及 375 / 768 / 1440 宽度无页面溢出和内容铺满。
- `usage-history.test.mjs` 包含真实本地 SSE → Pi SDK → journal 落盘与重开投影，覆盖 TTFT、回退、未知字段和 token 口径；随发版全量门禁执行。
- 截图及详细结果保存在忽略目录 `.visual/workflow/vision/usage-history/`。应用当前提供浅色模式；未将暗色或已安装实例的更新安装流程计为通过。

# 会话历史与滚动的维护边界

本次整理以 `a3a72921` 为基线，保留共享 SDK、Host 执行权和 TanStack Virtual。PC 本地、PC Bot、iOS 共享操作与展示语义；只有提供 `fetchHistory` 的 transport 启用历史分页。本地 IPC 不需要模拟网络重连。

| 位置 | 唯一职责 |
| --- | --- |
| Host `flow-window.mjs` | 从权威时间线选择最新窗口、历史页和问答边界 |
| SDK `flow-replica.ts` | 最新窗口的版本连续性、generation 和 Host epoch |
| SDK `history-view.ts` | 已加载历史与最新窗口的合并、历史更新、一个未加载缺口 |
| SDK `conversation.ts` | 一次历史请求的取消、错误和加载状态；原有操作日志、草稿、队列与回执 |
| transport | IPC / RPC / 实时连接、认证、平台 IO |
| `use-transcript-viewport.ts` | 用户手势与向上加载触发，每个手势最多一页 |
| `virtual-transcript.tsx` | 阅读/跟随状态、测量和所有滚动写入 |
| `history-loader.tsx` | 加载提示、错误、重试按钮；不监听滚动、不操作滚动位置 |

## 数据规则

- 实时副本始终只保留最新窗口。展示历史不回灌副本，也不扩大离线检查点。
- 连续窗口合并成一段。新窗口与旧阅读段不相交时，保留 `[阅读段][缺口][最新段]`；再次不连续时替换最新段，最多一个缺口，不建立区间树。
- 缺口是展示行，有稳定 key。用户每点击一次只补一页，不自动追赶所有缺失数据。补齐后恢复连续时间线。
- generation、Host epoch 或连接恢复会取消旧读取。正常发送、停止和队列操作不取消历史请求，也不等待它完成。
- 过期页静默丢弃。读取期间收到的历史项更新优先于迟到页，错误不会把已在线的实时连接改成离线。
- 断线时点击加载会明确提示恢复连接；连接确认后清除此提示。草稿、未知回执和暂停队列仍由原有机制保护，不自动重放旧输入。

## 分页与展示规则

页大小以 32 个时间线项为目标，正常字节预算为 256 KiB。若整轮问答在预算内、且不超过 100 项，就从问题开头返回。超长问答分段返回，可选的 `continuation` 标明前后还有同轮内容；顶部按钮显示“加载本轮更早内容”。单个超大项仍允许超过软字节预算，本次不拆分单项 DOM，也不改变其身份。

加载行继续位于虚拟消息体外，缺口行位于其对应的两段之间。阅读列被纳入尺寸观察，使加载提示或通知改变高度时重新测量 `scrollMargin`。保留同步 DOM 测量、`anchorTo: end`、消息体裁切及键盘/正文尺寸变化时的跟随补偿。没有依据把这些已验证的行为全部删除。

Markdown 解析缓存只按既有 LRU 容量和当前内容管理。临时消息消失不再清空缓存。应用不再直接修改 TanStack 的内部 `itemSizeCache`；已无入口的桌面虚拟列表副本已删除。

## 验证与后续修改

核心边界测试：

```sh
node --test packages/conversation-flow/test/history-view.test.mjs packages/conversation-flow/test/flow-window.test.mjs
```

UI 生命周期需覆盖开发和构建两种渲染版本：

```sh
npm run build:mobile
node scripts/verify-history-loading-layout.mjs
node scripts/verify-history-gap.mjs
node scripts/verify-mobile-reconnection.mjs
node scripts/verify-shared-sdk-desktop.mjs
```

其中布局与重连脚本连接隔离的真实 Host；缺口脚本专门检查 SDK 展示边界。浏览器合成触摸事件不代表 iOS 原生回弹。模拟器/真机结果必须单独注明所用构建，不能沿用之前安装包的结论。生产 Bot 与真机更新也应与代码验证分开记录。

当前布局脚本会记录 ResizeObserver 通知警告数，并检查稳定后不再持续增加。警告仍需观察；不能用“没有 pageerror”替代对此的记录。

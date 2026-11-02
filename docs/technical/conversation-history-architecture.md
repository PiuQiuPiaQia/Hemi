# 会话历史与滚动的维护边界

本次整理以 `a3a72921` 为基线，保留共享 SDK、Host 执行权和 TanStack Virtual。PC 本地、PC Bot、iOS 共享操作与展示语义；只有提供 `fetchHistory` 的 transport 启用历史分页。本地 IPC 不需要模拟网络重连。

| 位置 | 唯一职责 |
| --- | --- |
| Host `flow-window.mjs` | 从权威时间线选择最新窗口、历史页和问答边界 |
| SDK `flow-replica.ts` | 最新窗口的版本连续性、generation 和 Host epoch |
| SDK `history-view.ts` | 已加载历史与最新窗口的合并、历史更新、一个未加载缺口 |
| SDK `conversation.ts` | 一次历史请求的取消、错误和加载状态；原有操作日志、草稿、队列与回执 |
| transport | IPC / RPC / 实时连接、认证、平台 IO |
| `use-transcript-viewport.ts` | 向上读到最早三轮 QA 时预取十轮；程序定位不触发读取 |
| `virtual-transcript.tsx` | 阅读/跟随状态、测量和所有滚动写入 |
| `history-loader.tsx` | 加载提示、错误、重试按钮；不监听滚动、不操作滚动位置 |

## 数据规则

- 实时副本始终只保留最新窗口。展示历史不回灌副本，也不扩大离线检查点。
- 打开时只取最近十轮 QA，允许额外五轮缓冲。窗口超过十五轮时一次收回到最近十轮；例如批量增长到十八轮时回收八轮，不固定删除五轮。
- 上翻加载的历史在阅读期间保留，不按行数或体积反复回收中间内容。回到最新时释放回载历史，恢复实时窗口。
- 连续窗口合并成一段。新窗口与旧阅读段不相交时，保留 `[阅读段][缺口][最新段]`；再次不连续时替换最新段，最多一个缺口，不建立区间树。
- 缺口是展示行，有稳定 key。向上滚动接近缺口时补一页，也可点击；程序定位和新窗口本身不追赶缺失数据。补齐后恢复连续时间线。
- generation、Host epoch 或连接恢复会取消旧读取。正常发送、停止和队列操作不取消历史请求，也不等待它完成。
- 过期页静默丢弃。读取期间收到的历史项更新优先于迟到页，错误不会把已在线的实时连接改成离线。
- 断线时点击加载会明确提示恢复连接；连接确认后清除此提示。草稿、未知回执和暂停队列仍由原有机制保护，不自动重放旧输入。

## 分页与展示规则

一轮 QA 从一条用户提问开始，包括下一条提问之前的全部回答、过程记录和子任务入口。打开取十轮，历史每页也取十轮；内容体积和过程行数不切断问答。被引用子任务的完整执行详情保留。缺少提问的旧档仍可用 `continuation` 补齐，但新窗口不主动生成半轮。

手动点击和向上滚动都进入阅读状态。首次补入历史提问不算用户新发送，不跳到底部；只有实际新增提问才触发发送定位，Host 时间线总数用于区分新投递与历史回填。程序补偿滚动位置不恢复跟随，用户向下操作或点击回到底部才恢复。

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
node scripts/verify-history-reading.mjs
node scripts/verify-history-loading-layout.mjs
node scripts/verify-history-gap.mjs
node scripts/verify-mobile-reconnection.mjs
node scripts/verify-shared-sdk-desktop.mjs
```

其中布局与重连脚本连接隔离的真实 Host；缺口脚本专门检查 SDK 展示边界。浏览器合成触摸事件不代表 iOS 原生回弹。模拟器/真机结果必须单独注明所用构建，不能沿用之前安装包的结论。生产 Bot 与真机更新也应与代码验证分开记录。

当前布局脚本会记录 ResizeObserver 通知警告数，并检查稳定后不再持续增加。警告仍需观察；不能用“没有 pageerror”替代对此的记录。

## 2026-11-02 历史读取回归验证

验证基线为 `e762cf16fe8b9025aa1ba236b64448cccf2e4f32` 加本次未提交工作区，环境为 macOS arm64、Node v22.22.3、Electron 44。所有桌面和 Host 验证均使用隔离的临时数据及合成会话。

- SDK、主进程 flow service 和展示投影定向测试共 139 项通过，覆盖完整 QA 分页、五轮缓冲、批量增长后收回默认值、读取期间保留历史、版本隔离和迟到更新。
- `npm run build` 与移动端工作区构建通过。`verify-history-reading.mjs` 在 Vite 开发版和构建版各通过 8 项实际桌面 IPC 检查，历史每页十轮且问答不拆开。
- `verify-history-gap.mjs` 的开发/构建两版均验证了第四轮尚不预取、进入最早第三轮时预取十轮、连续上翻、定位不读取和阅读锚点保留。
- `verify-history-loading-layout.mjs` 在开发/构建两版验证实际 Host 的分页、375/768/1440 布局、加载失败、重试及最终页的锚点。
- `verify-runtime-performance.mjs --ui-only` 的开发/构建两版各通过 8 项，覆盖四任务并行输出与实际保存、完整复制、草稿、跨会话回收和恢复。
- spacing 与 `git diff --check` 通过。原始报告位于 `.visual/workflow/history-reading/`、`architecture-refactor/gap-harness/` 和 `history-loading-layout/`。

未运行全量测试；未发版、替换安装包、部署生产 Bot 或更新物理移动设备。Windows 和真机交互未在本轮验证。

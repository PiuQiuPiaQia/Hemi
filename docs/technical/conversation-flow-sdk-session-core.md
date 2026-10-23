# 对话 SDK 会话核心

版本 1.1，2026-10-23。沿用 `codex/conversation-flow-sdk` worktree，将 SDK 从展示组件扩展为完整前端会话 SDK；现有受控展示接口兼容。

## 结构与边界

```text
@hemi/conversation-flow/core    状态、草稿、待发送记录、恢复、队列与时间线投影
@hemi/conversation-flow/react   useConversation：订阅、启动与 retain 清理
@hemi/conversation-flow         原有受控对话组件
@hemi/conversation-flow/parts   原有部件与共用 TurnQueueTray
```

core 是纯 TypeScript，运行时不导入 React、DOM、Electron、Capacitor、Node 内置模块或 Hemi 应用代码。Markdown 文件引用解析沿用包中已有前端依赖。导入和构造不发网络请求，不启动计时器；start／React retain 后才开始同步。

| SDK 负责 | 注入接口负责 | 上游负责 |
| --- | --- | --- |
| 会话副本、版本追平、重连退避、可选轮询、恢复 | fetchSnapshot、subscribe、网络与前后台事件 | Bot 身份、版本、权威快照和事实 |
| 草稿模型、防抖持久化、加载竞态、冲突暂停 | storage.drafts 的 load／save、原子写入与加密 | 涉及跨设备的服务端草稿 CAS |
| 本机待发送记录、串行受理、撤回未发送输入、未知结果核对 | storage.operations、command、lookupOperation | 真正执行队列、幂等受理、任务运行和停止 |
| 历史缓存恢复、迟到响应过滤 | 可选 storage.snapshots | 权威历史与旧档归一化 |
| 消息／队列投影、普通编辑／重试／停止动作 | 协议映射、工作流／任务／预览的特定动作 | 模型、工具、授权与工作流执行 |
| 文件卡、资源租约与错误展示 | 原有 Host 的读取、保存、分享、复制等 | 文件查证与实际 IO |

没有新增后端服务或独立 Bot Client 包。SSH、凭据、安全存储和 Bot 部署维护留在宿主。旧档恢复与生产任务调度器继续保留在原服务中，不能由前端重建一套执行事实。

## 会话接口

`createConversation({scope, transport, storage?, lifecycle?, makeId?, requestTimeoutMs?, pollIntervalMs?})` 返回独立 client。scope 包含 environmentId、conversationId；environmentId 应体现实际服务／Bot 实例／账号身份。每个 scope 在一个宿主中使用一个稳定 client，多个 UI 共同订阅该 client；不同设备的物理存储独立。

client 提供 start、retain／dispose、subscribe／getSnapshot、draft、sendDraft、sendCommand、refresh、flushQueue、flushDraft、cancelWaiting 和 resolveDraftConflict。React 的 useConversation 自动 retain；无会话时可传 `{enabled:false}`，避免空槽重连。

transport 提供获取快照、推送订阅与命令。推送适配器可报告断线，由 SDK 重新追平；没有推送时默认每 2 秒查询，pollIntervalMs 可显式配置。生命周期接收 resume／suspend／online／offline，后台暂停同步时保留快照和输入，不发送停止任务的命令。

所有网络等待有超时和取消。dispose 丢弃迟到发布、取消等待、清理订阅与时钟；取消等待不等于取消远端副作用。SDK 不因重新挂载或回到前台重建任务。

## 草稿与待发送记录

草稿文字、标签、附件及引用共享版本模型，并保存可跨重启核对的内容 token。接受回执只清其提交版本，后来输入不受影响；队列编辑覆盖输入框时仍保存原稿。载入以 scope 与内容版本守卫，异步读取不能覆盖后来的输入或标签变更；宿主附件清理不会误使旧文字恢复失效。

存储读取失败保留当前输入，暂停未经核对的写入；保存失败的会话另保留内存副本，切换回来仍可找回。保存冲突暂停自动保存，由用户选择 keep-local 或 reload。加载已有版本后再递增，显式新建会话清空草稿槽也能跨进程覆盖原来的高版本。删除当前会话时先丢弃该槽未保存内容，再采用新槽，避免把新输入保存到已删除会话。

命令先保存 waiting，再保存 sending，最后交给 transport。传输异常、超时、缺少合法回执或上游返回 needs-review 进入 unknown。重启载入的 sending 也进入 unknown；通过稳定 inputId 的权威快照或 lookupOperation 查询核对。查不到不代表没发生，不自动重放；后续等待输入暂停。尚未发送的 waiting 可撤回；持久化撤回失败时恢复原项，不能宣称撤回成功。离线仅允许发送输入排队，停止与编辑等操作要求在线。

同一草稿版本双击发送共用在途 Promise；不同输入按受理顺序串行提交。上游执行仍可继续，SDK 不等待每个任务完成才提交下一条，上游负责实际排队。跨回卷代次的旧 waiting 拒绝执行，旧代回执不清当前草稿。最近已完成回执有限保留，unknown 不因容量被静默删除。支持保留 token 的存储可在重启后准确清除已受理的原稿；旧宿主未保存 token 时保留恢复草稿，避免按文字相同猜测版本。

未注入某个存储接口时，相应状态仅保留在当前 client 内存。storage 必须按 scope 隔离、提供可靠的原子持久化；多标签页共享同一物理缓存时，宿主应协调单写者或提供版本守卫。凭据不能混入草稿、操作命令或诊断数据。

## 实际迁移

- 原 renderer 的 composer-draft、flow-replica、flow-bridge、message-edit、input-history、turn-retry、turn-busy、flow-timeline-view、transcript-parts-view、flow-deliverables、retained-deliverables、reply-file-references 改为 SDK 兼容转发，业务逻辑只有包内一份。
- use-conversation-flow 改为 SDK client＋React hook；宿主适配器只转换实际 IPC。桌面主页面的草稿防抖／载入／冲刷改为共用 persistence，队列投影与消息展示映射改用共用实现。
- 桌面 TurnQueueTray 迁入 SDK，保留已有排序、编辑、撤回、优先运行和暂停恢复交互；样式从原 composer 样式抽入隔离构建，宿主布局位置保持不变。
- 移动端删除页面中的独立消息数组、受理清理和流式计时器；改用共享会话核心、presenter、动作处理器、队列部件。演示流式计时器移到显式本机通信替身，模拟“上游继续、前端断线”。
- 移动演示的草稿使用 localStorage；演示快照和回执、待发送记录使用 sessionStorage。替身页面重载视为演示运行中断，不声称真实后台常驻；真实 Bot、SSH 与设备生命周期尚未接入。

桌面真实验收发现并修复了两处接入顺序：切换会话后重复清空会令 SDK 草稿载入失效；新建会话时先清空旧模型、再换持久化键，会将空内容覆盖旧会话草稿。现在由 SDK 激活新作用域后再清理 UI。

## 合并前验证

源码基线 `52460a00bcc2ee5bf7b491a215527f29a155a847` 加当前未提交 SDK／移动端工作区；macOS arm64、Node 22.22.3、Electron 44、Chrome 155。全部应用测试使用临时独立 userData、合成会话、本地 SSE 模型替身与真实 IPC／会话控制器；未读取个人模型配置或凭据。

验证证据在 `.visual/workflow/vision/conversation-core/`，桌面详细报告在 `.visual/workflow/vision/turn-stage-flow/{dev,built}/`，移动报告在 `.visual/workflow/vision/mobile/`。最终源码清单含 1000 个源码／配置文件，SHA-256：`a7c1b3cdf206534d93cbfa8eeb645a1595c1c56730a1ad66ef2e9d888c97693a`。

剩余范围：真实 Bot SSH 适配、iOS／Android 原生编译与真机验证、设备后台恢复及系统文件能力仍未验收；核心的端口测试不能替代这些验证。产品保持既有浅色展示；构建仍有现有大 chunk 提示。未提交、推送或发布。


### 最终验收结果

| 检查 | 结果 |
| --- | --- |
| `npm ci --no-audit --no-fund` | 通过，继续使用 Node 22.22.3 与统一锁文件 |
| `npm test` | 1615／1615 通过，无跳过；含 SDK 41 项边界／恢复／资源／展示测试 |
| `npm run build` | 桌面类型检查与 renderer 构建通过 |
| `npm run build:mobile` | 移动端类型检查与构建通过 |
| `node scripts/verify-turn-stage-flow.mjs` | 构建 renderer 10 项通过；真实 IPC、Pi SDK、read／bash、草稿持久化、排队派发、重载与虚拟列表 |
| `HEMI_UI_TIMEOUT_MS=30000 VITE_DEV_SERVER_URL=http://127.0.0.1:5197 node scripts/verify-turn-stage-flow.mjs` | 开发 renderer 同样 10 项通过，无 renderer 错误 |
| `npm run verify:mobile` | 开发与构建页面各 12 组通过；含离线 outbox、恢复发送、草稿重载；无应用全局桥、无外部请求或 renderer 错误 |
| `node scripts/verify-conversation-sdk-package.mjs` | 实际 tarball 在仓库外安装；普通 TypeScript／Vite／单 HTML 构建与全部公开入口 Node／SSR 导入通过 |
| 资源同步 | `npm run sync --workspace @hemi/mobile` 通过；8 个输出文件在 Web／iOS／Android 逐个 SHA-256 一致 |
| 许可 | renderer 154 项、移动端 129 个运行依赖；重新生成并核对，无待审通知；SDK 包含新增队列依赖许可 |
| 规范 | spacing 与 `git diff --check` 通过；core 未导入应用别名、React 运行时、DOM、Node／原生 API |

视觉证据：桌面 `sdk-core-queue.png` 保持原布局；移动 `built-offline-queue.png` 展示共用队列，触摸控件至少 44px 且输入区可见。手机 320／375／390／768／1440、桌面 375／768／1440 检查通过。没有新增深色主题或对未提供的视觉稿作像素一致性承诺。

## 合入 main 的兼容处理

保留 main 的完整桌面 Bot 功能。共享展示组件和会话 hook 通过 ConversationBridgeContext 读取当前宿主，不绕过注入访问本地数据。Bot 的 environmentId 包含 instanceId，替换实例后重新隔离资源与异步回执；本地会话保持 desktop-local 作用域。Bot 文件菜单继续提供云端下载，断线时禁用，不提供本机定位操作。文件投影保留 main 的“按生产 run 定位相对文件链接”规则，切换目录后的同名文件不会串到旧回复中。

合并后的提交、环境、命令、结果与未覆盖范围记录在 `.visual/workflow/merge-sdk-main/`。合并时主工作区出现的独立 Bot 依赖安装修复保留在原处，不计入本次提交；测试在 SDK worktree 的合并版本上隔离执行。

开发验收曾受到生成目录 HTML 重载与持续构建干扰，已排除移动 dist／iOS／Android 和 .visual 目录的桌面 watcher，并在停止构建、重启开发服务器后完成最终回归。测试浏览器、Electron 及本次启动的开发服务器均已关闭。

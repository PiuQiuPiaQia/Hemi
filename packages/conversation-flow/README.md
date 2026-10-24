# @hemi/conversation-flow

Hemi 的完整前端会话 SDK。Web、Electron 和移动 WebView 共用会话状态、草稿、待发送队列、恢复逻辑及展示组件。通信、存储、文件与系统能力通过接口注入；SDK 不绑定 Bot／SSH／Electron／Capacitor，也不要求额外后端服务。

```tsx
import { ConversationFlow, type MessageView } from '@hemi/conversation-flow';
import { createWebHost } from '@hemi/conversation-flow/web-host';
import '@hemi/conversation-flow/styles.css';

const messages: MessageView[] = [
  { id: 'one', author: 'user', text: '你好' },
  { id: 'two', author: 'assistant', text: '**你好**，有什么需要处理？' },
];
const host = createWebHost(); // 仅在浏览器允许时提供剪贴板；资源和导航由应用注入

<div style={{ height: 600, display: 'flex' }}>
  <ConversationFlow
    scope={{ environmentId: 'local', conversationId: 'sample', generation: '1' }}
    messages={messages}
    host={host}
  />
</div>
```

React / React DOM 19 为 peer dependencies。消费端无需 Tailwind、Hemi 路径别名或全局对象。包为 ESM，带声明文件、预编译 CSS、内嵌文件图标和第三方版权。包名尚未公开发布；在仓库根目录执行 `npm run build:sdk`，再在包目录执行 `npm pack` 得到可安装 tarball。

## 会话核心与 React 接入

已有受控 `<ConversationFlow>` 用法继续兼容。需要 SDK 管理会话时，从 `/core` 创建 `createConversation({scope, transport, storage, lifecycle})`，从 `/react` 使用 `useConversation(client)`。每个环境、会话使用一个稳定 client；同一会话的多个组件订阅同一 client。

- `/core`：纯 TypeScript；快照／补丁追平、过期回执过滤、草稿、持久化、待发送记录、回执核对、队列和时间线投影、编辑回卷与重试输入恢复。
- `/react`：`useSyncExternalStore` 订阅与 retain 生命周期；兼容 StrictMode，最后一个使用者离开后释放订阅与计时器。
- `/parts`：增加共用 `TurnQueueTray`，保留桌面排序、编辑、撤回、优先运行和暂停恢复展示；未提供的操作禁用。与其他 parts 一样，独立使用时由 `ConversationFlowProvider` 提供作用域及样式。

```tsx
import {useMemo} from 'react';
import {ConversationFlow, type ConversationFlowHost} from '@hemi/conversation-flow';
import {createConversationPresenter, createConversationActionHandler, type ConversationClient} from '@hemi/conversation-flow/core';
import {useConversation} from '@hemi/conversation-flow/react';
import '@hemi/conversation-flow/styles.css';

export function Session({client, host}: {client: ConversationClient; host: ConversationFlowHost}) {
  const state = useConversation(client);
  const present = useMemo(createConversationPresenter, []);
  const onAction = useMemo(() => createConversationActionHandler(client), [client]);
  const messages = useMemo(() => present(state.snapshot), [present, state.snapshot]);
  return <>
    <ConversationFlow scope={{...client.scope, generation: String(state.snapshot?.generation ?? 1)}}
      messages={messages} host={host} onAction={onAction}
      state={{busy: Boolean(state.snapshot && state.snapshot.phase !== 'idle'), notice: state.error}} />
    <textarea aria-label="消息" value={state.draft.text} onChange={event => client.draft.setText(event.target.value)} />
    <button onClick={() => {void client.sendDraft();}}>发送</button>
  </>;
}
```

`transport.fetchSnapshot/subscribe/command/lookupOperation` 使用 `/core` 的类型。适配器负责将已有服务协议转换成这些输入与回执；`subscribe` 可报告断线，SDK 负责重新追平。无推送适配器时默认每 2 秒查询，可通过 `pollIntervalMs` 设置或关闭。`lifecycle` 注入 resume／suspend／online／offline；暂停前端同步不会停止远端任务。

`storage.drafts` 提供 load／save；`storage.operations` 提供待发送记录的 load／save；可选 `storage.snapshots` 提供历史缓存。三者都必须按 environmentId（实际服务／实例／账号身份）与 conversationId 隔离，宿主负责原子写入和需要的加密。未注入存储时相应状态只保留在内存。更换身份时创建新 client，不复用旧 client 或存储键。

草稿加载不会覆盖随后输入的文字和标签；发送只在受理后清除提交的那个草稿版本。保存冲突暂停自动写入，宿主可让用户选择 `client.resolveDraftConflict('keep-local' | 'reload')`。保存失败也保留输入，不能用成功提示掩盖。

操作先保存到待发送记录，再交给通信适配器；重启时 sending 转为 unknown。unknown 通过稳定 inputId 的权威快照或 lookupOperation 回执核对，不自动重发；未确认前后续待发送操作暂停。明确的 waiting 操作可撤回，持久化撤回失败时恢复原项并反馈失败；`flushQueue()` 只向上游提交，真实执行顺序、权限及任务调度由服务端确认。离线仅允许发送输入进入本机待发送队列；停止、编辑等操作要求在线，不静默延后执行。保存失败的草稿在同一宿主中按会话保留内存副本，切换回来仍可找回。

client 导入和构造不发请求。手动使用时调用 `start()`、订阅 `getSnapshot()` 并在结束时 `dispose()`；React 场景由 hook 管理 retain，无须重复 start。`sendDraft()`、`sendCommand()`、`refresh()`、`flushDraft()` 是普通调用入口。`createConversationActionHandler` 提供编辑、重试及停止的默认映射，任务／工作流／预览等宿主业务可通过 fallback 注入。

详细边界与验收见 [会话核心实施说明](../../docs/technical/conversation-flow-sdk-session-core.md)。

## 数据与动作

`messages` 已按展示顺序排列。相同消息、part、工具调用和资源更新时保持 ID；流式输入是累计内容。`parts` 支持 text、thinking、tools、file-delivery 和 workflow-card。`state.tasks` 是子任务展示数据，`permissionRequests` 是当前确认队列，`runActivity` 是后台命令与资源等待摘要。工作流的节点、参数、标签、模型选项放在 `card.presentation`，SDK 不查询定义。设置 `card.readOnly` 或交互的终态表示历史记录。

`onAction(request, { signal })` 是唯一业务出口。它接收编辑、重试、停止、授权、工作流和预览请求，返回 `FlowResult<FlowActionReceipt>`。每次请求包含 scope、targetId、requestId 和可选 expectedRevision。宿主必须重新校验当前对象、权限和版本，并对有副作用的请求按 requestId 做幂等处理。

- `accepted` 表示宿主受理，`completed` 表示该操作完成，`needs-review` 表示结果待核对。均不会由 SDK 自行改写正式业务状态；更新后的展示数据仍通过 props 回传。
- 无确定回执时，SDK 不自动重发同一对象/版本的动作。前端取消等待不会停止任务或拒绝授权。
- 工作流草稿保存必须返回 `completed` 和新 revision；保存顺序串行化，提交先冲净草稿并携带最后确认版本。失败不会继续提交。
- `actions.edit/retry/stop/preview` 控制消息操作。未提供业务回调时内容仍可读；剪贴板和链接遵循 Host 能力。
- `message.edit-state` 只通知宿主局部编辑开始/取消，便于原页面保留输入区联动。独立消费方可不传 `state.editingMessageId`，由 SDK 管理局部编辑。

`scope` 三元组变化会重建展示状态并取消旧读取。`host` 和 `onAction` 建议使用稳定引用；替换任一项会撤销旧适配器的在途请求。多个实例没有共享缓存或业务状态。`active={false}` 暂停展示时钟与动画，恢复后从当前时间计算；宿主仍负责系统前后台事件及 WebView 尺寸。

## 统一 Host API

完整签名见导出的 `ConversationFlowHost`、`HostContext`、`FlowResult`、`ResourceRef`。能力声明必须与方法实现一致。

| 方法 | 语义 |
| --- | --- |
| copyText | 复制纯文本；拒绝权限返回 denied |
| openLink | 由宿主验证并打开链接，不由组件直接导航 |
| resources.resolve | 将待解析链接转换为宿主管理的资源标识 |
| resources.read | 按 ref.id、ref.version 和用途返回资源租约 |
| resources.listActions | 返回当前资源真实可用的保存、分享、定位或打开程序操作 |
| resources.perform | 执行返回列表中的 actionId，不能把保存静默换成分享 |

资源返回 text 或可由 WebView 加载的 URL，以及幂等 `release()`。Blob URL 的创建与撤销由宿主负责。SDK 在最后一个使用者离开、版本改变或会话卸载时取消读取并释放租约；即使宿主迟到返回，租约也会释放。原始路径不是读取权限。

旧任务图片的兼容 ref 为 `task-artifact:<taskId>:<artifactId>`，旧报告保存为 `task-body:<taskId>`，旧文件改动为 `file-change:<taskId>:<path>`；这些是桌面适配器约定。新宿主优先在文件 part 上显式提供 `resource`，并自行解释 preview.open 的目标。

## 样式、滚动与部件

样式只作用于 `[data-hemi-conversation-flow]` 内；菜单和 Dialog 默认挂到该实例的 portal。宿主传 `appearance.tokens` 覆盖 `--hcf-*` 变量，例如 `--hcf-ink`、`--hcf-bg-surface`、`--hcf-font`、`--hcf-h24-read-w`。默认是现有浅色视觉，未增加独立深色主题。`appearance.portalContainer` 必须位于同一主题/样式作用域内。

容器须有界高度。通过 ref 调用 `scrollToBottom()` 或 `scrollToMessage(id)`；未加载目标返回 `{ok:true,value:{found:false}}`。`state.scrollIntent.id` 变化明确请求跟随最新内容。历史前插与普通流式更新不会隐式加载或重新排序。

宿主因软键盘、面板或窗口调整容器高度时，虚拟列表在读取新视口尺寸后恢复滚动锚点：原本在底部则继续显示末尾，正在翻历史则保留位置。用户在尺寸调整期间发起新的滚动操作，会取消尚未执行的自动跟随。

`/parts` 提供同一实现的 `ConversationFlowProvider`、`PermissionStack`、`RunActivity` 等部件，供宿主保留原来的外围排列。独立组合部件须放在 Provider 内，跨作用域时为 Provider 设置 `key`。不要同时将同一确认队列或运行摘要交给主组件和独立部件。

## 移动端

`/native-host` 提供 JSON 桥适配器 `createNativeHost({transport,capabilities,actions})`，导出 `NativeRequest`/`NativeResponse`。iOS 和 Android 只实现 send/subscribe 及平台能力，消息流不分叉。它关联 scope/requestId，传递取消与超时，并用 releaseToken 释放原生资源。`dispose()` 应随 WebView 生命周期调用；原生端在页面销毁时也必须清理该页面的未决请求与资源。

仓库的 `examples/conversation-flow/native/` 有 Swift 与 Kotlin 最小宿主代码。它们演示本地页面加载、原生复制与外部链接；资源分享/保存和业务动作应由实际应用接入后再声明可用。当前交付验证了浏览器触屏布局和 JSON 桥契约，尚未完成 iOS/Android 真机验收。

## 开发与验证

仓库根目录：`npm ci`、`npm run build:sdk`、`npm run test:sdk`。独立示例见 `examples/conversation-flow`，其离线 HTML 可直接打开，不启动应用服务。完整桌面和视觉验证记录见 `docs/technical/conversation-flow-sdk-implementation.md`。

## Shared conversation controls and surfaces

Desktop and mobile applications consume these additional public entries:

| Entry | Exports and responsibility |
| --- | --- |
| `@hemi/conversation-flow/composer` | `ConversationComposer`, `ComposerAdapter`, attachment views, editor tokens and tag undo |
| `@hemi/conversation-flow/controls` | model options/selector, thinking options/selector, usage aggregation and `SessionUsage` |
| `@hemi/conversation-flow/navigation` | conversation row/status/grouping/formatting and the directory picker |
| `@hemi/conversation-flow/resources` | preview content/sheet, download progress and resource transfer view types |
| `@hemi/conversation-flow/core` | existing pure session API and the pure resource progress contract; no React runtime dependency |

`ConversationComposer` is controlled. Its `desktop` and `touch` layouts share the editor, draft identity, submission gating and keyboard implementation. Desktop Enter submits and Shift+Enter inserts a line; touch Enter inserts a line and Cmd/Ctrl+Enter submits. The touch layout retains independent send and stop controls. Header/tool/trailing slots carry voice and application controls without teaching the editor about native services.

`ComposerAdapter` supplies optional slash candidates, references and dropped-file path resolution, plus automatic-routing availability and the keyboard hint. Unsupported candidate queries do not open an unusable panel. Keep adapter callbacks stable for the environment; stale reference replies are discarded on query, conversation or adapter changes.

`ModelOptions` and `ThinkingOptions` support menu and sheet presentations. The desktop model selector takes a routing-configuration callback. Saving, selected values, connectivity and model availability come from the application. Menu and sheet choices share selection/disabled behavior, including `unavailableReason` from a model directory.

`DirectoryPicker` accepts a cancellable `load(path, signal)` callback and a selection callback. It owns navigation, retries and stale-response guards. The sheet presentation uses `@hemi/ui`; desktop can inject `renderSurface` for its existing dialog. It does not perform filesystem or RPC access itself.

`ConversationRow` owns common row content, status and rename editing. Sidebars/drawers, drag sensors, history loading and context actions remain application adapters. Optional actions preserve the capabilities offered by each host.

`ConversationRow.actions` renders sibling controls outside the conversation-open button. Touch hosts can open `ConversationActionsSheet` with the selected item, optional async `onRename(title)` / `onRemove()` adapters, connectivity and a focus-return target. The shared sheet provides rename editing, explicit deletion confirmation, pending guards and recoverable errors. The host owns authorization, operation receipts, persistence, cache cleanup and selection after deletion. Desktop context menus can continue to supply their existing actions.

`ResourcePreview` uses `ConversationFlowHost.resources` and optional transfer progress. The host owns verified bytes, resource leases and system operations. `ResourceContent` can render text, images and Markdown inside either preview surface. Markdown uses `ConversationFlowProvider`; callers with an existing Markdown host may supply `renderMarkdown`. Desktop retains its tab cache, document/video renderers and process panels. Mobile retains its keyboard-safe sheet and native QuickLook/save/share adapters.

The package depends on `@hemi/ui` by version; its published manifest contains no sibling `file:` dependency. The repository verifier packs both packages and installs them in a fresh directory outside the monorepo before checking TypeScript, Vite and Node/SSR imports.

## Shared style ownership and input controls

`src/styles/source/` is the single source of conversation styles. Desktop uses the public `@hemi/conversation-flow/styles/*.css` entries in its existing cascade order; `styles.css` compiles the same sources into the scoped SDK stylesheet. Base controls, popovers, dialogs and native interaction styles live in `@hemi/ui`. The desktop no longer carries copies of those sources.

Touch hosts also import these before their local shell/theme styles:

```tsx
import '@hemi/ui/styles/touch.css';
import '@hemi/conversation-flow/styles/touch.css';
```

`ModelSelectorControl` and `ThinkingLevelStrip` accept `layout="desktop"` or `layout="touch"`. Both use the same trigger, disclosure and surface code; touch uses a Sheet, desktop uses a Menu. `open`/`onOpenChange` allow a host to coordinate panels or open the model selector from its page header. `saving`, `offline`, `disabled`, `error` and `returnFocus` preserve host operation state and accessibility. A selection callback may return a Promise; `false` keeps the surface open after a rejected update, while success closes it. Thrown errors are shown without discarding the selection surface.

`ModelSelectorChip` supplies the desktop directory grouping, search, automatic-routing row, source/availability details and routing-settings callback to `ModelSelectorControl`. A touch host may supply its flat model catalog directly. `DirectoryControlButton` shares the same input-control trigger markup while local/SSH selection, native picking and RPC remain host adapters; touch defaults to a folder icon without directory text. The directory browser itself remains `DirectoryPicker`.

## Permission requests

`@hemi/conversation-flow/parts` exports `PermissionRequestCard`, `PermissionRequest` and the local-task adapter `PermissionCard`. Both desktop and touch hosts use the same request view and button submission path. A raw Bot request supplies `id`, `title`, `options` and optional command/path/reason metadata; `onChooseOption` receives the original server option string without translation. Omit `remainingMs` for persistent Bot confirmation. An explicit countdown of zero disables decisions; `disabled` also blocks the stop action. Touch retains its compact layout and server option order. Desktop retains task context, command disclosure, sorted decision buttons and queued-request hints.

`PermissionCard` adapts a local `TaskStateSnapshot`, legacy labels and enum decisions. Modern grant/action requests ignore Escape. Historical requests without `kind` retain Escape-to-deny while yielding to menus/modal dialogs; disabled or expired requests cannot be decided by keyboard. The host owns the clock, pending requests, conversation/generation filtering, RPC/IPC, busy state, stop and uncertain receipt recovery. `PermissionStack` continues to supply runtime revision/action guards.

## Controlled conversation lists and history

`@hemi/conversation-flow/navigation` exports `ConversationList`, `ConversationGroup` and `ConversationRow`. A list takes flat `items` or named `groups`, a `renderItem` callback and an empty view. `renderHeading` and `wrapGroupItems` preserve host headings and desktop drag providers. Item keys use conversation identity; grouping policy, data subscriptions, search, persistence and context actions stay with the host.

`ConversationRow` supports `sidebar`, `drawer` and `history` presentations. History reuses the same title/status and rename editor while showing time and turn count; `disabled` preserves in-flight operation guards and corrupt rows cannot open. Rename is controlled, ignores composing Enter, commits only once for Enter/blur, and Escape cancels without closing a containing dialog or committing on blur. Touch retains its existing title, pinned/running marks and tap layout. This does not add desktop mutations to touch hosts that do not provide them.

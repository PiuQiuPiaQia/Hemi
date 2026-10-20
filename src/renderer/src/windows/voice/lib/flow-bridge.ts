/**
 * 057：shared/conversation-flow.mjs 的渲染层门面（纯转发，与 lib/turn-parts 同口径——
 * .ts 内不做本地绑定，避免对无声明 .mjs 的 TS7016）。补丁应用与 UI 消费类型
 * （FlowChangeView/FlowSnapshotView）见 @shared/protocol。
 */
export { applyFlowChange } from '../../../../../shared/conversation-flow.mjs';

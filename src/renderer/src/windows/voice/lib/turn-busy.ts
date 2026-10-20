/**
 * 057 AC-40（bug#12 相关防御层）：模型忙态的统一派生——本地回合相位（runTurn 置的
 * thinking）或主进程 flow 运行事实（preparing/running）任一为真即忙。
 *
 * 背景：此前 busy 只吃本地 turnPhase，依赖 ui-state「running」广播被 adopt 单次命中；
 * 主进程发起的回合（队列派发/事件回合/外部直发）丢了那一帧广播＝整轮不亮停止钮。
 * flow 是单一事实源（订阅按会话绑定，不需再比对 conversationId）；stopping 仍占用
 * （060：真实资源退出前不能把会话当空闲）。
 */
export function deriveModelBusy({
  turnPhase,
  flowPhase,
}: {
  turnPhase?: string | null;
  flowPhase?: string | null;
}): boolean {
  if (turnPhase === 'thinking') return true;
  return flowPhase === 'preparing' || flowPhase === 'running' || flowPhase === 'stopping';
}

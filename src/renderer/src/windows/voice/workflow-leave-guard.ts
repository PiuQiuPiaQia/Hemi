// 与设置记忆编辑器相同的离开协议：导航方等待编辑器作出保存/放弃/取消选择。
let guard: (() => Promise<boolean>) | null = null;
export function registerWorkflowLeaveGuard(next: () => Promise<boolean>) {
  guard = next;
  return () => {
    if (guard === next) guard = null;
  };
}
export function confirmWorkflowLeave() {
  return guard?.() ?? Promise.resolve(true);
}

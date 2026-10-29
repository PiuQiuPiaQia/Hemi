/**
 * 回卷前让在途运行收口：控制器非 idle 时发 preempt 停止（不暂停队列），
 * 订阅补丁流等到 phase 回 idle。超时返回 false，调用方拒绝回卷而不是
 * 在旧运行仍活着时推进 generation（那会让旧代 run-closed 被丢弃、控制器卡在 stopping）。
 */
export async function waitRunSettled(controller, { timeoutMs = 8000 } = {}) {
  const idle = () => controller.getSnapshot().phase === 'idle';
  if (idle()) return true;
  let unsubscribe = () => {};
  let timer = null;
  const done = new Promise((resolve) => {
    unsubscribe = controller.subscribe(() => { if (idle()) resolve(true); });
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  try {
    // 渲染层通常已先发过 preempt；重复请求在 stopping 态是幂等的。
    await controller.command({ type: 'stop', reason: 'preempt' }).catch(() => null);
    if (idle()) return true;
    return await done;
  } finally {
    unsubscribe();
    clearTimeout(timer);
  }
}

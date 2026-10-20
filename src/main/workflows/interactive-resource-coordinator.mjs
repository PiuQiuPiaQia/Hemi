/**
 * 059 交互资源协调器（S5，运行接线 §10）：同一主机的桌面／共享浏览器会话互斥。
 *
 * 粗粒度 `interactive:<host>` 租约：同一时刻一个租约持有一个 owner（workflowRunId）；
 * 第二个请求排队等待（公平 FIFO），不抢焦点、不忙循环。等待可取消（取消后出队，
 * 拒绝原等待者的唤醒）。租约带 owner／epoch；节点结束／真正停止才释放；不需要
 * GUI 的模型／文件工作不占租约。
 */

export function createInteractiveResourceCoordinator({ log = null } = {}) {
  /** host → { holder: { owner, epoch } | null, queue: Array<{ owner, resolve, reject, timer }> } */
  const hosts = new Map();
  let epochCounter = 0;

  function hostState(host) {
    let state = hosts.get(host);
    if (!state) {
      state = { holder: null, queue: [] };
      hosts.set(host, state);
    }
    return state;
  }

  /**
   * 获取租约：空闲立即授予；被占则 FIFO 排队（返回的 promise 在释放时 resolve）。
   * @returns {Promise<{ host: string, owner: string, epoch: number, release: Function }>}
   */
  function acquire(host, owner, { timeoutMs = null } = {}) {
    const state = hostState(host);
    if (!state.holder) {
      const epoch = ++epochCounter;
      state.holder = { owner, epoch };
      return Promise.resolve(makeLease(host, owner, epoch));
    }
    return new Promise((resolve, reject) => {
      const entry = { owner, resolve, reject };
      if (timeoutMs) {
        entry.timer = setTimeout(() => {
          const index = state.queue.indexOf(entry);
          if (index >= 0) state.queue.splice(index, 1);
          const error = new Error(`等待交互资源超时（${host} 被另一运行占用）`);
          error.code = "resource-busy";
          reject(error);
        }, timeoutMs);
        // 不 unref：等待租约是关键路径，进程应活到超时或授予（停止时由 cancelWait 收口）。
      }
      state.queue.push(entry);
    });
  }

  function makeLease(host, owner, epoch) {
    let released = false;
    return {
      host,
      owner,
      epoch,
      release: () => {
        if (released) return;
        released = true;
        releaseHost(host, owner, epoch);
      },
    };
  }

  function releaseHost(host, owner, epoch) {
    const state = hosts.get(host);
    if (!state?.holder) return;
    if (state.holder.owner !== owner || state.holder.epoch !== epoch) return; // 旧代次的迟到释放不接管
    const next = state.queue.shift();
    if (next) {
      if (next.timer) clearTimeout(next.timer);
      const epochNext = ++epochCounter;
      state.holder = { owner: next.owner, epoch: epochNext };
      next.resolve(makeLease(host, next.owner, epochNext));
      return;
    }
    state.holder = null;
  }

  /**
   * 取消某 owner 的等待（停止／继续语义）：出队并 reject 其等待 promise。
   * @returns {boolean} 是否真的取消了等待
   */
  function cancelWait(host, owner) {
    const state = hosts.get(host);
    if (!state) return false;
    const index = state.queue.findIndex((entry) => entry.owner === owner);
    if (index < 0) return false;
    const [entry] = state.queue.splice(index, 1);
    if (entry.timer) clearTimeout(entry.timer);
    const error = new Error("等待已取消");
    error.code = "wait-cancelled";
    entry.reject(error);
    return true;
  }

  /** 观测：当前持有者与队列长度（测试与诊断）。 */
  function snapshot(host) {
    if (!host) {
      return [...hosts.keys()].map((h) => snapshot(h));
    }
    const state = hosts.get(host);
    if (!state) return { host, holder: null, queueLength: 0 };
    return { host, holder: state.holder, queueLength: state.queue.length };
  }

  return { acquire, cancelWait, snapshot };
}

// 生产会话与工作流共用同一宿主的交互资源池；测试仍可构造独立实例。
let sharedCoordinator;
export function getInteractiveResourceCoordinator() {
  return (sharedCoordinator ??= createInteractiveResourceCoordinator());
}

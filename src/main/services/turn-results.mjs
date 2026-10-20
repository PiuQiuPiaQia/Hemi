/** 060：执行结果与受理回执分离；重复请求共享结果，不创建无人处理的拒绝 Promise。 */
export function createTurnResults({ limit = 128 } = {}) {
  const completed = new Map();
  const waiting = new Map();
  return {
    has: (inputId) => completed.has(inputId),
    wait(inputId) {
      if (completed.has(inputId)) return Promise.resolve(completed.get(inputId));
      if (!waiting.has(inputId)) {
        let resolve;
        const promise = new Promise((done) => { resolve = done; });
        waiting.set(inputId, { promise, resolve });
      }
      return waiting.get(inputId).promise;
    },
    settle(inputId, outcome) {
      if (!inputId || completed.has(inputId)) return;
      completed.set(inputId, outcome);
      waiting.get(inputId)?.resolve(outcome);
      waiting.delete(inputId);
      while (completed.size > limit) completed.delete(completed.keys().next().value);
    },
  };
}

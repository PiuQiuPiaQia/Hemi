// 无业务目标的连接探测／附件准备仍记录实际请求；由产品装配注入，纯服务单测保持独立。
let observer = null;
export function setAuxiliaryTransportObserver(value) { observer = value; }
export function observeAuxiliaryTransport(config, purpose, run) {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  return observer ? observer({ config, purpose, fetchImpl, run }) : run(fetchImpl);
}

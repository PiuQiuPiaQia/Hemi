/**
 * 059 浏览器／桌面节点执行器（S4，运行接线 §6「按执行类型分派」）：
 * 目标解析校验（纯函数）＋共享节点 worker；与 skill 同款模式——差异只有
 * 目标解析、工具面（index 装配按节点类型分派）与桥可用性校验。
 *
 * 依赖不可用（浏览器扩展桥未连接、应用身份缺失）一律 dependency-unavailable
 * 明确阻止，不静默降级为普通执行、不换工具绕过（契约 §5 错误码）。
 */

const URL_RE = /^https?:\/\//i;

/**
 * 解析浏览器节点目标（纯函数）：字面 targetUrl 优先，其次 targetBinding 的已解析
 * 输入值（openAgent 已把绑定值冻结进 inputs）。
 * @returns {{ ok: true, url: string } | { ok: false, code: string, reason: string }}
 */
export function resolveBrowserTarget({ nodeData, inputs }) {
  const literal = typeof nodeData?.targetUrl === 'string' ? nodeData.targetUrl.trim() : '';
  if (literal) {
    if (!URL_RE.test(literal)) return { ok: false, code: 'dependency-unavailable', reason: `目标 URL 非法：${literal}` };
    return { ok: true, url: literal };
  }
  const binding = nodeData?.targetBinding;
  if (binding && typeof binding === 'object') {
    const key = binding.as ?? binding.key;
    const value = key ? (inputs ?? {})[key] : undefined;
    if (typeof value === 'string' && URL_RE.test(value.trim())) {
      return { ok: true, url: value.trim() };
    }
    return { ok: false, code: 'dependency-unavailable', reason: `URL 绑定（${key ?? '未命名'}）没有可用的 http(s) 地址` };
  }
  return { ok: false, code: 'dependency-unavailable', reason: '浏览器节点没有目标 URL 或 URL 绑定' };
}

/**
 * 解析桌面节点应用身份（纯函数）。
 * @returns {{ ok: true, applicationRef: string } | { ok: false, code: string, reason: string }}
 */
export function resolveDesktopApp({ nodeData }) {
  const ref = typeof nodeData?.applicationRef === 'string' ? nodeData.applicationRef.trim() : '';
  if (!ref) return { ok: false, code: 'dependency-unavailable', reason: '桌面节点没有应用身份（applicationRef）' };
  return { ok: true, applicationRef: ref };
}

function dependencyError(message) {
  const error = new Error(message);
  error.code = 'dependency-unavailable';
  return error;
}

/**
 * 浏览器节点的宿主校验＋桥租约：桥工厂未注入（扩展桥不可用）或目标解析失败
 * 都在这里阻止，不进节点 worker。
 * @param {object} params
 * @param {object} params.nodeData
 * @param {object} params.inputs
 * @param {((client: {taskId: string, taskLabel: string}) => object) | null} params.browserBridgeFactory
 * @param {string} params.accessId
 * @returns {{ client: object, release: Function, url: string }}
 */
export function acquireBrowserLease({ nodeData, inputs, browserBridgeFactory, accessId }) {
  const target = resolveBrowserTarget({ nodeData, inputs });
  if (!target.ok) throw dependencyError(target.reason);
  if (typeof browserBridgeFactory !== 'function') {
    throw dependencyError('浏览器扩展桥未连接（请在 Chrome 里启用 Hemi 浏览器控制扩展后重试）');
  }
  const client = browserBridgeFactory({ taskId: accessId, taskLabel: `workflow ${nodeData?.title ?? '浏览器节点'}` });
  if (!client) throw dependencyError('浏览器扩展桥客户端创建失败');
  let released = false;
  return {
    client,
    url: target.url,
    release: () => {
      if (released) return;
      released = true;
      client.release?.();
    },
  };
}

/**
 * 桌面节点的宿主校验：应用身份缺失阻止（应用授权沿现有门控，安装工作流不是预授权）。
 */
export function acquireDesktopLease({ nodeData }) {
  const app = resolveDesktopApp({ nodeData });
  if (!app.ok) throw dependencyError(app.reason);
  return { applicationRef: app.applicationRef, release: () => {} };
}

/**
 * 043 B1 · 平台能力状态机（纯逻辑，探测函数注入，node --test 离线覆盖）。
 *
 * 设计约束（technical-plan「能力状态是唯一事实来源」）：
 * - state ∈ checking/ready/blocked/unavailable/error；缺字段或探测失败一律收紧
 *   （checking/error），绝不默认 ready；
 * - 探测带超时，超时转 error（原因 probe-failed）；
 * - 同一能力只有最新代次（generation）的探测回执生效——recheck 重入或能力
 *   被外部 apply 时，先前的迟到回执按代次丢弃；
 * - revision 单调递增，只有状态真变化才推进并广播（订阅方按 revision 去重）。
 */

export const CAPABILITY_IDS = Object.freeze([
  'microphone',
  'audioDuplex',
  'pushToTalk',
  'desktop',
  'browser',
  'command',
  'systemProxy',
  'capture',
  'currentPage',
  'appCatalog',
]);

const CAPABILITY_SET = new Set(CAPABILITY_IDS);

const VALID_STATES = new Set(['checking', 'ready', 'blocked', 'unavailable', 'error']);

/** 每个能力的探测预算：首启快照不能为慢探测无限等（超时转 error 不假装可用）。 */
const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

function baseCapability(enabled) {
  return { supported: false, enabled: enabled === true, state: 'checking', reason: undefined, actions: [] };
}

/**
 * 归一探测回执。探测函数返回 { state, reason?, supported?, actions? } 或其中
 * 字段缺失——缺 state 的回执视作探测失败（收紧为 error），不透传未知的 state。
 */
function normalizeResult(result) {
  if (!result || typeof result !== 'object') {
    return { state: 'error', reason: 'probe-failed' };
  }
  const state = VALID_STATES.has(result.state) ? result.state : 'error';
  return {
    state,
    reason: typeof result.reason === 'string' ? result.reason : undefined,
    supported: result.supported === true,
    actions: Array.isArray(result.actions) ? result.actions.filter((a) => typeof a === 'string') : [],
  };
}

/**
 * 创建能力服务。
 * @param {object} options
 * @param {string} options.platform 'darwin' | 'win32'（快照原样携带）
 * @param {string} [options.sessionId] 宿主运行代次（缺省随机；重启后从头计数）
 * @param {Record<string, () => Promise|object>} options.probes 能力 → 探测函数
 * @param {Record<string, boolean>} [options.enabledIntents] 能力 → 已保存的用户意图
 * @param {(snapshot: object) => void} [options.notify] 状态变化广播（快照同源）
 * @param {() => number} [options.now] 时钟注入（测试确定性推进）
 * @param {number} [options.probeTimeoutMs]
 */
export function createCapabilityService({
  platform,
  sessionId = `ps-${Math.random().toString(36).slice(2, 10)}`,
  probes,
  enabledIntents = {},
  notify = () => {},
  now = Date.now,
  probeTimeoutMs = DEFAULT_PROBE_TIMEOUT_MS,
  probeTimeouts = {},
}) {
  if (!platform) throw new Error('createCapabilityService: platform 必填');
  if (!probes || typeof probes !== 'object') throw new Error('createCapabilityService: probes 必填');

  /** @type {Map<string, object>} */
  const capabilities = new Map();
  for (const id of CAPABILITY_IDS) {
    capabilities.set(id, baseCapability(enabledIntents[id]));
  }

  let revision = 0;
  /** 每能力探测代次：apply/recheck 都会让旧代次回执失效。 */
  const generations = new Map(CAPABILITY_IDS.map((id) => [id, 0]));

  const runProbe = (id, generation) =>
    new Promise((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ state: 'error', reason: 'probe-failed' });
      }, probeTimeouts[id] ?? probeTimeoutMs);
      timer.unref?.();
      Promise.resolve()
        .then(() =>
          probes[id]
            ? probes[id]()
            : // 后端没注册探测＝该构建不含此实现：unavailable 收紧，不悬在 checking。
              { state: 'unavailable', supported: false },
        )
        .then((result) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(normalizeResult(result));
        })
        .catch(() => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ state: 'error', reason: 'probe-failed' });
        });
      void generation; // 代次校验在 resolve 之后统一判（见 accept）
    });

  const accept = (id, generation, result) => {
    if (generation !== generations.get(id)) return false; // 旧代次回执丢弃
    const current = capabilities.get(id);
    const next = {
      ...current,
      state: result.state,
      reason: result.reason,
      supported: result.supported || current.supported,
      actions: result.actions ?? current.actions,
    };
    const changed =
      current.state !== next.state ||
      current.reason !== next.reason ||
      current.supported !== next.supported ||
      JSON.stringify(current.actions) !== JSON.stringify(next.actions);
    if (!changed) return false;
    capabilities.set(id, next);
    return true;
  };

  const publishIfChanged = () => {
    revision += 1;
    notify(snapshot());
  };

  function snapshot() {
    const caps = {};
    for (const id of CAPABILITY_IDS) {
      const cap = capabilities.get(id);
      // actions 拷贝一份：快照给渲染层/调用方，不能共享内部可变数组。
      caps[id] = { ...cap, actions: [...cap.actions] };
    }
    return { platform, sessionId, revision, capabilities: caps, shortcuts: shortcutsOf() };
  }

  /** 快捷键由主进程后端给（win 候选键未定案时为 null）。 */
  let pushToTalkShortcut = null;
  function shortcutsOf() {
    return { pushToTalk: pushToTalkShortcut ? { ...pushToTalkShortcut } : null };
  }

  return {
    sessionId,
    get revision() {
      return revision;
    },

    /** 首次构建：全部能力并行探测（各自超时），任一变化即发布。 */
    async probeAll() {
      const generationFor = new Map(generations);
      const results = await Promise.all(
        CAPABILITY_IDS.map(async (id) => [id, await runProbe(id, generationFor.get(id))]),
      );
      let changed = false;
      for (const [id, result] of results) {
        if (accept(id, generationFor.get(id), result)) changed = true;
      }
      if (changed) publishIfChanged();
      return snapshot();
    },

    /** 单能力重查（recheck IPC）：代次推进让在途旧回执失效。 */
    async recheck(id) {
      if (!CAPABILITY_SET.has(id)) throw new Error(`未知能力：${id}`);
      const generation = generations.get(id) + 1;
      generations.set(id, generation);
      capabilities.set(id, { ...capabilities.get(id), state: 'checking', reason: undefined });
      publishIfChanged();
      const result = await runProbe(id, generation);
      if (accept(id, generation, result)) publishIfChanged();
      return snapshot();
    },

    /**
     * 运行态事件注入（如钩子启停、桥状态翻转）：直接落状态并发布，
     * 同时推进代次——让在途探测的迟到回执不会盖掉刚发生的事实。
     */
    apply(id, patch) {
      if (!CAPABILITY_SET.has(id)) throw new Error(`未知能力：${id}`);
      const current = capabilities.get(id);
      const state = VALID_STATES.has(patch?.state) ? patch.state : current.state;
      generations.set(id, generations.get(id) + 1);
      capabilities.set(id, {
        ...current,
        ...patch,
        state,
        reason: patch?.reason === undefined ? undefined : patch.reason,
        enabled: typeof patch?.enabled === 'boolean' ? patch.enabled : current.enabled,
      });
      publishIfChanged();
    },

    /** 主进程后端登记快捷键（不推进 revision 之外的语义）。 */
    setShortcut(key, label) {
      pushToTalkShortcut = key && label ? { key, label } : null;
      publishIfChanged();
    },

    setEnabled(id, enabled) {
      const current = capabilities.get(id);
      if (!current || current.enabled === (enabled === true)) return;
      capabilities.set(id, { ...current, enabled: enabled === true });
      publishIfChanged();
    },

    snapshot,
  };
}

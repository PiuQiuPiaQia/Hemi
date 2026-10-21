import { writeFile } from 'node:fs/promises';
import { get as httpGet } from 'node:http';

import { BrowserWsHub } from '../agent/gate/browser-ws.mjs';
import { createHeadlessBrowserService } from './headless-browser-service.mjs';

/**
 * 023 R-15 · 应用级浏览器桥单例（BrowserBridgeService）。
 *
 * 旧形态：每个 Pi 会话的 pi-browser 扩展各自 createBrowserBridge 起 hub——
 * 并行任务时后到者抢不到扩展连接（022 真机 P1），pi 进程吞 SIGTERM 还会
 * 残留监听占端口。单例化后：
 *   - hub 随浏览器能力启用（首个浏览器任务实际用到桥时惰性启动）常驻，
 *     与单个任务的生死解耦；应用退出统一关闭；
 *   - 所有 Agent 会话经 createClient 拿到任务专属客户端，cmd/result 信封
 *     携带 taskId（按任务记账），Chrome 扩展按 taskId 维护各自的任务窗口；
 *   - 能力握手：扩展 hello 自报 multiTask。扩展不支持多任务（旧版本）时，
 *     第二个并发任务快速报忙（021「正被另一个任务使用」语义保留为兜底），
 *     绝不静默串台；
 *   - 021 的版本握手、报忙端口探测（detectOtherHubs）保留为桥本体异常时
 *     的可行动文案来源。
 *
 * 浏览器工具按任务选择后端：短等扩展握手，未连接则启动独立无头会话。
 * 无头任务不中途切换到扩展；扩展断连的在途动作不重放，后续回退需重新导航。
 */

/** 桥端口段：扩展侧按同一段顺序重试；前缀固定本机回环。 */
export const BRIDGE_PORTS = [9467, 9468, 9469, 9470];
export const OP_TIMEOUT_MS = { 'session.navigate': 30000, 'tab.screenshot': 20000, default: 15000 };

/**
 * 探测同机桥端口段里是否有【别的】Hemi 桥在运行（022 真机：并行任务时扩展
 * 只连一个桥，先到的任务锁死扩展，后到的任务干等）。指纹＝普通 HTTP GET 的
 * `x-hemi-bridge` 标记头（见 browser-ws 的非 Upgrade 分支）——不做 WebSocket
 * 握手，因此绝不会顶掉别的任务正在用的扩展连接。返回占用端口列表。
 */
export function detectOtherHubs({ ports = BRIDGE_PORTS, excludePort = null, probeMs = 800 } = {}) {
  const candidates = ports.filter((p) => p !== excludePort);
  return Promise.all(
    candidates.map(
      (port) =>
        new Promise((resolve) => {
          const req = httpGet({ host: '127.0.0.1', port, path: '/', timeout: probeMs }, (res) => {
            const isBridge = res.headers['x-hemi-bridge'] === '1';
            res.resume();
            resolve(isBridge ? port : null);
          });
          req.on('timeout', () => {
            req.destroy();
            resolve(null);
          });
          req.on('error', () => resolve(null));
        }),
    ),
  ).then((found) => found.filter(Boolean));
}

/** 纯状态机：桥/会话状态流转（测试用）。off → starting → ready；任何态可 → error。 */
export function bridgeStateTransition(state, event) {
  switch (event) {
    case 'env-off':
      return 'off';
    case 'start':
      return 'starting';
    case 'listening':
    case 'client-hello':
      return state === 'off' ? state : 'ready';
    case 'client-gone':
      if (state === 'off') return state;
      return state === 'error' ? 'error' : 'starting';
    case 'fatal':
      return 'error';
    case 'stop':
      return 'off';
    default:
      return state;
  }
}

/** 021 报忙文案（扩展连接被占/桥降级时的兜底语义，R-15 裁决保留）。 */
export function busyMessage(busyPorts) {
  return `浏览器通道正被另一个任务使用（端口 ${busyPorts.join('、')}）：等那个任务完成后再下浏览器操作，或先停止它；期间可用 web_search/web_extract 兜底`;
}

/**
 * 创建桥服务（多数场景用 getBrowserBridgeService 单例；测试可多实例）。
 * createClient 返回的对象即 pi-browser 工具面的 `bridge`：
 *   { state, port, connected, session, extVersion, ensureReady, request,
 *     noteSession, endSession, stop }
 */
export function createBrowserBridgeService({
  ports = BRIDGE_PORTS,
  statePath = null,
  log = null,
  writeFileFn = writeFile,
  opTimeout = OP_TIMEOUT_MS,
  now = Date.now,
  extensionWaitMs = 1000,
  headlessFactory = () => createHeadlessBrowserService({ log, opTimeout }),
} = {}) {
  let state = 'off';
  let hub = null;
  let seq = 0;
  const pending = new Map(); // cmd id -> { resolve, reject, timer }
  let extVersion = null;
  /** 扩展能力：hello.multiTask=true 才允许并行任务复用同一扩展连接。 */
  let extMultiTask = false;
  /** 按任务记账：taskId -> { label, session 镜像 }。enterTask/leaveTask 维护。 */
  const activeTasks = new Map();
  let headless = null;
  const headlessService = () => headless ??= headlessFactory();
  const extensionReady = () => state === 'ready' && Boolean(hub?.connected);

  async function writeStatus(partial) {
    if (!statePath) return;
    const primary = activeTasks.values().next().value ?? null;
    const headlessTasks = [...activeTasks.values()].filter(task => task.backend === 'headless').length;
    const payload = {
      state,
      updatedAt: now(),
      port: hub?.port ?? null,
      session: primary?.session ?? null,
      extVersion,
      multiTask: extMultiTask,
      tasks: activeTasks.size,
      ...partial,
      backend: primary?.backend ?? (extensionReady() ? 'extension' : null),
      extensionConnected: extensionReady(),
      headlessTasks,
      ...(headlessTasks ? {
        state: 'ready',
        detail: primary?.backend === 'extension' ? `另有 ${headlessTasks} 个无头浏览器任务（独立登录状态）` : '正在使用独立无头浏览器（独立登录状态）',
      } : {}),
    };
    try {
      await writeFileFn(statePath, `${JSON.stringify(payload)}\n`);
    } catch (error) {
      log?.warn?.(`[browser] 桥状态写盘失败：${error.message}`);
    }
  }

  function transition(event) {
    state = bridgeStateTransition(state, event);
    return state;
  }

  function rejectAll(message, taskId = null) {
    for (const [key, entry] of pending) {
      if (taskId !== null && entry.taskId !== taskId) continue;
      clearTimeout(entry.timer);
      entry.reject(new Error(message));
      pending.delete(key);
    }
  }

  function wireHub() {
    hub.on('text', (_client, text) => {
      let message = null;
      try {
        message = JSON.parse(text);
      } catch {
        log?.debug?.('[browser] 忽略非 JSON 消息');
        return;
      }
      if (message?.type === 'hello') {
        transition('client-hello');
        extVersion = typeof message.extVersion === 'string' && message.extVersion ? message.extVersion : null;
        extMultiTask = message.multiTask === true;
        void writeStatus({ state: 'ready', detail: null });
        // 协议 2：cmd 信封携带 taskId/taskLabel；旧扩展忽略该字段也能单任务工作。
        hub.sendText(JSON.stringify({ type: 'hello-ok', protocol: 2 }));
        log?.info?.(`[browser] Chrome 扩展已接入${extVersion ? `（v${extVersion}）` : '（未上报版本＝旧扩展，请在 chrome://extensions 重新加载）'}${extMultiTask ? '，多任务并发可用' : '，仅单任务（并行将报忙，请更新扩展）'}`);
      } else if (message?.type === 'ping') {
        hub.sendText(JSON.stringify({ type: 'pong' }));
      } else if (message?.type === 'result' && pending.has(message.id)) {
        const entry = pending.get(message.id);
        pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) entry.resolve(message.data ?? {});
        else entry.reject(new Error(String(message.error || '浏览器操作失败')));
      }
    });
    hub.on('close', () => {
      rejectAll('浏览器桥连接断开（Chrome 侧可能已关闭或扩展休眠）');
      if (transition('client-gone') !== 'off') {
        void writeStatus({ state: 'connecting', detail: '等待 Chrome 扩展重新接入' });
      }
    });
    hub.on('error', (error) => log?.warn?.(`[browser] 桥错误：${error.message}`));
  }

  async function ensureStarted() {
    if (state === 'ready' || state === 'starting') return hub?.port ?? null;
    transition('start');
    hub = new BrowserWsHub({ log });
    wireHub();
    try {
      await hub.listen({ ports });
    } catch (error) {
      transition('fatal');
      await writeStatus({ state: 'error', detail: error.message });
      hub.close();
      hub = null;
      throw error;
    }
    await writeStatus({ state: 'connecting', detail: '等待 Chrome 扩展接入' });
    return hub?.port ?? null;
  }

  /** 等扩展 hello；超时后按 021 报忙探测给出可行动文案。 */
  async function waitReadyGlobal(waitMs = 35000, signal) {
    if (state === 'ready') return;
    const started = now();
    while (now() - started < waitMs) {
      if (signal?.aborted) throw new Error('操作已被中断，未执行');
      if (state === 'ready') return;
      if (state === 'off') throw new Error('浏览器桥未启动');
      if (state === 'error') {
        const busyOnStart = await detectOtherHubs({ ports, excludePort: hub?.port ?? null }).catch(() => []);
        if (busyOnStart.length) throw new Error(busyMessage(busyOnStart));
        throw new Error('浏览器桥启动失败');
      }
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    const busyPorts = await detectOtherHubs({ ports, excludePort: hub?.port ?? null }).catch(() => []);
    if (busyPorts.length) throw new Error(busyMessage(busyPorts));
    throw new Error('Chrome 扩展未接入：请确认已按设置页引导安装 Hemi 浏览器扩展，且 Chrome 正在运行');
  }

  /**
   * 任务专属客户端。pi-browser 工具面把它当 `bridge` 用；cmd 信封统一带
   * taskId/taskLabel（扩展按任务记账各自的窗口），结果按命令 id 路由。
   */
  function createClient({ taskId, taskLabel = '' } = {}) {
    const id = String(taskId ?? `task-${++seq}`);
    let session = null; // { windowId, tabId } 镜像（仅该任务）
    // 056：同一客户端（一个任务/主 agent 的窗口）的命令串行执行。宿主工具不标 sequential
    // （否则同批 task 被串行化），同一条助手消息里的 navigate＋extract 会并发到扩展——
    // extract 读到导航前的旧页（2026-10-14 真机实录）。不同任务各自一条队列，互不阻塞。
    let chain = Promise.resolve();
    let ending = null;
    let backend = null;
    let local = null;
    let selecting = null;
    let switched = false;
    let epoch = 0;

    async function ensureReady(signal) {
      if (signal?.aborted) throw new Error('操作已被中断，未执行');
      if (ending) await ending;
      if (backend === 'headless') { await local.ensureReady(signal); return; }
      if (backend === 'extension' && extensionReady()) return;
      if (selecting) return selecting;
      selecting = (async () => {
        try {
          await ensureStarted();
          if (!extensionReady()) await waitReadyGlobal(extensionWaitMs, signal);
        } catch (error) {
          if (signal?.aborted) throw error;
          log?.debug?.(`[browser] 扩展暂不可用，选择无头后端：${error.message}`);
        }
        if (signal?.aborted) throw new Error('操作已被中断，未执行');
        if (!extensionReady()) {
          const next = headlessService().createClient({ taskId: id, taskLabel });
          try { await next.ensureReady(signal); }
          catch (error) {
            await next.endSession().catch(() => {});
            await writeStatus({ state: 'error', detail: error.message });
            throw error;
          }
          switched = backend === 'extension';
          backend = 'headless'; local = next; session = null;
          activeTasks.set(id, { label: String(taskLabel).slice(0, 40), session: null, backend });
          await writeStatus({});
          return;
        }
        // 能力门禁：扩展不支持多任务时，同一时间只允许一个任务占用通道（R-15
        // 裁决的兜底语义；新扩展 multiTask=true 后这里恒放行）。
        if (!extMultiTask && !activeTasks.has(id) && [...activeTasks.values()].some(task => task.backend === 'extension')) {
          const holder = activeTasks.keys().next().value;
          log?.info?.(`[browser] 通道被任务 ${holder} 占用且扩展不支持多任务，报忙`);
          throw new Error(`浏览器通道正被另一个任务使用：等那个任务完成后再下浏览器操作，或先停止它；期间可用 web_search/web_extract 兜底`);
        }
        if (!activeTasks.has(id)) {
          activeTasks.set(id, { label: String(taskLabel).slice(0, 40), session: null, backend: 'extension' });
          void writeStatus({});
        }
        backend = 'extension';
      })();
      try { await selecting; } finally { selecting = null; }
    }

    async function sendRequest(op, params) {
      if (backend === 'headless') {
        if (switched && !['session.navigate', 'session.end', 'tab.list'].includes(op)) {
          throw new Error('Chrome 扩展连接断开，已回退独立无头浏览器（独立登录状态）；请先 browser_navigate 重新打开目标页面并核对状态，再继续操作，不要直接重复提交');
        }
        const result = await local.request(op, params);
        if (op === 'session.navigate') switched = false;
        return result;
      }
      if (!hub?.connected) throw new Error('浏览器桥未连接：Chrome 扩展不在（任务窗口可能已被关闭）');
      const cmdId = `${id}-${++seq}`;
      const payload = JSON.stringify({ type: 'cmd', id: cmdId, op, params, taskId: id, taskLabel: String(taskLabel).slice(0, 40) });
      const timeoutMs = opTimeout[op] ?? opTimeout.default;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(cmdId);
          reject(new Error(`浏览器操作超时（${Math.round(timeoutMs / 1000)}s）：${op}`));
        }, timeoutMs);
        pending.set(cmdId, { resolve, reject, timer, taskId: id });
        try {
          hub.sendText(payload);
        } catch (error) {
          pending.delete(cmdId);
          clearTimeout(timer);
          reject(error);
        }
      });
    }

    function releaseTask() {
      if (activeTasks.delete(id)) void writeStatus({});
    }

    return {
      get taskId() {
        return id;
      },
      get taskLabel() {
        return taskLabel;
      },
      get state() {
        return state;
      },
      get port() {
        return hub?.port ?? null;
      },
      get connected() {
        return backend === 'headless' || extensionReady();
      },
      get backend() {
        return backend;
      },
      get session() {
        return session;
      },
      get extVersion() {
        return extVersion;
      },
      ensureReady,

      /** 只确保 hub 在监听（不等扩展 hello）；测试先起桥再让扩展拨入用。 */
      async start() {
        return ensureStarted();
      },

      /** 只等扩展 hello（不改变任务记账）；可调等待时长，报忙探测同全局语义。 */
      async waitReady(waitMs = 35000) {
        return waitReadyGlobal(waitMs);
      },

      request(op, params = {}) {
        const expected = epoch;
        const run = chain.then(() => {
          if (expected !== epoch) throw new Error('浏览器任务已结束，取消排队操作');
          return sendRequest(op, params);
        });
        chain = run.catch(() => {});
        return run;
      },

      /** 056：结束会话时绕过队列直接发（避免排在一个卡住的 navigate 后面等 30s）。 */
      requestPriority(op, params = {}) {
        return sendRequest(op, params);
      },

      /** 扩展侧回执里的 session 镜像（设置页展示窗口归属）。 */
      noteSession(next) {
        session = next;
        const entry = activeTasks.get(id);
        if (entry) entry.session = next;
      },

      /**
       * 任务收尾：只结束本任务的窗口会话（session.end 带 taskId，扩展只清
       * 本任务的标签页），hub 与其他任务不受影响——R-15 与任务终态解耦。
       */
      async endSession() {
        if (ending) return ending;
        // 没用过浏览器的回合不创建任务记账，也不发无意义的 session.end。
        if (!activeTasks.has(id) && !session && !selecting) return;
        epoch++;
        ending = (async () => {
          await selecting?.catch(() => {});
          try {
            if (backend === 'headless') await local.endSession();
            else if (hub?.connected) await this.request('session.end', {});
            session = null;
            backend = null; local = null; switched = false;
            releaseTask();
          } catch (error) {
            // 失败保留归属供下轮／dispose 重试，不能提前报 tasks=0 冒充已清理。
            log?.warn?.(`[browser] 任务 ${id} 页面回收失败，保留归属待重试：${error?.message ?? error}`);
          }
        })();
        try { await ending; } finally { ending = null; }
      },

      /** pi-browser 停止路径的旧入口名；语义已收敛为 endSession（不关 hub）。 */
      async stop() {
        rejectAll(`浏览器操作已被任务停止取消（任务 ${id}）`, id);
        await this.endSession();
      },
    };
  }

  return {
    get state() {
      return state;
    },
    get port() {
      return hub?.port ?? null;
    },
    get connected() {
      return Boolean(hub?.connected);
    },
    get extVersion() {
      return extVersion;
    },
    get extMultiTask() {
      return extMultiTask;
    },
    get activeTaskIds() {
      return [...activeTasks.keys()];
    },
    /** 测试/诊断用：客户端创建入口（与旧 createBrowserBridge 的工具面契约一致）。 */
    createClient,
    async checkAvailable() {
      try { await ensureStarted(); } catch { /* A port conflict must not disable headless browsing. */ }
      if (extensionReady()) return 'extension';
      await headlessService().checkAvailable();
      return 'headless';
    },
    /** 惰性启动入口（R-15：随浏览器能力启用而启动；任务侧经 ensureReady 亦会触发）。 */
    start: () => ensureStarted(),
    /** 应用退出统一关闭（R-15：hub 不随任务生死，只随应用生死）。 */
    async stopHub() {
      rejectAll('应用退出，浏览器桥关闭');
      if (hub) {
        hub.close();
        hub = null;
      }
      activeTasks.clear();
      await headless?.stop(); headless = null;
      transition('stop');
      await writeStatus({ state: 'off', detail: null });
    },
  };
}

/** 应用级单例（R-15）：随浏览器能力启用惰性创建，应用退出统一 stopHub。 */
let sharedService = null;
export function getBrowserBridgeService(options = {}) {
  if (!sharedService) sharedService = createBrowserBridgeService(options);
  return sharedService;
}
export async function shutdownBrowserBridgeService() {
  if (!sharedService) return;
  await sharedService.stopHub();
  sharedService = null;
}

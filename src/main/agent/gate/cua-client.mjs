// 036 · cua-driver 唯一桥——桌面操控原语自建清零后的全部系统触点。
//
// 集成形态（spike 2026-10-02 真机验证，6/6 过）：进程内运行时
// CuaDriver.create()，原生库就是平台包 @trycua/cua-driver-darwin-arm64 里
// 的 .node——没有独立二进制、没有 daemon、没有 postinstall 下载。TCC 权限
// （辅助功能/屏幕录制）归属宿主进程：打包后是 Hemi.app 自己，dev 态是 Electron。
//
// 关键约束：SDK 的 node-runtime 在模块 import 时就 require(.node) 加载原生库，
// 因此本文件**对 @trycua/cua-driver 零静态 import**——纯函数助手不碰 SDK，
// 构造器/枚举全部经 loadSdk() 动态获取。主进程启动与 node --test 单测均不
// 触发原生库加载；首次工具调用才加载（spike 实测首调约 1s 含初始化）。
//
// 桥的职责（业务语义外的系统关心点都在这层）：
//  - 懒加载单例 + 应用退出收尾（shutdown + uniffiDestroy）；
//  - 每次调用过 perf 埋点（{ command, ms, ok }，接 task.ipc 的视觉原语通道，
//    补上 agent-desktop 时代缺失的埋点）；
//  - 取消：Pi 的 AbortSignal 直通 SDK 的 asyncOpts.signal；
//  - 错误翻译：DriverError.Tool（refused 走异常通道，inner.errorCode 是钥匙）
//    → 带中文指引的 Error；权限类报错引导去系统设置授权。
//  - scroll 的后台→前台升级：官方口径是「后台不可用不得自动前台重试」，
//    Hemi 场景不同——门控已批动作本身，且旧 JXA 实现全部是前台档（activate
//    后全局事件），前台不是新的权限面。升级仅一次且在结果里明说。typed
//    ScrollInput 没有 deliveryMode 字段，升级路径经通用 callTool 走 MCP wire。
//
// 枚举数值钉在 0.32.0（ActionEffect: Confirmed=0/Partial=1/Unverifiable=2/
// SuspectedNoop=3/Refused=4；ScrollDirection: Up=0/Down=1）——升级 SDK 版本
// 时须以 cua-client.test.mjs 的形状断言回归。
/** 截图长边上限（R-06 预算沿用：960 足以定位控件，token/延迟双降）。 */
export const CAPTURE_LONG_EDGE = 960;

/** 单次驱动调用的外层兜底超时：SDK 内部有自己的分项超时（AX walk 默认 1s）。 */
export const DRIVER_CALL_TIMEOUT_MS = 90_000;

/** scroll 单次滚动量上限（SDK 约束 1–50 行/页）。 */
const SCROLL_AMOUNT_MAX = 50;

/** 原语耗时上报 sink（{ command, ms, ok }）：宿主接线到 hemi.log perf 域。 */
let timingSink = null;
export function setDriverTimingSink(fn) {
  timingSink = typeof fn === 'function' ? fn : null;
}

function reportTiming(command, startedAt, ok) {
  try { timingSink?.({ command, ms: Date.now() - startedAt, ok }); } catch { /* 上报不外溢 */ }
}

/**
 * 组合键解析（沿用旧 ui_key 的模型面约定）：「cmd+a」「shift+tab」「enter」
 * → keys 数组（长度 >1 走 hotkey，单键走 pressKey）。esc→escape 归一，
 * 其余原样小写交 SDK。
 */
export function parseCombo(combo) {
  const parts = String(combo ?? '').split('+').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return parts.map((k) => (k === 'esc' ? 'escape' : k));
}

/** ui_scroll 的 deltaY（正=向上，负=向下）→ 方向与行数（SDK 约束 1–50）。 */
export function deltaYToScroll(deltaY) {
  const amount = Math.min(SCROLL_AMOUNT_MAX, Math.max(1, Math.round(Math.abs(Number(deltaY) || 3))));
  return { direction: Number(deltaY) >= 0 ? 'up' : 'down', amount };
}

/** DriverError.Tool 提取（refused 走异常通道；其他 tag 返回 null）。 */
export function driverErrorInfo(e) {
  if (!e || typeof e !== 'object' || e.tag !== 'Tool' || !e.inner) return null;
  const { tool, message, errorCode } = e.inner;
  return { tool, message, errorCode };
}

/** 权限/状态类 errorCode 的中文指引（R-09：失败必须能引导用户）。 */
export function translateDriverError(e) {
  const info = driverErrorInfo(e);
  if (!info) return e instanceof Error ? e : new Error(String(e?.message ?? e));
  const { tool, message, errorCode } = info;
  const text = `${errorCode ?? 'error'}: ${message ?? ''}（工具 ${tool ?? '?'}）`;
  if (/element_token|stale/i.test(`${errorCode} ${message}`)) {
    return new Error(`快照已过期或元素定位失败（${text}）：请重新 screen_view / ui_tree 拿最新快照再动作，不要重试旧坐标或旧 token`);
  }
  if (/permission|accessibility|screen.?recording|tcc|not.?authorized/i.test(`${errorCode} ${message}`)) {
    return new Error(`系统权限不足（${text}）：请到 系统设置 → 隐私与安全性，检查 Hemi 的「辅助功能」与「屏幕录制」授权后重试`);
  }
  if (/window|pid/i.test(`${errorCode} ${message}`) && /not|gone|exist|closed|invalid/i.test(`${errorCode} ${message}`)) {
    return new Error(`目标窗口已不存在（${text}）：请重新 ui_list 定位`);
  }
  return new Error(`驱动拒绝执行（${text}）`);
}

/** ActionEffect 数值 → 动作状态（details.actionState 沿用 006 语义）。 */
const EFFECT_EXECUTED = new Set([0, 1, 2]); // Confirmed / Partial / Unverifiable
export function describeAction(action) {
  if (!action || typeof action !== 'object') return { actionState: 'executed', note: '' };
  const effect = Number(action.effect);
  if (action.error?.code || effect === 4) {
    return { actionState: 'not-executed', note: action.error?.hint ?? action.error?.code ?? '' };
  }
  if (effect === 3) return { actionState: 'not-executed', note: action.summary ?? '疑似未生效' };
  if (!EFFECT_EXECUTED.has(effect)) return { actionState: 'executed', note: '' };
  const notes = [];
  if (effect === 1) notes.push('部分生效');
  if (effect === 2) notes.push('后台投递未核验，需要确认结果请截图');
  if (Number(action.delivery?.mode) === 1) notes.push('以前台方式执行（短暂置前目标窗口）');
  return { actionState: 'executed', note: notes.join('；') };
}

/** ToolResult（typeText/scroll/hotkey 等的返回）→ 动作状态。 */
export function describeToolResult(result) {
  if (!result || typeof result !== 'object') return { actionState: 'executed', note: '' };
  if (result.isError) {
    return { actionState: 'not-executed', note: `${result.errorCode ?? 'error'}: ${result.text ?? ''}`.slice(0, 200) };
  }
  if (result.action) return describeAction(result.action);
  return { actionState: 'executed', note: '' };
}

/** ToolResult/WindowStateOutput 的图片统一取出（base64 + mimeType）。 */
export function firstImage(result) {
  const img = result?.images?.[0];
  return img ? { data: img.dataBase64, mimeType: img.mimeType || 'image/png' } : null;
}

/** 惰性 SDK 模块缓存：测试注入 loadSdk 时完全不走这条（不触发原生库加载）。 */
let sdkModulePromise = null;
function defaultLoadSdk() {
  sdkModulePromise ??= import('@trycua/cua-driver');
  return sdkModulePromise;
}

function withTimeout(promise, ms, label) {
  let timer = null;
  const guard = new Promise((_r, reject) => {
    timer = setTimeout(() => reject(new Error(`驱动调用超时（${label} ${ms}ms）`)), ms);
    timer.unref?.(); // 不拖住进程退出
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

/**
 * 创建桥实例。生产用模块级默认实例；测试注入 loadSdk 返回假模块 +
 * createDriver 返回假驱动（假模块只需提供本文件用到的构造器/枚举）。
 * 每个 SDK 调用统一：计时上报 → 透传取消信号 → 异常翻译（DriverError.Tool →
 * 中文 Error；AbortError → 旧「操作已被中断」口径）。
 */
export function createCuaBridge({
  loadSdk = defaultLoadSdk,
  createDriver,
  timeoutMs = DRIVER_CALL_TIMEOUT_MS,
  nowFn = Date.now,
} = {}) {
  let sdkPromise = null;
  let driverPromise = null;

  async function sdk() {
    sdkPromise ??= Promise.resolve().then(() => loadSdk());
    return sdkPromise;
  }

  async function driver(signal) {
    if (!driverPromise) {
      driverPromise = Promise.resolve()
        .then(async () => (createDriver ? createDriver(signal) : (await sdk()).CuaDriver.create(undefined)))
        .catch((e) => { driverPromise = null; throw e; });
    }
    return driverPromise;
  }

  async function call(name, invoke, { signal } = {}) {
    if (signal?.aborted) {
      reportTiming(name, nowFn(), false);
      throw new Error('操作已被中断，未执行后续动作');
    }
    const startedAt = nowFn();
    try {
      const d = await driver(signal);
      // SDK 的 asyncOpts 是 ?.signal.aborted 直读：无 signal 时必须传 undefined，
      // 传 {} 或 {signal: undefined} 都会 TypeError（ubjs core async-rust-call）。
      const opts = signal ? { signal } : undefined;
      const out = await withTimeout(Promise.resolve(invoke(d, opts)), timeoutMs, name);
      reportTiming(name, startedAt, true);
      return out;
    } catch (e) {
      reportTiming(name, startedAt, false);
      if (e?.name === 'AbortError' || signal?.aborted) throw new Error('操作已被中断，未执行后续动作');
      throw translateDriverError(e);
    }
  }

  return {
    /** 应用退出时收尾：shutdown（幂等）+ uniffiDestroy（释放原生句柄）。 */
    async dispose() {
      const p = driverPromise;
      driverPromise = null;
      if (!p) return;
      try {
        const d = await p;
        await d.shutdown?.();
        d.uniffiDestroy?.();
      } catch { /* 尽力而为 */ }
    },

    /** ui_list / 对话侧窗口上下文：按 pid 聚合的可见应用清单（兼容旧输出形状）。 */
    async listAppWindows({ signal } = {}) {
      return call('list_apps+windows', async (d, opts) => {
        const s = await sdk();
        const [apps, wins] = await Promise.all([
          d.listApps(s.ListAppsInput.create({}), opts),
          d.listWindows(s.ListWindowsInput.create({ onScreenOnly: true }), opts),
        ]);
        const byPid = new Map(apps.apps.filter((a) => a.running).map((a) => [a.pid, a]));
        const grouped = new Map();
        for (const w of wins.windows) {
          if (w.pid == null) continue;
          if (!grouped.has(w.pid)) grouped.set(w.pid, []);
          grouped.get(w.pid).push(w);
        }
        return [...grouped.entries()].map(([pid, ws]) => {
          const app = byPid.get(pid);
          return {
            pid,
            name: app?.name ?? ws[0]?.appName ?? `pid ${pid}`,
            bundleId: app?.bundleId ?? '',
            frontmost: Boolean(app?.active),
            windows: ws.map((w) => ({
              windowId: w.windowId.toString(),
              title: w.title ?? '',
              x: w.bounds?.x, y: w.bounds?.y, w: w.bounds?.width, h: w.bounds?.height,
            })),
          };
        });
      }, { signal });
    },

    /** screen_view 有 target 时：窗口级截图（includeTree 供 ui_tree 复用）。 */
    async windowState({ pid, windowId, includeTree = false, includeScreenshot = true, query, timeoutMs: axTimeout, signal }) {
      return call('get_window_state', async (d, opts) => {
        const s = await sdk();
        return d.getWindowState(s.GetWindowStateInput.create({
          pid: Number(pid),
          windowId: BigInt(windowId),
          includeAccessibilityTree: includeTree,
          includeScreenshot,
          ...(query ? { query } : {}),
          maxImageDimension: CAPTURE_LONG_EDGE,
          ...(axTimeout ? { timeoutMs: axTimeout } : {}),
        }), opts);
      }, { signal });
    },

    /** screen_view 无 target / 对话侧「看屏幕回答」：桌面级截图。 */
    async desktopState({ signal } = {}) {
      return call('get_desktop_state', async (d, opts) => {
        const s = await sdk();
        return d.getDesktopState(s.GetDesktopStateInput.create({ maxImageDimension: CAPTURE_LONG_EDGE }), opts);
      }, { signal });
    },

    async click({ pid, windowId, x, y, elementToken, delivery = 'background', signal }) {
      return call('click', async (d, opts) => {
        const s = await sdk();
        const target = new s.ActionTarget.Window({ pid: Number(pid), windowId: BigInt(windowId) });
        const position = elementToken
          ? new s.ClickPosition.Element({ elementToken })
          : new s.ClickPosition.Coordinates({ x: Math.round(Number(x)), y: Math.round(Number(y)) });
        return d.click(s.ClickInput.create({
          target,
          position,
          deliveryMode: delivery === 'foreground' ? s.InputDeliveryMode.Foreground : s.InputDeliveryMode.Background,
        }), opts);
      }, { signal });
    },

    async typeText({ text, pid, windowId, signal }) {
      return call('type_text', async (d, opts) => {
        const s = await sdk();
        const input = { text: String(text ?? '') };
        if (pid != null && windowId != null) input.target = new s.ActionTarget.Window({ pid: Number(pid), windowId: BigInt(windowId) });
        return d.typeText(s.TypeTextInput.create(input), opts);
      }, { signal });
    },

    /** AX 设值（typed 面没有 set_value，经 callTool 走 MCP wire；wire 形状为
     *  顶层 pid/window_id + element_token——真机验收 2026-10-02 逐项核实）。 */
    async setValue({ elementToken, value, pid, windowId, signal }) {
      return call('set_value', async (d, opts) => d.callTool('set_value', JSON.stringify({
        element_token: elementToken,
        value: String(value ?? ''),
        pid: Number(pid),
        window_id: String(windowId),
      }), opts), { signal });
    },

    async key({ combo, pid, windowId, signal }) {
      const keys = parseCombo(combo);
      return call(keys.length > 1 ? 'hotkey' : 'press_key', async (d, opts) => {
        const s = await sdk();
        const input = keys.length > 1 ? { keys } : { key: keys[0] };
        if (pid != null && windowId != null) input.target = new s.ActionTarget.Window({ pid: Number(pid), windowId: BigInt(windowId) });
        return keys.length > 1 ? d.hotkey(s.HotkeyInput.create(input), opts) : d.pressKey(s.PressKeyInput.create(input), opts);
      }, { signal });
    },

    /**
     * 滚动：typed 调用默认后台（不动真实指针）；后台不可用（Electron/Chromium
     * 目标已知）时经 callTool 以 delivery_mode=foreground 重试一次——旧实现本
     * 就是前台档，不构成新的权限面。升级以 hemiEscalatedForeground 标记。
     * 拒出的两条通道都要检：typed 面以 ToolResult(isError+errorCode) 返回，
     * 异常通道兜底（真机验收 2026-10-02：ZCode 窗口走的是结果通道）。
     * 前台像素动作要求会话先有带截图的快照——缺了就补拍一次再试。
     */
    async scroll({ deltaY, x, y, pid, windowId, signal }) {
      const { direction, amount } = deltaYToScroll(deltaY);
      const wire = {
        x: x == null ? 100 : Math.round(Number(x)),
        y: y == null ? 100 : Math.round(Number(y)),
        direction,
        by: 'line',
        amount,
        delivery_mode: 'foreground',
        ...(pid != null && windowId != null
          ? { target: { kind: 'window', pid: Number(pid), window_id: Number(windowId) } }
          : {}),
      };
      const runBackground = () => call('scroll', async (d, opts) => {
        const s = await sdk();
        const input = {
          x: wire.x, y: wire.y,
          direction: s.ScrollDirection[direction === 'up' ? 'Up' : 'Down'],
          by: s.ScrollBy.Line,
          amount: BigInt(amount),
        };
        if (pid != null && windowId != null) {
          input.target = new s.ActionTarget.Window({ pid: Number(pid), windowId: BigInt(windowId) });
        }
        return d.scroll(s.ScrollInput.create(input), opts);
      }, { signal });
      const isBgUnavailable = (e) => {
        const info = driverErrorInfo(e) ?? {};
        return /background|route|delivery/i.test(
          `${info.errorCode ?? ''} ${info.message ?? ''} ${e.message ?? ''} ${e?.text ?? ''}`,
        );
      };
      let bg;
      try {
        bg = await runBackground();
        if (!(bg?.isError && isBgUnavailable(bg))) return bg;
      } catch (e) {
        if (!isBgUnavailable(e)) throw e;
      }
      const runForeground = () => call('scroll_foreground', async (d, opts) => d.callTool('scroll', JSON.stringify(wire), opts), { signal });
      let fg;
      try {
        fg = await runForeground();
      } catch (e) {
        if (!/snapshot|pixels/i.test(String(e?.message ?? ''))) throw e;
        fg = null;
      }
      // callTool 的错误也走结果通道（isError+text），两条通道都要检快照缺失：
      // 前台像素需要会话自有的截图快照，缺了补拍一次再试（真实流程里
      // screen_view 已提供，这条只在模型跳过看屏时兜底）。
      if (!fg || (fg.isError && /snapshot|pixels/i.test(`${fg.errorCode ?? ''} ${fg.text ?? ''}`))) {
        await this.windowState({ pid, windowId, includeScreenshot: true, signal });
        fg = await runForeground();
      }
      return { ...fg, hemiEscalatedForeground: true };
    },
  };
}

/** 生产单例（主进程一份；测试勿用，自建 createCuaBridge 注入假模块/假驱动）。 */
export const cua = createCuaBridge();

/** 供 Electron 主进程退出钩子调用；无实例时为 no-op。 */
export function disposeCuaDriver() {
  return cua.dispose();
}

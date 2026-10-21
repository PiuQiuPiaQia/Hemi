// Hemi 浏览器控制 · Chrome MV3 service worker
//
// 职责（014 D-1/D-2/D-3）：
//  1. 主动外连 Pi 进程里的本地桥（ws://127.0.0.1:9467-9470，带重连退避）；
//  2. 执行桥命令：在「任务专用后台窗口」（focused:false / active:false）里
//     打开网页、按 CSS 选择器点击、键入、提取正文、截图；
//  3. 归属记账：只操作自己建的任务窗口，用户标签页不可见不可碰；
//  4. 清理：桥断开（Pi 进程结束）＝任务结束，关闭任务窗口；新 hello 时先
//     清理上一次会话遗留的孤儿窗口（SW 重启兜底）。
//
// 页面操作全部走 chrome.debugger（CDP）：Input.dispatchMouseEvent / insertText /
// Runtime.evaluate。真实事件路径让页面正常响应（悬停、焦点、受控组件都认）。
// 附着调试器期间 Chrome 顶部会出现系统提示条——平台强制的知情提示，如实展示。
//
// 021（R-06/07/11）：快照与引用动作改在【隔离世界】执行——元素引用表对页面
// 主世界脚本不可见不可写，网页替换 window 变量不再能劫持执行目标；页面侧
// 逻辑源在 page-logic.js（Node 单测与生产同源），经 importScripts 载入。

importScripts('page-logic.js', 'page-operations.js');
const PAGE_LOGIC = globalThis.HEMI_PAGE_LOGIC;

// 约定（021 用户裁决）：扩展文件每次改动必须升 manifest.json 的 version——
// 版本经 hello 上报到桥与设置页（BrowserBridgeStatus.extVersion），并在这里
// 随处可查，杜绝「分不清跑的是新扩展还是旧扩展」。
const EXT_VERSION = chrome.runtime.getManifest().version;

const BRIDGE_PORTS = [9467, 9468, 9469, 9470];
const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 250;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 10000;
const HEARTBEAT_MS = 25000;

let ws = null;
let wsReady = false;
let reconnectTimer = null;
let heartbeatTimer = null;
let portIndex = 0;
let attempts = 0;

/** 任务窗口记账（SW 可能被回收，存 session storage）：
 *  windowId 持久复用（用户裁决 2026-09-20：不每次新开窗口），taskTabIds 是
 *  当前任务的标签页集合，任务结束即清；marker 标签页（hemi-task.html）不在
 *  集合里，是窗口的常驻身份牌。 */
/** 任务窗口记账（023 R-15 按任务记账）：taskId -> { windowId, tabId, taskTabIds }。
 *  并行任务各自一个窗口，命令信封带 taskId，互不串台。SW 可能被回收，存
 *  session storage；windowId 持久复用（2026-09-20 裁决），taskTabIds 是该任务
 *  的标签页集合，任务结束即清；marker 标签页（hemi-task.html）不在集合里，
 *  是窗口的常驻身份牌。 */
const agents = new Map();
const DEFAULT_TASK = 'default';
const attachedTabs = new Set();

function blankAgent() {
  return { windowId: null, tabId: null, taskTabIds: [] };
}

/** 命令归属解析：桥的 cmd 信封带 taskId；无 taskId（异常/旧桥）落 default。 */
function getTask(taskId) {
  const key = String(taskId || DEFAULT_TASK);
  if (!agents.has(key)) agents.set(key, blankAgent());
  const rec = agents.get(key);
  rec.__taskId = key; // serialized 按任务分桶用（不落盘的运行时标记）
  return rec;
}

// 021：每标签页的在飞请求数（Network 域事件计数）。DONE 核验用它等"网络安静"
// ——SPA 点完筛选后结果要几秒才到，固定延时只会拍到空骨架。计数允许误差
// （重定向/缓存会轻微失衡），Math.max(0) 防负数，静默判定只看"是否为 0"。
const netInflight = new Map(); // tabId -> count

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source?.tabId;
  if (!tabId || !String(method).startsWith('Network.')) return;
  if (method === 'Network.requestWillBeSent') {
    netInflight.set(tabId, (netInflight.get(tabId) || 0) + 1);
  } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
    netInflight.set(tabId, Math.max(0, (netInflight.get(tabId) || 0) - 1));
  }
});

// 021 R-06：每标签页的隔离世界执行上下文（引用表住在这里）。导航/关闭即失效，
// 下次使用前健康检查不通过就重建——引用随文档销毁是语义的一部分，不是故障。
const worlds = new Map(); // tabId -> executionContextId
// 021 R-09：refAct 回执按 dispatchId 留存（生命周期内有界），重复派发直接回
// 上一次回执——不重复执行副作用（跨进程「恰好一次」仍不保证，丢失按未知处理）。
// 021 R-06：同一任务标签页的观察/动作严格串行，检查与真实事件之间不留并发缝。
// 023 R-15：队列按任务分桶——并行任务各自的观察/动作互不阻塞。
const opQueues = new Map(); // taskId -> Promise
function serialized(task, fn) {
  const key = task ? String(task.__taskId ?? '') : '';
  const queue = opQueues.get(key) ?? Promise.resolve();
  const run = queue.then(fn, fn);
  opQueues.set(key, run.catch(() => {}));
  return run;
}

// ---------- 小工具 ----------

function sendToBridge(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function reply(id, data) {
  sendToBridge({ type: 'result', id, ok: true, data });
}

function replyError(id, error) {
  sendToBridge({ type: 'result', id, ok: false, error: String((error && error.message) || error) });
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveAgents() {
  const plain = {};
  for (const [id, rec] of agents) {
    const { __taskId, ...rest } = rec;
    plain[id] = rest;
  }
  await chrome.storage.session.set({ hemiAgents: plain });
}

/** 空闲任务窗口池（0.3.1）：任务结束窗口还池、新任务优先领用、全忙才开新窗。
 *  修复「每任务净增一个窗口、越开越多」（2026-09-24 用户实录：连发多个任务
 *  后 Hemi 任务窗口线性堆积）。并行任务仍各占一窗互不串台；池有上限，富余
 *  窗口在还池时自愈关闭（顺带清掉历史堆积）。 */
const FREE_WINDOW_CAP = 2;
let freeWindows = [];

async function persistFreeWindows() {
  await chrome.storage.session.set({ hemiFreeWindows: freeWindows });
}

/** 窗口还池；超上限的富余直接关掉。窗口已没了就当它从未存在。 */
async function releaseWindowToPool(windowId) {
  if (!Number.isInteger(windowId)) return;
  try {
    await chrome.windows.get(windowId);
  } catch {
    return;
  }
  freeWindows.push(windowId);
  while (freeWindows.length > FREE_WINDOW_CAP) {
    const extra = freeWindows.shift();
    try {
      await chrome.windows.remove(extra);
    } catch {
      /* 已没了 */
    }
  }
  await persistFreeWindows();
}

/** 从池里领一个活窗口：校验存在、marker 身份牌丢了就补一块；领不到返回 null。 */
async function claimPooledWindow() {
  while (freeWindows.length) {
    const wid = freeWindows.shift();
    try {
      await chrome.windows.get(wid);
      const tabs = await chrome.tabs.query({ windowId: wid });
      const hasMarker = tabs.some((t) => (t.url || '').startsWith(chrome.runtime.getURL('')));
      if (!hasMarker) {
        await chrome.tabs.create({ windowId: wid, url: chrome.runtime.getURL('hemi-task.html') });
      }
      await persistFreeWindows();
      return wid;
    } catch {
      /* 窗口已被关，试下一个 */
    }
  }
  await persistFreeWindows();
  return null;
}

async function loadAgents() {
  try {
    const stored = await chrome.storage.session.get('hemiAgents');
    if (stored && stored.hemiAgents) {
      for (const [id, rec] of Object.entries(stored.hemiAgents)) {
        agents.set(id, { taskTabIds: [], ...rec });
      }
    }
  } catch {
    /* 首次没有 */
  }
  try {
    const pool = await chrome.storage.session.get('hemiFreeWindows');
    freeWindows = Array.isArray(pool?.hemiFreeWindows)
      ? pool.hemiFreeWindows.filter((n) => Number.isInteger(n))
      : [];
  } catch {
    freeWindows = [];
  }
}

/** 任务窗口复用入口（按任务）：活着就用；没了先领空闲池里的，池也空才新建。
 *  窗口身份牌＝marker 标签页。 */
async function ensureWindow(task, defaults = {}) {
  if (task.windowId) {
    try {
      await chrome.windows.get(task.windowId);
      return;
    } catch {
      task.windowId = null;
      task.tabId = null;
      task.taskTabIds = [];
    }
  }
  const pooled = await claimPooledWindow();
  if (pooled != null) {
    task.windowId = pooled;
    task.tabId = null;
    task.taskTabIds = [];
    await saveAgents();
    return;
  }
  const win = await chrome.windows.create({
    url: chrome.runtime.getURL('hemi-task.html'),
    focused: false, // D-2：后台创建，绝不抢前台
    left: Number.isFinite(defaults.left) ? defaults.left : undefined,
    top: Number.isFinite(defaults.top) ? defaults.top : undefined,
    width: Number.isFinite(defaults.width) ? defaults.width : undefined,
    height: Number.isFinite(defaults.height) ? defaults.height : undefined,
  });
  task.windowId = win.id;
  task.tabId = null;
  task.taskTabIds = [];
  await saveAgents();
}

/** 清某个任务的标签页，保留窗口与身份牌（R-10：窗口常驻、页面不残留）；
 *  023 R-15 起只清该任务的，其他任务的窗口不受影响。 */
async function cleanupTaskTabs(task) {
  const ids = task.taskTabIds ?? [];
  task.tabId = null;
  task.taskTabIds = [];
  await saveAgents();
  for (const tabId of ids) {
    try {
      await chrome.tabs.remove(tabId);
    } catch {
      /* 已没了 */
    }
  }
  // 活动标签回到身份牌。
  if (task.windowId) {
    try {
      const tabs = await chrome.tabs.query({ windowId: task.windowId });
      const marker = tabs.find((tab) => (tab.url || '').startsWith(chrome.runtime.getURL('')));
      if (marker) await chrome.tabs.update(marker.id, { active: true });
    } catch {
      /* 窗口可能已被手关 */
    }
  }
}

// ---------- 调试器（CDP）封装 ----------

function debugTarget(tabId) {
  return { tabId };
}

async function attach(tabId) {
  if (attachedTabs.has(tabId)) return;
  await chrome.debugger.attach(debugTarget(tabId), '1.3');
  await chrome.debugger.sendCommand(debugTarget(tabId), 'Page.enable');
  // 021：DONE 核验要等网络安静——不打开 Network 域就没有请求事件可数。
  try {
    await chrome.debugger.sendCommand(debugTarget(tabId), 'Network.enable', {});
  } catch {
    /* 老内核不支持时静默降级：netQuiet 立即返回 quiet */
  }
  attachedTabs.add(tabId);
}

async function cdp(tabId, method, params = {}) {
  await attach(tabId);
  return chrome.debugger.sendCommand(debugTarget(tabId), method, params);
}

function detachAll() {
  worlds.clear(); // 会话结束＝隔离世界引用全部作废
  netInflight.clear();
  for (const tabId of [...attachedTabs]) {
    attachedTabs.delete(tabId);
    try {
      chrome.debugger.detach(debugTarget(tabId));
    } catch {
      /* 目标已没了 */
    }
  }
}

chrome.debugger.onDetach.addListener((source) => {
  if (source?.tabId) {
    attachedTabs.delete(source.tabId);
    worlds.delete(source.tabId);
    netInflight.delete(source.tabId);
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  worlds.delete(tabId);
  netInflight.delete(tabId);
  // 任务当前标签页被用户手动关闭：该任务记账清空，后续命令报「没有页面」。
  for (const rec of agents.values()) {
    if (rec.tabId === tabId) {
      rec.tabId = null;
      void saveAgents();
      break;
    }
  }
});

// 导航即撤销隔离世界（引用随文档销毁）：开始加载就失效，下次使用前重建。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') worlds.delete(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const [id, rec] of agents) {
    if (rec.windowId === windowId) {
      agents.set(id, blankAgent());
      void saveAgents();
      break;
    }
  }
});

const { opExtract, opClick, opType, opSnapshot, opRefAct } = globalThis.HEMI_CREATE_PAGE_OPERATIONS({
  requireActiveTab, evaluate, evaluateIn, cdp, delay, ensureWorld,
  pageLogic: PAGE_LOGIC, serialized,
});

// ---------- 页面操作原语 ----------

function requireActiveTab(task) {
  if (!task.windowId || !task.tabId) {
    throw new Error('任务还没有打开任何页面：先调用 browser_navigate');
  }
  return task.tabId;
}

async function waitReady(tabId) {
  const started = Date.now();
  for (;;) {
    if (Date.now() - started > READY_TIMEOUT_MS) {
      throw new Error('页面加载超时（20s）——网址可能不可达，换个地址或稍后再试');
    }
    // 真机实录（021 验证）：新建标签页的 about:blank readyState 也是 complete，
    // 会在真实导航提交前放行——navigate 返回空标题、首张快照拍到空白页。
    // 只认非 about 页面的 complete（入口已限 http/https，不存在合法 about 目标）。
    const state = await cdp(tabId, 'Runtime.evaluate', {
      expression: 'document.readyState + "|" + location.href',
      returnByValue: true,
    });
    const [ready, href = ''] = String(state?.result?.value ?? '|').split('|');
    if (ready === 'complete' && href && !href.startsWith('about:')) {
      await delay(200); // 渲染喘口气
      return;
    }
    await delay(READY_POLL_MS);
  }
}

async function evaluate(tabId, expression, argList = []) {
  // 参数以 JSON 字面量内联（页面上下文里没有任何占位符可解析）；
  // JSON 字符串是合法 JS 表达式（ES2019 起 U+2028/2029 亦合法）。
  const argsJson = JSON.stringify(argList);
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(${expression})(...${argsJson})`,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result?.exceptionDetails) {
    const text = result.exceptionDetails?.exception?.description || '页面脚本执行失败';
    throw new Error(text.split('\n')[0].slice(0, 160));
  }
  return result?.result?.value;
}

/** 指定执行上下文求值（021：隔离世界里的快照/引用脚本都走这里）。 */
async function evaluateIn(tabId, contextId, expression, argList = []) {
  const argsJson = JSON.stringify(argList);
  const result = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(${expression})(...${argsJson})`,
    contextId,
    returnByValue: true,
    awaitPromise: false,
  });
  if (result?.exceptionDetails) {
    const text = result.exceptionDetails?.exception?.description || '页面脚本执行失败';
    throw new Error(text.split('\n')[0].slice(0, 160));
  }
  return result?.result?.value;
}

/** 隔离世界就绪：健康检查失败（导航/上下文销毁）即重建。 */
async function ensureWorld(tabId) {
  const known = worlds.get(tabId);
  if (known != null) {
    try {
      await cdp(tabId, 'Runtime.evaluate', { expression: '1+1', contextId: known, returnByValue: true });
      return known;
    } catch {
      worlds.delete(tabId);
    }
  }
  let frameId = null;
  try {
    const tree = await cdp(tabId, 'Page.getFrameTree', {});
    frameId = tree?.frameTree?.frame?.id ?? null;
  } catch {
    /* 页面可能正在跳转 */
  }
  if (!frameId) throw new Error('无法定位页面主框架（页面可能正在跳转），请重试');
  let world = null;
  try {
    world = await cdp(tabId, 'Page.createIsolatedWorld', { frameId, worldName: 'hemi-isolated-refs' });
  } catch {
    throw new Error('当前 Chrome 不支持隔离执行上下文（Page.createIsolatedWorld）：请更新 Chrome 后重试');
  }
  const contextId = world?.executionContextId ?? null;
  if (!contextId) throw new Error('隔离执行上下文创建失败：请更新 Hemi 浏览器扩展后重试');
  worlds.set(tabId, contextId);
  return contextId;
}

async function opNavigate(params, task) {
  let url = String(params.url || '');
  if (!/^https?:\/\//i.test(url)) throw new Error('只支持 http/https 网址');
  await ensureWindow(task, params.defaults || {});
  if (params.newTab || !task.tabId) {
    const tab = await chrome.tabs.create({ windowId: task.windowId, url, active: false });
    task.tabId = tab.id;
    task.taskTabIds = [...(task.taskTabIds ?? []), tab.id];
    await saveAgents();
  } else {
    await chrome.tabs.update(task.tabId, { url });
  }
  await waitReady(task.tabId);
  const tab = await chrome.tabs.get(task.tabId);
  return {
    title: tab.title || '',
    url: tab.url || url,
    session: { windowId: task.windowId, tabId: task.tabId },
  };
}

async function opList(params, task) {
  if (!task.windowId) return { tabs: [], session: null };
  const tabs = await chrome.tabs.query({ windowId: task.windowId });
  return {
    tabs: tabs.map((tab, index) => ({
      index,
      title: tab.title || '',
      url: tab.url || '',
      active: tab.id === task.tabId,
    })),
    session: { windowId: task.windowId, tabId: task.tabId },
  };
}

async function opScreenshot(params, task) {
  const tabId = requireActiveTab(task);
  // 最小化/被完全遮挡的窗口不渲染帧，captureScreenshot 会一直等不到画面。
  // 恢复成可见但不聚焦（focused:false 不抢前台，014 D-2 语义内）。
  if (task.windowId) {
    try {
      const win = await chrome.windows.get(task.windowId);
      if (win.state === 'minimized') {
        await chrome.windows.update(task.windowId, { focused: false, state: 'normal' });
        await delay(250);
      }
    } catch {
      /* 窗口没了就按原路径走，超时兜底 */
    }
  }
  // fromSurface:false = 从渲染器取帧：任务窗口在后台/被遮挡时浏览器合成器
  // 不出帧，表面截图会饿死（020 真机实录：15s 超时连发）。渲染器直取不依赖
  // 窗口可见性。014 截图语义不变：仍是任务标签页的画面。
  const shot = await cdp(tabId, 'Page.captureScreenshot', {
    format: 'jpeg', quality: 80, fromSurface: false,
  });
  let width = null;
  let height = null;
  try {
    const metrics = await cdp(tabId, 'Page.getLayoutMetrics');
    const css = metrics?.cssContentSize || metrics?.contentSize || {};
    width = Math.round(css.width ?? 0) || null;
    height = Math.round(css.height ?? 0) || null;
  } catch {
    /* 尺寸拿不到不致命 */
  }
  return { data: shot?.data || '', width, height };
}

// ---------- 020/021 · Jev 步进原语（快照 + 按下标执行） ----------
//
// browser_act 的页面半边：tab.snapshot 产出编号元素表并把节点引用留在【隔离
// 世界】（页面主世界脚本不可写，021 R-06）；tab.refAct 按下标解析回真实节点
// 执行。模型只给「动作名 + 下标」，永远给不出选择器/坐标/JS——引用必须来自
// 我们自己观察过的快照。观察与动作严格串行；重复 dispatchId 直接回上一次
// 回执，不重复执行副作用（R-09）。

/**
 * 021 R-08：等网络安静（在飞请求归零并持续 quietMs）。DONE 核验前调用——
 * SPA 点完筛选后结果要几秒才到，不等就拍快照会把"空骨架"当结果。
 * 只读操作；超上限返回 quiet:false（长轮询页面不能无限等），调用方照常
 * 走快照稳定性 + noul 判据兜底。
 */
async function opNetQuiet(params, task) {
  const tabId = requireActiveTab(task);
  const quietMs = Math.max(100, Math.min(Number(params.quietMs) || 600, 3000));
  const maxMs = Math.max(quietMs, Math.min(Number(params.maxMs) || 6000, 15000));
  const started = Date.now();
  let quietSince = null;
  for (;;) {
    if ((netInflight.get(tabId) || 0) === 0) {
      if (quietSince === null) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) {
        return { quiet: true, waitedMs: Date.now() - started };
      }
    } else {
      quietSince = null;
    }
    if (Date.now() - started >= maxMs) {
      return { quiet: false, waitedMs: Date.now() - started };
    }
    await delay(150);
  }
}

/** 只拆【本任务】标签页的调试器目标（023 R-15：session.end 不得波及并行任务）。 */
function detachTask(task) {
  const ids = [...(task.taskTabIds ?? []), task.tabId].filter(Boolean);
  for (const tabId of ids) {
    if (!attachedTabs.has(tabId)) continue;
    attachedTabs.delete(tabId);
    worlds.delete(tabId);
    netInflight.delete(tabId);
    try {
      chrome.debugger.detach(debugTarget(tabId));
    } catch {
      /* 目标已没了 */
    }
  }
}

async function opSessionEnd(params, task) {
  // 0.3.1：清掉本任务标签页与调试器目标后，窗口还回空闲池（下一个任务领用），
  // 并删除该任务的记账——修复每任务净增一个窗口的堆积。R-15：不波及其他任务。
  detachTask(task);
  await cleanupTaskTabs(task);
  const windowId = task.windowId;
  if (agents.has(task.__taskId)) {
    agents.delete(task.__taskId);
    await saveAgents();
  }
  await releaseWindowToPool(windowId);
  return {};
}

/** 桥断开/重连时的残留清理：清【所有】任务的标签页，窗口统一还池
 *  （0.3.1：池有上限，历史堆积在还池时自愈关闭）。 */
async function cleanupAllOrphans() {
  await loadAgents();
  detachAll();
  const released = [...agents.values()].map((rec) => rec.windowId).filter(Boolean);
  agents.clear();
  await saveAgents();
  for (const rec of released) {
    await cleanupTaskTabsById(rec);
  }
  for (const wid of released) {
    await releaseWindowToPool(wid);
  }
}

/** 按 windowId 清残留标签（记账已删时 cleanupTaskTabs 拿不到 task 对象）。 */
async function cleanupTaskTabsById(windowId) {
  if (!Number.isInteger(windowId)) return;
  try {
    const tabs = await chrome.tabs.query({ windowId });
    for (const tab of tabs) {
      if ((tab.url || '').startsWith(chrome.runtime.getURL(''))) continue; // marker 留着
      try {
        await chrome.tabs.remove(tab.id);
      } catch {
        /* 已没了 */
      }
    }
  } catch {
    /* 窗口已没了 */
  }
}

// ---------- 命令分发 ----------

const OPS = {
  'session.navigate': opNavigate,
  'session.end': opSessionEnd,
  'tab.extract': opExtract,
  'tab.click': opClick,
  'tab.type': opType,
  'tab.list': opList,
  'tab.screenshot': opScreenshot,
  'tab.snapshot': opSnapshot,
  'tab.refAct': opRefAct,
  'tab.netQuiet': opNetQuiet,
  // 版本探针：不改页面状态，任何一侧随时可问「跑的是哪个版本」。
  'ext.version': () => ({ version: EXT_VERSION, snapshotProtocol: 2 }),
};

async function handleCommand(message) {
  const handler = OPS[message.op];
  if (!handler) {
    replyError(message.id, `未知操作：${message.op}`);
    return;
  }
  // 023 R-15：cmd 信封带 taskId，命令只作用于该任务自己的窗口（按任务记账）。
  const task = getTask(message.taskId);
  try {
    reply(message.id, await handler(message.params || {}, task));
  } catch (error) {
    replyError(message.id, error);
  }
}

// ---------- 桥连接（外连 + 重连退避） ----------

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const waitMs = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(attempts, 4), RECONNECT_MAX_MS);
  attempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, waitMs);
}

function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const port = BRIDGE_PORTS[portIndex % BRIDGE_PORTS.length];
  portIndex += 1;
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.addEventListener('open', () => {
    attempts = 0;
    socket.send(JSON.stringify({ type: 'hello', version: 1, ext: 'chrome-extension', extVersion: EXT_VERSION, multiTask: true }));
  });
  socket.addEventListener('message', (event) => {
    let message = null;
    try {
      message = JSON.parse(String(event.data));
    } catch {
      return;
    }
    if (message.type === 'hello-ok') {
      wsReady = true;
      void cleanupAllOrphans().then(() => {
        sendToBridge({ type: 'log', text: '桥已就绪，任务窗口待命' });
      });
      stopHeartbeat();
      heartbeatTimer = setInterval(() => sendToBridge({ type: 'ping' }), HEARTBEAT_MS);
    } else if (message.type === 'cmd') {
      void handleCommand(message);
    } else if (message.type === 'pong') {
      /* 心跳应答，无需处理 */
    }
  });
  socket.addEventListener('close', () => {
    if (ws !== socket) return;
    ws = null;
    wsReady = false;
    stopHeartbeat();
    // 桥断开＝应用退出或桥重启：清所有任务的标签页；窗口常驻复用（R-10 用户迭代）。
    void (async () => {
      await cleanupAllOrphans();
    })();
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    // close 会跟在 error 后面，统一在 close 里重连。
  });
}

// SW 休眠兜底：MV3 会在空闲 ~30s 后杀掉 SW，重连计时器随之消失。alarms 每
// 30s 唤醒一次，醒来若未连接就拨号（任务等待上限由此决定，约 30s 一次机会）。
// create 同名幂等；SW 每次醒来都会重申一遍。
const CONNECT_ALARM = 'hemi-connect';
try {
  chrome.alarms.create(CONNECT_ALARM, { periodInMinutes: 0.5 });
} catch {
  /* 某些旧版本最低 1 分钟 */
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== CONNECT_ALARM) return;
  if (!ws || ws.readyState >= WebSocket.CLOSING) connect();
});

void loadAgents().then(connect);

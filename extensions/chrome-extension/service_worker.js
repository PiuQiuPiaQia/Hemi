// Hemi 浏览器控制 · Chrome MV3 service worker
//
// 职责（014 D-1/D-2/D-3）：
//  1. 主动外连 Pi 进程里的本地桥（ws://127.0.0.1:9467-9470，带重连退避）；
//  2. 执行桥命令：在「任务专用后台窗口」（focused:false）里
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

importScripts('page-logic.js', 'page-operations.js', 'page-cursor.js');
const PAGE_LOGIC = globalThis.HEMI_PAGE_LOGIC;

// 约定（021 用户裁决）：扩展文件每次改动必须升 manifest.json 的 version——
// 版本经 hello 上报到桥与设置页（BrowserBridgeStatus.extVersion），并在这里
// 随处可查，杜绝「分不清跑的是新扩展还是旧扩展」。
const EXT_VERSION = chrome.runtime.getManifest().version;

const BRIDGE_PORTS = [9467, 9468, 9469, 9470];
const READY_TIMEOUT_MS = 20000;
const READY_POLL_MS = 250;
const RECONNECT_BASE_MS = 1000;
// 新启动的 Dev/安装版桥要在工具的短握手等待内接入，不能退避到十秒后。
const RECONNECT_MAX_MS = 1000;
const HEARTBEAT_MS = 25000;

let heartbeatTimer = null;
const bridges = new Map(BRIDGE_PORTS.map(port => [port, {
  port, socket: null, ready: false, timer: null, attempts: 0, cleanup: Promise.resolve(),
}]));
let startupCleanup = null;

/** 任务窗口记账（023 R-15 按任务记账）：taskId -> { windowId, tabId, taskTabIds }。
 *  并行任务各自一个窗口及标签组；任务结束连同占位页一起关闭。
 *  session storage 用于 SW 重启后回收遗留窗口和网页弹出的标签页。 */
const agents = new Map();
const DEFAULT_TASK = 'default';
const attachedTabs = new Set();

function blankAgent() {
  return { windowId: null, tabId: null, taskTabIds: [], groupId: null };
}

/** 命令归属解析：桥的 cmd 信封带 taskId；无 taskId（异常/旧桥）落 default。 */
function getTask(taskId, bridge = null) {
  const originalId = String(taskId || DEFAULT_TASK);
  const key = bridge ? `${bridge.port}/${originalId}` : originalId;
  if (!agents.has(key)) agents.set(key, blankAgent());
  const rec = agents.get(key);
  rec.__taskId = key; // serialized 按任务分桶用（不落盘的运行时标记）
  rec.taskId = originalId;
  if (bridge) rec.bridgePort = bridge.port;
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

function sendToBridge(payload, bridge = null) {
  for (const target of bridge ? [bridge] : bridges.values()) {
    if (target.socket?.readyState === WebSocket.OPEN) target.socket.send(JSON.stringify(payload));
  }
}

function reply(id, data, bridge) {
  sendToBridge({ type: 'result', id, ok: true, data }, bridge);
}

function replyError(id, error, bridge) {
  sendToBridge({ type: 'result', id, ok: false, error: String((error && error.message) || error) }, bridge);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveAgents() {
  const plain = {};
  for (const [id, rec] of agents) {
    const { __taskId, __ending, ...rest } = rec;
    plain[id] = rest;
  }
  await chrome.storage.session.set({ hemiAgents: plain });
}

// 只读取旧版空闲池，升级后清理；不再保留空闲窗口。
let freeWindows = [];
const groupQueues = new Map();
let orphanCleanup = Promise.resolve();

async function closeWindow(windowId) {
  if (!Number.isInteger(windowId)) return;
  try { await chrome.windows.get(windowId); } catch { return; }
  try { await chrome.windows.remove(windowId); }
  catch (error) {
    try { await chrome.windows.get(windowId); } catch { return; }
    throw error; // 活窗口关闭失败时保留记账，供下次回收重试。
  }
}

function isMarker(tab) {
  return (tab.pendingUrl || tab.url || '') === chrome.runtime.getURL('hemi-task.html');
}

function shortTaskTitle(value) {
  return [...String(value || '').replace(/\s+/g, ' ').trim()].slice(0, 24).join('');
}

/** 只分组本任务窗口内的内容页；串行处理 onCreated 与 navigate 的重复通知。 */
function groupTaskTabs(task) {
  const key = task.__taskId;
  const run = (groupQueues.get(key) ?? Promise.resolve()).then(async () => {
    if (!task.windowId || task.__ending) return;
    const tabs = (await chrome.tabs.query({ windowId: task.windowId })).filter(tab => !isMarker(tab));
    if (!tabs.length) return;
    const tabIds = tabs.map(tab => tab.id);
    task.taskTabIds = [...new Set([...task.taskTabIds, ...tabIds])];
    // 分组被用户解散/关空后自动重建；不移动其它窗口的标签。
    const existing = tabs.find(tab => tab.groupId === task.groupId && tab.groupId >= 0);
    task.groupId = await chrome.tabs.group({
      tabIds, ...(existing ? { groupId: task.groupId } : { createProperties: { windowId: task.windowId } }),
    });
    const colors = ['green', 'blue', 'purple', 'cyan', 'orange', 'pink'];
    const hash = [...key].reduce((value, char) => (value * 31 + char.charCodeAt(0)) >>> 0, 0);
    const current = tabs.find(tab => tab.id === task.tabId) || tabs[0];
    let site = '';
    try { site = new URL(current.url || current.pendingUrl).hostname; } catch { /* 页面可能尚未提交导航。 */ }
    const label = task.title || shortTaskTitle(current.title) || site || '网页任务';
    await chrome.tabGroups.update(task.groupId, {
      title: `Hemi · ${label}`.slice(0, 48), color: colors[hash % colors.length], collapsed: false,
    });
    await saveAgents();
  });
  groupQueues.set(key, run.catch(() => {}));
  return run;
}

async function closeEmptyTaskWindow(task) {
  if (!task.windowId || task.__ending) return;
  const tabs = await chrome.tabs.query({ windowId: task.windowId });
  if (tabs.every(isMarker)) await closeWindow(task.windowId);
}

async function loadAgents() {
  try {
    const stored = await chrome.storage.session.get('hemiAgents');
    if (stored && stored.hemiAgents) {
      for (const [id, rec] of Object.entries(stored.hemiAgents)) {
        agents.set(id, { ...blankAgent(), ...rec, __taskId: id });
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

/** 同一任务复用窗口；上一任务结束后，下次按需新建。 */
async function ensureWindow(task, defaults = {}) {
  if (task.windowId) {
    try {
      await chrome.windows.get(task.windowId);
      return;
    } catch {
      task.windowId = null;
      task.tabId = null;
      task.groupId = null;
    }
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
  task.groupId = null;
  await saveAgents();
}

/** 整窗关闭以捕获网页自行打开、未登记的标签；跨窗弹出页按 ID 单独回收。 */
async function cleanupTaskTabs(task) {
  const ids = [...(task.taskTabIds ?? [])];
  await closeWindow(task.windowId);
  for (const tabId of ids) {
    try { await chrome.tabs.get(tabId); } catch { continue; }
    try { await chrome.tabs.remove(tabId); }
    catch (error) {
      try { await chrome.tabs.get(tabId); } catch { continue; }
      throw error;
    }
  }
  task.windowId = null; task.tabId = null; task.taskTabIds = []; task.groupId = null;
  await saveAgents();
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
  if ((method === 'Input.dispatchMouseEvent' && params.type !== 'mouseReleased') || method === 'Input.insertText') {
    // 视觉反馈失败不改变真实动作回执；隔离世界 + closed shadow 不进入正文和引用表。
    try {
      const contextId = await ensureWorld(tabId);
      if (method === 'Input.dispatchMouseEvent') {
        // 保留页面 click 处理器；只接管尚未被取消的 _blank 默认导航。
        // Chrome 对真实点击的新标签会激活整个应用，必须改由 tabs.create(active:false) 打开。
        await evaluateIn(tabId, contextId, `() => {
          if (window.__hemiBackgroundLinks) return;
          window.__hemiBackgroundLinks = [];
          window.addEventListener('click', event => {
            if (!event.isTrusted || event.defaultPrevented || event.button !== 0) return;
            const anchor = event.composedPath().find(node => node?.tagName === 'A');
            if (!anchor || anchor.target.toLowerCase() !== '_blank' || anchor.hasAttribute('download')) return;
            if (!/^https?:$/.test(new URL(anchor.href).protocol)) return;
            event.preventDefault();
            window.__hemiBackgroundLinks.push(anchor.href);
          });
        }`, []);
      }
      await updateCursor(tabId, method === 'Input.insertText' ? { action: 'type' } : { x: params.x, y: params.y, action: params.type === 'mousePressed' ? 'click' : 'move' });
    } catch { /* 导航/受限页面上允许没有视觉反馈。 */ }
  }
  const result = await chrome.debugger.sendCommand(debugTarget(tabId), method, params);
  if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
    // 不能吞掉真实打开失败：点击回执必须反映新页是否成功创建。
    const contextId = worlds.get(tabId);
    if (contextId) {
      let urls = [];
      try { urls = await evaluateIn(tabId, contextId, '() => window.__hemiBackgroundLinks?.splice(0) || []', []); }
      catch { /* 点击可能已导航，旧上下文与待开页列表一起销毁。 */ }
      const task = [...agents.values()].find(task => task.taskTabIds.includes(tabId));
      if (task && !task.__ending) {
        for (const url of urls) {
          const tab = await chrome.tabs.create({ windowId: task.windowId, url, active: false, openerTabId: tabId });
          task.taskTabIds = [...new Set([...task.taskTabIds, tab.id])];
        }
        if (urls.length) await groupTaskTabs(task);
      }
    }
  }
  return result;
}

async function updateCursor(tabId, feedback = {}) {
  try {
    const tab = await chrome.tabs.get(tabId);
    // 只选择任务窗口内正在操作的页，不调用 windows.update/focus，浏览器仍留在后台。
    if (!tab.active) await chrome.tabs.update(tabId, { active: true });
    const contextId = await ensureWorld(tabId);
    const state = await evaluateIn(tabId, contextId, String(globalThis.HEMI_SHOW_CURSOR), [feedback]);
    if (!state?.visible) throw new Error('指针未显示');
    return state;
  } catch (error) {
    sendToBridge({ type: 'log', text: `虚拟鼠标显示失败：${String(error.message).slice(0, 160)}` });
    return null;
  }
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

chrome.tabs.onCreated.addListener((tab) => {
  if (isMarker(tab)) return;
  for (const task of agents.values()) {
    if (task.windowId !== tab.windowId && !task.taskTabIds.includes(tab.openerTabId)) continue;
    task.taskTabIds = [...new Set([...task.taskTabIds, tab.id])];
    void saveAgents();
    if (task.windowId === tab.windowId) {
      void groupTaskTabs(task).catch(() => {}); // 页面可能立即关闭；导航路径会再次确认分组。
    }
    break;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  attachedTabs.delete(tabId);
  worlds.delete(tabId);
  netInflight.delete(tabId);
  for (const rec of agents.values()) {
    if (rec.taskTabIds.includes(tabId)) {
      rec.taskTabIds = rec.taskTabIds.filter(id => id !== tabId);
      if (rec.tabId === tabId) rec.tabId = null;
      void saveAgents();
      // 手动关掉最后一个内容页后，身份牌也没有继续占窗的必要。
      void closeEmptyTaskWindow(rec).catch(() => {});
      break;
    }
  }
});

// 导航即撤销隔离世界（引用随文档销毁）：开始加载就失效，下次使用前重建。
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') worlds.delete(tabId);
});

chrome.windows.onRemoved.addListener((windowId) => {
  for (const rec of agents.values()) {
    if (rec.windowId === windowId) {
      rec.windowId = null; rec.tabId = null; rec.groupId = null;
      void saveAgents();
      break;
    }
  }
});

const { opExtract, opClick, opType, opSnapshot, opRefAct } = globalThis.HEMI_CREATE_PAGE_OPERATIONS({
  requireActiveTab, evaluate, evaluateIn, cdp, delay, ensureWorld,
  pageLogic: PAGE_LOGIC, serialized, showCursor: updateCursor,
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
  const title = shortTaskTitle(params.taskTitle);
  if (title) task.title = title;
  await ensureWindow(task, params.defaults || {});
  if (params.newTab || !task.tabId) {
    const tab = await chrome.tabs.create({ windowId: task.windowId, url, active: true });
    task.tabId = tab.id;
    task.taskTabIds = [...new Set([...(task.taskTabIds ?? []), tab.id])];
    await saveAgents();
  } else {
    await chrome.tabs.update(task.tabId, { url });
  }
  await waitReady(task.tabId);
  const tab = await chrome.tabs.get(task.tabId);
  await groupTaskTabs(task);
  await updateCursor(task.tabId, { action: 'navigate' });
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
  // 从目标页面的合成表面截图，不切换活动标签、不恢复最小化窗口。
  // 新版 Chrome 已拒绝 fromSurface:false（Only screenshots from surface are allowed）。
  const shot = await cdp(tabId, 'Page.captureScreenshot', {
    format: 'jpeg', quality: 80, fromSurface: true,
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
  task.__ending = true;
  try {
    await groupQueues.get(task.__taskId);
    detachTask(task);
    await cleanupTaskTabs(task);
    agents.delete(task.__taskId);
    groupQueues.delete(task.__taskId);
    opQueues.delete(task.__taskId);
    await saveAgents();
  } finally {
    task.__ending = false;
  }
  return {};
}

/** 断连/重启清理所有任务，并迁移旧版本的空闲窗口池。 */
async function cleanupAllOrphans() {
  await loadAgents();
  detachAll();
  for (const task of [...agents.values()]) await opSessionEnd({}, task);
  for (const wid of [...freeWindows]) {
    await closeWindow(wid);
    freeWindows = freeWindows.filter(id => id !== wid);
    await chrome.storage.session.set({ hemiFreeWindows: freeWindows });
  }
  // storage.session 在扩展更新后可能为空；只凭身份牌认领完全空闲的窗口。
  const markers = await chrome.tabs.query({ url: chrome.runtime.getURL('hemi-task.html') });
  for (const marker of markers) {
    const tabs = await chrome.tabs.query({ windowId: marker.windowId }).catch(() => []);
    if (tabs.length && tabs.every(isMarker)) await closeWindow(marker.windowId);
  }
}

function queueOrphanCleanup() {
  orphanCleanup = orphanCleanup.catch(() => {}).then(cleanupAllOrphans);
  void orphanCleanup.catch(error => {
    sendToBridge({ type: 'log', text: `浏览器遗留页面回收失败：${error.message}` });
  });
  return orphanCleanup;
}

async function cleanupBridgeTasks(port) {
  for (const task of [...agents.values()]) {
    if (task.bridgePort === port) await opSessionEnd({}, task);
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

async function handleCommand(message, bridge) {
  try { await orphanCleanup; await bridge?.cleanup; }
  catch (error) { replyError(message.id, error, bridge); return; }
  const handler = OPS[message.op];
  if (!handler) {
    replyError(message.id, `未知操作：${message.op}`, bridge);
    return;
  }
  // 023 R-15：cmd 信封带 taskId，命令只作用于该任务自己的窗口（按任务记账）。
  const task = getTask(message.taskId, bridge);
  task.label = String(message.taskLabel || '').slice(0, 40);
  try {
    reply(message.id, await handler(message.params || {}, task), bridge);
  } catch (error) {
    replyError(message.id, error, bridge);
  }
}

// ---------- 桥连接（外连 + 重连退避） ----------

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect(bridge) {
  if (bridge.timer) return;
  const waitMs = Math.min(RECONNECT_BASE_MS * 2 ** Math.min(bridge.attempts, 4), RECONNECT_MAX_MS);
  bridge.attempts += 1;
  bridge.timer = setTimeout(() => {
    bridge.timer = null;
    connect(bridge);
  }, waitMs);
}

function connect(bridge) {
  if (bridge.socket && (bridge.socket.readyState === WebSocket.OPEN || bridge.socket.readyState === WebSocket.CONNECTING)) return;
  const { port } = bridge;
  let socket;
  try {
    socket = new WebSocket(`ws://127.0.0.1:${port}`);
  } catch {
    scheduleReconnect(bridge);
    return;
  }
  bridge.socket = socket;
  socket.addEventListener('open', () => {
    bridge.attempts = 0;
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
      bridge.ready = true;
      // 同一扩展同时服务安装版与 Dev。仅首次握手清 SW 重启的孤儿，
      // 后续桥接入不能关闭另一个实例的正在执行的页面。
      startupCleanup ??= queueOrphanCleanup();
      void startupCleanup.then(() => bridge.cleanup).then(() => {
        sendToBridge({ type: 'log', text: '桥已就绪，任务窗口待命' }, bridge);
      }).catch(() => {});
      if (!heartbeatTimer) heartbeatTimer = setInterval(() => {
        for (const target of bridges.values()) if (target.ready) sendToBridge({ type: 'ping' }, target);
      }, HEARTBEAT_MS);
    } else if (message.type === 'cmd') {
      void handleCommand(message, bridge);
    } else if (message.type === 'pong') {
      /* 心跳应答，无需处理 */
    }
  });
  socket.addEventListener('close', () => {
    if (bridge.socket !== socket) return;
    bridge.socket = null;
    bridge.ready = false;
    if (![...bridges.values()].some(target => target.ready)) stopHeartbeat();
    // 仅回收断开实例的任务；并行实例及其页面继续工作。
    bridge.cleanup = bridge.cleanup.catch(() => {}).then(() => orphanCleanup.catch(() => {})).then(() => cleanupBridgeTasks(port));
    void bridge.cleanup.catch(error => sendToBridge({ type: 'log', text: `任务页面回收失败：${error.message}` }));
    scheduleReconnect(bridge);
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
  for (const bridge of bridges.values()) connect(bridge);
});

void loadAgents().then(() => { for (const bridge of bridges.values()) connect(bridge); });

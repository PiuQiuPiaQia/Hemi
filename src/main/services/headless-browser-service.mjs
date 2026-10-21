import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import { pathToFileURL } from 'node:url';

/** Only executable discovery: never open or copy a user's browser profile. */
export function findHeadlessExecutable({
  platform = process.platform, env = process.env, home = os.homedir(),
  exists = existsSync, bundled = null,
} = {}) {
  if (env.HEMI_BROWSER_EXECUTABLE) {
    if (!exists(env.HEMI_BROWSER_EXECUTABLE)) throw new Error('HEMI_BROWSER_EXECUTABLE 指向的浏览器不存在');
    return env.HEMI_BROWSER_EXECUTABLE;
  }
  const names = ['Google Chrome', 'Microsoft Edge', 'Chromium', 'Brave Browser', 'Google Chrome Canary'];
  // Join with the target platform's rules: a win32 test run must not turn macOS paths into backslashes.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  const candidates = platform === 'darwin'
    ? ['/Applications', join(home, 'Applications')].flatMap(root => names.map(name => join(root, `${name}.app`, 'Contents', 'MacOS', name)))
    : platform === 'win32'
      ? [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean).flatMap(root => [
        join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        join(root, 'Chromium', 'Application', 'chrome.exe'),
      ])
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/google/chrome/chrome', '/usr/bin/microsoft-edge'];
  const executable = [...candidates, bundled].filter(Boolean).find(exists);
  if (!executable) throw new Error('无头浏览器不可用：请安装 Chrome、Edge 或 Chromium，或用 HEMI_BROWSER_EXECUTABLE 指定浏览器程序');
  return executable;
}

let pageOperations;
async function loadPageOperations() {
  if (!pageOperations) pageOperations = (async () => {
    const development = new URL('../../../extensions/chrome-extension/', import.meta.url);
    const root = existsSync(new URL('page-logic.js', development)) ? development
      : pathToFileURL(`${path.join(process.resourcesPath, 'chrome-extension')}${path.sep}`);
    const scope = {};
    for (const name of ['page-logic.js', 'page-operations.js']) {
      runInNewContext(await readFile(new URL(name, root), 'utf8'), scope, { filename: name });
    }
    return { logic: scope.HEMI_PAGE_LOGIC, create: scope.HEMI_CREATE_PAGE_OPERATIONS };
  })();
  return pageOperations;
}

/** Shared process, isolated context per task; close the process when the last task ends. */
export function createHeadlessBrowserService({
  loadChromium = async () => (await import('playwright-core')).chromium,
  executablePath = null, log = null,
  opTimeout = { 'session.navigate': 30000, 'tab.screenshot': 20000, default: 15000 },
} = {}) {
  let browser = null;
  let launching = null;
  let disposed = false;
  let sequence = 0;
  const clients = new Set();

  async function ensureBrowser() {
    if (disposed) throw new Error('无头浏览器服务已关闭');
    if (browser?.isConnected()) return browser;
    if (!launching) launching = (async () => {
      const chromium = await loadChromium();
      const executable = executablePath ?? findHeadlessExecutable({ bundled: chromium.executablePath() });
      const instance = await chromium.launch({ executablePath: executable, headless: true, chromiumSandbox: true, timeout: 30000 });
      if (disposed) { await instance.close(); throw new Error('无头浏览器启动已取消'); }
      browser = instance;
      instance.on('disconnected', () => { if (browser === instance) browser = null; });
      log?.info?.('[browser] 已启动独立无头浏览器');
      return instance;
    })().finally(() => { launching = null; });
    return launching;
  }

  function createClient({ taskId } = {}) {
    let context = null;
    let preparing = null;
    let generation = 0;
    let windowId = null;
    let tabId = null;
    let operations = null;
    let ending = null;
    const tabs = new Map();
    const task = {};
    Object.defineProperties(task, { windowId: { get: () => windowId }, tabId: { get: () => tabId } });

    function recordPage(page) {
      const id = ++sequence;
      const entry = { page, protocol: null, world: null, inflight: new Set() };
      tabs.set(id, entry);
      tabId = id;
      page.on('close', () => { tabs.delete(id); if (tabId === id) tabId = [...tabs.keys()].at(-1) ?? null; });
      page.on('dialog', dialog => { void dialog.dismiss().catch(() => {}); });
      return entry;
    }

    async function cdp(id, method, params = {}) {
      const entry = tabs.get(id);
      if (!entry || entry.page.isClosed()) throw new Error('任务页面已关闭，请用 browser_navigate 重新打开');
      if (!entry.protocol) entry.protocol = (async () => {
        const session = await context.newCDPSession(entry.page);
        session.on('Network.requestWillBeSent', event => entry.inflight.add(event.requestId));
        session.on('Network.loadingFinished', event => entry.inflight.delete(event.requestId));
        session.on('Network.loadingFailed', event => entry.inflight.delete(event.requestId));
        session.on('Page.frameNavigated', event => { if (!event.frame.parentId) entry.world = null; });
        await session.send('Page.enable');
        await session.send('Network.enable');
        return session;
      })();
      return (await entry.protocol).send(method, params);
    }

    async function ensureWorld(id) {
      const entry = tabs.get(id);
      if (!entry) throw new Error('任务还没有打开任何页面：先调用 browser_navigate');
      if (entry.world != null) {
        try { await cdp(id, 'Runtime.evaluate', { expression: '1', contextId: entry.world }); return entry.world; }
        catch { entry.world = null; }
      }
      const { frameTree } = await cdp(id, 'Page.getFrameTree');
      const world = await cdp(id, 'Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'hemi-isolated-refs' });
      entry.world = world.executionContextId;
      return entry.world;
    }

    async function evaluateIn(id, contextId, expression, args = []) {
      const result = await cdp(id, 'Runtime.evaluate', {
        expression: `(${expression})(...${JSON.stringify(args)})`,
        ...(contextId == null ? {} : { contextId }), returnByValue: true,
      });
      if (result.exceptionDetails) throw new Error((result.exceptionDetails.exception?.description ?? '页面脚本执行失败').split('\n')[0].slice(0, 160));
      return result.result?.value;
    }

    async function ensureReady(signal) {
      signal?.throwIfAborted();
      if (ending) await ending;
      if (context && browser?.isConnected()) return;
      if (!preparing) {
        const expected = generation;
        clients.add(client);
        preparing = (async () => {
          const instance = await ensureBrowser();
          const next = await instance.newContext({ viewport: { width: 1180, height: 820 }, acceptDownloads: false });
          if (expected !== generation || disposed) { await next.close(); throw new Error('无头浏览器任务已停止'); }
          context = next;
          windowId = ++sequence;
          tabs.clear(); tabId = null;
          next.on('page', recordPage);
          const shared = await loadPageOperations();
          operations = shared.create({
            requireActiveTab: () => {
              if (!tabId) throw new Error('任务还没有打开任何页面：先调用 browser_navigate');
              return tabId;
            },
            cdp, ensureWorld, delay, evaluateIn,
            evaluate: (id, expression, args) => evaluateIn(id, null, expression, args),
            pageLogic: shared.logic,
          });
        })().finally(() => { preparing = null; });
      }
      await preparing;
      signal?.throwIfAborted();
    }

    async function endSession() {
      if (ending) return ending;
      ending = (async () => {
        generation++;
        // A stop during launch waits only for the bounded launch, then closes its context.
        await preparing?.catch(() => {});
        await context?.close();
        context = null; operations = null; windowId = null; tabId = null; tabs.clear();
        clients.delete(client);
        if (!clients.size && browser) {
          const instance = browser; browser = null;
          await instance.close();
        }
      })();
      try { await ending; } finally { ending = null; }
    }

    const client = {
      get session() { return context ? { windowId, tabId } : null; },
      ensureReady, endSession,
      async request(op, params = {}) {
        let timer;
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`无头浏览器操作超时：${op}；正在回收任务页面，动作结果未知，请重新导航并核对，不要直接重复提交`));
            void endSession().catch(error => log?.warn?.(`[browser] 超时回收失败：${error.message}`));
          }, opTimeout[op] ?? opTimeout.default);
        });
        try { return await Promise.race([this.dispatch(op, params), timeout]); }
        finally { clearTimeout(timer); }
      },
      async dispatch(op, params = {}) {
        if (op === 'session.end') return endSession();
        if (!context || !browser?.isConnected()) throw new Error('无头浏览器已断开，请用 browser_navigate 重新打开');
        if (op === 'session.navigate') {
          const url = new URL(params.url);
          if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只支持 http/https 网址');
          if (params.newTab || !tabId) await context.newPage();
          const entry = tabs.get(tabId);
          await cdp(tabId, 'Page.enable');
          await entry.page.goto(url.href, { waitUntil: 'load', timeout: 25000 });
          return { title: await entry.page.title(), url: entry.page.url(), session: client.session };
        }
        if (op === 'tab.list') return {
          tabs: await Promise.all([...tabs].map(async ([id, entry], index) => ({ index, title: await entry.page.title(), url: entry.page.url(), active: id === tabId }))),
          session: client.session,
        };
        const page = tabs.get(tabId)?.page;
        if (!page) throw new Error('任务还没有打开任何页面：先调用 browser_navigate');
        if (op === 'tab.screenshot') {
          const shot = await page.screenshot({ type: 'jpeg', quality: 80, timeout: 15000 });
          return { data: shot.toString('base64'), ...page.viewportSize() };
        }
        if (op === 'tab.netQuiet') {
          const quietMs = Math.max(100, Math.min(Number(params.quietMs) || 600, 3000));
          const maxMs = Math.max(quietMs, Math.min(Number(params.maxMs) || 6000, 15000));
          const started = Date.now(); let since = null;
          do {
            if (!tabs.get(tabId)?.inflight.size) since ??= Date.now(); else since = null;
            if (since != null && Date.now() - since >= quietMs) return { quiet: true, waitedMs: Date.now() - started };
            await delay(100);
          } while (Date.now() - started < maxMs);
          return { quiet: false, waitedMs: Date.now() - started };
        }
        const handler = {
          'tab.extract': operations.opExtract, 'tab.click': operations.opClick, 'tab.type': operations.opType,
          'tab.snapshot': operations.opSnapshot, 'tab.refAct': operations.opRefAct,
        }[op];
        if (!handler) throw new Error(`未知操作：${op}`);
        return handler(params, task);
      },
    };
    return client;
  }

  return {
    createClient,
    async checkAvailable() {
      const chromium = await loadChromium();
      return executablePath ?? findHeadlessExecutable({ bundled: chromium.executablePath() });
    },
    async stop() {
      disposed = true;
      await Promise.allSettled([...clients].map(client => client.endSession()));
      await launching?.catch(() => {});
      await browser?.close(); browser = null;
    },
  };
}

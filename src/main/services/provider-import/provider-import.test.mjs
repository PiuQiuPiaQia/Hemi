// 047 协调器全链路单测：假 Electron（View/session/witness）＋假站点＋内存目录。
// 覆盖：登录核验→选择→创建→查证→读 Key→验证→保存；失败重试不重建；取消撤销
// 精确 id；journal 断点恢复（先回执后 journal）；双击防重。
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';

import { createProfileStore } from '../../lib/model-profiles.mjs';
import { createImportCoordinator } from './provider-import.mjs';
import { createImportJournal } from './journal.mjs';

function memoryFs(initial = {}) {
  const files = new Map(Object.entries(initial));
  const error = (code) => Object.assign(new Error(code), { code });
  // journal.mjs 的 fileOf 走 path.join——Windows 出反斜杠；桩内键一律归一成正斜杠。
  const norm = (p) => String(p).split(path.sep).join('/');
  return {
    files,
    readFile: async (p) => (files.has(norm(p)) ? files.get(norm(p)) : Promise.reject(error('ENOENT'))),
    writeFile: async (p, c) => files.set(norm(p), c),
    rename: async (from, to) => {
      const fromKey = norm(from);
      if (!files.has(fromKey)) return Promise.reject(error('ENOENT'));
      files.set(norm(to), files.get(fromKey));
      files.delete(fromKey);
    },
    mkdir: async () => {},
    readdir: async (p) => [...files.keys()].filter((key) => key.startsWith(`${norm(p)}/`)).map((key) => key.slice(norm(p).length + 1)),
    unlink: async (p) => (files.has(norm(p)) ? files.delete(norm(p)) : Promise.reject(error('ENOENT'))),
  };
}

const safeStub = {
  isEncryptionAvailable: () => true,
  encryptString: (plain) => Buffer.from(`enc:${plain}`).toString('base64'),
  decryptString: (buf) => {
    const text = Buffer.from(buf).toString('utf8');
    return text.startsWith('enc:') ? text.slice(4) : '';
  },
};

const SITE = 'https://vvcode.top';

/** 假 New API 站点（vvcode 口径：Cookie＋New-Api-User；创建不回 id；key 无前缀）。 */
function makeSite() {
  const site = {
    loggedIn: false,
    userId: 7,
    tokens: [],
    nextId: 100,
    createCalls: 0,
    keyReads: 0,
    deletes: [],
    fault: null, // 'probe-anthropic' | 'key-read' | 'create-network'
    listeners: null,
    emitPageRequests: async () => {},
  };
  const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
  const authed = (init) => site.loggedIn && init?.headers?.['New-Api-User'] === String(site.userId);

  async function handle(url, init) {
    const parsed = new URL(url);
    const path = parsed.pathname;
    const method = init?.method ?? 'GET';
    if (path === '/api/status') return json({ data: { system_name: 'MockAPI', version: '' } });
    if (!path.startsWith('/api/')) return json({}, 404);
    if (!authed(init)) return json({ success: false, message: '无权访问' }, 401);
    if (method === 'GET' && path === '/api/user/self') return json({ success: true, data: { id: site.userId, username: 'demo' } });
    if (method === 'GET' && path === '/api/user/self/groups') {
      return json({ success: true, data: { default: { ratio: 1, desc: '默认分组' }, vip: { ratio: 0.8, desc: '' } } });
    }
    if (method === 'GET' && path === '/api/pricing') {
      return json({ success: true, data: [
        { model_name: 'gpt-5.2', enable_groups: ['default'], supported_endpoint_types: ['openai'] },
        { model_name: 'claude-opus-4.6', enable_groups: ['default'], supported_endpoint_types: ['anthropic', 'openai'] },
        { model_name: 'gemini-3-pro', enable_groups: ['default'], supported_endpoint_types: ['gemini'] },
      ] });
    }
    if (method === 'POST' && path === '/api/token/') {
      site.createCalls += 1;
      const body = JSON.parse(init.body);
      site.nextId += 1;
      site.tokens.push({
        id: site.nextId,
        name: body.name,
        group: body.group,
        user_id: site.userId,
        created_time: Math.floor(Date.now() / 1000),
        key: `mock-${site.nextId}full`,
        revoked: false,
      });
      // 故障注入在服务端已受理之后（响应丢失）：客户端不知道，但令牌已存在。
      if (site.fault === 'create-network') throw new Error('socket hang up');
      return json({ success: true, message: '' });
    }
    if (method === 'GET' && path === '/api/token/search') {
      const keyword = parsed.searchParams.get('keyword') ?? '';
      return json({ success: true, data: { items: site.tokens.filter((token) => token.name === keyword && !token.revoked) } });
    }
    const keyMatch = path.match(/^\/api\/token\/(\d+)\/key$/);
    if (method === 'POST' && keyMatch) {
      const token = site.tokens.find((item) => item.id === Number(keyMatch[1]) && !item.revoked);
      if (!token) return json({ success: false }, 404);
      site.keyReads += 1;
      if (site.fault === 'key-read') return json({ success: false, message: 'boom' }, 500);
      return json({ success: true, data: { key: token.key } });
    }
    const delMatch = path.match(/^\/api\/token\/(\d+)$/);
    if (method === 'DELETE' && delMatch) {
      const token = site.tokens.find((item) => item.id === Number(delMatch[1]));
      if (!token) return json({ success: false }, 404);
      token.revoked = true;
      site.deletes.push(token.id);
      return json({ success: true });
    }
    return json({}, 404);
  }

  const session = {
    setPermissionRequestHandler() {},
    webRequest: {
      onBeforeSendHeaders(filter, listener) {
        if (filter === null) { site.listeners = null; return; }
        site.listeners = { filter, listener };
      },
    },
    async fetch(url, init) {
      // 模拟页面请求先过认证见证（登录后页面自发带头）。
      if (site.listeners) {
        await new Promise((resolve) => {
          site.listeners.listener(
            { requestHeaders: site.loggedIn ? { 'New-Api-User': String(site.userId) } : {} },
            () => resolve(),
          );
        });
      }
      return handle(url, init);
    },
    clearStorageData: async () => { site.cleared = true; },
    clearCache: async () => {},
    closeAllConnections: async () => {},
  };
  site.session = session;
  return site;
}

let viewIdSeq = 0;
function makeFakeElectron(site) {
  const world = { partitions: [], childViews: [], removedViews: [], bounds: [] };
  class FakeWebContentsView {
    constructor({ webPreferences }) {
      this.viewPrefs = webPreferences;
      const self = this;
      viewIdSeq += 1;
      this.webContents = {
        id: viewIdSeq,
        url: '',
        get mainFrame() { return { id: this.id }; },
        async loadURL(url) {
          this.url = url;
          world.pageLoads = (world.pageLoads ?? 0) + 1;
          // 页面启动自发管理请求（登录后带头）→ 推进认证见证。
          await new Promise((resolve) => setTimeout(resolve, 5));
          await site.session.fetch(`${SITE}/api/user/self`, { headers: { 'New-Api-User': String(site.userId) } }).catch(() => undefined);
        },
        setUserAgent() {},
        getUserAgent: () => 'Mozilla/5.0 (mock)',
        getURL() { return this.url; },
        setWindowOpenHandler() {},
        close() { this.closed = true; },
        isDestroyed() { return Boolean(this.closed); },
      };
    }
    setBounds(bounds) { world.bounds.push(bounds); this.bounds = bounds; }
    setVisible(visible) { this.visible = visible; }
    isDestroyed() { return Boolean(this.webContents.closed); }
  }
  const mainWindow = {
    webContents: { id: 501 },
    contentView: {
      addChildView(view) { world.childViews.push(view); },
      removeChildView(view) { world.removedViews.push(view); },
    },
    on() {},
    removeListener() {},
  };
  return {
    world,
    mainWindow,
    WebContentsView: FakeWebContentsView,
    sessionFromPartition(partition) {
      world.partitions.push(partition);
      return site.session;
    },
  };
}

/** 推理端独立通道（无账号 Cookie，仅模型 Key）。 */
function inferenceFetch(site) {
  return async (url, init) => {
    const parsed = new URL(url);
    const key = init?.headers?.Authorization?.replace(/^Bearer /, '') ?? init?.headers?.['x-api-key'] ?? '';
    const token = site.tokens.find((item) => !item.revoked && `sk-${item.key}` === key);
    const json = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) });
    if (!token) return json({ error: { message: 'bad key' } }, 401);
    const visible = ['gpt-5.2', 'claude-opus-4.6'];
    if (parsed.pathname === '/v1/models') {
      return json({ data: visible.map((id) => ({ id, supported_endpoint_types: ['openai'] })) });
    }
    if (parsed.pathname === '/v1/chat/completions') {
      if (site.fault === 'probe-hang' && site.gate) await site.gate.promise; // 在途取消测试：挂住探活
      return json({ model: 'x', choices: [{ message: { role: 'assistant', content: 'pong' } }] });
    }
    if (parsed.pathname === '/v1/messages') {
      if (site.fault === 'probe-anthropic') return json({ type: 'error' }, 500);
      return json({ role: 'assistant', content: [{ type: 'text', text: 'pong' }], model: 'x' });
    }
    return json({}, 404);
  };
}

function buildHarness({ siteOverrides = {} } = {}) {
  const site = makeSite();
  Object.assign(site, siteOverrides);
  const electron = makeFakeElectron(site);
  const fs = memoryFs();
  const store = createProfileStore({
    filePath: '/ud/text-model-profiles.json',
    readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename, mkdir: fs.mkdir,
    safeStorage: safeStub, env: {}, log: null,
  });
  const states = [];
  const coordinator = createImportCoordinator({
    getMainWindow: () => electron.mainWindow,
    WebContentsView: electron.WebContentsView,
    sessionFromPartition: electron.sessionFromPartition,
    safeStorage: safeStub,
    getProfilesStore: () => store,
    journalDirPath: '/ud/provider-import',
    env: {},
    log: null,
    fetchImpl: inferenceFetch(site),
    journalFs: {
      readFile: fs.readFile, writeFile: fs.writeFile, rename: fs.rename,
      mkdir: fs.mkdir, readdir: fs.readdir, unlink: fs.unlink,
    },
  });
  coordinator.setOwnerSender((dto) => states.push(dto));
  const event = { sender: electron.mainWindow.webContents, senderFrame: electron.mainWindow.webContents.mainFrame };
  return { site, electron, fs, store, coordinator, states, event };
}

async function driveToSelecting(harness) {
  const started = await harness.coordinator.start(harness.event, { siteUrl: 'vvcode.top' });
  assert.equal(started.ok, true);
  harness.site.loggedIn = true; // 用户在页面上完成登录
  const checked = await harness.coordinator.checkLogin(harness.event, {
    operationId: started.state.operationId,
    revision: started.state.revision,
  });
  assert.equal(checked.ok, true, `登录核验失败：${JSON.stringify(checked)}`);
  return started.state.operationId;
}

async function waitForPhase(harness, phases, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const last = harness.states[harness.states.length - 1];
    if (last && phases.includes(last.phase)) return last;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`等阶段超时：${phases.join('/')}，最后是 ${JSON.stringify(harness.states[harness.states.length - 1]?.phase ?? null)}`);
}

function latest(harness) {
  return harness.states[harness.states.length - 1];
}

test('全链路：登录→选择→创建→查证→读Key→验证→原子保存→清理', async () => {
  const harness = buildHarness();
  const operationId = await driveToSelecting(harness);

  const selected = await harness.coordinator.setSelection(harness.event, {
    operationId,
    revision: latest(harness).revision,
    selection: {
      group: 'default',
      models: [
        { modelName: 'gpt-5.2', api: 'openai-completions' },
        { modelName: 'claude-opus-4.6', api: 'anthropic-messages' },
      ],
    },
  });
  assert.equal(selected.ok, true);
  assert.equal(selected.state.preview.providers.length, 2, '混合协议拆两条供应商');
  const anthropicPreview = selected.state.preview.providers.find((provider) => provider.api === 'anthropic-messages');
  assert.equal(anthropicPreview.baseUrl, SITE, 'anthropic 端点不带 /v1');
  assert.equal(selected.state.preview.providers.find((provider) => provider.api === 'openai-completions').baseUrl, `${SITE}/v1`);

  const submitted = await harness.coordinator.submit(harness.event, {
    operationId,
    revision: latest(harness).revision,
    planHash: selected.state.preview.planHash,
  });
  assert.equal(submitted.ok, true);

  const done = await waitForPhase(harness, ['success', 'failed']);
  assert.equal(done.phase, 'success', `失败：${JSON.stringify(done.error)}`);
  assert.equal(harness.site.createCalls, 1, '远端创建恰好一次');
  assert.equal(done.result.providers.length, 2);
  assert.equal(done.result.encrypted, true);

  const list = await harness.store.list();
  assert.equal(list.providers.length, 2);
  assert.equal(list.providers.filter((provider) => provider.api === 'openai-completions').length, 1);
  assert.equal(list.providers.filter((provider) => provider.api === 'anthropic-messages').length, 1);
  assert.equal(list.defaultModelId.startsWith('mpi-'), true, '首次导入设默认');
  const credentials = await harness.store.providerCredentials(list.providers[0].id);
  assert.equal(credentials.apiKey, `sk-${harness.site.tokens[0].key}`, '共享本次 Key（vvcode 补前缀口径）');

  // 成功清理：journal 清空、浏览器回收（session 清存储）。
  assert.equal([...harness.fs.files.keys()].filter((key) => key.startsWith('/ud/provider-import')).length, 0);
  assert.equal(harness.electron.world.removedViews.length, 1);
  assert.notEqual(harness.site.cleared, true, '成功导入保留站点登录状态');
  // Key 明文不进任何推送 DTO。
  assert.equal(JSON.stringify(harness.states).includes(harness.site.tokens[0].key), false);
});

test('双击防重：提交后立即再提交被拒', async () => {
  const harness = buildHarness();
  const operationId = await driveToSelecting(harness);
  const selected = await harness.coordinator.setSelection(harness.event, {
    operationId,
    revision: latest(harness).revision,
    selection: { group: 'default', models: [{ modelName: 'gpt-5.2', api: 'openai-completions' }] },
  });
  await harness.coordinator.submit(harness.event, { operationId, revision: latest(harness).revision, planHash: selected.state.preview.planHash });
  await assert.rejects(
    () => harness.coordinator.submit(harness.event, { operationId, revision: latest(harness).revision, planHash: selected.state.preview.planHash }),
    /不能提交|进行/,
  );
  await waitForPhase(harness, ['success']);
  assert.equal(harness.site.createCalls, 1);
});

test('验证失败→重试复用 Key（远端创建仍为 1）', async () => {
  const harness = buildHarness();
  const operationId = await driveToSelecting(harness);
  const selected = await harness.coordinator.setSelection(harness.event, {
    operationId,
    revision: latest(harness).revision,
    selection: { group: 'default', models: [
      { modelName: 'gpt-5.2', api: 'openai-completions' },
      { modelName: 'claude-opus-4.6', api: 'anthropic-messages' },
    ] },
  });
  harness.site.fault = 'probe-anthropic';
  await harness.coordinator.submit(harness.event, { operationId, revision: latest(harness).revision, planHash: selected.state.preview.planHash });
  const failed = await waitForPhase(harness, ['failed']);
  assert.equal(failed.error.code, 'VERIFY_FAILED');
  assert.equal(failed.error.retryTarget, 'validating');
  assert.equal(failed.validation.some((item) => !item.ok), true);
  assert.equal(failed.can.back, false, '已创建 Key 后不能回方式选择');

  harness.site.fault = null;
  await harness.coordinator.retry(harness.event, { operationId, revision: latest(harness).revision });
  const done = await waitForPhase(harness, ['success', 'failed']);
  assert.equal(done.phase, 'success', `重试失败：${JSON.stringify(done.error)}`);
  assert.equal(harness.site.createCalls, 1, '重试不重建');
  assert.equal(harness.site.keyReads, 1, 'Key 不重复读');
});

test('创建后取消：精确撤销本次令牌；取消前未创建则零远端副作用', async () => {
  const harness = buildHarness();
  const operationId = await driveToSelecting(harness);
  await harness.coordinator.cancel(harness.event, { operationId, revision: latest(harness).revision });
  const cancelled = await waitForPhase(harness, ['cancelled']);
  assert.equal(cancelled.phase, 'cancelled');
  assert.equal(harness.site.createCalls, 0);
  assert.equal(harness.site.tokens.length, 0);

  // 第二轮：创建后（key 读取失败停在断点）取消 → 撤销精确 id。
  const operationId2 = await driveToSelecting(harness);
  const selected = await harness.coordinator.setSelection(harness.event, {
    operationId: operationId2,
    revision: latest(harness).revision,
    selection: { group: 'default', models: [{ modelName: 'gpt-5.2', api: 'openai-completions' }] },
  });
  harness.site.fault = 'key-read';
  await harness.coordinator.submit(harness.event, { operationId: operationId2, revision: latest(harness).revision, planHash: selected.state.preview.planHash });
  await waitForPhase(harness, ['failed']);
  assert.equal(harness.site.createCalls, 1);

  harness.site.fault = null;
  await harness.coordinator.cancel(harness.event, { operationId: operationId2, revision: latest(harness).revision });
  const revoked = await waitForPhase(harness, ['cancelled', 'cleanup-pending']);
  assert.equal(revoked.phase, 'cancelled');
  assert.deepEqual(harness.site.deletes, [harness.site.tokens[0].id], '只删本次 id');
  assert.equal([...harness.fs.files.keys()].filter((key) => key.startsWith('/ud/provider-import')).length, 0, 'journal 清理');
});

test('创建请求结果不明（网络断）→ 查证结算，不重发', async () => {
  const harness = buildHarness();
  const operationId = await driveToSelecting(harness);
  const selected = await harness.coordinator.setSelection(harness.event, {
    operationId,
    revision: latest(harness).revision,
    selection: { group: 'default', models: [{ modelName: 'gpt-5.2', api: 'openai-completions' }] },
  });
  harness.site.fault = 'create-network';
  await harness.coordinator.submit(harness.event, { operationId, revision: latest(harness).revision, planHash: selected.state.preview.planHash });
  const done = await waitForPhase(harness, ['success', 'failed']);
  assert.equal(done.phase, 'success', '网络断后查证仍找到令牌并完成导入');
  assert.equal(harness.site.createCalls, 1, '没有重发创建');
});

test('断点恢复：journal 持 Key 无回执 → 直接验证保存（不重建、不需浏览器）', async () => {
  const harness = buildHarness();
  const site = harness.site;
  // 预置站点上已有一次创建的令牌＋journal 里已有 Key（模拟崩溃现场）。
  site.tokens.push({
    id: 55, name: 'Hemi-crash-01', group: 'default', user_id: site.userId,
    created_time: Math.floor(Date.now() / 1000), key: 'crashed-key', revoked: false,
  });
  const seedJournal = createImportJournal({
    dirPath: '/ud/provider-import',
    safeStorage: safeStub, log: null,
    readFile: harness.fs.readFile, writeFile: harness.fs.writeFile, rename: harness.fs.rename,
    mkdir: harness.fs.mkdir, readdir: harness.fs.readdir, unlink: harness.fs.unlink,
  });
  await seedJournal.persist('pi-crashed-0001', {
    siteOrigin: SITE,
    apiBaseUrl: SITE,
    accountLabel: 'demo（#7）',
    userId: '7',
    phase: 'validating',
    intent: {
      tokenName: 'Hemi-crash-01', group: 'default', budgetMode: 'unlimited', expiryMode: 'never',
      models: [{ modelName: 'gpt-5.2', api: 'openai-completions' }],
      firstDefaultModelKey: null,
    },
    planHash: null,
    createDispatch: 'acknowledged',
    tokenId: 55,
    remoteState: 'created',
    apiKey: 'sk-crashed-key',
  });

  const pending = await harness.coordinator.listPending();
  assert.equal(pending.pending.length, 1);
  assert.equal(pending.pending[0].apiKeyHeld, true);

  const resumed = await harness.coordinator.resumePending(harness.event, { operationId: 'pi-crashed-0001' });
  assert.equal(resumed.ok, true);
  const done = await waitForPhase(harness, ['success', 'failed']);
  assert.equal(done.phase, 'success', `恢复失败：${JSON.stringify(done.error)}`);
  assert.equal(site.createCalls, 0, '恢复不重建');
  const list = await harness.store.list();
  assert.equal(list.providers.length, 1);
  const credentials = await harness.store.providerCredentials(list.providers[0].id);
  assert.equal(credentials.apiKey, 'sk-crashed-key');

  // 回执优先的入口约束：active 存在（成功态未让位）时 resumePending 拒绝——先处理当前操作。
  await seedJournal.persist('pi-crashed-0001', { phase: 'saving', apiKey: 'sk-crashed-key', tokenId: 55 });
  await assert.rejects(
    () => harness.coordinator.resumePending(harness.event, { operationId: 'pi-crashed-0001' }),
    /先处理当前/,
  );
});

test('在途取消：验证进行中 cancel → 暂停后照常撤销（不卡 cancelling）', async () => {
  const harness = buildHarness();
  const operationId = await driveToSelecting(harness);
  const selected = await harness.coordinator.setSelection(harness.event, {
    operationId,
    revision: latest(harness).revision,
    selection: { group: 'default', models: [{ modelName: 'gpt-5.2', api: 'openai-completions' }] },
  });
  // 探活挂住 → 提交 → validating 在途 → cancel（先暂停后撤销）→ 释放 → cancelled。
  harness.site.fault = 'probe-hang';
  harness.site.gate = { promise: new Promise((resolve) => { harness.site.releaseGate = resolve; }) };
  await harness.coordinator.submit(harness.event, { operationId, revision: latest(harness).revision, planHash: selected.state.preview.planHash });
  await waitForPhase(harness, ['validating'], 15000);
  const cancelPromise = harness.coordinator.cancel(harness.event, { operationId, revision: latest(harness).revision });
  harness.site.releaseGate();
  await cancelPromise;
  const done = await waitForPhase(harness, ['cancelled', 'cleanup-pending'], 15000);
  assert.equal(done.phase, 'cancelled', '在途取消必须走完撤销，不能停在 cancelling');
  assert.deepEqual(harness.site.deletes, [harness.site.tokens[0].id]);
});

test('列表外站点/登录未完成/换账号如实拒绝', async () => {
  const harness = buildHarness();
  await assert.rejects(() => harness.coordinator.start(harness.event, { siteUrl: 'ftp://x' }), /https/);

  const started = await harness.coordinator.start(harness.event, { siteUrl: 'vvcode.top' });
  // 未登录 → checkLogin 如实返回 LOGIN_REQUIRED
  const checked = await harness.coordinator.checkLogin(harness.event, {
    operationId: started.state.operationId,
    revision: started.state.revision,
  });
  assert.equal(checked.ok, false);
  assert.equal(checked.code, 'LOGIN_REQUIRED');

  // 换账号（站点上换了 userId）→ ACCOUNT_CHANGED
  harness.site.loggedIn = true;
  const checked2 = await harness.coordinator.checkLogin(harness.event, {
    operationId: started.state.operationId,
    revision: latest(harness).revision,
  });
  assert.equal(checked2.ok, true);
  harness.site.userId = 99;
  harness.site.loggedIn = false;
  const operationId = started.state.operationId;
  // 触发一次失败后走 login 阶段再换号：简化为直接第二次导入流程里验。
  await harness.coordinator.cancel(harness.event, { operationId, revision: latest(harness).revision });
  await waitForPhase(harness, ['cancelled']);

  const second = buildHarness();
  const op2 = await driveToSelecting(second);
  const selected = await second.coordinator.setSelection(second.event, {
    operationId: op2,
    revision: latest(second).revision,
    selection: { group: 'default', models: [{ modelName: 'gpt-5.2', api: 'openai-completions' }] },
  });
  // 提交后站点会话被顶掉（登录失效）→ 读 Key 401 → 回登录阶段；用户重登成另一个账号 → ACCOUNT_CHANGED
  second.site.loggedIn = false;
  await second.coordinator.submit(second.event, { operationId: op2, revision: latest(second).revision, planHash: selected.state.preview.planHash });
  const atLogin = await waitForPhase(second, ['login', 'success', 'failed']);
  assert.equal(atLogin.phase, 'login', '读 Key 401 应回登录阶段');
  assert.equal(atLogin.error?.retryTarget, 'reconciling', 'creating 中断的恢复点是查证，不是重发创建');

  second.site.loggedIn = true;
  second.site.userId = 42; // 重登的是另一个账号
  const rechecked = await second.coordinator.checkLogin(second.event, { operationId: op2, revision: latest(second).revision });
  assert.equal(rechecked.ok, false);
  assert.equal(rechecked.code, 'ACCOUNT_CHANGED');
});

test('显式 http 站点放行（自建站）：过门禁进登录阶段', async () => {
  const harness = buildHarness();
  const started = await harness.coordinator.start(harness.event, { siteUrl: 'http://127.0.0.1:9' });
  assert.equal(started.ok, true);
  assert.equal(started.state.siteOrigin, 'http://127.0.0.1:9');
  assert.equal(started.state.phase, 'login');
  // 后续链路与 https 同构：登录核验照常进选择阶段
  harness.site.loggedIn = true;
  const checked = await harness.coordinator.checkLogin(harness.event, {
    operationId: started.state.operationId,
    revision: latest(harness).revision,
  });
  assert.equal(checked.ok, true);
  assert.equal(checked.state.phase, 'selecting');
});

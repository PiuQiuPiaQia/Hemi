// 047 真实站点验收 harness：与假站版（verify-newapi-import.mjs）同一套协调器/IPC，
// 登录改为通用 React 表单填充（semi-design 口径：原生 value setter＋input 事件）。
// 凭据只经环境变量注入（HEMI_047_USER/PASS），不落仓库、不进 hemi.log；
// 密码只进站点页面（与真人键入同路径）。验证探活会产生极少量模型用量。
//
// 运行（先 npm run build）：
//   HEMI_047_USER=xxx HEMI_047_PASS=yyy \
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-047-real-ud \
//   npx electron scripts/verify-newapi-import-real.mjs
// 可选：HEMI_047_SITE（默认 https://vvcode.top）、HEMI_047_GROUP、
//       HEMI_047_MODELS（逗号分隔）、HEMI_047_SCENARIOS（默认 import,cancel）。
import { app, ipcMain } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

const SITE = process.env.HEMI_047_SITE ?? 'https://vvcode.top';
const USER = process.env.HEMI_047_USER ?? '';
const PASS = process.env.HEMI_047_PASS ?? '';
const SCENARIOS = (process.env.HEMI_047_SCENARIOS ?? 'import,cancel').split(',').map((item) => item.trim());
const TIMEOUT_MS = Number(process.env.HEMI_047_TIMEOUT ?? 420000);

if (!USER || !PASS) {
  console.error('[verify047-real] 缺少 HEMI_047_USER / HEMI_047_PASS');
  process.exit(2);
}

const { IPC } = await import('../src/shared/ipc-channels.mjs');
const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { getProviderImportService } = await import('../src/main/ipc/provider-import.ipc.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const log = createLogger('verify047real');
const handler = (channel) => {
  const fn = ipcMain._invokeHandlers?.get(channel);
  if (typeof fn !== 'function') {
    console.error(`[verify047-real] 找不到 IPC handler：${channel}`);
    app.exit(1);
  }
  return fn;
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok), detail: String(detail ?? '').slice(0, 300) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`);
};
let finished = false;
function finish(code, summary) {
  if (finished) return;
  finished = true;
  console.log(`HEMI_047_REAL_RESULT=${JSON.stringify({ summary, site: SITE, results, passed: results.every((item) => item.ok) })}`);
  setTimeout(() => app.exit(code), 800);
}

function drive(channel, payload) {
  const event = { sender: appState.mainWindow.webContents, senderFrame: appState.mainWindow.webContents.mainFrame };
  return handler(channel)(event, payload ?? {});
}
async function currentRevision(operationId) {
  const result = await drive(IPC.providerImport.getState, { operationId });
  return result?.state?.revision ?? 0;
}
async function pollState(operationId, want, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    const result = await drive(IPC.providerImport.getState, { operationId });
    last = result?.state ?? null;
    if (want.includes(last?.phase)) return last;
    await sleep(200);
  }
  throw new Error(`等待阶段超时：${want.join('/')}，最后 ${last?.phase ?? 'null'} ${JSON.stringify(last?.error ?? null)}`);
}

/** 页面注入统一带超时（导航会挂死未结算的 executeJavaScript，实测坑）。 */
function execWithTimeout(contents, code, ms = 10000) {
  return Promise.race([
    contents.executeJavaScript(code),
    new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
  ]).catch(() => '__error__');
}

/** 同步探测＋填充：一次只查一次 DOM（页面导航会挂死带 await 的注入脚本，实测坑），外层重试。 */
const FILL_SCRIPT = `
  (function () {
    const password = document.querySelector('input[type=password]');
    if (!password) return 'waiting:' + location.pathname;
    const form = password.closest('form') ?? document;
    const username = form.querySelector('input:not([type=password]):not([type=hidden]):not([type=checkbox])');
    if (!username) return 'no-username:' + location.pathname;
    const setNativeValue = (element, value) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      setter.call(element, value);
      element.dispatchEvent(new Event('input', { bubbles: true }));
      element.dispatchEvent(new Event('change', { bubbles: true }));
    };
    setNativeValue(username, ${JSON.stringify(USER)});
    setNativeValue(password, ${JSON.stringify(PASS)});
    const buttons = [...form.querySelectorAll('button')].filter((button) => !button.disabled);
    const submit = buttons.find((button) => /登录|sign in|login/i.test(button.textContent ?? ''))
      ?? buttons[buttons.length - 1];
    if (!submit) return 'no-submit-button:' + location.pathname;
    submit.click();
    return 'submitted:' + location.pathname;
  })()
`;

async function simulateUserLogin() {
  const service = getProviderImportService();
  let contents = service.testBrowserContents();
  const deadline = Date.now() + 15000;
  while ((!contents || contents.isDestroyed()) && Date.now() < deadline) {
    await sleep(150);
    contents = service.testBrowserContents();
  }
  if (!contents) throw new Error('导入浏览器 webContents 不存在');
  // 模拟用户从首页点「登录」：直接走到站点登录路由（不硬编码进产品，harness 知道目标站）。
  await contents.loadURL(`${SITE}/sign-in`).catch(async () => undefined);
  let out = '';
  for (let i = 0; i < 50 && !String(out).startsWith('submitted'); i += 1) {
    out = await execWithTimeout(contents, FILL_SCRIPT, 4000);
    if (!String(out).startsWith('submitted') && i % 8 === 7) log.info(`登录填充等待中：${out}`);
    if (!String(out).startsWith('submitted')) await sleep(500);
  }
  if (String(out).startsWith('submitted')) {
    log.info(`登录表单已提交（${out}）`);
  } else {
    log.warn(`登录表单填充未完成：${out}`);
  }
  // 登录后的跳转/接口调用交给 checkLogin 核验；这里只等页面稳定。
  await sleep(2500);
}

/** 读公开 pricing 找「有可导入模型的分组」（本人组交集；auto 等空组跳过）。 */
async function pickGroupWithModels(accountGroups) {
  const response = await fetch(`${SITE}/api/pricing`);
  const payload = await response.json();
  const perGroup = new Map();
  for (const item of payload?.data ?? []) {
    const types = item?.supported_endpoint_types ?? [];
    const api = types.includes('anthropic') ? 'anthropic-messages' : types.includes('openai') ? 'openai-completions' : null;
    if (!api) continue;
    for (const groupName of item?.enable_groups ?? []) {
      if (!perGroup.has(groupName)) perGroup.set(groupName, []);
      perGroup.get(groupName).push({ modelName: item.model_name, api });
    }
  }
  // 本人组顺序优先；组内同时有双协议的组加分（验混合拆分）。
  for (const account of accountGroups) {
    const usable = perGroup.get(account.name) ?? [];
    if (!usable.length) continue;
    const hasAnthropic = usable.some((model) => model.api === 'anthropic-messages');
    const hasOpenai = usable.some((model) => model.api === 'openai-completions');
    if (hasAnthropic && hasOpenai) return { group: account.name, usable };
  }
  for (const account of accountGroups) {
    const usable = perGroup.get(account.name) ?? [];
    if (usable.length) return { group: account.name, usable };
  }
  return { group: null, usable: [] };
}

async function loginAndSelect({ group, models: wantedModels }) {
  const started = await drive(IPC.providerImport.start, { siteUrl: SITE });
  if (!started?.ok) throw new Error(`start 失败：${JSON.stringify(started?.state?.error ?? started)}`);
  const operationId = started.state.operationId;
  await simulateUserLogin();
  const checked = await drive(IPC.providerImport.checkLogin, { operationId, revision: await currentRevision(operationId) });
  check('登录核验（服务端身份＋本人分组）', checked?.ok === true && (checked.state?.groups?.length ?? 0) > 0,
    `ok=${checked?.ok} code=${checked?.code ?? ''} groups=${(checked.state?.groups ?? []).map((group) => group.name).join('/')}`);
  if (!checked?.ok) throw new Error(`登录核验失败：${checked?.code} ${checked?.message ?? ''}`);
  const selecting = checked.state;
  const found = await pickGroupWithModels(selecting.groups);
  let pickGroup = group && selecting.groups.some((item) => item.name === group) ? group : found.group;
  if (!pickGroup) throw new Error(`账号分组里没有带可导入模型的分组：${selecting.groups.map((item) => item.name).join('/')}`);
  log.info(`选用分组「${pickGroup}」（pricing 可用模型 ${found.usable.length} 条）`);
  // 候选来自公开 pricing（与协调器 setSelection 内的按组过滤同一数据源；checkLogin 的 DTO 不带候选）。
  const usable = found.group === pickGroup ? found.usable : (await pickGroupWithModels([{ name: pickGroup }])).usable;
  let models = [];
  if (wantedModels?.length) {
    models = wantedModels
      .map((name) => usable.find((item) => item.modelName === name))
      .filter(Boolean)
      .map((item) => ({ modelName: item.modelName, api: item.api }));
  }
  if (!models.length) {
    // 自动挑：一个 openai 协议＋一个 anthropic 协议（不同型号优先，验混合拆分）。
    const openaiModel = usable.find((item) => item.api === 'openai-completions');
    if (openaiModel) models.push({ modelName: openaiModel.modelName, api: 'openai-completions' });
    const anthropicModel = usable.find((item) => item.api === 'anthropic-messages' && item.modelName !== openaiModel?.modelName);
    if (anthropicModel) models.push({ modelName: anthropicModel.modelName, api: 'anthropic-messages' });
  }
  if (!models.length) throw new Error(`分组「${pickGroup}」没有可导入的候选模型`);
  log.info(`选用分组「${pickGroup}」＋模型：${models.map((model) => `${model.modelName}(${model.api})`).join('、')}`);
  const selected = await drive(IPC.providerImport.setSelection, {
    operationId,
    revision: selecting.revision,
    selection: { group: pickGroup, models },
  });
  check('选择生效＋预览', selected?.ok === true && (selected.state?.preview?.providers?.length ?? 0) >= 1,
    `providers=${selected.state?.preview?.providers?.length ?? 0}`);
  if (!selected?.ok) throw new Error(`选择失败：${selected.state?.error?.message ?? ''}`);
  return { operationId, state: selected.state, models };
}

app.setName('hemi');
app.setPath('userData', path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-047-real-ud'));

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({
      app, Menu, platform: process.platform, appName: 'Hemi',
      devTools: !app.isPackaged, openExternal: openExternalIfAllowed,
    });
    await createMainWindow();
    check('主窗创建（View 宿主）', Boolean(appState.mainWindow));
    log.info(`真站验收开始：${SITE}（账号 ${USER.slice(0, 2)}***）`);

    if (SCENARIOS.includes('import')) {
      const wanted = (process.env.HEMI_047_MODELS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      const { operationId, state, models } = await loginAndSelect({ group: process.env.HEMI_047_GROUP, models: wanted });
      const submitted = await drive(IPC.providerImport.submit, {
        operationId,
        revision: state.revision,
        planHash: state.preview.planHash,
      });
      check('提交受理', submitted?.ok === true);
      const done = await pollState(operationId, ['success', 'failed'], 300000);
      check('导入成功', done.phase === 'success', JSON.stringify(done.error ?? {}));
      if (done.phase === 'success') {
        check('回执供应商数与协议一致', done.result?.providers?.length === new Set(models.map((model) => model.api)).size,
          `providers=${done.result?.providers?.map((provider) => provider.api).join(',')}`);
        const directory = await handler(IPC.llm.listModelProfiles)({ sender: appState.mainWindow.webContents }, {});
        const imported = directory.providers.filter((provider) => provider.id.startsWith('mpi-'));
        check('目录落盘（Key 已加密）', imported.length >= 1 && imported.every((provider) => provider.hasApiKey && provider.keyStoredSecurely));
        check('令牌名带 Hemi 前缀', Boolean(done.tokenName?.startsWith('Hemi-')), done.tokenName ?? '');
        const journalDir = path.join(app.getPath('userData'), 'provider-import');
        const leftovers = fs.existsSync(journalDir) ? fs.readdirSync(journalDir).filter((name) => name.endsWith('.json')) : [];
        check('journal 已清空', leftovers.length === 0, leftovers.join(','));
        const logText = fs.readFileSync(path.join(app.getPath('userData'), 'hemi.log'), 'utf8');
        check('日志无 Key 线索（sk- 全串不出现）', !/sk-[A-Za-z0-9]{16,}/.test(logText));
        console.log(`\n真站导入完成：令牌「${done.tokenName}」保留在站点（可在站点令牌管理里查看）。`);
      }
    }

    if (SCENARIOS.includes('restart')) {
      // AC-08 重启半段：同 userData 重启后，已导入供应商可读、Key 可解密、端点可用。
      const directory = await handler(IPC.llm.listModelProfiles)({ sender: appState.mainWindow.webContents }, {});
      const imported = directory.providers.filter((provider) => provider.id.startsWith('mpi-'));
      check('重启后目录可读（导入供应商在场）', imported.length >= 1, `count=${imported.length}`);
      const probeTarget = imported[0]?.models?.[0];
      const probe = probeTarget
        ? await handler(IPC.llm.testModelProfile)({ sender: appState.mainWindow.webContents }, { modelKey: probeTarget.modelKey })
        : { ok: false, error: 'no model' };
      check('重启后 Key 解密＋端点探活可用', probe.ok === true, `model=${probeTarget?.model ?? ''} ${probe.error ?? `latency=${probe.latencyMs}`}`);
    }

    if (SCENARIOS.includes('cancel')) {
      // 第二次操作：创建后立刻取消 → 真站 DELETE 精确撤销。
      const wanted = (process.env.HEMI_047_MODELS ?? '').split(',').map((item) => item.trim()).filter(Boolean);
      const { operationId, state } = await loginAndSelect({ group: process.env.HEMI_047_GROUP, models: wanted.slice(0, 1).length ? wanted.slice(0, 1) : null });
      await drive(IPC.providerImport.submit, { operationId, revision: state.revision, planHash: state.preview.planHash });
      // 等 Key 已读（validating 及以后）再取消——撤销走真实 DELETE。
      const reached = await pollState(operationId, ['validating', 'saving', 'success'], 240000);
      if (reached.phase === 'success') {
        log.warn('取消场景跑赢了（直接成功）——真站撤销路径本轮未覆盖');
        check('取消场景（未覆盖，跑赢为 success）', true, reached.phase);
      } else {
        await drive(IPC.providerImport.cancel, { operationId, revision: await currentRevision(operationId) });
        const done = await pollState(operationId, ['cancelled', 'cleanup-pending'], 120000);
        check('真站撤销完成', done.phase === 'cancelled', done.phase);
        if (done.phase === 'cleanup-pending') {
          console.log(`撤销未证实：到 ${done.cleanupPending?.siteOrigin} 手动删除「${done.cleanupPending?.tokenName}」`);
        }
      }
    }

    finish(results.every((item) => item.ok) ? 0 : 1, results.every((item) => item.ok) ? 'all-pass' : 'has-failures');
  } catch (error) {
    console.error('[verify047-real] 失败：', error);
    check('脚本异常', false, error?.stack ?? String(error));
    finish(1, 'exception');
  }
});
setTimeout(() => finish(1, 'timeout'), TIMEOUT_MS);

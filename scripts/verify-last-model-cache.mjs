// 2026-10-08 新建主脑模型选择缓存（用户反馈：总被重置回默认 DeepSeek）：
// 真机 UI 驱动验证——隔离 userData＋合成模型目录（safeStorage 现场加密，不碰
// 用户真实配置），全程走真实 DOM（chip 菜单选模型、侧栏「新建对话」按钮）。
// 四个场景：
//   select  无缓存起步：菜单选 model-b2 → 落盘 lastConversationModelKey →
//           新建对话后 chip 仍是 model-b2（不再重置回默认）；
//   restore 预置有效缓存 mp-b/m-b2：冷启动落新对话态 chip 即 model-b2；
//   stale   预置失效引用 gone/m9：冷启动回落默认 model-a1；
//   auto    预置 'auto'（角色就绪）：冷启动 chip「自动」，新建对话仍「自动」。
// 运行：HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-lmc-<mode> \
//       npx electron scripts/verify-last-model-cache.mjs <mode>
import { app } from 'electron';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const mode = process.argv[2] ?? 'select';
const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const log = createLogger('lmc-verify');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 200)}` : ''}`);
};
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  console.log(`HEMI_LASTMODEL_RESULT=${JSON.stringify({ mode, passed: results.every((item) => item.ok) })}`);
  setTimeout(() => app.exit(code), 400);
};

const exec = (code, ms = 8000) => {
  const contents = appState.mainWindow.webContents;
  return Promise.race([
    contents.executeJavaScript(code),
    new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
  ]).catch((error) => `__error__:${error?.message}`);
};

const waitFor = async (predicateScript, label, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await exec(predicateScript)) === true) return true;
    await sleep(250);
  }
  log.warn(`等待超时：${label}`);
  return false;
};

const chipLabel = () => exec(`(function () {
  const el = document.querySelector('.h24-model-chip .h24-model-chip-label');
  return el ? (el.textContent ?? '').trim() : 'missing';
})()`);

const clickNewConversation = () => exec(`(function () {
  const btn = document.querySelector('button[aria-label="新建对话"]');
  if (!btn || btn.disabled) return 'missing';
  btn.click();
  return 'clicked';
}())`);

const profilesPath = () => path.join(app.getPath('userData'), 'text-model-profiles.json');
const readProfilesFile = async () => {
  try {
    return JSON.parse(await readFile(profilesPath(), 'utf8'));
  } catch {
    return null;
  }
};

app.setName('hemi');
const userDataDir = path.resolve(process.env.HEMI_USER_DATA_DIR ?? `/tmp/hemi-lmc-${mode}`);
await rm(userDataDir, { recursive: true, force: true });
app.setPath('userData', userDataDir);

app.whenReady().then(async () => {
  try {
    // 合成目录：两个供应商、默认 model-a1；按场景预置缓存/角色。
    initializeStableSafeStorageIdentity();
    const { safeStorage } = await import('electron');
    const encKey = (plain) => safeStorage.encryptString(plain).toString('base64');
    const directory = {
      version: 3,
      defaultModelId: 'mp-a/m-a1',
      providers: [
        {
          id: 'mp-a', name: '甲供应商', baseUrl: 'https://a.example/v1', encryptedApiKey: encKey('key-a'),
          models: [{ id: 'm-a1', model: 'model-a1', thinkingLevel: 'default', supportsVision: false, visionModel: '' }],
        },
        {
          id: 'mp-b', name: '乙供应商', baseUrl: 'https://b.example/v1', encryptedApiKey: encKey('key-b'),
          models: [
            { id: 'm-b1', model: 'model-b1', thinkingLevel: 'default', supportsVision: false, visionModel: '' },
            { id: 'm-b2', model: 'model-b2', thinkingLevel: 'default', supportsVision: false, visionModel: '' },
          ],
        },
      ],
    };
    if (mode === 'restore') directory.lastConversationModelKey = 'mp-b/m-b2';
    if (mode === 'stale') directory.lastConversationModelKey = 'gone/m9';
    if (mode === 'auto') {
      directory.autoRouting = { chatModelKey: 'mp-a/m-a1', executionModelKey: 'mp-b/m-b1', fallbackModelKey: null };
      directory.lastConversationModelKey = 'auto';
    }
    await mkdir(userDataDir, { recursive: true });
    await writeFile(profilesPath(), `${JSON.stringify(directory, null, 2)}\n`);
    const now = Date.now();
    await writeFile(
      path.join(userDataDir, 'onboarding.json'),
      `${JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted', updatedAt: now, completedAt: now })}\n`,
    );

    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();
    await sleep(1200); // 等渲染层就绪

    const chipReady = await waitFor(`Boolean(document.querySelector('.h24-model-chip'))`, '模型 chip');
    check('模型 chip 渲染', chipReady);
    if (!chipReady) return finish(1);

    if (mode === 'select') {
      check('起步是默认模型', (await chipLabel()) === 'model-a1', await chipLabel());
      // 打开菜单选 model-b2（乙供应商第二个模型）。
      check('打开模型菜单', (await exec(`(function () {
        const chip = document.querySelector('.h24-model-chip');
        if (!chip) return 'missing';
        chip.click();
        return 'clicked';
      })()`)) === 'clicked');
      const menuReady = await waitFor(`Boolean(document.querySelector('.h37-model-menu'))`, '菜单展开');
      check('菜单展开', menuReady);
      check('点选 model-b2', (await exec(`(function () {
        const item = [...document.querySelectorAll('.h37-model-menu [role="menuitemradio"]')]
          .find((node) => (node.textContent ?? '').includes('model-b2'));
        if (!item || item.disabled) return 'missing';
        item.click();
        return 'clicked';
      })()`)) === 'clicked');
      check('chip 切到 model-b2', (await chipLabel()) === 'model-b2', await chipLabel());
      // 选择即记账：文件里出现 lastConversationModelKey。
      let persisted = null;
      for (let i = 0; i < 20 && !persisted; i += 1) {
        await sleep(250);
        persisted = (await readProfilesFile())?.lastConversationModelKey === 'mp-b/m-b2';
      }
      check('选择落盘 lastConversationModelKey', Boolean(persisted));
      // 新建对话：不重置回默认，仍显示 model-b2。
      check('点新建对话', (await clickNewConversation()) === 'clicked');
      await sleep(600);
      check('新建对话沿用上次选择', (await chipLabel()) === 'model-b2', await chipLabel());

      // 定向直达：本形态无 autoRouting → 菜单有「去设置自动路由」；点击必须
      // 真的打开设置并落「模型与路由」（2026-10-08 修复：此前只设目标不打开）。
      check('再开模型菜单', (await exec(`(function () {
        const chip = document.querySelector('.h24-model-chip');
        if (!chip) return 'missing';
        chip.click();
        return 'clicked';
      })()`)) === 'clicked');
      await waitFor(`Boolean(document.querySelector('.h37-model-menu'))`, '菜单展开');
      check('点「去设置自动路由」', (await exec(`(function () {
        const item = [...document.querySelectorAll('.h37-model-menu button')]
          .find((node) => (node.textContent ?? '').includes('去设置自动路由'));
        if (!item || item.disabled) return 'missing';
        item.click();
        return 'clicked';
      })()`)) === 'clicked');
      const settingsOpened = await waitFor(`Boolean(document.querySelector('.settings-nav, .h37-settings-side'))`, '设置打开', 10000);
      check('直达真的打开设置', settingsOpened);
      check('直达落「模型与路由」', (await exec(`(function () {
        const item = document.querySelector('.settings-nav [aria-current="true"], .h37-settings-navitem[aria-current="true"]');
        return item ? (item.textContent ?? '').trim() : 'missing';
      })()`)) === '模型与路由');
    } else if (mode === 'restore') {
      check('冷启动恢复上次选择', (await chipLabel()) === 'model-b2', await chipLabel());
      check('点新建对话', (await clickNewConversation()) === 'clicked');
      await sleep(600);
      check('新建对话沿用上次选择', (await chipLabel()) === 'model-b2', await chipLabel());
    } else if (mode === 'stale') {
      check('失效缓存回落默认模型', (await chipLabel()) === 'model-a1', await chipLabel());
      check('点新建对话', (await clickNewConversation()) === 'clicked');
      await sleep(600);
      check('新建对话仍默认模型', (await chipLabel()) === 'model-a1', await chipLabel());
    } else if (mode === 'auto') {
      check('冷启动恢复「自动」', (await chipLabel()) === '自动', await chipLabel());
      check('点新建对话', (await clickNewConversation()) === 'clicked');
      await sleep(600);
      check('新建对话仍「自动」', (await chipLabel()) === '自动', await chipLabel());
    } else {
      check(`未知模式 ${mode}`, false);
    }
    finish(results.every((item) => item.ok) ? 0 : 1);
  } catch (error) {
    log.warn(`验证脚本异常：${error?.stack ?? error}`);
    check('脚本无异常', false, error?.message);
    finish(1);
  }
});

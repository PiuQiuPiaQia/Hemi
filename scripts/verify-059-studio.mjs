// 059 S4 真机走查：工作流页全链（真实应用窗口＋真实 DOM 驱动，隔离 userData）。
//   N1 图标栏「工作流」tab 打开工作流页（空态文案）
//   N2 「新建工作流」→ FlowGram 画布挂载（flow 编辑器 DOM 出现、两个默认节点渲染）
//   N3 「保存草稿」成功 → 「保存并发布」成功（宿主完整业务校验通过）
//   N4 返回列表：条目出现（v1 已发布）
//   N5 「预览」→ 右侧预览面板 workflow-definition-preview（节点结构列表）
//   N6 新建对话后「去对话运行」：缺参（topic 必填）如实提示（不静默启动）
// 结果打一行 HEMI_059_STUDIO_RESULT；exit 0＝全过。
// 运行：HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-059-studio \
//       npx electron scripts/verify-059-studio.mjs
import { app } from 'electron';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const log = createLogger('wf-studio-verify');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 160)}` : ''}`);
};
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  console.log(`HEMI_059_STUDIO_RESULT=${JSON.stringify({ passed: results.every((item) => item.ok), results })}`);
  setTimeout(() => app.exit(code), 400);
};

const exec = (code, ms = 12000) => {
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
  const dump = await exec(`JSON.stringify([...document.querySelectorAll('[role="status"]')].map((n) => n.textContent?.slice(0, 120)))`);
  log.warn(`等待超时：${label}；当前浮条=${dump}`);
  return false;
};

app.setName('hemi');
const userDataDir = path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-059-studio');
await rm(userDataDir, { recursive: true, force: true });
app.setPath('userData', userDataDir);

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    const { safeStorage } = await import('electron');
    const directory = {
      version: 3,
      defaultModelId: 'mp-a/m-a1',
      providers: [
        {
          id: 'mp-a', name: '甲供应商', baseUrl: 'https://a.example/v1', encryptedApiKey: safeStorage.encryptString('key-a').toString('base64'),
          models: [{ id: 'm-a1', model: 'model-a1', thinkingLevel: 'default', supportsVision: false, visionModel: '' }],
        },
      ],
    };
    await mkdir(userDataDir, { recursive: true });
    await writeFile(path.join(userDataDir, 'text-model-profiles.json'), `${JSON.stringify(directory, null, 2)}\n`);
    const now = Date.now();
    await writeFile(
      path.join(userDataDir, 'onboarding.json'),
      `${JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted', updatedAt: now, completedAt: now })}\n`,
    );

    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();
    await sleep(1500);

    // N1 打开工作流页
    check('渲染层就绪', await waitFor(`Boolean(document.querySelector('.h24-navrail'))`, '图标栏'));
    check('点图标栏工作流 tab', (await exec(`(function () {
      const btn = [...document.querySelectorAll('.h24-navrail-item')].find((n) => n.getAttribute('title') === '工作流');
      if (!btn) return 'missing';
      btn.click();
      return 'clicked';
    })()`)) === 'clicked');
    check('工作流页出现（空态）', await waitFor(`Boolean(document.querySelector('[data-testid="workflow-studio"]'))`, '工作流页'));
    check('空态文案', await waitFor(`Boolean(document.querySelector('[data-testid="workflow-studio"]')?.textContent.includes('还没有工作流'))`, '空态文案', 10000));

    // N2 新建 → 画布
    check('点新建工作流', (await exec(`(function () {
      const btn = [...document.querySelectorAll('button')].find((n) => n.textContent?.trim() === '新建工作流');
      if (!btn || btn.disabled) return 'missing';
      btn.click();
      return 'clicked';
    })()`)) === 'clicked');
    check('画布挂载', await waitFor(`Boolean(document.querySelector('[data-testid="workflow-canvas"]'))`, '画布'));
    check('FlowGram 编辑器节点渲染', await waitFor(`document.querySelectorAll('[data-node-id]').length >= 2`, '编辑器节点', 45000));
    check('默认两节点渲染（输入/交付）', (await exec(`[...document.querySelectorAll('.h59-node')].filter(n=>n.getBoundingClientRect().width>100&&n.textContent.trim()).length`)) >= 2, await exec(`document.querySelectorAll('[data-node-id]').length`));

    // N3 保存＋发布
    check('点保存草稿', (await exec(`(function () {
      const btn = [...document.querySelectorAll('button')].find((n) => n.textContent?.trim() === '保存草稿');
      if (!btn || btn.disabled) return 'missing';
      btn.click();
      return 'clicked';
    })()`)) === 'clicked');
    check('桥暴露 workflowSaveDraft', (await exec(`typeof window.hemiVoice?.workflowSaveDraft`)) === 'function', await exec(`typeof window.hemiVoice?.workflowSaveDraft`));
    check('草稿保存成功', await waitFor(`Boolean([...document.querySelectorAll('[role="status"]')].some((n) => n.textContent?.includes('草稿已保存')))`, '保存浮条'));
    check('点保存并发布', (await exec(`(function () {
      const btn = [...document.querySelectorAll('button')].find((n) => n.textContent?.trim() === '保存并发布');
      if (!btn || btn.disabled) return 'missing';
      btn.click();
      return 'clicked';
    })()`)) === 'clicked');
    check('发布成功', await waitFor(`Boolean([...document.querySelectorAll('[role="status"]')].some((n) => n.textContent?.includes('已发布新版本')))`, '发布浮条'));

    // N4 返回列表
    check('点返回', (await exec(`(function () {
      const btn = [...document.querySelectorAll('button')].find((n) => n.textContent?.trim() === '返回');
      if (!btn) return 'missing';
      btn.click();
      return 'clicked';
    })()`)) === 'clicked');
    check('列表条目出现（v1）', await waitFor(`Boolean([...document.querySelectorAll('[data-testid="workflow-row"]')].some((n) => n.textContent?.includes('v1')))`, '列表条目'));

    // N5 预览
    check('点预览', (await exec(`(function () {
      const btn = [...document.querySelectorAll('[data-testid="workflow-row"] button')].find((n) => n.textContent?.trim() === '预览');
      if (!btn || btn.disabled) return 'missing';
      btn.click();
      return 'clicked';
    })()`)) === 'clicked');
    check('预览面板出现', await waitFor(`Boolean(document.querySelector('[data-testid="workflow-definition-preview"]'))`, '定义预览'));
    check('预览含节点结构（交付）', await waitFor(`Boolean(document.querySelector('[data-testid="workflow-definition-preview"]')?.textContent.includes('交付'))`, '节点列表', 15000));

    // N6 无会话也能主动创建关联对话；必填缺失只推准备卡，不启动。
    check('点新建对话', (await exec(`(function () {
      const btn = document.querySelector('button[aria-label="新建对话"]');
      if (!btn || btn.disabled) return 'missing';
      btn.click();
      return 'clicked';
    })()`)) === 'clicked');
    await sleep(600);
    check('回工作流页', (await exec(`(function () {
      const btn = [...document.querySelectorAll('.h24-navrail-item')].find((n) => n.getAttribute('title') === '工作流');
      if (!btn) return 'missing';
      btn.click();
      return 'clicked';
    })()`)) === 'clicked');
    check('无会话时也可去对话运行', (await exec(`(function () {
      const btn = [...document.querySelectorAll('[data-testid="workflow-row"] button')].find((n) => n.textContent?.trim() === '去对话运行');
      if(!btn||btn.disabled)return false;btn.click();return true;
    })()`))===true);
    check('缺参准备卡可见且不能开始',await waitFor(`Boolean([...document.querySelectorAll('[data-testid="workflow-card"][data-status="preparing"] button')].find(b=>b.textContent==='开始运行')?.disabled)`,'准备卡缺参'));


    finish(results.every((item) => item.ok) ? 0 : 1);
  } catch (error) {
    log.error(`走查异常：${error?.stack ?? error}`);
    finish(1);
  }
});

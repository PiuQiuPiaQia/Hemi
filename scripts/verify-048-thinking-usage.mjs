// 048 真机验收（AC-01～07 对话侧）：隔离 userData 起真实应用，经真实 DOM 发
// 思考题——断言思考折叠头三态（思考中计时＋最新一行 / 已思考可展开 / 思考已
// 中断）、用量入口与面板、重开会话回看（内容与当时一致）、面板数字与会话
// 档案账本＋hemi.log 对账。逐阶段截图留证。
//
// 运行（openai 方言，默认 deepseek-flash）：
//   HEMI_SMOKE_TEST=1 HEMI_USER_DATA_DIR=/tmp/hemi-048-verify-a npx electron scripts/verify-048-thinking-usage.mjs
// 指定方言：HEMI_VERIFY_048_MODEL=vvcode（default 模型换成 claude-opus-5-5）
//   HEMI_SMOKE_TEST=1 HEMI_VERIFY_048_MODEL=vvcode HEMI_USER_DATA_DIR=/tmp/hemi-048-verify-b npx electron scripts/verify-048-thinking-usage.mjs
import { app } from 'electron';
import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const { initializeStableSafeStorageIdentity } = await import('../src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await import('../src/main/ipc/index.mjs');
const { createMainWindow } = await import('../src/main/windows/main-window.mjs');
const { state: appState } = await import('../src/main/state.mjs');
const { createLogger } = await import('../src/main/lib/logger.mjs');
const { installNativeShell } = await import('../src/main/windows/native-shell.mjs');
const { openExternalIfAllowed } = await import('../src/main/lib/external-links.mjs');

const log = createLogger('verify-048');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 220)}` : ''}`);
};
let finished = false;
const finish = (code) => {
  if (finished) return;
  finished = true;
  console.log(`HEMI_048_VERIFY_RESULT=${JSON.stringify({ passed: results.every((item) => item.ok), checks: results })}`);
  setTimeout(() => app.exit(code), 400);
};

const exec = (code, ms = 10_000) => {
  const contents = appState.mainWindow.webContents;
  return Promise.race([
    contents.executeJavaScript(code),
    new Promise((resolve) => setTimeout(() => resolve('__timeout__'), ms)),
  ]).catch((error) => `__error__:${error?.message}`);
};
const waitFor = async (predicateScript, label, timeoutMs = 30_000, intervalMs = 250) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await exec(predicateScript)) === true) return true;
    await sleep(intervalMs);
  }
  log.warn(`等待超时：${label}`);
  return false;
};
const shotDir = path.resolve(process.cwd(), '.visual/workflow/vision/048/real');
const screenshot = async (name) => {
  try {
    const image = await appState.mainWindow.webContents.capturePage();
    await mkdir(shotDir, { recursive: true });
    await writeFile(path.join(shotDir, `${name}.png`), image.toPNG());
    console.log(`  📷 ${name}.png`);
  } catch (error) {
    log.warn(`截图失败（${name}）：${error.message}`);
  }
};

/** 难题（探针同款）：逼推理模型真正长思考。 */
const HARD_QUESTION = '有 12 枚外观相同的硬币，其中恰有一枚重量不同（不知偏轻偏重）。用天平称 3 次找出它并判断轻重。请给出完整称法，最后用两三句话总结。';
// 中断轮用同款难题：保证思考流在跑（软题可能不思考，停不到点上）。
const SOFT_QUESTION = HARD_QUESTION;

/** 往受控 textarea 注入文本并派发 input（React 19 受控注入口径）。 */
const setDraft = (text) => exec(`(function () {
  const el = document.querySelector('.text-composer-input');
  if (!el) return 'no-input';
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(el, ${JSON.stringify(text)});
  el.dispatchEvent(new Event('input', { bubbles: true }));
  return 'ok';
})()`);

const clickSend = () => exec(`(function () {
  const btn = document.querySelector('button[aria-label="发送消息"]');
  if (!btn || btn.disabled) return 'no-send';
  btn.click();
  return 'ok';
})()`);

const clickStop = () => exec(`(function () {
  const btn = document.querySelector('button[aria-label="停止回应"]');
  if (!btn) return 'no-stop';
  btn.click();
  return 'ok';
})()`);

const thinkingState = (state) => exec(`(function () {
  const node = document.querySelector('.h48-thinking[data-state=${JSON.stringify(state)}] .h48-thinking-head');
  if (!node) return null;
  const latest = node.querySelector('.h48-thinking-latest');
  return { label: (node.querySelector('.h48-thinking-label')?.textContent ?? '').trim(),
           text: (node.textContent ?? '').trim().slice(0, 120),
           latest: latest ? (latest.textContent ?? '').trim() : null };
})()`);

const clickThinkingHead = (state) => exec(`(function () {
  const node = document.querySelector('.h48-thinking[data-state=${JSON.stringify(state)}] .h48-thinking-head');
  if (!node) return 'missing';
  node.click();
  return 'ok';
})()`);

const thinkingBodyText = (state) => exec(`(function () {
  const body = document.querySelector('.h48-thinking[data-state=${JSON.stringify(state)}] .h48-thinking-body');
  return body ? (body.textContent ?? '') : null;
})()`);

// ---- 启动 ----
app.setName('hemi');
const userDataDir = path.resolve(process.env.HEMI_USER_DATA_DIR ?? '/tmp/hemi-048-verify');
await rm(userDataDir, { recursive: true, force: true });
app.setPath('userData', userDataDir);
const dialect = process.env.HEMI_VERIFY_048_MODEL === 'vvcode' ? 'anthropic' : 'openai';

app.whenReady().then(async () => {
  try {
    initializeStableSafeStorageIdentity();
    // 配置五件套（safeStorage 同机可解密）＋ onboarding 完成态。
    const real = path.join(app.getPath('appData'), 'hemi');
    for (const name of ['doubao-asr.json', 'text-model.json', 'text-model-profiles.json', 'web-search.json']) {
      await copyFile(path.join(real, name), path.join(userDataDir, name));
    }
    // 方言选择：vvcode → default 换 claude-opus-5-5（anthropic-messages）。
    if (dialect === 'anthropic') {
      const profilesPath = path.join(userDataDir, 'text-model-profiles.json');
      const profiles = JSON.parse(await readFile(profilesPath, 'utf8'));
      const vvcode = profiles.providers.find((item) => item.api === 'anthropic-messages');
      profiles.defaultModelId = `${vvcode.id}/${vvcode.models[0].id}`;
      await writeFile(profilesPath, JSON.stringify(profiles, null, 2));
    }
    const now = Date.now();
    await writeFile(
      path.join(userDataDir, 'onboarding.json'),
      `${JSON.stringify({ version: 1, phase: 'complete', step: 'done', permissionChoice: 'granted', updatedAt: now, completedAt: now })}\n`,
    );

    await registerAllIpcHandlers();
    const { Menu } = await import('electron');
    installNativeShell({ app, Menu, platform: process.platform, appName: 'Hemi', devTools: !app.isPackaged, openExternal: openExternalIfAllowed });
    await createMainWindow();
    await sleep(1200);
    check(`[${dialect}] 主窗口就绪（输入框可用）`, await waitFor(`Boolean(document.querySelector('.text-composer-input'))`, '输入框'));

    // —— 轮 1：难题长思考 ——
    if ((await setDraft(HARD_QUESTION)) !== 'ok') return check('轮 1 注入草稿', false) || finish(1);
    if ((await clickSend()) !== 'ok') { check('轮 1 点发送', false, '发送键不可用'); return finish(1); }
    check(`[${dialect}] 轮 1 难题已发送`, true);

    const streamingSeen = await waitFor(`Boolean(document.querySelector('.h48-thinking[data-state=' + JSON.stringify('streaming') + ']'))`, '思考折叠头（思考中）', 60_000);
    check(`[${dialect}] AC-01/02 思考中折叠头出现（计时亮起）`, streamingSeen);
    if (streamingSeen) {
      await sleep(2500); // 让计时走几秒、最新一行有内容（Claude 摘要式首片可晚到）
      const stream = await thinkingState('streaming');
      check(`[${dialect}] 思考中文案含计时`, /思考中/.test(stream?.text ?? '') && /·\s*\d+s/.test(stream?.text ?? ''), stream?.text);
      await screenshot(`verify-${dialect}-streaming`);
    }

    // 完成：转录条目带 done 折叠头（正文可能仍在流式，等转录落定）。
    const doneSeen = await waitFor(`Boolean(document.querySelector('.h48-thinking[data-state=' + JSON.stringify('done') + '] .h48-thinking-head'))`, '已思考折叠头', 150_000);
    check(`[${dialect}] 完成后收成「已思考 Ns」`, doneSeen && /已思考/.test((await thinkingState('done'))?.text ?? ''), (await thinkingState('done'))?.text);
    await waitFor(`Boolean(document.querySelector('.h24-hemi-message .chat-copy'))`, '回复正文入流', 30_000);
    await screenshot(`verify-${dialect}-done`);

    // 展开：点折叠头，展开区有思考全文。
    await clickThinkingHead('done');
    const expandedText = await thinkingBodyText('done');
    check(`[${dialect}] 点开可看思考全文`, typeof expandedText === 'string' && expandedText.trim().length > 20, `展开 ${expandedText?.length ?? 0} 字`);
    await screenshot(`verify-${dialect}-expanded`);

    // —— 轮 2：中途停止 ——
    if ((await setDraft(SOFT_QUESTION)) !== 'ok') return finish(1);
    if ((await clickSend()) !== 'ok') return finish(1);
    const stopStreaming = await waitFor(`Boolean(document.querySelector('.h48-thinking[data-state=' + JSON.stringify('streaming') + ']'))`, '轮 2 思考中', 60_000);
    if (stopStreaming) {
      // Claude 摘要式思考首片可晚到（探针 10.3s）：等最新一行有文字再停——
      // 验证「已收到思考后中断」的 AC-06 主路径（无文字中断的形态属产品裁决，不在本测）。
      await waitFor(`Boolean(document.querySelector('.h48-thinking[data-state=' + JSON.stringify('streaming') + '] .h48-thinking-latest'))`, '思考文字到达', 45_000);
      const stopped = await clickStop();
      check(`[${dialect}] 轮 2 停止已点击`, stopped === 'ok', stopped);
    } else {
      check(`[${dialect}] 轮 2 思考中`, false, '等不到思考头（无法测停止）');
    }
    const interrupted = await waitFor(`Boolean(document.querySelector('.h48-thinking[data-state=' + JSON.stringify('interrupted') + ']'))`, '思考已中断留痕', 15_000);
    check(`[${dialect}] AC-06 中断轮显示「思考已中断 · Ns」`, interrupted, (await thinkingState('interrupted'))?.text);
    if (interrupted) {
      await clickThinkingHead('interrupted');
      check(`[${dialect}] 中断思考仍可展开`, ((await thinkingBodyText('interrupted')) ?? '').trim().length > 0);
      await screenshot(`verify-${dialect}-interrupted`);
    }

    // —— 用量入口与面板（AC-07）——
    const entrySeen = await waitFor(`Boolean(document.querySelector('.h48-usage-entry'))`, '用量入口', 15_000);
    check(`[${dialect}] 输入框下出现用量入口`, entrySeen);
    if (entrySeen) {
      const entryText = await exec(`(document.querySelector('.h48-usage-entry')?.textContent ?? '').trim()`);
      check(`[${dialect}] 入口文案（总量＋缓存命中）`, /tokens/.test(entryText) && /命中/.test(entryText), entryText);
      await screenshot(`verify-${dialect}-usage-entry`);
      await exec(`document.querySelector('.h48-usage-entry')?.click()`);
      const panelSeen = await waitFor(`Boolean(document.querySelector('.h48-usage-panel'))`, '用量面板', 5000);
      check(`[${dialect}] 面板打开（表头＋总计＋筛选＋表）`, panelSeen
        && Boolean(await exec(`Boolean(document.querySelector('.h48-usage-panel .h37-info-title') && document.querySelector('.h48-usage-totals') && document.querySelector('.h48-usage-table tbody'))`)));
      await screenshot(`verify-${dialect}-usage-panel`);
      await exec(`document.querySelector('.h48-usage-entry')?.click()`);
    }

    // —— 重开会话（AC-04）：reload 后启动种子化铺回档案 ——
    await sleep(1500); // 等防抖落盘（800ms）
    appState.mainWindow.webContents.reload();
    await sleep(1500);
    const reopened = await waitFor(`Boolean(document.querySelector('.h48-thinking[data-state=' + JSON.stringify('done') + '] .h48-thinking-head'))`, '重开后已思考折叠头', 30_000);
    check(`[${dialect}] AC-04 重开会话回看「已思考 Ns」`, reopened);
    if (reopened) {
      await clickThinkingHead('done');
      const reopenedText = (await thinkingBodyText('done')) ?? '';
      check(`[${dialect}] 重开后思考全文与当时一致`, reopenedText === (expandedText ?? ''), `${reopenedText.length} vs ${expandedText?.length ?? 0} 字`);
      await screenshot(`verify-${dialect}-reopened`);
    }

    // —— 对账：会话档案账本 / turn usage 与入口数字 ——
    const convDir = path.join(userDataDir, 'conversations');
    const convFiles = (await import('node:fs')).readdirSync(convDir).filter((name) => name.endsWith('.json'));
    const archive = convFiles.length
      ? JSON.parse(await readFile(path.join(convDir, convFiles[0]), 'utf8'))
      : null;
    check(`[${dialect}] 会话档案已落盘（含账本）`, Boolean(archive?.usageLedger?.length), `ledger ${archive?.usageLedger?.length ?? 0} 条`);
    if (archive) {
      const thinkingTurns = archive.turns.filter((turn) => turn.author === 'hemi' && turn.thinking);
      check(`[${dialect}] 思考随档案落盘（done＋interrupted）`, thinkingTurns.length >= 2
        && thinkingTurns.some((turn) => turn.thinking.interrupted === true)
        && thinkingTurns.some((turn) => !turn.thinking.interrupted), `${thinkingTurns.length} 条思考轮`);
      const usageTurns = archive.turns.filter((turn) => turn.author === 'hemi' && turn.usage);
      check(`[${dialect}] turn 级用量随档案落盘`, usageTurns.length >= 1, `${usageTurns.length} 条用量轮`);
      const ledgerTotal = (archive.usageLedger ?? []).reduce(
        (sum, record) => sum + record.input + record.cacheRead + record.cacheWrite + record.output, 0);
      const logText = await readFile(path.join(userDataDir, 'hemi.log'), 'utf8').catch(() => '');
      const usageLines = (logText.match(/轮 usage 入/g) ?? []).length;
      // 对账口径：llm.ipc 的 usage 行只记对话轮（chat/fallback）；自动标题/回炉
      // 不经 llm.ipc 循环，账本单列。中断轮 abort 不回 usage，两边都不计。
      const chatLedger = (archive.usageLedger ?? []).filter((record) => record.source === 'chat' || record.source === 'fallback');
      check(`[${dialect}] 对话轮账本条数＝hemi.log 用量行数`, chatLedger.length === usageLines, `chat 账本 ${chatLedger.length} vs log ${usageLines}`);
      console.log(`  账本合计 ${ledgerTotal} tokens · ${JSON.stringify((archive.usageLedger ?? []).map((r) => ({ source: r.source, key: r.modelKey, missing: r.missing ?? 0 })))}`);
    }

    finish(results.every((item) => item.ok) ? 0 : 1);
  } catch (error) {
    console.error(`验收脚本异常：${error?.stack ?? error}`);
    finish(1);
  }
});

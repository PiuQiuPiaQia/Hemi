#!/usr/bin/env node
/**
 * 028/029/030/031 统一真机走查 harness（开发/验收，非产品链路）。
 *
 * 前置（与 027 走查同口径）：应用以 HEMI_TEST_MIC_GRANT=1（产品自带测试缝隙，
 * 见 src/main/ipc/permissions.ipc.mjs）+ 隔离 userData 在 9222 上运行。
 *
 * 覆盖：
 *  - 028：合成 paste 事件带真实 PNG（页面 onPaste → 主进程登记 → 托盘 →
 *    预览 Tab → 随消息发送 → 历史 chips）。文件选择窗是系统 UI 无法自动化，
 *    粘贴是同级 P0 入口，链路等价；模型侧证据看 hemi.log「携带消息附件」。
 *  - 029：在途回合点停止键 → 靶向取消、输入恢复、用户消息保留、草稿可写。
 *    （deepseek 单轮直答不走流式分片，部分增量冻结由 fixtures 覆盖。）
 *  - 031：模型 chip 渲染、下拉可选、Esc 回触发器（双组真实路由需第二组凭据，
 *    留待用户验收；迁移与快照贯通另有单测与日志证据）。
 *  - 030（--drafts 模式）：重启后会话草稿与新对话草稿槽恢复。
 *
 * 用法：node scripts/real-app-composer-verify.mjs [--drafts]
 * 产物：.visual/workflow/vision/composer-verify/（截图 + JSON）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const OUT = resolve(process.cwd(), '.visual/workflow/vision/composer-verify');
mkdirSync(OUT, { recursive: true });
const CDP = 'http://127.0.0.1:9222';
const DRAFTS_MODE = process.argv.includes('--drafts');
const BATCH2_MODE = process.argv.includes('--batch2');

const results = [];
const record = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let conn = null;
let errors = [];

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const target = list.find(
    (t) => t.type === 'page' && t.title.includes('Hemi') && !/mode=(orb|caption|task-popover)/.test(t.url),
  );
  if (!target) throw new Error('main window target not found');
  const ws = new WebSocket(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((r, j) => {
    ws.once('open', r);
    ws.once('error', j);
  });
  let seq = 0;
  const pending = new Map();
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw);
    if (msg.id && pending.has(msg.id)) {
      const { resolve: ok, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else ok(msg.result);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      errors.push(msg.params.exceptionDetails?.exception?.description ?? JSON.stringify(msg.params).slice(0, 200));
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (!text.includes('Insecure Content-Security-Policy')) errors.push(`[console.${msg.params.type}] ${text.slice(0, 200)}`);
    }
  });
  ws.on('close', () => {
    for (const { reject } of pending.values()) reject(new Error('cdp ws closed'));
    pending.clear();
  });
  const call = (method, params = {}) =>
    new Promise((resolvePromise, rejectPromise) => {
      const id = ++seq;
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectPromise(new Error(`cdp call timeout: ${method}`));
      }, 20_000);
      pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolvePromise(v); },
        reject: (e) => { clearTimeout(timer); rejectPromise(e); },
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await call('Page.enable');
  await call('Runtime.enable');
  return { ws, call };
}

async function withConn(fn) {
  try {
    if (!conn) conn = await connect();
    return await fn(conn.call);
  } catch (error) {
    console.log(`（连接中断（${String(error).slice(0, 50)}），重连重试）`);
    try { conn?.ws.close(); } catch {}
    conn = await connect();
    return await fn(conn.call);
  }
}

const rt = (expression) =>
  withConn((call) => call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }))
    .then((r) => {
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
      return r.result.value;
    });

async function click(selectorJs) {
  const rect = await rt(`(() => {
    const el = ${selectorJs};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!rect) return false;
  await withConn((call) => call('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }));
  await withConn((call) => call('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', clickCount: 1 }));
  return true;
}

/** React 受控 textarea 清空（原生 setter ＋ input 事件，onChange 才会收到）。 */
async function clearComposer() {
  await rt(`(() => {
    const el = document.querySelector('.text-composer-input');
    if (!el) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
}

async function typeText(text) {
  await withConn((call) => call('Input.insertText', { text }));
}

async function waitFor(label, read, timeoutMs = 30_000, interval = 500) {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!value && Date.now() < deadline) {
    await sleep(interval);
    value = await read();
  }
  if (!value) throw new Error(`等待超时：${label}`);
  return value;
}

async function shot(name) {
  await withConn((call) => call('Page.captureScreenshot', { format: 'png' })).then(({ data }) => {
    writeFileSync(resolve(OUT, name), Buffer.from(data, 'base64'));
    console.log(`saved ${name}`);
  });
}

const composerValue = () => rt(`document.querySelector('.text-composer-input')?.value ?? ''`);
/** 回合结束信号：busy 态发送键是停止键（不再 disabled）——非停止态且无流式/思考指示。 */
const turnIdle = () =>
  rt(`(() => { const btn = document.querySelector('.text-composer-send'); const busy = document.querySelector('.streaming-copy, .thinking-copy'); return Boolean(btn) && !document.querySelector('.text-composer-stop') && !btn.className.includes('is-stop') && !busy; })()`);

try {
  await withConn((call) => call('Page.reload', { ignoreCache: true }));
  await waitFor('主窗渲染', () => rt(`Boolean(document.querySelector('.text-composer'))`), 40_000);

  if (BATCH2_MODE) {
    // —— 前置：发一条消息（供历史找回）＋粘贴图片发送（供 @ 引用候选）。 ——
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await typeText('简单回我一句：收到就好，不用做事。');
    await click('document.querySelector(".text-composer-send")');
    await waitFor('前置回合结束', () => turnIdle(), 120_000, 800);

    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await rt(`(() => {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const dt = new DataTransfer();
      dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
      document.querySelector('.text-composer-input').dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
      return true;
    })()`);
    await sleep(1200);
    await typeText('看一下这张图。');
    await click('document.querySelector(".text-composer-send")');
    await waitFor('附件回合结束', () => turnIdle(), 150_000, 800);
    record(true, '二批前置：历史与附件候选就绪');

    // —— 030 二批：↑ 历史找回 + Esc 恢复原草稿。 ——
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await typeText('刚刚写的原稿');
    await sleep(300);
    await rt(`(() => { const el = document.querySelector('.text-composer-input'); el.setSelectionRange(0, 0); el.focus(); return true; })()`);
    await withConn((call) => call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 }));
    await withConn((call) => call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowUp', code: 'ArrowUp', windowsVirtualKeyCode: 38, nativeVirtualKeyCode: 38 }));
    await sleep(500);
    const recalled = await composerValue();
    record(recalled !== '刚刚写的原稿' && recalled.length > 0, '030 ↑ 找回最近一条已发送输入', `「${recalled.slice(0, 20)}」`);
    await withConn((call) => call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }));
    await withConn((call) => call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 }));
    await sleep(400);
    record((await composerValue()) === '刚刚写的原稿', '030 Esc 恢复原草稿', `「${(await composerValue()).slice(0, 16)}」`);
    await shot('b2-history-recall.png');

    // —— 031 二批：/model 命令菜单。 ——
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await typeText('/model');
    await sleep(600);
    const cmdOpen = await rt(`Boolean(document.querySelector('.h24-command-menu'))`);
    record(cmdOpen, '031 /model 命令菜单弹出');
    if (cmdOpen) {
      await shot('b2-command-menu.png');
      await withConn((call) => call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }));
      await withConn((call) => call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 }));
      await sleep(500);
      record((await composerValue()) === '', '031 Enter 选中配置组并清命令文本');
    }

    // —— 028 二批：@ 引用插入 → 芯片 → 发送（模型侧证据看 hemi.log 携带引用）。 ——
    await click('document.querySelector(".text-composer-input")');
    await typeText('参考 @');
    await sleep(1200);
    const mentionOpen = await rt(`Boolean(document.querySelector('.h24-mention-menu'))`);
    record(mentionOpen, '028 @ 引用候选弹出');
    if (mentionOpen) {
      await shot('b2-mention-menu.png');
      await click(`document.querySelector('.h24-mention-menu .h24-model-item')`);
      await sleep(600);
      const chipCount = await rt(`document.querySelectorAll('.h24-attach-card[data-kind="reference"]').length`);
      const composerHasName = await composerValue();
      record(chipCount === 1 && composerHasName.includes('@'), '028 插入引用：芯片＋@正文', `chip=${chipCount}，「${composerHasName.slice(0, 24)}」`);
      await shot('b2-reference-chip.png');
      await click('document.querySelector(".text-composer-send")');
      await waitFor('引用回合结束', () => turnIdle(), 120_000, 800);
      const refChips = await rt(`document.querySelectorAll('.h24-msg-attachment').length`);
      record(refChips >= 1, '028 引用随消息入史（chips）', `${refChips} 枚`);
      await shot('b2-reference-sent.png');
    }

    // —— 029 二批：在途回合发送 → 方式菜单 → 排队 → 停止暂停 → 继续发送清队。 ——
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await typeText('写一段 400 字的散文，主题是雨后的山路，慢慢写。');
    await click('document.querySelector(".text-composer-send")');
    const sendDiag = await rt(`(() => ({ value: document.querySelector('.text-composer-input')?.value ?? '', btn: document.querySelector('.text-composer-send')?.className ?? '', disabled: document.querySelector('.text-composer-send')?.disabled ?? null }))()`);
    console.log('（029 散文发送诊断）', JSON.stringify(sendDiag));
    await waitFor('停止键出现', () => rt(`Boolean(document.querySelector('.text-composer-stop, .text-composer-send.is-stop'))`), 60_000, 300);
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await typeText('写完后帮我起三个标题。');
    await click('document.querySelector(".text-composer-send")');
    await sleep(700);
    const menuOpen = await rt(`Boolean(document.querySelector('.h24-send-method'))`);
    record(menuOpen, '029 在途发送弹方式菜单');
    await shot('b2-send-method.png');
    if (menuOpen) {
      await rt(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(400);
      const menuClosed = !(await rt(`Boolean(document.querySelector('.h24-send-method'))`));
      const draftKept = (await composerValue()).includes('起三个标题');
      const stillBusy = await rt(`Boolean(document.querySelector('.text-composer-stop, .text-composer-send.is-stop'))`);
      record(menuClosed && draftKept && stillBusy, '029 Esc 只关菜单（草稿保留、回合继续）');

      await click('document.querySelector(".text-composer-send")');
      await sleep(700);
      await click(`[...document.querySelectorAll('.h24-send-method .h24-model-item')].find((b) => b.textContent.includes('排队发送'))`);
      await sleep(900);
      const trayCount = await rt(`document.querySelectorAll('.h24-queue-item').length`);
      record(trayCount === 1, '029 排队入托盘', `${trayCount} 条`);
      await shot('b2-queue-tray.png');

      await click(`document.querySelector('.text-composer-stop, .text-composer-send.is-stop')`);
      await sleep(900);
      const pausedBanner = await rt(`Boolean(document.querySelector('.h24-queue-paused'))`);
      record(pausedBanner, '029 停止回应后面板显示队列已暂停');
      await shot('b2-queue-paused.png');
      const hemiCountBefore = await rt(`document.querySelectorAll('.h24-hemi-message').length`);
      await click('document.querySelector(".h24-queue-resume")');
      await waitFor('队列清空', () => rt(`document.querySelectorAll('.h24-queue-item').length === 0`), 120_000, 800);
      await waitFor('排队回复入流', () => rt(`document.querySelectorAll('.h24-hemi-message').length > ${hemiCountBefore}`), 60_000, 800);
      const queuedReplied = await rt(`document.querySelectorAll('.h24-hemi-message').length > ${hemiCountBefore}`);
      record(queuedReplied, '029 继续发送后队列条目发出并收到回复（回复条数增加）', `+${(await rt(`document.querySelectorAll('.h24-hemi-message').length`)) - hemiCountBefore} 条`);
      await shot('b2-queue-drained.png');
    }
  } else if (DRAFTS_MODE) {
    // —— 030 重启后恢复：上轮已写好会话 A 草稿与新对话草稿槽。冷启动自动
    //    继续最近会话（A），应直接见到 A 的草稿。 ——
    const restored = await waitFor('会话 A 草稿恢复', () => composerValue(), 20_000);
    record(restored.includes('A 会话的草稿'), '030 重启后最近会话草稿恢复', `「${restored.slice(0, 24)}」`);
    await shot('drafts-restored-a.png');
    await click('document.querySelector(".h24-sidebar-new")');
    await sleep(900);
    const newDraft = await waitFor('新对话草稿槽恢复', () => composerValue(), 15_000);
    record(newDraft.includes('新对话的未发送草稿'), '030 新建对话恢复草稿槽（未发送内容不因新建丢失）', `「${newDraft.slice(0, 24)}」`);
    await shot('drafts-restored-new.png');
  } else {
    // —— 030 准备：写 A 草稿（供重启模式验证）。 ——
    await click('document.querySelector(".text-composer-input")');
    await typeText('A 会话的草稿：第一行\n第二行待续');
    await sleep(900);
    record((await composerValue()).includes('A 会话的草稿'), '030 草稿随编辑防抖保存（内存态）');

    // —— 031：模型 chip 与下拉（真实应用只有迁移出的默认组）。 ——
    const chipVisible = await rt(`Boolean(document.querySelector('.h24-model-chip'))`);
    record(chipVisible, '031 输入区模型 chip 渲染');
    if (chipVisible) {
      await click('document.querySelector(".h24-model-chip")');
      await sleep(500);
      const menuItems = await rt(`document.querySelectorAll('.h24-model-item').length`);
      const activeItem = await rt(`document.querySelector('.h24-model-item[data-active="true"]')?.textContent?.trim().slice(0, 30) ?? null`);
      record(menuItems >= 1 && Boolean(activeItem), '031 选择器下拉列出配置组（迁移默认组）', `${menuItems} 项，当前「${activeItem}」`);
      await shot('model-menu.png');
      await rt(`document.querySelector('.h24-model-filter')?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await sleep(300);
      record(!(await rt(`Boolean(document.querySelector('.h24-model-menu'))`)), '031 Esc 关闭选择器回触发器');
    }

    // —— 028：先发一条真实消息建立会话身份。 ——
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await typeText('简单回我一句：收到就好，不用做事。');
    await click('document.querySelector(".text-composer-send")');
    await waitFor('首个回合结束', () => turnIdle(), 120_000, 800);
    record(true, '028 前置：真实回合完成（会话身份建立）');

    // —— 028 附件真实 UI 通路：合成 paste 事件带真实 PNG。 ——
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    const pasted = await rt(`(() => {
      const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const file = new File([bytes], 'pasted.png', { type: 'image/png' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const target = document.querySelector('.text-composer-input');
      target.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      return true;
    })()`);
    await sleep(1400);
    const trayCount = await rt(`document.querySelectorAll('.h24-attach-card').length`);
    record(pasted && trayCount === 1, '028 粘贴图片 → 登记进托盘（真实 UI 通路）', `${trayCount} 张卡`);
    await shot('attach-tray.png');

    // 附件预览进 027 宿主（粘贴图片正文是 <img>）。
    await click('document.querySelector(".h24-attach-open")');
    await sleep(1100);
    const attachTabs = await rt(`document.querySelectorAll('.h24-preview-tab').length`);
    const attachImg = await rt(`Boolean(document.querySelector('.h24-preview-body img'))`);
    record(attachTabs === 1 && attachImg, '028 附件预览进入 027 宿主（图片正文渲染）', `Tab ${attachTabs}，img=${attachImg}`);
    await shot('attach-preview.png');

    // 带附件发送 → 历史 chips（冻结身份入史）。
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await typeText('看一下这张图片长什么样，一句话概括。');
    await click('document.querySelector(".text-composer-send")');
    await waitFor('附件回合结束', () => turnIdle(), 150_000, 800);
    const chips = await rt(`document.querySelectorAll('.h24-msg-attachment').length`);
    record(chips >= 1, '028 历史消息附件 chips（冻结身份入史）', `${chips} 枚`);
    await shot('attach-sent-chips.png');

    // —— 029：在途回合中停止（靶向取消主场景）。 ——
    await clearComposer();
    await click('document.querySelector(".text-composer-input")');
    await typeText('写一段 500 字的散文，主题是冬夜的车站，慢慢写。');
    await click('document.querySelector(".text-composer-send")');
    await waitFor('停止键出现（回合并发中）', () => rt(`Boolean(document.querySelector('.text-composer-stop, .text-composer-send.is-stop'))`), 30_000, 300);
    await sleep(700);
    const stopClicked = await click(`document.querySelector('.text-composer-stop, .text-composer-send.is-stop')`);
    await sleep(900);
    const idleAgain = await turnIdle();
    const userKept = await rt(`[...document.querySelectorAll('.h24-user-bubble')].some((el) => el.textContent.includes('冬夜的车站'))`);
    record(stopClicked && idleAgain && userKept, '029 停止在途回合：靶向取消、输入恢复、用户消息保留', `点击=${stopClicked}，恢复=${idleAgain}，消息保留=${userKept}`);
    await click('document.querySelector(".text-composer-input")');
    await typeText('停止后继续写的草稿');
    await sleep(700);
    record((await composerValue()).includes('停止后继续写的草稿'), '029 停止后新草稿可写且保留');
    await shot('stopped.png');

    // —— 030 准备：清掉草稿，重写 A 草稿 → 新建对话写新草稿（供 --drafts 验证）。 ——
    await clearComposer();
    await sleep(600);
    await click('document.querySelector(".text-composer-input")');
    await typeText('A 会话的草稿：第一行\n第二行待续');
    await sleep(900);
    await click('document.querySelector(".h24-sidebar-new")');
    await sleep(900);
    await click('document.querySelector(".text-composer-input")');
    await typeText('新对话的未发送草稿：重启后要回来');
    await sleep(1400);
    record(true, '030 双草稿已备（A 会话 + 新对话槽），退出供重启验证');
  }

  writeFileSync(resolve(OUT, 'verify-result.json'), JSON.stringify({ results, errors }, null, 2));
  console.log(`\nconsole-errors: ${errors.length}`);
  for (const e of errors.slice(0, 8)) console.log(`  - ${e}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== composer 走查结果：${results.length - failed}/${results.length} 通过 ===`);
  conn?.ws.close();
  process.exit(failed || errors.length ? 3 : 0);
} catch (error) {
  results.push({ ok: false, name: 'harness 异常', detail: String(error?.message ?? error) });
  writeFileSync(resolve(OUT, 'verify-result.json'), JSON.stringify({ results, errors }, null, 2));
  console.error('[composer-verify] 异常：', error);
  try { conn?.ws.close(); } catch {}
  process.exit(4);
}

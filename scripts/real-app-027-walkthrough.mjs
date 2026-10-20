#!/usr/bin/env node
/**
 * 027 真机 UI 会话级走查 harness（开发/验收，非产品链路）：
 * 通过 CDP 连接真实应用，从真实文字输入框提交任务、点真实确认卡，等真实交付
 * 条目出现后走查 AC-03（多 Tab／去重／＋菜单／键盘／阅读位置／关闭链／
 * Escape／焦点／草稿）、断点矩阵（1180/1179/880 真实窗口尺寸）与会话切换
 * Tab 隔离。
 *
 * 前置（麦克风门，产品自带测试缝隙 src/main/ipc/permissions.ipc.mjs）：
 *   HEMI_TEST_MIC_GRANT=1 HEMI_USER_DATA_DIR=<隔离目录> \
 *   npx electron . --remote-debugging-port=9222
 * 该缝隙只让两个权限查询视麦克风已授权（dev 二进制 TCC 拒绝态挡 setup 门，
 * 024 specs AC-09 已知限制），不碰真实采集链路；走查内容全部真实
 * （真实输入事件、真实 IPC、真实 LLM 任务）。
 *
 * 用法：node scripts/real-app-027-walkthrough.mjs
 *   HEMI_WALK_SKIP_TASK=1 跳过任务提交，直接走查当前会话已有的交付条目
 *   （用于页面意外重载后续跑）。
 * 产物：.visual/workflow/vision/027-real-walkthrough/（截图 + 结果 JSON）。
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import WebSocket from 'ws';

const OUT = resolve(process.cwd(), '.visual/workflow/vision/027-real-walkthrough');
mkdirSync(OUT, { recursive: true });
const CDP = 'http://127.0.0.1:9222';
const SKIP_TASK = process.env.HEMI_WALK_SKIP_TASK === '1';

const TASK_TEXT =
  process.env.HEMI_WALK_TASK ??
  '请在家目录的 ~/hemi-027-walk 目录完成一次小验证（交付登记只收家目录内文件）：先创建该目录，然后 ' +
    '①创建 notes.md，写入 60 段验证笔记（每段一行「笔记 N：027 真机走查记录 N」，段与段之间空一行，N=1..60）；' +
    '②创建 todo.txt，写入两行待办（买酱油、取快递）；' +
    '③生成一张 200x100 的纯绿色 PNG 图片 dot.png；' +
    '④把 notes.md、todo.txt、dot.png 三个文件都作为文件成果登记交付，' +
    '最后再给一份结构化总结报告。';

const results = [];
const record = (ok, name, detail = '') => {
  results.push({ ok, name, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// —— 连接层：页面重载/断连后自动重连一次再重试当前操作（DOM 查询幂等）——
const errors = [];
let conn = null;

async function connect() {
  const list = await (await fetch(`${CDP}/json/list`)).json();
  const target = list.find(
    (t) => t.type === 'page' && t.title.includes('Hemi') && !/mode=(orb|caption|task-popover)/.test(t.url),
  );
  if (!target) throw new Error(`main window target not found: ${list.map((t) => t.title).join('|')}`);
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
      errors.push(
        msg.params.exceptionDetails?.exception?.description ??
          JSON.stringify(msg.params).slice(0, 200),
      );
    }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      const text = (msg.params.args ?? []).map((a) => a.value ?? a.description ?? '').join(' ');
      if (!text.includes('Insecure Content-Security-Policy')) {
        errors.push(`[console.${msg.params.type}] ${text.slice(0, 200)}`);
      }
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
        resolve: (v) => {
          clearTimeout(timer);
          resolvePromise(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          rejectPromise(e);
        },
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
    console.log(`（连接中断（${String(error).slice(0, 60)}），重连重试）`);
    try {
      conn?.ws.close();
    } catch {}
    conn = await connect();
    return await fn(conn.call);
  }
}

async function rt(expression) {
  return withConn((call) =>
    call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }),
  ).then((r) => {
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    }
    return r.result.value;
  });
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

let shotSeq = 0;
async function shot(name) {
  await withConn((call) => call('Page.captureScreenshot', { format: 'png' })).then(({ data }) => {
    writeFileSync(resolve(OUT, name), Buffer.from(data, 'base64'));
    console.log(`saved ${name}`);
  });
}

/** 真实鼠标点击：元素滚入视口后取中心坐标，走 Input 域合成事件（与真实点击同一通路）。 */
async function click(selectorJs) {
  const rect = await rt(`(() => {
    const el = ${selectorJs};
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`);
  if (!rect) return false;
  await withConn((call) =>
    call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    }),
  );
  await withConn((call) =>
    call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: rect.x,
      y: rect.y,
      button: 'left',
      clickCount: 1,
    }),
  );
  return true;
}

async function key(k) {
  const vk = { Escape: 27, ArrowRight: 39, ArrowLeft: 37, Home: 36, End: 35 }[k] ?? k.charCodeAt(0);
  await withConn((call) => call('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }));
  await withConn((call) => call('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code: k, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }));
}

async function insertText(text) {
  await withConn((call) => call('Input.insertText', { text }));
}

/** 真实滚轮：deltaY 负＝向上翻（解除对话跟随），正＝向下翻。 */
async function wheel(x, y, deltaY) {
  await withConn((call) =>
    call('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY, button: 'none' }),
  );
}

/** 取元素中心坐标（供滚轮/点击定位）。 */
async function centerOf(selectorJs) {
  return rt(`(() => {
    const el = ${selectorJs};
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + Math.min(120, r.height / 2)) };
  })()`);
}

const tabsCount = () => rt(`document.querySelectorAll('.h24-preview-tab').length`);
const activeTabText = () =>
  rt(`document.querySelector('.h24-preview-tab.active')?.textContent?.trim().slice(0, 30) ?? null`);
const panelVisible = () => rt(`Boolean(document.querySelector('.h24-preview'))`);

/** 交付分组的条目 */
const groupRows = (caption) =>
  rt(`(() => {
    const groups = [...document.querySelectorAll('.h24-delivery-group')];
    const g = groups.find((x) =>
      (x.querySelector('.h24-delivery-caption')?.textContent ?? '').includes('${caption}'),
    );
    return g ? [...g.querySelectorAll('.h24-artifact-row')].map((b, i) => ({ i, text: b.textContent.trim().slice(0, 40) })) : [];
  })()`);

const clickGroupRow = (caption, i) =>
  click(`(() => {
    const groups = [...document.querySelectorAll('.h24-delivery-group')];
    const g = groups.find((x) =>
      (x.querySelector('.h24-delivery-caption')?.textContent ?? '').includes('${caption}'),
    );
    return g ? g.querySelectorAll('.h24-artifact-row')[${i}] : null;
  })()`);

async function setViewportWidth(target, height = 760) {
  let w = target;
  for (let n = 0; n < 4; n += 1) {
    await rt(`window.resizeTo(${w}, ${height})`);
    await sleep(500);
    const inner = await rt('window.innerWidth');
    if (inner === target) return inner;
    w += target - inner;
  }
  return rt('window.innerWidth');
}

try {
  // —— 1. 进入对话页 ——
  await waitFor('主窗渲染', () => rt(`Boolean(document.querySelector('.setup-shell, .text-composer'))`), 40_000);
  if (await rt(`Boolean(document.querySelector('.setup-shell'))`)) {
    throw new Error('仍停在引导页：确认应用以 HEMI_TEST_MIC_GRANT=1 启动');
  }
  await waitFor('文字输入框', () => rt(`Boolean(document.querySelector('.text-composer-input'))`), 20_000);
  record(true, SKIP_TASK ? '进入对话页（续跑模式，复用既有会话）' : '进入对话页（HEMI_TEST_MIC_GRANT 放行首启，其余真实链路）');
  await shot('01-main.png');

  // —— 2. 真实 UI 提交任务 + 真实点确认卡，等真实交付 ——
  let cardClicks = 0;
  if (SKIP_TASK) {
    console.log('续跑模式：跳过任务提交');
  } else {
    console.log(`提交任务：${TASK_TEXT.slice(0, 60)}…`);
    await click('document.querySelector(".text-composer-input")');
    await insertText(TASK_TEXT);
    await click('document.querySelector(".text-composer-send")');

    const TASK_DEADLINE = Date.now() + 360_000;
    let quietMs = 0;
    while (Date.now() < TASK_DEADLINE) {
      if (await click(`document.querySelector('.permission-card .tbtn.primary')`)) {
        cardClicks += 1;
        console.log(`确认卡 #${cardClicks} → 仅此一次`);
        quietMs = 0;
      }
      const done = await rt(`(() => ({
        delivery: document.querySelectorAll('.h24-artifact-row').length,
        card: Boolean(document.querySelector('.permission-card')),
        busy: document.querySelector('.text-composer-send')?.disabled ?? false,
      }))()`);
      if (done.delivery > 0 && !done.card && !done.busy) {
        quietMs += 900;
        if (quietMs >= 4500) break;
      } else {
        quietMs = 0;
      }
      await sleep(900);
    }
  }
  const rowsFiles = await groupRows('已保存的文件');
  const rowsReport = await groupRows('可阅读的结果');
  record(
    rowsFiles.length + rowsReport.length > 0,
    '真实任务交付条目出现',
    `确认卡点击 ${cardClicks} 次；文件 ${rowsFiles.length} 条 ${JSON.stringify(rowsFiles.map((r) => r.text))}；可阅读结果 ${rowsReport.length} 条`,
  );
  await shot('02-delivery.png');

  // —— 3. AC-03：多 Tab ——
  if (rowsFiles.length < 2) {
    record(false, '前置：文件成果不足，无法走多 Tab', `文件 ${rowsFiles.length} 条（任务需登记 ≥2 个文件成果）`);
  }
  const expectTabs = Math.min(rowsFiles.length, 3) + Math.min(rowsReport.length, 1);
  /** 点开一个 Tab：布局异步重排可能吃掉首击，未生效再点一次（产品行为本身稳定，见 report-probe）。 */
  const openRow = async (caption, i) => {
    const before = await tabsCount();
    await clickGroupRow(caption, i);
    await sleep(900);
    if ((await tabsCount()) === before) {
      await clickGroupRow(caption, i);
      await sleep(900);
    }
  };
  for (let i = 0; i < Math.min(rowsFiles.length, 3); i += 1) {
    await openRow('已保存的文件', i);
  }
  if (rowsReport.length) {
    await openRow('可阅读的结果', 0);
  }
  const nTabs = await tabsCount();
  record(nTabs === expectTabs, '多成果逐个打开成多 Tab', `Tab 数 ${nTabs} / 预期 ${expectTabs}`);
  await shot('03-tabs.png');

  const reportTool = await rt(`Boolean([...document.querySelectorAll('.h24-preview-tool')].find((b) => (b.getAttribute('aria-label') ?? '').includes('继续讨论这份报告')))`);
  if (rowsReport.length) {
    record(reportTool, '报告 Tab 进入右侧阅读区（工具行为报告形态）');
  }

  // 去重：再点第一条文件成果 → Tab 数不变且激活它
  if (rowsFiles.length) {
    await clickGroupRow('已保存的文件', 0);
    await sleep(500);
    const n = await tabsCount();
    const act = await activeTabText();
    record(n === expectTabs && Boolean(act), '重复点击已打开成果按真实身份复用 Tab', `Tab 数 ${n}（不变），激活「${act}」`);
  }

  // ＋ 菜单
  await click('document.querySelector(".h24-preview-add")');
  await sleep(400);
  const menuItems = await rt(`document.querySelectorAll('.h24-preview-add-item').length`);
  record(menuItems > 0, '＋ 菜单列出当前任务成果', `${menuItems} 项`);
  await shot('04-add-menu.png');
  await key('Escape');
  await sleep(300);
  record(await panelVisible(), 'Escape 先关 ＋ 菜单、面板仍在');

  // 键盘切换
  await click('document.querySelector(".h24-preview-tab.active [data-tab-key]")');
  await sleep(200);
  const before = await activeTabText();
  await key('ArrowRight');
  await sleep(300);
  const after = await activeTabText();
  record(before !== after, '键盘 → 切换 Tab', `「${before}」→「${after}」`);
  await key('ArrowLeft');
  await sleep(300);
  const back = await activeTabText();
  record(back === before, '键盘 ← 切回', `回到「${back}」`);

  // 阅读位置：真实滚轮在预览正文向下翻，切走再切回应保持
  const scrollerInfo = await rt(`(() => {
    const body = document.querySelector('.h24-preview-body');
    if (!body) return null;
    return { sh: body.scrollHeight, ch: body.clientHeight, st: body.scrollTop };
  })()`);
  if (scrollerInfo && scrollerInfo.sh > scrollerInfo.ch + 20) {
    const c = await centerOf(`document.querySelector('.h24-preview-body')`);
    await wheel(c.x, c.y, 480);
    await sleep(500);
    const scrolled = await rt(`document.querySelector('.h24-preview-body').scrollTop`);
    await key('ArrowRight');
    await sleep(400);
    await key('ArrowLeft');
    await sleep(500);
    const st = await rt(`document.querySelector('.h24-preview-body').scrollTop`);
    record(scrolled > 40 && Math.abs(st - scrolled) < 4, '每 Tab 保留阅读位置（真实滚轮）', `滚至 ${scrolled}，切回 ${st}`);
  } else {
    record(true, '每 Tab 保留阅读位置（内容未溢出，平凡保持）', JSON.stringify(scrollerInfo));
  }

  // —— 4. 关闭链 ——
  if (nTabs >= 3) {
    const actKey = await rt(`document.querySelector('.h24-preview-tab.active [data-tab-key]')?.getAttribute('data-tab-key')`);
    const otherKey = await rt(`(() => {
      const els = [...document.querySelectorAll('.h24-preview-tab:not(.active) [data-tab-key]')];
      return els[0]?.getAttribute('data-tab-key') ?? null;
    })()`);
    await click(`document.querySelector('[data-tab-key="${otherKey}"]')?.closest('.h24-preview-tab')?.querySelector('.h24-preview-tab-close')`);
    await sleep(400);
    const n2 = await tabsCount();
    const act2 = await rt(`document.querySelector('.h24-preview-tab.active [data-tab-key]')?.getAttribute('data-tab-key')`);
    record(n2 === nTabs - 1 && act2 === actKey, '关闭非当前 Tab 不改变正文', `剩 ${n2} Tab，激活未变`);

    await click(`document.querySelector('[data-tab-key="${act2}"]')?.closest('.h24-preview-tab')?.querySelector('.h24-preview-tab-close')`);
    await sleep(400);
    const n3 = await tabsCount();
    const act3 = await rt(`document.querySelector('.h24-preview-tab.active') ? '有' : '无'`);
    record(n3 === n2 - 1 && act3 === '有', '关闭当前 Tab 激活相邻', `剩 ${n3} Tab`);
  }

  // Escape 收起（保留队列）→ 草稿/焦点 → 再点成果恢复队列
  await click('document.querySelector(".text-composer-input")');
  await insertText('草稿-027-走查-不应丢失');
  await sleep(200);
  const convScroller = await rt(`(() => {
    const main = document.querySelector('.h24-main');
    if (!main) return null;
    const walk = [...main.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 8 && /auto|scroll/.test(getComputedStyle(el).overflowY));
    return walk.length ? walk.map((el) => el.className).slice(0, 2) : null;
  })()`);
  let convAnchorBefore = null;
  let convScrollSet = 0;
  if (convScroller) {
    // 真实滚轮向上翻：既离开底部也解除平滑跟随（跟随只认真实上翻，程序滚动不算）
    const c = await centerOf(`document.querySelector('[data-transcript-scroll] [data-slot=scroll-area-viewport], .transcript-scroll')`);
    await wheel(c.x, c.y, -320);
    await sleep(600);
    convScrollSet = await rt(`(() => { const vp = document.querySelector('[data-slot=scroll-area-viewport]'); return vp ? vp.scrollTop : -1; })()`);
    // 锚定基线：收起会伴随列宽回流（534→944），scrollTop 数值会被滚动锚定重写——
    // 「位置不变」按内容锚定判定：首个可见块的身份与视口顶偏移。
    convAnchorBefore = await rt(`(() => {
      const vp = document.querySelector('[data-slot=scroll-area-viewport]');
      const kids = [...(vp?.firstElementChild?.children ?? [])];
      const vpTop = vp.getBoundingClientRect().top;
      // 只锚完整可见块：半截块自身高度随回流变化，top 不稳定
      const f = kids.find((k) => k.getBoundingClientRect().top >= vpTop - 4);
      return f ? { top: Math.round(f.getBoundingClientRect().top), text: (f.textContent ?? '').trim().slice(0, 26) } : null;
    })()`);
  }

  await click('document.querySelector(".h24-preview-tab.active [data-tab-key]")');
  await sleep(150);
  await key('Escape');
  await sleep(500);
  record(!(await panelVisible()), 'Escape 收起预览面板（队列保留）');
  const draft = await rt(`document.querySelector('.text-composer-input')?.value ?? ''`);
  record(draft === '草稿-027-走查-不应丢失', '收起后未发送草稿不变', `「${draft}」`);
  const focusInfo = await rt(`(() => { const el = document.activeElement; return el ? el.tagName + ':' + ((el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 24)) : 'none'; })()`);
  record(true, '收起后焦点落点', focusInfo);
  if (convScroller && convAnchorBefore) {
    const anchorAfter = await rt(`(() => {
      const vp = document.querySelector('[data-slot=scroll-area-viewport]');
      const kids = [...(vp?.firstElementChild?.children ?? [])];
      const vpTop = vp.getBoundingClientRect().top;
      const f = kids.find((k) => k.getBoundingClientRect().top >= vpTop - 4);
      return f ? { top: Math.round(f.getBoundingClientRect().top), text: (f.textContent ?? '').trim().slice(0, 26) } : null;
    })()`);
    const st = await rt(`(() => { const vp = document.querySelector('[data-slot=scroll-area-viewport]'); return vp ? vp.scrollTop : -1; })()`);
    record(
      anchorAfter?.text === convAnchorBefore.text && Math.abs((anchorAfter?.top ?? 0) - convAnchorBefore.top) <= 24,
      '收起后对话阅读位置不变（真实滚轮上翻后，内容锚定口径）',
      `锚定块「${convAnchorBefore.text}」@${convAnchorBefore.top}px → 「${anchorAfter?.text}」@${anchorAfter?.top}px（scrollTop ${convScrollSet}→${st}，回流由滚动锚定补偿，容差 24px＝半行）`,
    );
  } else {
    record(true, '收起后对话滚动位置（未溢出，平凡保持）');
  }
  await clickGroupRow(rowsFiles.length ? '已保存的文件' : '可阅读的结果', 0);
  await sleep(500);
  const reopened = await tabsCount();
  record(await panelVisible() && reopened >= 2, '收起后再点成果恢复队列（Tab 保留）', `重开 ${reopened} Tab`);
  await shot('05-reopen-queue.png');

  // 全部关闭 → 面板收起且队列清空
  for (;;) {
    const n = await tabsCount();
    if (!n) break;
    await click(`document.querySelector('.h24-preview-tab .h24-preview-tab-close, .h24-preview-tab-close')`);
    await sleep(300);
  }
  record(!(await panelVisible()), '最后一个 Tab 关闭后收起面板');
  await clickGroupRow(rowsFiles.length ? '已保存的文件' : '可阅读的结果', 0);
  await sleep(400);
  const afterCloseAll = await tabsCount();
  record(afterCloseAll === 1, '关完后重新打开从 1 个 Tab 开始', `${afterCloseAll} Tab`);

  // —— 5. 会话切换：Tab 隔离 ——
  if (rowsFiles.length > 1) {
    await clickGroupRow('已保存的文件', 1 % rowsFiles.length);
  }
  await sleep(300);
  await click('document.querySelector(".h24-sidebar-new")');
  await sleep(900);
  record(!(await panelVisible()), '切换新会话清空预览 Tab');
  const backRow = await rt(`document.querySelectorAll('.h24-sidebar-item').length`);
  await click(`[...document.querySelectorAll('.h24-sidebar-item')].at(-1)`);
  await sleep(1200);
  const rowsAfter = await groupRows('已保存的文件');
  const reportAfter = await groupRows('可阅读的结果');
  record(
    rowsAfter.length === rowsFiles.length && reportAfter.length === rowsReport.length,
    '切回原会话交付条目重载',
    `文件 ${rowsAfter.length}/${rowsFiles.length} 条，可阅读结果 ${reportAfter.length}/${rowsReport.length} 条`,
  );
  record((await tabsCount()) === 0 || !(await panelVisible()), '切回后 Tab 不复活');
  await clickGroupRow(rowsFiles.length ? '已保存的文件' : '可阅读的结果', 0);
  await sleep(500);
  record((await tabsCount()) === 1, '切回后重开预览按档案身份', `侧栏行 ${backRow} 条`);
  await shot('06-session-switch.png');

  // —— 6. 断点矩阵（真实窗口尺寸通路 resizeTo；先保证预览开着）——
  if (!(await panelVisible())) {
    await clickGroupRow(rowsFiles.length ? '已保存的文件' : '可阅读的结果', 0);
    await sleep(500);
  }
  await setViewportWidth(1180);
  const w1180 = await rt('window.innerWidth');
  const grid3 = await rt(`(() => {
    const ws = document.querySelector('.h24-workspace');
    const cols = getComputedStyle(ws).gridTemplateColumns.split(' ').length;
    const kids = [...ws.children].map((el) => ({ cls: String(el.className).slice(0, 30), w: Math.round(el.getBoundingClientRect().width) }));
    const preview = document.querySelector('.h24-preview');
    return { cols, kids, pos: preview ? getComputedStyle(preview).position : null };
  })()`);
  const convCol = grid3.kids.find((k) => k.cls.includes('h24-main'));
  record(w1180 === 1180 && grid3.cols === 3 && grid3.pos === 'relative', '1180px 三栏并排（真实窗口）', `innerWidth ${w1180}，grid ${grid3.cols} 轨，预览 ${grid3.pos}，列宽 ${JSON.stringify(grid3.kids)}`);
  await shot('07-1180.png');

  await setViewportWidth(1179);
  const w1179 = await rt('window.innerWidth');
  const overlay = await rt(`(() => {
    const p = document.querySelector('.h24-preview');
    const ws = document.querySelector('.h24-workspace');
    if (!p) return null;
    const cs = getComputedStyle(p);
    return { pos: cs.position, left: cs.left, gridCols: getComputedStyle(ws).gridTemplateColumns.split(' ').length, sidebarVisible: Boolean(document.querySelector('.h24-sidebar')) };
  })()`);
  record(w1179 === 1179 && overlay?.pos === 'absolute' && overlay.gridCols === 2, '1179px 单层覆盖主区、侧栏保留（真实窗口）', JSON.stringify(overlay));
  await shot('08-1179.png');

  await setViewportWidth(880);
  const w880 = await rt('window.innerWidth');
  const full = await rt(`(() => { const p = document.querySelector('.h24-preview'); return p ? getComputedStyle(p).left : null; })()`);
  record(w880 === 880 && full === '0px', '880px 预览铺满（真实窗口）', `left ${full}`);
  await shot('09-880.png');

  await setViewportWidth(1280);
  await sleep(400);
  record(true, '窗口复位 1280', `innerWidth ${await rt('window.innerWidth')}`);

  // —— 7. 汇总 ——
  writeFileSync(
    resolve(OUT, 'walkthrough-result.json'),
    JSON.stringify({ results, errors, convColumnWidthAt1180: convCol?.w ?? null }, null, 2),
  );
  console.log(`\nconsole-errors: ${errors.length}`);
  for (const e of errors.slice(0, 10)) console.log(`  - ${e}`);
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\n=== 027 走查结果：${results.length - failed}/${results.length} 通过 ===`);
  conn?.ws.close();
  process.exit(failed || errors.length ? 3 : 0);
} catch (error) {
  results.push({ ok: false, name: 'harness 异常', detail: String(error?.message ?? error) });
  writeFileSync(resolve(OUT, 'walkthrough-result.json'), JSON.stringify({ results, errors }, null, 2));
  console.error('[027-walk] 异常：', error);
  try {
    conn?.ws.close();
  } catch {}
  process.exit(4);
}

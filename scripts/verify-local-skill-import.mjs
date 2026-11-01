// 导入本地技能弹窗：隔离 fixture 上的真实交互检查（headless Chrome + CDP，真实鼠标/键盘事件）。
// 先起 fixture：
//   dev：  vite --config scripts/fixtures/local-skill-import/vite.config.ts            （5188）
//   built：vite build --config … && vite preview --config … （5189）
// 用法：HEMI_FIXTURE_URL=http://127.0.0.1:5188/ node scripts/verify-local-skill-import.mjs
// 截图输出到 HEMI_CAPTURE_OUTPUT（默认 .visual/local-skill-import/<label>）。不读写真实应用数据。
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const baseUrl = process.env.HEMI_FIXTURE_URL || 'http://127.0.0.1:5188/';
const label = process.env.HEMI_FIXTURE_LABEL || 'dev';
const output = path.resolve(process.env.HEMI_CAPTURE_OUTPUT || `.visual/local-skill-import/${label}`);
const profile = await mkdtemp(path.join(os.tmpdir(), 'hemi-skill-import-'));
const browser = spawn(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
let socket;
try {
  let port;
  for (let i = 0; i < 100 && !port; i++) {
    try { port = Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]); } catch { await sleep(100); }
  }
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((item) => item.type === 'page'); } catch { /* 启动中 */ }
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('Chrome 页面不可用');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  let id = 0;
  const pending = new Map();
  const errors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') errors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
    const resolve = pending.get(message.id);
    if (resolve) { pending.delete(message.id); resolve(message); }
  });
  const call = (method, params = {}) => new Promise((resolve) => { const next = ++id; pending.set(next, resolve); socket.send(JSON.stringify({ id: next, method, params })); });
  const evaluate = async (expression) => {
    const response = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.result?.exceptionDetails) throw new Error(response.result.exceptionDetails.exception?.description ?? response.result.exceptionDetails.text);
    return response.result.result.value;
  };
  const waitFor = async (expression, ms = 5000) => {
    for (let t = 0; t < ms; t += 50) { if (await evaluate(expression).catch(() => false)) return true; await sleep(50); }
    throw new Error(`等待超时：${expression}`);
  };
  const center = async (selector) => {
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    if (!box) throw new Error(`找不到元素：${selector}`);
    return box;
  };
  const clickAt = async ({ x, y }) => {
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    await sleep(60);
  };
  const click = async (selector) => clickAt(await center(selector));
  const key = async (name, code = name, keyCode = 0, modifiers = 0) => {
    await call('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
    await call('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
    await sleep(60);
  };
  const type = async (text) => { await call('Input.insertText', { text }); await sleep(80); };
  const shot = async (name) => {
    await sleep(320);
    const { result } = await call('Page.captureScreenshot', { format: 'png' });
    const file = path.join(output, `${name}.png`);
    await writeFile(file, Buffer.from(result.data, 'base64'));
    return file;
  };
  const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail }); if (!ok) console.error(`✗ ${name} ${detail}`); };
  const open = async (scene, width = 1280, height = 820) => {
    await call('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 2, mobile: false });
    await call('Page.navigate', { url: `${baseUrl}?scene=${scene}` });
    await waitFor(`Boolean(document.querySelector('.h34-import'))`, 15000);
    await click('.h34-import');
    await waitFor(`Boolean(document.querySelector('.h71-import'))`);
  };
  const calls = (name) => evaluate(`window.__calls.filter((c) => c.name === ${JSON.stringify(name)}).length`);
  const popup = `document.querySelector('.h71-import')`;
  const inPopup = `${popup}?.contains(document.activeElement)`;

  await call('Page.enable');
  await call('Runtime.enable');
  await mkdir(output, { recursive: true });
  const shots = [];

  // 1. 打开即扫描、不弹原生目录对话框、不自动导入；列表、来源、已导入、警告。
  await open('list');
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  check('打开弹窗自动扫描', await calls('scanLocalSkills') >= 1);
  check('打开弹窗不调用原生目录对话框', await calls('importLocalSkill') === 0);
  check('扫描不会自动导入', await calls('importLocalSkills') === 0);
  check('焦点在弹窗内', await evaluate(inPopup));
  check('列表 6 条', await evaluate(`document.querySelectorAll('ul.h71-list .h71-row').length`) === 6);
  check('已导入条目禁用且带标记', await evaluate(`[...document.querySelectorAll('.h71-row[data-installed="true"]')].every((r) => r.querySelector('input').disabled && r.textContent.includes('已导入'))`));
  check('未导入排在已导入之前', await evaluate(`(() => { const s = [...document.querySelectorAll('.h71-row')].map((r) => r.dataset.installed); return s.indexOf('true') > s.lastIndexOf('false'); })()`));
  check('家目录缩写为 ~ 且 title 保留完整路径', await evaluate(`(() => { const p = document.querySelector('.h71-path'); return p.textContent.startsWith('~/') && p.title.startsWith('/Users/demo/'); })()`));
  check('导入按钮初始禁用', await evaluate(`[...document.querySelectorAll('.h71-actions .h37-btn-primary')][0].disabled`));
  check('有警告折叠', await evaluate(`document.querySelector('.h71-warnings summary')?.textContent.includes('2 个位置')`));
  check('背景锁滚', await evaluate(`(() => { const cs = getComputedStyle(document.documentElement); const b = getComputedStyle(document.body); return cs.overflow === 'hidden' || b.overflow === 'hidden' || document.documentElement.hasAttribute('data-base-ui-scroll-locked') || document.body.style.overflow === 'hidden' || document.documentElement.style.overflow === 'hidden'; })()`));
  check('本机不提供方式选择或复制入口', await evaluate(`!document.querySelector('.h71-mode, .h71-import input[type="radio"], .h71-import select, .h71-import [role="radiogroup"]') && !document.querySelector('.h71-import').textContent.includes('复制')`));
  check('仅保留简短软链接说明', await evaluate(`(() => { const t = document.querySelector('.h71-import-hint').textContent; return t.includes('实时引用原目录') && t.includes('不重复占用磁盘空间') && t.includes('原目录改动会同步') && t.includes('移动或删除后会失效'); })()`));
  shots.push(await shot('01-list-1280'));

  // Tab 循环不跑出弹窗。
  let trapped = true;
  const trail = [];
  for (let i = 0; i < 14; i++) { await key('Tab', 'Tab', 9); const where = await evaluate(`(() => { const a = document.activeElement; return (${popup}?.contains(a) ? 'in:' : 'OUT:') + a.tagName + '.' + (a.className || '') + '[' + (a.getAttribute('aria-label') || a.textContent.slice(0, 12)) + ']'; })()`); trail.push(where); if (where.startsWith('OUT')) trapped = false; }
  check('Tab 焦点留在弹窗内', trapped, trail.join(' > '));
  // Option+Tab：巡航全部控件（复选框、按钮），同样不出弹窗，且能到达复选框。
  let trappedAll = true; const seen = new Set();
  for (let i = 0; i < 24; i++) { await key('Tab', 'Tab', 9, 1); const w = await evaluate(`(() => { const a = document.activeElement; return (${popup}?.contains(a) ? 'in:' : 'OUT:') + a.tagName + (a.type ? ':' + a.type : ''); })()`); seen.add(w); if (w.startsWith('OUT')) trappedAll = false; }
  check('Option+Tab 焦点留在弹窗内并到达复选框', trappedAll && seen.has('in:INPUT:checkbox') && seen.has('in:BUTTON:button'), [...seen].join(','));
  // 空格切换复选（键盘可操作）。
  await evaluate(`document.querySelector('.h71-row input:not(:disabled)').focus()`);
  await key(' ', 'Space', 32);
  check('空格勾选复选框', await evaluate(`document.querySelector('.h71-row input:not(:disabled)').checked`));
  await key(' ', 'Space', 32);

  // 筛选与全选结果。
  await click('.h71-search input');
  await type('git');
  check('筛选 git 只剩 1 条', await evaluate(`document.querySelectorAll('ul.h71-list .h71-row').length`) === 1);
  check('全选文案随筛选变化', await evaluate(`document.querySelector('.h71-all')?.textContent.includes('全选结果')`));
  await click('.h71-all input');
  check('全选结果只选可见项', await evaluate(`document.querySelector('.h71-actions .h37-btn-primary').textContent.includes('导入 1 个')`));
  await evaluate(`(() => { const i = document.querySelector('.h71-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(80);
  check('清空筛选后全选为半选态', await evaluate(`document.querySelector('.h71-all input').indeterminate`));
  await type('没有这个');
  check('无匹配提示', await evaluate(`document.querySelector('.h71-state')?.textContent.includes('没有名称')`));
  await evaluate(`(() => { const i = document.querySelector('.h71-search input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(i, ''); i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
  await sleep(80);

  // 点行勾选两个，导入。
  await click('ul.h71-list li:nth-child(1) .h71-row');
  await click('ul.h71-list li:nth-child(3) .h71-row');
  check('勾选后按钮显示数量', await evaluate(`document.querySelector('.h71-actions .h37-btn-primary').textContent.includes('导入 3 个')`));
  shots.push(await shot('02-picked-1280'));
  await click('.h71-actions .h37-btn-primary');
  await waitFor(`document.querySelector('.h71-status')?.textContent.includes('正在导入')`);
  check('导入中按钮与关闭禁用', await evaluate(`document.querySelector('.h71-actions .h37-btn-primary').disabled && document.querySelector('.h71-head [aria-label="关闭"]').disabled`));
  await key('Escape', 'Escape', 27);
  check('导入中 Esc 不关闭', await evaluate(`Boolean(${popup})`));
  await waitFor(`document.querySelector('.h71-status')?.textContent.includes('已导入 3 个技能')`);
  const sent = await evaluate(`window.__calls.find((c) => c.name === 'importLocalSkills').args[0]`);
  check('只提交用户勾选的路径', Array.isArray(sent) && sent.length === 3, JSON.stringify(sent));
  check('本机批量传 symlink', await evaluate(`window.__calls.find((c) => c.name === 'importLocalSkills').args[1].mode === 'symlink'`));
  check('成功条目就地标为已导入', await evaluate(`document.querySelectorAll('.h71-row[data-installed="true"]').length`) === 5);
  shots.push(await shot('03-imported-1280'));
  // 手动选择文件夹：调用原接口；取消不报错、弹窗保留。
  await click('.h71-actions .h37-btn-ghost');
  await waitFor(`document.querySelector('.h71-status')?.textContent.includes('系统窗口')`);
  await waitFor(`!document.querySelector('.h71-status')?.textContent.includes('系统窗口')`);
  check('手动选择文件夹调用 importLocalSkill', await calls('importLocalSkill') === 1);
  check('本机手选传 symlink', await evaluate(`window.__calls.find((c) => c.name === 'importLocalSkill').args[0].mode === 'symlink'`));
  check('取消原生对话框不报错', await evaluate(`document.querySelector('.h71-status').dataset.tone !== 'danger' && Boolean(${popup})`));
  await key('Escape', 'Escape', 27);
  await waitFor(`!${popup}`);
  check('Esc 关闭弹窗', true);
  check('关闭后焦点回到导入按钮', await evaluate(`document.activeElement?.classList.contains('h34-import')`));
  check('导入过就切到已安装', await evaluate(`document.querySelector('[role="tab"][aria-selected="true"]')?.textContent.includes('已安装')`));

  // 1b. 重开弹窗仍没有方式选择，导入规则不依赖界面状态。
  await click('.h34-import');
  await waitFor(`Boolean(${popup})`);
  check('重开仍无方式选择', await evaluate(`!document.querySelector('.h71-import input[type="radio"]') && !document.querySelector('.h71-import').textContent.includes('导入方式')`));

  // 2. 部分失败。
  await open('partial');
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  await click('.h71-all input');
  await click('.h71-actions .h37-btn-primary');
  await waitFor(`document.querySelector('.h71-status')?.dataset.tone === 'warn'`);
  check('部分失败汇总', await evaluate(`document.querySelector('.h71-status').textContent`) === '已导入 2 个，2 个未能导入，原因见条目。');
  check('失败条目显示原因并保留勾选', await evaluate(`[...document.querySelectorAll('.h71-row-error')].length === 2 && [...document.querySelectorAll('.h71-row-error')].every((e) => e.closest('.h71-row').querySelector('input').checked)`));
  check('重试按钮只剩失败数', await evaluate(`document.querySelector('.h71-actions .h37-btn-primary').textContent.includes('导入 2 个')`));
  shots.push(await shot('04-partial-1280'));

  // 3. 导入进行中：点遮罩与 Esc 都不关。
  await open('importing');
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  await click('ul.h71-list li:nth-child(1) .h71-row');
  await click('.h71-actions .h37-btn-primary');
  await waitFor(`document.querySelector('.h71-status')?.textContent.includes('正在导入 1 个')`);
  await clickAt({ x: 20, y: 20 });
  await key('Escape', 'Escape', 27);
  check('导入中点遮罩/Esc 不关闭', await evaluate(`Boolean(${popup})`));
  shots.push(await shot('05-importing-1280'));

  // 4. 空闲时点遮罩关闭。
  await open('list');
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  await clickAt({ x: 20, y: 20 });
  await waitFor(`!${popup}`);
  check('空闲点遮罩关闭', true);

  // 5. 扫描中骨架 + 刷新。
  await open('slow');
  await sleep(700);
  check('慢扫描显示骨架', await evaluate(`Boolean(document.querySelector('.h71-list-loading'))`));
  check('扫描中刷新按钮禁用', await evaluate(`document.querySelector('.h71-head [aria-label="正在扫描"]').disabled`));
  shots.push(await shot('06-scanning-1280'));
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`, 4000);
  const before = await calls('scanLocalSkills');
  await click('.h71-head [aria-label="重新扫描"]');
  await sleep(200);
  check('重新扫描保留旧列表并变淡', await evaluate(`document.querySelector('ul.h71-list')?.dataset.stale === 'true'`));
  check('刷新触发新扫描', await calls('scanLocalSkills') === before + 1);
  await waitFor(`document.querySelector('ul.h71-list')?.dataset.stale === 'false'`, 4000);

  // 6. 空结果 / 扫描失败。
  await open('empty');
  await waitFor(`Boolean(document.querySelector('.h71-state'))`);
  check('空结果提示', await evaluate(`document.querySelector('.h71-state').textContent.includes('没有找到技能')`));
  check('空结果仍可手动选择文件夹', await evaluate(`!document.querySelector('.h71-actions .h37-btn-ghost').disabled`));
  shots.push(await shot('07-empty-1280'));
  await open('scan-failed');
  await waitFor(`Boolean(document.querySelector('.h71-state[role="alert"]'))`);
  check('扫描失败带原因', await evaluate(`document.querySelector('.h71-state').textContent.includes('没有读取用户目录的权限')`));
  await click('.h71-state .h37-btn');
  await sleep(150);
  check('失败后重新扫描', await calls('scanLocalSkills') >= 2);
  await waitFor(`Boolean(document.querySelector('.h71-state[role="alert"]'))`);
  shots.push(await shot('08-scan-failed-1280'));

  // 7. 远端 Bot 文案。
  await open('remote');
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  check('远端文案说明导入到 Bot', await evaluate(`document.querySelector('.h71-import [data-slot="dialog-description"]').textContent.includes('导入到这个 Bot')`));

  check('远端不提供方式选择且说明文件传输', await evaluate(`!document.querySelector('.h71-import input[type="radio"], .h71-import select, .h71-import [role="radiogroup"]') && document.querySelector('.h71-import-hint').textContent.includes('文件会传输到这个 Bot')`));
  await click('ul.h71-list li:nth-child(1) .h71-row');
  shots.push(await shot('13-remote-1280'));
  await click('.h71-actions .h37-btn-primary');
  await waitFor(`document.querySelector('.h71-status')?.textContent.includes('已导入 1 个技能')`);
  check('远端批量只传 copy', await evaluate(`window.__calls.find((c) => c.name === 'importLocalSkills').args[1].mode === 'copy'`));
  await click('.h71-actions .h37-btn-ghost');
  await waitFor(`!document.querySelector('.h71-actions .h37-btn-ghost').disabled`);
  check('远端手选只传 copy', await evaluate(`window.__calls.find((c) => c.name === 'importLocalSkill').args[0].mode === 'copy'`));

  // 7b. 批量上限 50：全选只选 50 个，其余禁用并提示。
  await open('many');
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  await click('.h71-all input');
  check('全选受 50 上限', await evaluate(`document.querySelector('.h71-actions .h37-btn-primary').textContent.includes('导入 50 个')`));
  check('达到上限后其余条目禁用', await evaluate(`[...document.querySelectorAll('ul.h71-list input')].filter((i) => !i.checked && i.disabled).length === 10`));
  check('上限提示', await evaluate(`document.querySelector('.h71-status').textContent.includes('一次最多导入 50 个')`));
  shots.push(await shot('11-limit-1280'));
  await click('.h71-actions .h37-btn-primary');
  await waitFor(`document.querySelector('.h71-status')?.textContent.includes('已导入 50 个技能')`);
  check('提交 50 条路径', await evaluate(`window.__calls.find((c) => c.name === 'importLocalSkills').args[0].length`) === 50);

  // 8. 窄屏底部弹层 + 长内容。
  for (const [width, height] of [[375, 760], [600, 760]]) {
    await open('long', width, height);
    await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
    const fit = await evaluate(`(() => {
      const p = document.querySelector('.h71-import').getBoundingClientRect();
      const over = [...document.querySelectorAll('.h71-import *')].filter((el) => el.scrollWidth > el.clientWidth + 1 && !['hidden', 'clip'].includes(getComputedStyle(el).overflowX) && getComputedStyle(el).overflowX !== 'auto').map((el) => el.className);
      const foot = document.querySelector('.h71-foot').getBoundingClientRect();
      return { left: p.left, right: p.right, bottom: p.bottom, vw: innerWidth, vh: innerHeight, over, footVisible: foot.bottom <= innerHeight + 1 };
    })()`);
    check(`${width} 弹层贴底铺满`, Math.abs(fit.left) < 1 && Math.abs(fit.right - fit.vw) < 1 && Math.abs(fit.bottom - fit.vh) < 1, JSON.stringify(fit));
    check(`${width} 无横向溢出`, fit.over.length === 0, fit.over.join(','));
    check(`${width} 底栏可见`, fit.footVisible);
    check(`${width} 长名称不超出行宽`, await evaluate(`(() => { const n = [...document.querySelectorAll('.h71-name')].find((e) => e.textContent.startsWith('an-unusually')); const r = n.getBoundingClientRect(), row = n.closest('.h71-row').getBoundingClientRect(); return r.right <= row.right + 0.5; })()`));
    check(`${width} 无方式选择或复制入口`, await evaluate(`!document.querySelector('.h71-import input[type="radio"]') && !document.querySelector('.h71-import').textContent.includes('复制')`));
    // 按项目 mac 原生策略，先真实键盘巡航进入 kb-nav；程序化 focus 后直接按空格会被拦截。
    await evaluate(`document.querySelector('.h71-search input').focus()`);
    let reachedCheckbox = false;
    for (let i = 0; i < 12; i++) {
      await key('Tab', 'Tab', 9, 1);
      if (await evaluate(`document.activeElement === document.querySelector('.h71-row input:not(:disabled)')`)) { reachedCheckbox = true; break; }
    }
    check(`${width} 键盘可到达技能复选框`, reachedCheckbox);
    await key(' ', 'Space', 32);
    check(`${width} 键盘可勾选技能`, await evaluate(`document.querySelector('.h71-row input:not(:disabled)').checked`));
    await key(' ', 'Space', 32);
    let narrowTrapped = true;
    for (let i = 0; i < 24; i++) { await key('Tab', 'Tab', 9, 1); if (!await evaluate(inPopup)) narrowTrapped = false; }
    check(`${width} 键盘焦点不出弹窗`, narrowTrapped);
    shots.push(await shot(`09-long-${width}`));
    await key('Escape', 'Escape', 27);
    await waitFor(`!${popup}`);
    check(`${width} Esc 关闭后返回导入入口`, await evaluate(`document.activeElement?.classList.contains('h34-import')`));
  }
  await open('remote', 375, 760);
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  check('远端窄屏无方式选择且底栏可见', await evaluate(`!document.querySelector('.h71-import input[type="radio"]') && document.querySelector('.h71-import').getBoundingClientRect().right <= innerWidth && document.querySelector('.h71-foot').getBoundingClientRect().bottom <= innerHeight`));
  let remoteTrapped = true;
  for (let i = 0; i < 24; i++) { await key('Tab', 'Tab', 9, 1); if (!await evaluate(inPopup)) remoteTrapped = false; }
  check('远端窄屏键盘焦点不出弹窗', remoteTrapped);
  shots.push(await shot('19-remote-375'));

  await open('long', 1280, 820);
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  check('长列表在清单区内滚动', await evaluate(`(() => { const b = document.querySelector('.h71-body'); return b.scrollHeight > b.clientHeight && document.querySelector('.h71-foot').getBoundingClientRect().bottom <= innerHeight; })()`));
  shots.push(await shot('10-long-1280'));

  // 9. 后端拒绝不伪装成成功。
  await open('rejected');
  await waitFor(`document.querySelectorAll('ul.h71-list .h71-row').length > 0`);
  await click('ul.h71-list li:nth-child(1) .h71-row');
  await click('.h71-actions .h37-btn-primary');
  await waitFor(`document.querySelector('.h71-status')?.dataset.tone === 'danger'`);
  check('显示后端返回的失败原因且不标成功', await evaluate(`document.querySelector('.h71-status').textContent.includes('无法创建软链接：没有写入权限') && document.querySelectorAll('.h71-row[data-installed="true"]').length === 2 && document.querySelector('.h71-row input:checked') !== null`));

  // 10. 真实市场组件的已安装状态：链接、失效、复制、无模式的旧记录。
  await call('Emulation.setDeviceMetricsOverride', { width: 1280, height: 820, deviceScaleFactor: 2, mobile: false });
  await call('Page.navigate', { url: `${baseUrl}?scene=installed` });
  await waitFor(`document.querySelectorAll('.h34-card').length === 4`);
  check('卡片区分软链/副本/旧记录', await evaluate(`(() => { const rows = [...document.querySelectorAll('.h34-card')]; return rows[0].textContent.includes('本地软链接') && rows[1].textContent.includes('链接失效') && rows[1].textContent.includes('源目录已移动或删除') && rows[2].textContent.includes('本地副本') && rows[3].textContent.includes('本地导入') && !rows[3].textContent.includes('软链接'); })()`));
  check('软链卡片显示真实来源路径', await evaluate(`document.querySelector('.h34-card .h34-mono').title === '/Users/demo/.claude/skills/pdf-tools'`));
  check('在途任务不再承诺固定版本', await evaluate(`!document.querySelector('.h34-market').textContent.includes('受理时的版本')`));
  shots.push(await shot('14-installed-1280'));
  await click('.h34-card:nth-child(1)');
  await waitFor(`Boolean(document.querySelector('.h34-detail'))`);
  check('软链详情说明实时引用与备份边界', await evaluate(`(() => { const t = document.querySelector('.h34-detail').textContent; return t.includes('实时引用原目录') && !t.includes('选复制') && t.includes('备份只保存链接登记，不包含原目录文件'); })()`));
  shots.push(await shot('18-linked-detail-1280'));
  await click('.h34-detail-back');
  await waitFor(`document.querySelectorAll('.h34-card').length === 4`);
  await click('.h34-card:nth-child(2)');
  await waitFor(`Boolean(document.querySelector('.h34-detail [role="alert"]'))`);
  check('详情显示后端失效原因及恢复方法', await evaluate(`(() => { const t = document.querySelector('.h34-detail [role="alert"]').textContent; return t.includes('源目录已移动或删除') && t.includes('恢复原路径') && t.includes('卸载不会删除原目录'); })()`));
  shots.push(await shot('15-invalid-detail-1280'));
  await click('.h34-detail .h37-btn-danger');
  await waitFor(`Boolean(document.querySelector('.h34-confirm'))`);
  check('软链卸载确认只移除链接不删源', await evaluate(`document.querySelector('.h34-confirm').textContent.includes('只移除 Hemi 中的软链接，不会删除原目录')`));
  check('确认前不调用卸载', await calls('removeSkill') === 0);
  shots.push(await shot('16-uninstall-1280'));
  await click('.h34-confirm .h37-btn-secondary');
  check('取消卸载无副作用', await calls('removeSkill') === 0);
  await call('Emulation.setDeviceMetricsOverride', { width: 375, height: 760, deviceScaleFactor: 2, mobile: false });
  check('失效详情窄屏无横向溢出', await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.h34-detail [role="alert"]').getBoundingClientRect().right <= innerWidth`));
  shots.push(await shot('17-invalid-detail-375'));

  const realErrors = errors.filter((text) => !/Download the React DevTools/.test(text));
  check('无控制台错误', realErrors.length === 0, realErrors.join(' | '));
  const failed = results.filter((item) => !item.ok);
  const report = { label, baseUrl, environment: { node: process.version, platform: `${process.platform}/${process.arch}`, browser: (await call('Browser.getVersion')).result }, passed: results.length - failed.length, failed: failed.length, results, shots };
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  if (failed.length) process.exitCode = 1;
} finally {
  socket?.close();
  browser.kill();
  await sleep(200);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
}

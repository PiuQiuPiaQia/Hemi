#!/usr/bin/env node
/**
 * 066 订阅额度 UI 生命周期检查（fixtures，开发/验收辅助，非产品链路）：
 * 无头 Electron 逐场景加载 fixtures.html，断言结构（额度挂行尾区、不含交互元素、
 * 只给可查询订阅挂额度）、请求次数（StrictMode 合并、刷新强制、Bot 零请求、下钻返回不重查）、
 * 各状态文案，并截图。
 *
 * 用法：npx electron scripts/verify-066-subscription-quota.mjs [base] [outDir]
 * base 默认 http://127.0.0.1:5173/fixtures.html；可指向构建产物的 file:// fixtures.html。
 */
import { app, BrowserWindow } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const base = process.argv[2] ?? 'http://127.0.0.1:5173/fixtures.html';
const outDir = resolve(process.cwd(), process.argv[3] ?? '.visual/066');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = '') => {
  results.push(Boolean(ok));
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${String(detail).slice(0, 240)}` : ''}`);
};

async function open(scene, state, { width = 980, height = 900 } = {}) {
  const win = new BrowserWindow({ width, height, show: false, useContentSize: true });
  const errors = [];
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message); });
  const query = `?scene=${scene}${state ? `&state=${state}` : ''}`;
  // 上一个窗口销毁时 dev server 偶发中断下一次导航（ERR_FAILED），重试一次。
  await win.loadURL(`${base}${query}`).catch(async () => { await sleep(500); await win.loadURL(`${base}${query}`); });
  await sleep(900);
  const run = (code) => win.webContents.executeJavaScript(`(() => { ${code} })()`);
  const shot = async (name) => {
    mkdirSync(outDir, { recursive: true });
    writeFileSync(resolve(outDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  };
  return { win, errors, run, shot };
}

const structure = `
  const rows = [...document.querySelectorAll('.h37m-provider-row')];
  const items = [...document.querySelectorAll('.h37q-item')];
  return {
    groups: document.querySelectorAll('.h37q[data-state="ok"]').length,
    inRowEnd: document.querySelectorAll('.h37m-provider-row > .h37-row-end > .h37q').length,
    items: items.map(i => i.textContent),
    titles: items.map(i => i.title),
    interactive: document.querySelectorAll('.h37q button, .h37q a, .h37q input, .h37q [role="button"]').length,
    claudeQuota: rows.filter(r => r.textContent.includes('Claude') && r.querySelector('.h37q')).length,
    calls: window.__quotaCalls.map(c => c.provider + (c.force ? ':force' : '')),
    notes: [...document.querySelectorAll('.h37q-note')].map(n => n.textContent),
    stateTitles: [...document.querySelectorAll('.h37q[data-state="error"], .h37q[data-state="unavailable"]')].map(n => n.title),
    fills: document.querySelectorAll('.h37q-fill').length,
    bars: document.querySelectorAll('.h37q-bar').length,
  };`;

// 逐场景开关窗口：最后一个窗口关掉时不能让 Electron 默认退出。
app.on('window-all-closed', () => {});

async function main() {
  await app.whenReady();

  // 1. 正常：两家各两窗；Claude 不挂；StrictMode 下每家只请求一次。
  {
    const page = await open('settings-model-quota', 'ok');
    const s = await page.run(structure);
    check('ok：ChatGPT / GLM 各一组额度', s.groups === 2 && s.items.length === 4, JSON.stringify(s.items));
    check('ok：额度挂在订阅行行尾区', s.inRowEnd === 2);
    check('ok：额度块内无交互元素', s.interactive === 0);
    check('ok：不支持查询的 Claude 不挂额度', s.claudeQuota === 0);
    check('ok：首读每家一次，不查 anthropic', JSON.stringify([...s.calls].sort()) === JSON.stringify(['bigmodel', 'openai']), s.calls.join(','));
    check('ok：行内文本含标签与剩余', s.items.every(t => /剩 ?\d+%|剩余未知/.test(t)), s.items[0]);
    check('ok：悬停含重置时间与绝对剩余（服务器 remaining）', s.titles.some(t => t.includes('11,804 / 12,000 积分') && t.includes('重置')), s.titles[2]);
    await page.shot('ok');
    // 刷新：强制、每家一次。
    await page.run(`document.querySelector('[aria-label="刷新订阅额度"]').click();`);
    await sleep(300);
    const after = await page.run(structure);
    check('刷新：每家补一次 force 请求', after.calls.filter(c => c.endsWith(':force')).length === 2, after.calls.join(','));
    // 点额度单元本身 → 事件冒泡到行按钮，按原逻辑进详情。
    const before = after.calls.length;
    await page.run(`document.querySelectorAll('.h37q-item')[0].click();`);
    await sleep(700);
    const inDetail = await page.run(`return document.querySelectorAll('.h37q').length;`);
    check('点额度所在行仍按原逻辑进入详情', inDetail === 0);
    await page.run(`document.querySelector('button.h37-back')?.click();`);
    await sleep(900);
    const back = await page.run(structure);
    check('返回总览：额度从缓存回显，不重复请求', back.groups === 2 && back.calls.length === before, `${before} → ${back.calls.length}`);
    check('ok：无 console error', page.errors.length === 0, page.errors.join(' | '));
    page.win.destroy();
  }

  // 2. 各状态文案与「不造假进度」。
  for (const [state, expect] of [
    ['low', (s) => s.items.some(t => t.includes('剩 8%'))],
    // 百分比未知：无计数→「剩余未知」，有服务器剩余→给绝对量；两者都不画进度、不写 0%。
    ['unknown', (s) => s.items.filter(t => t.includes('剩余未知')).length === 1 && s.items.some(t => t.includes('剩 52,155 积分')) && s.fills === 2 && !s.items.some(t => / 0%/.test(t))],
    ['unavailable', (s) => s.notes.some(n => n.includes('额度暂不可查')) && s.groups === 1 && s.stateTitles.some(t => (t || '').includes('稍后会自动重试'))],
    ['error', (s) => s.notes.filter(n => n === '额度未读取').length === 2 && s.fills === 0 && s.stateTitles.every(t => t === '网络连接超时')],
  ]) {
    const page = await open('settings-model-quota', state);
    const s = await page.run(structure);
    check(`${state}：状态展示`, expect(s), JSON.stringify({ notes: s.notes, items: s.items, stateTitles: s.stateTitles, fills: s.fills }));
    check(`${state}：无 console error`, page.errors.length === 0, page.errors.join(' | '));
    await page.shot(state);
    page.win.destroy();
  }

  // 3. stale：首读成功、刷新失败 → 保留旧数据（降透明度），说明进悬停提示。
  {
    const page = await open('settings-model-quota', 'stale');
    await page.run(`document.querySelector('[aria-label="刷新订阅额度"]').click();`);
    await sleep(400);
    const s = await page.run(`${structure.replace('return {', 'return { stale: document.querySelectorAll(\'.h37q[data-stale="true"]\').length,')}`);
    check('stale：旧数据保留并降透明度', s.stale === 2 && s.fills === 4 && s.titles.every(t => t.includes('没刷新上')), JSON.stringify(s.titles));
    await page.shot('stale');
    page.win.destroy();
  }

  // 4. slow：加载提示不画进度；结果回来前下钻卸载，迟到结果不报错。
  {
    const page = await open('settings-model-quota', 'slow');
    const loading = await page.run(`return { text: [...document.querySelectorAll('.h37q-note')].map(n => n.textContent), bars: document.querySelectorAll('.h37q-bar').length };`);
    check('slow：先显示读取提示、无进度条', loading.text.includes('读取中…') && loading.bars === 0, JSON.stringify(loading));
    await page.shot('loading');
    await page.run(`[...document.querySelectorAll('.h37m-provider-row')][0].click();`);
    await sleep(1800);
    check('slow：卸载后迟到结果无报错', page.errors.length === 0, page.errors.join(' | '));
    page.win.destroy();
  }

  // 5. Bot 目录：不得查询本机订阅。
  {
    const page = await open('settings-model-quota-bot');
    await sleep(600);
    const s = await page.run(`return { calls: window.__quotaCalls.length, quota: document.querySelectorAll('.h37q, [aria-label="刷新订阅额度"]').length, rows: document.querySelectorAll('.h37m-provider-row').length };`);
    check('Bot：零请求、不显示额度与刷新', s.calls === 0 && s.quota === 0 && s.rows > 0, JSON.stringify(s));
    page.win.destroy();
  }

  // 6. 窄窗：收标签、条宽降档，单元不溢出不折行。
  {
    const page = await open('settings-model-quota', 'ok', { width: 560, height: 900 });
    const s = await page.run(`
      const g = document.querySelector('.h37m-provider-row').closest('.h37-group').getBoundingClientRect();
      const items = [...document.querySelectorAll('.h37q-item')];
      return {
        contained: items.every(i => { const r = i.getBoundingClientRect(); return r.right <= g.right + 0.5 && r.height < 30; }),
        labelsHidden: [...document.querySelectorAll('.h37q-label')].every(l => getComputedStyle(l).display === 'none'),
        barNarrow: [...document.querySelectorAll('.h37q-bar')].every(b => b.getBoundingClientRect().width <= 52),
        noWrap: [...document.querySelectorAll('.h37q-item')].every(i => i.getBoundingClientRect().height < 30),
      };`);
    check('窄窗：标签收起、条变窄、单元不溢出不折行', s.contained && s.labelsHidden && s.barNarrow && s.noWrap, JSON.stringify(s));
    await page.shot('narrow');
    page.win.destroy();
  }

  const passed = results.every(Boolean);
  console.log(`HEMI_066_QUOTA_RESULT=${JSON.stringify({ passed, total: results.length, failed: results.filter(r => !r).length, base })}`);
  app.exit(passed ? 0 : 1);
}

app.whenReady().then(main).catch((error) => { console.error(error); app.exit(1); });

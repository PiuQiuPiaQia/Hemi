// 备份设置分类的渲染层回归（docs/requirements/data-backup.md）：本地导航含「备份」、
// Bot 环境不含；empty/configured 两种桩态的关键区块；恢复向导交互（预览→取消/确认）；
// 2026-11 反馈收敛回归：手动备份真实事件时序下仅一个终态 toast（唯一出口为返回值）、
// 迟到终态事件不双报、进度行结束即清、无两行完成文案；备份成功后刷新失败单独归因；
// 保存目标/测试连接 toast；备份失败单一错误 toast；取消恢复无提示。
// node scripts/verify-backup-settings.mjs [--built]
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, rm} from 'node:fs/promises';import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {chromium} from 'playwright-core';

const built = process.argv.includes('--built');
const mode = built ? 'built' : 'dev';
const root = path.resolve(import.meta.dirname, '..');
const evidence = path.join(root, '.visual/backup-settings');
await mkdir(evidence, {recursive: true});
let server, directory, browser;
let base = process.env.HEMI_FIXTURES_BASE ?? 'http://127.0.0.1:5199';
const checks = [], errors = [];
const check = name => {checks.push(name); console.log(`PASS ${mode}: ${name}`);};

try {
  if (built) {
    directory = await mkdtemp(path.join(os.tmpdir(), 'hemi-backup-settings-built-'));
    const {build} = await import('vite');
    await build({configFile: path.join(root, 'vite.config.ts'), build: {
      outDir: directory,
      rollupOptions: {input: path.join(root, 'src/renderer/fixtures.html')}},
    });
    server = http.createServer(async (request, response) => {
      try {
        const name = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
        const file = path.resolve(directory, `.${name}`);
        if (!file.startsWith(directory + path.sep)) {response.writeHead(403); response.end(); return;}
        const mime = {'.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2'};
        response.setHeader('content-type', mime[path.extname(file)] ?? 'application/octet-stream');
        response.end(await readFile(file));
      } catch {response.writeHead(404); response.end();}
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;
} else {
  // dev 模式：配合外部已就绪的 vite dev server（端口 5199，与 verify-bot-settings 同约定）；
  // 未就绪时给出明确提示而非挂起。
  const probe = await fetch(`${base}/fixtures.html`).then(r => r.status, () => null);
  if (probe !== 200) {
    throw new Error(`dev fixtures 服务未就绪（${base}）。先在项目根另起：npx vite --port 5199，或用 HEMI_FIXTURES_BASE 指定。`);
  }
}

browser = await chromium.launch({headless: true, executablePath: process.env.HEMI_DESIGN_BROWSER_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context = await browser.newContext({viewport: {width: 980, height: 760}});
  const page = await context.newPage();
  const errors_seen = [];
  page.on('pageerror', error => errors_seen.push(String(error)));

  const open = async (scene, query = '') => {
    await page.goto(`${base}/fixtures.html?scene=${scene}${query}`, {waitUntil: 'networkidle'});
    await page.locator('.settings-shell').waitFor();
    await page.waitForTimeout(250);
  };

  // 1. 未配置引导态：导航含「备份」八项、页面显示目标配置与立即/定时区块；
  //    无错误与通知时不显示「先设置备份目标」状态卡（2026-11 用户裁决：目标表单即引导）
  await open('settings-backup', '&state=empty');
  const nav = page.getByRole('navigation', {name: '设置导航'});
  const navText = (await nav.locator('button').allTextContents()).join('|');
  assert.ok(navText.includes('备份'), `本地导航应含「备份」分类：${navText}`);
  const bodyEmpty = await page.locator('.settings-shell').innerText();
  for (const text of ['备份目标', '立即备份', '定时备份']) assert.ok(bodyEmpty.includes(text), `empty 态应含「${text}」`);
  assert.ok(bodyEmpty.includes('应用密码') || bodyEmpty.includes('坚果云'), 'empty 态应有 WebDAV/坚果云引导');
  assert.ok(await page.getByRole('button', {name: '选择…'}).count() === 1, '本地文件夹模式应有唯一的「选择…」目录按钮');
  for (const text of ['先设置备份目标', '避免卸载后丢失']) assert.ok(!bodyEmpty.includes(text), `empty 态不应显示多余状态卡：「${text}」`);
  // 页面滚动在 .settings-shell 内部，加高视口取整页（同 configured）。
  await page.setViewportSize({width: 980, height: 1700});
  await page.waitForTimeout(150);
  await page.screenshot({path: path.join(evidence, `backup-empty-${mode}.png`), fullPage: true});
  await page.setViewportSize({width: 980, height: 760});
  check(`empty 态渲染（导航含备份分类＋无冗余状态卡）`);

  // 2. 已配置态：目标信息（表单值）、上次备份状态、备份集列表（含损坏标记）、明文提示
  // 截图说明：页面滚动发生在 .settings-shell 内部，fullPage 拍不到，用加高视口取整页。
  await open('settings-backup', '&state=configured');
  await page.setViewportSize({width: 980, height: 1700});
  await page.waitForTimeout(150);
  // 方向 B（2026-11）：已保存目标默认收起为只读值行，地址以灰字显示；输入框在「编辑」后就地展开（见截图后断言）。
  assert.equal(await page.locator('#backup-url').count(), 0, '已配目标默认应收起，不显示输入框');
  const bodyFull = await page.locator('.settings-shell').innerText();
  for (const text of ['上次备份成功', 'hemi-backup-20261031-1011', '损坏', '明文副本']) {
    assert.ok(bodyFull.includes(text), `configured 态应含「${text}」`);
  }
  // 仅轻量档（2026-11 用户裁决）：一个「立即备份」按钮，无档位选择与完整档入口
  assert.equal(await page.getByRole('button', {name: '立即备份'}).count(), 1, '立即备份应只有一个按钮');
  assert.equal(await page.locator('#backup-tier').count(), 0, '不应再有档位选择控件');
  assert.ok(!bodyFull.includes('完整档'), `不应再出现完整档文案：${bodyFull}`);
  await page.screenshot({path: path.join(evidence, `backup-configured-${mode}.png`), fullPage: true});
  await page.getByRole('button', {name: '编辑备份目标'}).click();
  assert.equal(await page.locator('#backup-url').inputValue(), 'https://dav.jianguoyun.com/dav/', '编辑展开后已配 WebDAV 地址应回填表单');
  assert.equal(await page.locator('#backup-account').inputValue(), 'me@example.com', '编辑展开后账号应回填');
  assert.equal(await page.locator('#backup-password').getAttribute('placeholder'), '已保存，留空保持不变', '已存密码不回显，只提示已保存');
  await page.screenshot({path: path.join(evidence, `backup-configured-editing-${mode}.png`), fullPage: true});
  check('configured 态渲染（目标收起＋编辑就地展开回填＋上次状态＋单按钮立即备份，无档位 UI）');

  // 3. 目录选择回填：pick-ready 桩返回路径，点击「选择…」后填入输入框
  await open('settings-backup', '&state=pick-ready');
  await page.getByRole('button', {name: '选择…'}).click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('#backup-dir').inputValue(), '/Users/demo/Backups/Hemi', '选择目录后应回填路径');
  check('目录选择按钮回填路径');

  // 5. 删除备份集：点「删除」→ 气泡确认 → 删除后列表更新
  await open('settings-backup', '&state=configured');
  //    确认为锚定「删除」链接的小气泡（.h68-confirm，role=alertdialog）：全页唯一、写明不可恢复；
  //    取消／Esc／点外部都关闭且不删除；损坏集合单独文案；点其他行删除气泡移过去；
  //    确认后列表移除该行、其余保留、气泡关闭。
  const bubble = page.locator('.h68-confirm');
  const delNew = page.getByRole('button', {name: /^删除 hemi-backup-20261031/});
  const delBroken = page.getByRole('button', {name: /^删除 hemi-backup-20261030/});
  const settle = () => page.waitForTimeout(250); // 退出动效 140ms 后节点卸载
  await delNew.click();
  await settle();
  assert.equal(await bubble.count(), 1, '点删除应弹出唯一一个确认气泡');
  assert.equal(await page.locator('.h68-delete').count(), 0, '不应再有行下展开确认条');
  assert.equal(await delNew.getAttribute('aria-expanded'), 'true', '删除按钮应标记 aria-expanded');
  assert.equal(await bubble.getAttribute('role'), 'alertdialog', '确认气泡应为 alertdialog');
  const bubbleText = await bubble.innerText();
  assert.ok(bubbleText.includes('删除此备份') && bubbleText.includes('不可恢复'), `气泡文案：${bubbleText}`);
  const [bb, tb] = [await bubble.boundingBox(), await delNew.boundingBox()];
  assert.ok(bb && tb && bb.height <= 110 && bb.y >= tb.y + tb.height && bb.y - (tb.y + tb.height) < 24, `气泡应紧凑并锚定在删除链接下方：${JSON.stringify({bb, tb})}`);
  await page.screenshot({path: path.join(evidence, `backup-delete-confirm-${mode}.png`), fullPage: true});
  await bubble.getByRole('button', {name: '取消'}).click();
  await settle();
  assert.equal(await bubble.count(), 0, '取消应关闭气泡');
  assert.ok((await page.locator('.settings-shell').innerText()).includes('hemi-backup-20261031-1011'), '取消不应删除');
  await delNew.click();
  await settle();
  await page.keyboard.press('Escape');
  await settle();
  assert.equal(await bubble.count(), 0, 'Esc 应关闭气泡');
  await delNew.click();
  await settle();
  await page.locator('.h68-backup .h37-page-head h2').click();
  await settle();
  assert.equal(await bubble.count(), 0, '点气泡外部应关闭');
  await delBroken.click();
  await settle();
  const brokenText = await bubble.innerText();
  assert.ok(brokenText.includes('已损坏') && brokenText.includes('不可恢复'), `损坏集合气泡文案：${brokenText}`);
  await delNew.click();
  await settle();
  assert.equal(await bubble.count(), 1, '点其他行删除后仍只有一个气泡');
  assert.equal(await delNew.getAttribute('aria-expanded'), 'true', '气泡应移到新目标行');
  assert.notEqual(await delBroken.getAttribute('aria-expanded'), 'true', '原目标行应已收起');
  assert.ok(await page.getByRole('button', {name: /^确认删除 hemi-backup-20261031/}).isVisible(), '删除需二次确认');
  await page.getByRole('button', {name: /^确认删除 hemi-backup-20261031/}).click();
  await page.waitForTimeout(300);
  const bodyAfterDelete = await page.locator('.settings-shell').innerText();
  assert.ok(!bodyAfterDelete.includes('hemi-backup-20261031-1011'), '删除后列表应移除该备份集');
  assert.ok(bodyAfterDelete.includes('hemi-backup-20261030-2204'), '其余备份集保留');
  assert.equal(await bubble.count(), 0, '删除完成后气泡关闭');
  check('删除备份集（气泡确认＋列表更新）');

  // 6. 恢复向导交互：点击恢复 → 预览（会话/记忆计数＋覆盖警告）→ 取消回到列表；
  //    取消恢复正常路径无需成功提示（2026-11 反馈收敛：取消不出 toast）
  await open('settings-backup', '&state=configured');
  await page.getByRole('button', {name: /^删除 hemi-backup-20261031/}).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', {name: /^恢复 hemi-backup/}).first().click();
  await page.waitForTimeout(250);
  assert.equal(await page.locator('.h68-confirm').count(), 0, '展开恢复预览应关闭删除确认气泡');
  const restorePanel = await page.locator('.settings-shell').innerText();
  assert.ok(restorePanel.includes('120'), '恢复预览应显示会话计数');
  assert.ok(restorePanel.includes('pi-memory') || restorePanel.includes('记忆'), '恢复预览应显示覆盖范围');
  const cancel = page.getByRole('button', {name: /取消/});
  assert.ok(await cancel.count() > 0, '恢复向导应有取消按钮');
  await cancel.first().click();
  await page.waitForTimeout(150);
  assert.equal(await page.locator('.h37-toast').count(), 0, '取消恢复不应再弹成功 toast');
  await page.screenshot({path: path.join(evidence, `backup-restore-cancelled-${mode}.png`), fullPage: true});
  check('恢复向导（预览计数＋覆盖范围＋可取消，取消无多余提示）');

  // 4b. 恢复确认成功：toast 含重启提示且停留超过常规成功时长（2026-11 修复：重要终态不闪没）
  await page.getByRole('button', {name: /^恢复 hemi-backup/}).first().click();
  await page.getByRole('button', {name: '确认恢复'}).click();
  const restartToast = page.locator('.h37-toast', {hasText: '重启应用后完全生效'});
  await restartToast.waitFor();
  await page.waitForTimeout(3500);
  assert.equal(await restartToast.count(), 1, '重启提示应停留超过 2.6s 常规成功时长');
  check('恢复确认成功 toast（含重启提示，长停留）');

  // 5. 手动备份反馈去重（2026-11 双「备份完成」行修复）：fixture 按主进程真实时序
  //    （pack 事件 → done 事件 → runBackupNow 返回）触发。断言：进行中进度行出现，
  //    终态只有一个「备份完成」toast，页内 message 行不出现完成文案，结束后无残留。
  await open('settings-backup', '&state=configured');
  await page.getByRole('button', {name: '立即备份'}).click();
  await page.locator('.h68-message', {hasText: '打包中'}).waitFor();
  await page.locator('.h37-toast', {hasText: '备份完成'}).waitFor();
  assert.equal(await page.locator('.h37-toast').count(), 1, '备份完成应只有一个 toast（事件与返回值不得双报）');
  assert.equal(await page.locator('.h68-message', {hasText: '备份完成'}).count(), 0, '完成文案不应再进页内 message 行');
  await page.screenshot({path: path.join(evidence, `backup-run-done-toast-${mode}.png`), fullPage: true});
  await page.locator('.h37-toast', {hasText: '备份完成'}).waitFor({state: 'detached', timeout: 5000});
  assert.equal(await page.locator('.h68-message', {hasText: '打包中'}).count(), 0, '完成后进行中进度行应清除');
  const afterBackup = await page.locator('.settings-shell').innerText();
  assert.ok(!afterBackup.includes('备份完成'), `toast 消失后页内不应残留完成文案：${afterBackup}`);
  check('手动备份终态单一 toast（无重复完成行，进度行结束即清）');

  // 6. 备份失败：error 事件先到、runBackupNow 返回失败——唯一错误 toast（含原因），页内无残留
  await open('settings-backup', '&state=backup-fail');
  await page.getByRole('button', {name: '立即备份'}).click();
  await page.locator('.h37-toast[data-tone="err"]', {hasText: '模拟上传失败'}).waitFor();
  await page.screenshot({path: path.join(evidence, `backup-run-fail-toast-${mode}.png`), fullPage: true});
  assert.equal(await page.locator('.h37-toast').count(), 1, '备份失败应只有一个 toast');
  assert.equal(await page.locator('.h68-message').count(), 0, '失败反馈不进页内行');
  assert.equal(await page.locator('.h68-message', {hasText: '打包中'}).count(), 0, '失败后进度行应清除');
  check('备份失败单一错误 toast（含原因、不静默）');

  // 6b. 迟到终态事件（resolve 后 1800ms 再补发 done，超过任何时间窗启发式）：
  //     终态 toast 只认 runBackupNow 返回值；迟到事件不得弹第二条 toast，也不残留页内。
  //     MutationObserver 逐节点计数（toast 换 key 重挂载同样计入），不依赖时序猜测。
  await open('settings-backup', '&state=backup-late');
  await page.evaluate(() => {
    const win = window;
    win.__hemiBackupToasts = [];
    const seen = new WeakSet();
    const collect = () => {
      for (const el of document.querySelectorAll('.h37-toast')) {
        if (!seen.has(el)) { seen.add(el); win.__hemiBackupToasts.push(el.textContent ?? ''); }
      }
    };
    new MutationObserver(collect).observe(document.body, { childList: true, subtree: true });
    collect();
  });
  await page.getByRole('button', {name: '立即备份'}).click();
  await page.locator('.h37-toast', {hasText: '备份完成'}).waitFor();
  await page.waitForTimeout(3000); // 迟到事件（resolve 后 1800ms）已落地，首条 toast（2.6s）已过期
  const lateToasts = await page.evaluate(() => window.__hemiBackupToasts);
  assert.equal(lateToasts.length, 1, `迟到终态事件不得再弹第二条 toast：${lateToasts.join(' | ')}`);
  assert.equal(await page.locator('.h37-toast').count(), 0, '最终不应有残留 toast');
  const afterLate = await page.locator('.settings-shell').innerText();
  assert.ok(!afterLate.includes('备份完成'), `迟到事件不应在页内残留完成文案：${afterLate}`);
  check('迟到终态事件不双报（终态唯一出口为返回值，无时间窗启发式）');

  // 6c. 备份成功但刷新失败：终态仍只报成功一次，刷新失败明确归因「列表刷新失败」，
  //     不得把成功的备份弹成备份失败。
  await open('settings-backup', '&state=backup-refresh-fail');
  await page.evaluate(() => {
    const win = window;
    win.__hemiBackupToasts = [];
    const seen = new WeakSet();
    const collect = () => {
      for (const el of document.querySelectorAll('.h37-toast')) {
        if (!seen.has(el)) { seen.add(el); win.__hemiBackupToasts.push(el.textContent ?? ''); }
      }
    };
    new MutationObserver(collect).observe(document.body, { childList: true, subtree: true });
    collect();
  });
  await page.getByRole('button', {name: '立即备份'}).click();
  await page.locator('.h37-toast[data-tone="err"]', {hasText: '备份已完成，列表刷新失败'}).waitFor();
  const refreshToasts = await page.evaluate(() => window.__hemiBackupToasts);
  // 成功终态与刷新失败提示间隔极短时 React 会合并渲染（只出合并文案）；慢时序下则先成功
  // 后归因两条。两种都正确：成功事实不丢（首条含「备份完成」或唯一条自带「已完成」前缀），
  // 最终提示明确归因刷新失败，全程不得出现备份失败文案。
  assert.ok(refreshToasts.length >= 1 && refreshToasts.length <= 2, `toast 序列异常：${refreshToasts.join(' | ')}`);
  const lastToast = refreshToasts[refreshToasts.length - 1];
  assert.ok(lastToast.includes('备份已完成，列表刷新失败'), `最终提示应明确归因刷新失败：${lastToast}`);
  const allToasts = refreshToasts.join(' | ');
  assert.ok(!allToasts.includes('备份失败') && !allToasts.includes('操作失败'),
    `全程不得出现备份失败文案：${allToasts}`);
  check('备份成功后刷新失败单独归因（不误报备份失败、不静默）');

  // 7. 保存目标与测试连接：成功短反馈走 toast，不再堆页内 message 行
  await open('settings-backup', '&state=configured');
  await page.getByRole('button', {name: '编辑备份目标'}).click();
  await page.locator('#backup-remote-dir').fill('hemi-backups-2');
  await page.getByRole('button', {name: '保存目标'}).click();
  await page.locator('.h37-toast', {hasText: '备份目标已保存'}).waitFor();
  assert.equal(await page.locator('.h68-message').count(), 0, '保存成功反馈不应留在页内');
  await page.getByRole('button', {name: '测试连接'}).click();
  await page.locator('.h37-toast', {hasText: '连接成功'}).waitFor();
  assert.equal(await page.locator('.h37-toast').count(), 1, '同一时刻只保留最新一条 toast');
  check('保存目标/测试连接 toast 反馈');

  // 8. Bot 环境不含「备份」分类
  await open('settings-bot');
  const botNavText = (await page.getByRole('navigation', {name: '设置导航'}).locator('button').allTextContents()).join('|');
  assert.ok(!botNavText.includes('备份'), `Bot 导航不应含「备份」：${botNavText}`);
  check('Bot 环境导航不含备份分类');

  assert.deepEqual(errors_seen, [], `页面不应有未捕获异常：${errors_seen.join(' / ')}`);
  check('零 pageerror');
} catch (error) {
  errors.push(String(error?.stack ?? error));
} finally {
  await browser?.close();
  await server?.close();
  if (directory) await rm(directory, {recursive: true, force: true});
}

if (errors.length) {
  console.error(`FAIL ${mode}: ${errors.join('\n')}`);
  process.exit(1);
}
console.log(`${mode}: ${checks.length} 项全部通过`);

// Browser integration only. Native builds, plugins and SSH require device checks.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createServer, preview } from 'vite';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const app = path.join(root, 'apps/mobile');
const output = path.join(root, '.visual/workflow/vision/mobile');
await fs.mkdir(output, { recursive: true });
await fs.access(path.join(app, 'dist/index.html'));
const browser = await chromium.launch({
  executablePath: process.env.HEMI_CHROME_PATH ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
});
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(), node: process.version, platform: `${process.platform}/${process.arch}`, results: [] };

try {
  for (const mode of ['dev', 'built']) {
    const options = { configFile: path.join(app, 'vite.config.ts'), root: app, logLevel: 'error' };
    const server = mode === 'dev'
      ? await createServer({ ...options, server: { host: '127.0.0.1', port: 0 } })
      : await preview({ ...options, preview: { host: '127.0.0.1', port: 0 } });
    if (mode === 'dev') await server.listen();
    const url = server.resolvedUrls.local[0];
    const context = await browser.newContext({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce', permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    const errors = [];
    const external = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(`${message.text()} (${message.location().url})`); });
    page.on('request', request => { if (new URL(request.url()).origin !== new URL(url).origin) external.push(request.url()); });
    const checks = [];
    try {
      await page.goto(url);
      await page.getByRole('heading', { name: '移动端预览' }).waitFor();
      await page.locator('[data-hemi-conversation-flow] .h24-hemi-message').first().waitFor();
      assert.equal(await page.evaluate(() => typeof window.hemiVoice), 'undefined');
      checks.push('SDK runs without desktop globals');

      for (const width of [320, 375, 390, 768, 1440]) {
        await page.setViewportSize({ width, height: 812 });
        // Flush visualViewport resize and compositor frames before recording.
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        const layout = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > innerWidth,
          shell: document.querySelector('main').getBoundingClientRect().toJSON(),
          composer: document.querySelector('.composer').getBoundingClientRect().toJSON(),
        }));
        assert.equal(layout.overflow, false, `${width}: horizontal overflow`);
        assert.ok(layout.composer.bottom <= 813 && layout.composer.top > 100, `${width}: composer outside viewport`);
        await page.screenshot({ path: path.join(output, `${mode}-${width}.png`) });
      }
      checks.push('320/375/390/768/1440: viewport and composer bounds');
      await page.setViewportSize({ width: 375, height: 480 });
      await page.waitForFunction(() => document.querySelector('.composer').getBoundingClientRect().bottom <= 481);
      await page.setViewportSize({ width: 375, height: 812 });
      await page.emulateMedia({ colorScheme: 'dark' });
      assert.equal(await page.locator('main').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(255, 255, 255)');
      await page.screenshot({ path: path.join(output, `${mode}-system-dark.png`) });
      checks.push('viewport resize cleanup; declared light appearance under system dark');

      await page.getByRole('button', { name: '复制完整回答', exact: true }).first().click();
      assert.match(await page.evaluate(() => navigator.clipboard.readText()), /这是一段离线示例/);
      checks.push('real browser clipboard host');

      await page.getByRole('textbox', { name: '消息', exact: true }).fill('验证停止后的状态');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor();
      await page.getByRole('button', { name: '停止回复', exact: true }).click();
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'hidden' });
      const stopped = await page.locator('.flow-frame [data-hemi-conversation-flow]').innerText();
      await page.waitForTimeout(200);
      assert.equal(await page.locator('.flow-frame [data-hemi-conversation-flow]').innerText(), stopped);
      checks.push('send → stream → stop without late chunks');

      await page.getByRole('button', { name: '编辑这条消息', exact: true }).first().click();
      await page.getByRole('textbox', { name: '编辑消息', exact: true }).fill('修改后的演示任务');
      await page.getByRole('button', { name: '重新发送', exact: true }).click();
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor();
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
      const flow = await page.locator('.flow-frame [data-hemi-conversation-flow]').innerText();
      assert.match(flow, /修改后的演示任务/);
      assert.match(flow, /没有连接 Bot/);
      assert.doesNotMatch(flow, /验证停止后的状态/);
      checks.push('edit → truncate subsequent history → stream replacement');

      await page.getByRole('button', { name: 'Bot 连接', exact: true }).click();
      await page.getByText('Bot 尚未接入', { exact: true }).waitFor();
      await page.screenshot({ path: path.join(output, `${mode}-connection.png`) });
      await page.getByRole('button', { name: '开源许可', exact: true }).click();
      const response = await context.request.get(new URL('licenses/notices.txt', url).href);
      assert.equal(response.status(), 200);
      assert.match(await response.text(), /@capacitor\/ios@8\.5\.3/);
      await page.getByRole('button', { name: '返回对话', exact: true }).click();
      assert.match(await page.locator('.flow-frame [data-hemi-conversation-flow]').innerText(), /修改后的演示任务/);
      checks.push('connection disclosure, bundled licenses, navigation preserves state');

      // Leaving and returning during a stream must not create a second timer.
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('切换页面测试');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await page.getByRole('button', { name: 'Bot 连接', exact: true }).click();
      await page.getByRole('button', { name: '体验对话流', exact: true }).click();
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
      assert.equal(await page.locator('.h24-user-message').count(), 2);
      checks.push('navigation during streaming and React StrictMode lifecycle');

      await page.getByRole('textbox', { name: '消息', exact: true }).fill('先执行的演示任务');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor();
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('运行期间加入队列');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await page.getByText('待发送消息（1）', { exact: true }).waitFor();
      assert.equal(await page.locator('.h24-user-bubble').filter({hasText: '运行期间加入队列'}).count(), 0);
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'hidden', timeout: 15000 });
      assert.equal(await page.locator('.h24-user-bubble').filter({hasText: '运行期间加入队列'}).count(), 1);
      checks.push('shared SDK queue: accepted pending input appears once after dispatch');

      await page.getByRole('button', { name: 'Bot 连接', exact: true }).click();
      await page.getByRole('button', { name: '模拟断线', exact: true }).click();
      await page.getByRole('button', { name: '返回对话', exact: true }).click();
      await page.getByRole('textbox', { name: '消息', exact: true }).fill('断线后等待恢复');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await page.getByText('待发送消息（1）', { exact: true }).waitFor();
      assert.equal(await page.locator('.h24-user-bubble').filter({hasText: '断线后等待恢复'}).count(), 0);
      await page.screenshot({ path: path.join(output, `${mode}-offline-queue.png`) });
      await page.getByRole('button', { name: 'Bot 连接', exact: true }).click();
      await page.getByRole('button', { name: '恢复演示连接', exact: true }).click();
      await page.getByRole('button', { name: '返回对话', exact: true }).click();
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor();
      await page.getByRole('button', { name: '停止回复', exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
      assert.equal(await page.locator('.h24-user-bubble').filter({hasText: '断线后等待恢复'}).count(), 1);
      checks.push('shared SDK outbox → reconnect → reconcile → send without duplicate');

      await page.getByRole('textbox', { name: '消息', exact: true }).fill('重载后保留的草稿');
      await page.waitForFunction(() => Object.keys(localStorage).some(key => key.includes('draft') && localStorage.getItem(key).includes('重载后保留的草稿')));
      await page.reload();
      await page.waitForFunction(() => document.querySelector('#message-input')?.value === '重载后保留的草稿');
      checks.push('shared SDK draft persistence survives renderer reload');
      assert.deepEqual(errors, []);
      assert.deepEqual(external, []);
      checks.push('no renderer errors or external requests');
      report.results.push({ mode, checks, errors, external });
    } finally {
      await context.close();
      await server.close();
    }
  }
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser.close();
}

// Real renderer -> IPC -> runtime -> local HTTP retries -> persisted recovery anchor.
// Synthetic provider and fresh profiles only; both development and built renderers.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';

const repo = path.resolve(import.meta.dirname, '..');
const out = path.join(repo, '.visual/workflow/vision/recovery-order');
await fs.mkdir(out, {recursive: true});
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8'}).trim(), workingTree: true,
  node: process.version, environment: `${process.platform}/${process.arch}`, results: []};
const wait = async (predicate, label) => {
  const deadline = Date.now() + 25000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timeout: ${label}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
};
try {
  for (const mode of ['dev', 'built']) {
    const userData = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-recovery-order-'));
    const result = {mode, checks: [], errors: [], screenshots: []};
    report.results.push(result);
    const check = name => {result.checks.push(name); console.log('PASS', mode, name);};
    let app, page, vite, releaseFinal, mainRequests = 0;
    const finalGate = new Promise(resolve => {releaseFinal = resolve;});
    const provider = http.createServer(async (req, res) => {
      try {
        let raw = ''; for await (const chunk of req) raw += chunk;
        const body = JSON.parse(raw), main = body.tools?.length > 0;
        const n = main ? ++mainRequests : 0;
        if (n === 2) {
          res.writeHead(503, {'content-type': 'application/json'});
          res.end(JSON.stringify({error: {message: 'Service unavailable', type: 'api_error'}}));
          return;
        }
        if (n >= 4) await finalGate;
        res.writeHead(200, {'content-type': 'text/event-stream'});
        const send = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({id: 'recovery-order', model: body.model,
          choices: [{index: 0, delta, finish_reason}]})}\n\n`);
        const content = n === 1 ? '重连之前的输出。' : n === 3 ? '重连之后继续输出。' : main ? '后续任务已经完成。' : '恢复排序验证';
        send({role: 'assistant', content});
        if (n === 1 || n === 3) {
          send({tool_calls: [{index: 0, id: `order-tool-${n}`, type: 'function',
            function: {name: 'bash', arguments: JSON.stringify({command: 'echo recovery-order', timeout: 5})}}]});
          send({}, 'tool_calls');
        } else send({}, 'stop');
        res.end('data: [DONE]\n\n');
      } catch (error) {result.errors.push(String(error)); res.destroy();}
    });
    try {
      await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
      const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
      await fs.writeFile(path.join(userData, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
      await fs.writeFile(path.join(userData, 'text-model-profiles.json'), JSON.stringify({version: 3,
        defaultModelId: 'ordering/main', lastConversationModelKey: 'ordering/main', providers: [{id: 'ordering', name: '排序验证',
          api: 'openai-completions', baseUrl, models: [{id: 'main', model: 'ordering', thinkingLevel: 'off'}]}]}));
      if (mode === 'dev') {
        vite = await createServer({configFile: path.join(repo, 'vite.config.ts'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}});
        await vite.listen();
      }
      const env = {...process.env, HEMI_USER_DATA_DIR: userData, HEMI_TEST_MIC_GRANT: '1',
        HEMI_LLM_API_KEY: 'SYNTHETIC_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'ordering'};
      if (vite) env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
      app = await _electron.launch({executablePath: electronPath, args: ['.'], env});
      await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return !!page;}, 'main window');
      page.setDefaultTimeout(15000);
      page.on('pageerror', error => result.errors.push(error.message));
      page.on('console', message => {if (message.type() === 'error') result.errors.push(message.text());});
      const input = page.locator('textarea.text-composer-input');
      await input.waitFor();
      await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({id: 'ordering', name: '排序验证', api: 'openai-completions',
        baseUrl, apiKey: 'SYNTHETIC_ONLY', models: [{id: 'main', model: 'ordering', thinkingLevel: 'off'}], makeDefault: true}), baseUrl);
      await page.reload(); await input.waitFor();
      await input.fill('RECOVERY_ORDER 检查恢复顺序'); await input.press('Enter');
      await page.locator('.model-recovery-notice[data-phase="waiting"]').waitFor();
      const cid = await page.evaluate(async () => (await window.hemiVoice.listConversations()).sessions.find(item => item.title.includes('RECOVERY_ORDER')).id);
      const flow = () => page.evaluate(cid => window.hemiVoice.flowGetSnapshot(cid), cid);
      const first = await flow(), runId = first.activeRunId, anchor = first.runs[runId].recovery.anchor;
      assert.ok(anchor?.afterPartId, 'production runtime captures the pre-failure output position');
      await wait(async () => (await flow()).runs[runId].recovery.phase === 'recovered' && mainRequests >= 4, 'continued tool turn');
      const assertOrder = async () => {
        await page.getByText('重连之前的输出。', {exact: true}).waitFor();
        await page.getByText('重连之后继续输出。', {exact: true}).waitFor();
        assert.equal(await page.locator('.model-recovery-notice').count(), 1);
        const order = await page.evaluate(() => {
          const rows = [...document.querySelectorAll('article.h24-hemi-message')];
          const before = rows.findIndex(row => row.textContent.includes('重连之前的输出。'));
          const recovery = rows.findIndex(row => row.querySelector('.model-recovery-notice'));
          const after = rows.findIndex(row => row.textContent.includes('重连之后继续输出。'));
          return {before, recovery, after};
        });
        assert.ok(order.before >= 0 && order.before < order.recovery && order.recovery < order.after, JSON.stringify(order));
      };
      await assertOrder();
      assert.deepEqual((await flow()).runs[runId].recovery.anchor, anchor);
      check('real HTTP 503 recovery remains before subsequent model/tool output');
      await page.reload(); await input.waitFor(); await assertOrder();
      check('renderer reload preserves recovery position and identity');
      releaseFinal();
      await wait(async () => (await flow()).phase === 'idle', 'run completion');
      await assertOrder(); assert.equal(mainRequests, 4);
      assert.deepEqual((await flow()).runs[runId].recovery.anchor, anchor);
      const stored = JSON.parse(await fs.readFile(path.join(userData, 'runtime-v2/conversations', `${cid}.json`), 'utf8'));
      assert.deepEqual(stored.flow.runs[runId].recovery.anchor, anchor);
      check('completion and persisted history retain the anchor without duplicate requests');
      await page.locator('.model-recovery-title').filter({hasText: '恢复记录'}).waitFor();
      const shot = async label => {
        const file = `${mode}-${label}.png`;
        await page.screenshot({path: path.join(out, file), scale: 'css'}); result.screenshots.push(file);
      };
      for (const width of [1440, 768, 375]) {
        await app.evaluate(({BrowserWindow}, width) => {
          const win = BrowserWindow.getAllWindows().find(w => /^(http|file):/.test(w.webContents.getURL()) && !new URL(w.webContents.getURL()).searchParams.has('mode'));
          win.setMinimumSize(300, 400); win.setContentSize(width, 900);
        }, width);
        await page.waitForFunction(width => innerWidth === width, width);
        await page.waitForTimeout(350);
        await assertOrder();
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
        await shot(String(width));
      }
      check('1440/768/375 layouts preserve order without horizontal overflow');
      assert.deepEqual(result.errors, []);
    } catch (error) {
      result.error = error.stack;
      await page?.screenshot({path: path.join(out, `${mode}-failure.png`)}).catch(() => {});
      throw error;
    } finally {
      releaseFinal(); await app?.close(); await vite?.close();
      provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));
      await fs.rm(userData, {recursive: true, force: true});
    }
  }
} finally {
  await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

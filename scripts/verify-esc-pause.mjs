// Esc pause regression against the real desktop window; stubbed streaming provider, isolated data.
// node scripts/verify-esc-pause.mjs [--dev|--built]（默认两个模式都跑）
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {createServer} from 'vite';
import {_electron} from 'playwright-core';
import electronPath from 'electron';

const modes = process.argv.includes('--dev') ? ['dev'] : process.argv.includes('--built') ? ['built'] : ['dev', 'built'];
const repo = path.resolve(import.meta.dirname, '..');
const out = path.join(repo, '.visual/esc-pause');
await fs.mkdir(out, {recursive: true});
const report = {commit: execFileSync('git', ['rev-parse', 'HEAD'], {encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore']}).trim(),
  workingTree: true, date: new Date().toISOString(), node: process.version, environment: `${process.platform}/${process.arch}`,
  command: 'node scripts/verify-esc-pause.mjs', gaps: ['Desktop renderer only; mobile has no window-level keyboard page.'], results: []};
const wait = async (predicate, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (!await predicate()) {assert.ok(Date.now() < deadline, `Timeout: ${label}`); await new Promise(resolve => setTimeout(resolve, 40));}
};
try {
for (const mode of modes) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-esc-pause-'));
  const userData = path.join(root, 'profile');
  process.env.HEMI_USER_DATA_DIR = userData;
  const result = {mode, checks: [], errors: []}; report.results.push(result);
  const check = name => {result.checks.push(name); console.log(`PASS ${mode}: ${name}`);};
  let app, server, provider, held = [], page, lastSnap = null, requests = 0;
  try {
    await fs.mkdir(userData, {recursive: true});

    provider = http.createServer(async (req, res) => {
      let raw = ''; for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      if (body.tools?.length > 0) {
        requests += 1; held.push(res);
        res.writeHead(200, {'content-type': 'text/event-stream'});
        res.write(`data: ${JSON.stringify({id: 'esc-pause', model: body.model, choices: [{index: 0, delta: {role: 'assistant', content: `第${requests}次运行：慢速输出中，等待用户暂停。`}, finish_reason: null}]})}\n\n`);
        // 保持连接打开：模拟持续流式，直到 stop 取消。
        req.on('close', () => {try {res.end();} catch {}});
        return;
      }
      res.writeHead(200, {'content-type': 'text/event-stream'});
      res.write(`data: ${JSON.stringify({id: 'esc-pause-side', model: body.model, choices: [{index: 0, delta: {role: 'assistant', content: '旁路'}, finish_reason: 'stop'}]})}\n\n`);
      res.end('data: [DONE]\n\n');
    });
    await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
    const baseUrl = `http://127.0.0.1:${provider.address().port}/v1`;
    await fs.writeFile(path.join(userData, 'onboarding.json'), JSON.stringify({version: 2, phase: 'complete', step: 'done', permissionChoice: 'skipped', completedAt: Date.now()}));
    await fs.writeFile(path.join(userData, 'appearance.json'), JSON.stringify({schemaVersion: 1, skinId: 'classic', mode: 'light'}));
    await fs.writeFile(path.join(userData, 'text-model-profiles.json'), JSON.stringify({version: 3, defaultModelId: 'queue/main', lastConversationModelKey: 'queue/main',
      providers: [{id: 'queue', name: '隔离验证', api: 'openai-completions', baseUrl, models: [{id: 'main', model: 'queue', thinkingLevel: 'off'}]}]}));
    if (mode === 'dev') {server = await createServer({configFile: path.join(repo, 'vite.config.ts'), logLevel: 'error', server: {host: '127.0.0.1', port: 0, strictPort: false}}); await server.listen();}
    const env = {...process.env, HEMI_TEST_MIC_GRANT: '1', HEMI_LLM_API_KEY: 'SYNTHETIC_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'queue'};
    if (server) env.VITE_DEV_SERVER_URL = server.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    app = await _electron.launch({executablePath: electronPath, args: ['.'], cwd: repo, env});
    await wait(() => {page = app.windows().find(p => /^(http|file):/.test(p.url()) && !new URL(p.url()).searchParams.has('mode')); return Boolean(page);}, 'main window');
    page.on('pageerror', error => result.errors.push(error.message));
    await page.locator('textarea.text-composer-input').waitFor();
    await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({id: 'queue', name: '隔离验证', api: 'openai-completions', baseUrl,
      apiKey: 'SYNTHETIC_ONLY', models: [{id: 'main', model: 'queue', thinkingLevel: 'off'}], makeDefault: true}), baseUrl);
    await page.reload();
    await page.locator('textarea.text-composer-input').waitFor();
    const cidOf = async () => {
      const found = await page.evaluate(async () => {
        const list = await window.hemiVoice.listConversations().catch(() => null);
        const rows = Array.isArray(list) ? list : list?.sessions ?? [];
        const sorted = [...rows].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
        return sorted[0]?.id ?? (await window.hemiVoice.getLastConversation().catch(() => null))?.id ?? null;
      }).catch(() => null);
      return found;
    };
    const snap = async () => {lastSnap = await page.evaluate(cid => window.hemiVoice.flowGetSnapshot(cid), await cidOf()); return lastSnap;};
    const input = page.locator('textarea.text-composer-input');
    const send = async (text) => {
      await input.fill(text);
      await input.press('Enter');
      await wait(async () => (await input.inputValue()) === '', 'draft accepted');
    };
    await send('长任务：慢慢输出不要结束');
    const cid = await wait(cidOf, 'conversation id');
    result.conversationId = cid;
    await wait(async () => (await snap())?.phase !== 'idle', 'first run active');
    await wait(async () => requests === 1, 'provider streaming');
    await send('排队的第二条');
    await wait(async () => (await snap())?.pending?.length === 1, 'second message queued');
    assert.equal((await snap()).queuePaused, false);
    await page.screenshot({path: path.join(out, `${mode}-running.png`)});
    await page.keyboard.press('Escape');
    await wait(async () => {const s = await snap(); return s?.queuePaused === true && s?.phase === 'idle';}, 'esc pauses queue and stops run');
    check('Esc 暂停：运行收口且待发送队列进入暂停');
    await page.locator('.h24-queue-paused').waitFor();
    assert.match(await page.locator('.h24-queue-paused').innerText(), /队列已暂停/);
    assert.equal(requests, 1, 'queued message must not dispatch while paused');
    await page.screenshot({path: path.join(out, `${mode}-paused.png`)});
    await page.keyboard.press('Escape');
    await new Promise(resolve => setTimeout(resolve, 500));
    const afterIdleEsc = await snap();
    assert.equal(afterIdleEsc.queuePaused, true, 'idle Esc must not resume or change anything');
    assert.equal(afterIdleEsc.pending?.length ?? 0, 1);
    assert.equal(requests, 1);
    check('空闲时 Esc 无副作用（保持暂停不误恢复）');
    await page.locator('.h24-queue-resume').click();
    await wait(async () => (await snap())?.queuePaused === false, 'queue resumed');
    await wait(async () => requests === 2, 'queued message dispatched after resume');
    check('继续发送恢复队列并派发排队消息');
    await page.screenshot({path: path.join(out, `${mode}-resumed.png`)});
    assert.deepEqual(result.errors, []);
    check('渲染层无错误');
  } catch (error) {
    result.error = error.stack;
    if (page) {
      result.snapAtFailure = lastSnap;
      result.requestsAtFailure = requests;
      await page.screenshot({path: path.join(out, `${mode}-failure.png`)}).catch(() => {});
    }
    throw error;
  } finally {
    held.forEach(res => {try {res.end();} catch {}});
    await app?.close(); await server?.close();
    if (provider) {provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));}
    await fs.rm(root, {recursive: true, force: true});
  }
}
} finally {
await fs.writeFile(path.join(out, 'report.json'), JSON.stringify(report, null, 2) + '\n');
}

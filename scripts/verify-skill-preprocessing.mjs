// Actual dev/built renderer -> preload -> IPC -> Hemi catalog -> Pi -> local HTTP model.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { createServer } from 'vite';
import { _electron } from 'playwright-core';
import electronPath from 'electron';
import { replyToGoalCheck } from './lib/goal-model-fixture.mjs';

const repo = path.resolve(import.meta.dirname, '..');
const output = path.join(repo, '.visual/workflow/skill-preprocessing');
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-skill-preprocessing-'));
await fs.mkdir(output, { recursive: true });
const report = { commit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), workingTree: true,
  node: process.version, platform: `${process.platform}/${process.arch}`, results: [],
  gaps: ['No installed application, production Bot, or physical device was updated.'] };
const requests = [];
let app, page, vite, current;
const server = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (replyToGoalCheck(body, res)) return;
    if (body.tools?.length) requests.push(body);
    const content = body.tools?.length ? 'SKILL_PREPROCESSING_OK' : 'Isolated skill verification';
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }] }) +
      '\n\ndata: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 5 } }) + '\n\ndata: [DONE]\n\n');
  } catch (error) { current?.errors.push(error.message); res.destroy(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const wait = async (read, label) => {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) { const result = await read(); if (result) return result; await new Promise(resolve => setTimeout(resolve, 40)); }
  throw new Error(`Timeout: ${label}`);
};
const input = () => page.locator('textarea.text-composer-input');
const check = name => { current.checks.push(name); console.log(`PASS ${current.mode}: ${name}`); };
try {
  vite = await createServer({ configFile: path.join(repo, 'vite.config.ts'), cacheDir: path.join(root, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0, strictPort: false } });
  await vite.listen();
  for (const mode of ['dev', 'built']) {
    current = { mode, checks: [], errors: [] }; report.results.push(current);
    const profile = path.join(root, mode), workspace = path.join(profile, 'workspace/default');
    await fs.mkdir(path.join(workspace, '.git'), { recursive: true });
    const writeSkill = async (name, description) => {
      const dir = path.join(workspace, '.agents/skills', name);
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n${name} body`);
    };
    await writeSkill('good', 'GOOD_PROJECT_SKILL');
    await writeSkill('bad', 'Inspect changes. Trigger phrases include: "sync"');
    await fs.writeFile(path.join(profile, 'onboarding.json'), JSON.stringify({ version: 2, phase: 'complete', step: 'done', completedAt: Date.now() }));
    await fs.writeFile(path.join(profile, 'doubao-asr.json'), JSON.stringify({ globalPushToTalkEnabled: false }));
    const env = { ...process.env, HEMI_USER_DATA_DIR: profile, HEMI_TEST_MIC_GRANT: '1', HEMI_BOT_AUTO_UPDATE: '0',
      HEMI_LLM_API_KEY: 'SYNTHETIC_ONLY', HEMI_LLM_BASE_URL: baseUrl, HEMI_LLM_MODEL: 'skills' };
    if (mode === 'dev') env.VITE_DEV_SERVER_URL = vite.resolvedUrls.local[0]; else delete env.VITE_DEV_SERVER_URL;
    app = await _electron.launch({ executablePath: electronPath, args: ['.'], cwd: repo, env });
    await wait(() => { page = app.windows().find(window => /^(http|file):/.test(window.url()) && !new URL(window.url()).searchParams.has('mode')); return page; }, 'main window');
    page.setDefaultTimeout(10000); page.on('pageerror', error => current.errors.push(error.message));
    await input().waitFor();
    await page.evaluate(baseUrl => window.hemiVoice.saveModelProfile({ id: 'skills', name: '技能验证', api: 'openai-completions', baseUrl, apiKey: 'SYNTHETIC_ONLY',
      models: [{ id: 'main', model: 'skills', thinkingLevel: 'off', supportsVision: false }], makeDefault: true }), baseUrl);
    await page.reload(); await input().waitFor();
    const directory = await page.evaluate(() => window.hemiVoice.listSlashCandidates(''));
    assert.deepEqual(directory.skills.map(item => item.name), ['good']);
    assert.match(directory.skillsError, /YAML 格式错误/); assert.match(directory.skillsError, /bad\/SKILL.md/);
    await input().fill('/');
    const menu = page.getByRole('menu', { name: '命令与技能', exact: true });
    await menu.waitFor(); await menu.getByRole('status').filter({ hasText: '已跳过 1 个不可用技能' }).waitFor();
    assert.equal(await menu.getByRole('menuitem').filter({ hasText: 'good' }).count(), 1);
    await menu.getByRole('menuitem').filter({ hasText: 'good' }).waitFor();
    await page.screenshot({ path: path.join(output, `${mode}-skill-warning.png`) });
    await menu.getByText('部分技能不可用，查看原因', { exact: true }).click();
    await menu.getByRole('status').getByText(/YAML 格式错误/).waitFor();
    await menu.getByText('部分技能不可用，查看原因', { exact: true }).click();
    await input().press('Escape');
    check('IPC and slash menu retain valid skills and display the bad file warning');
    const send = async text => {
      const count = requests.length;
      await input().fill(text); await input().press('Enter');
      const id = await wait(() => page.evaluate(async text => {
        for (const item of (await window.hemiVoice.listConversations()).sessions) {
          const record = await window.hemiVoice.openConversation(item.id);
          if (record.turns.some(turn => turn.author === 'user' && turn.text === text)) return item.id;
        }
      }, text), 'conversation saved');
      const snapshot = await wait(async () => {
        const state = await page.evaluate(id => window.hemiVoice.flowGetSnapshot(id), id);
        return state.phase === 'idle' && Object.values(state.runs).length ? state : null;
      }, 'turn settled');
      assert.equal(Object.values(snapshot.runs).at(-1).outcome, 'completed');
      assert.ok(requests.length > count);
      const system = requests.at(-1).messages.find(message => message.role === 'system').content;
      assert.match(system, /GOOD_PROJECT_SKILL/); assert.doesNotMatch(system, /<name>bad<\/name>/);
      return id;
    };
    const first = await send(`FIRST_SKILL_TURN_${mode}`);
    await page.getByRole('button', { name: '新建对话', exact: true }).click();
    const second = await send(`NEW_SKILL_CONVERSATION_${mode}`);
    assert.notEqual(second, first);
    check('ordinary input and a genuinely new conversation complete through the actual Pi SDK');
    await writeSkill('bad', 'REPAIRED_PROJECT_SKILL');
    const repaired = await page.evaluate(id => window.hemiVoice.listSlashCandidates(id), second);
    assert.deepEqual(repaired.skills.map(item => item.name), ['bad', 'good']); assert.equal(repaired.skillsError, '');
    check('repairing the file restores it to the same candidate source');
    current.environment = await app.evaluate(({ app }) => ({ app: app.getVersion(), electron: process.versions.electron, node: process.versions.node }));
    assert.deepEqual(current.errors, []);
    await app.close(); app = null;
  }
  report.ok = true;
} finally {
  await app?.close(); await vite?.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  await fs.writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  await fs.rm(root, { recursive: true, force: true });
}

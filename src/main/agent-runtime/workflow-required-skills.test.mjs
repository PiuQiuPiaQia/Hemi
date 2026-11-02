// 生产装配链回归：真实 runtime→main-agent→hemi-session→Pi SDK，本机 HTTP provider。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createAgentRuntime } from './core.mjs';
import { createHemiSession } from '../agent/hemi-session.mjs';
import { AgentSessionError } from '../agent/session-contract.mjs';
import { createSkillStore } from '../skills/skill-store.mjs';
import { observeLiveSkillItems } from '../workflows/skill-executor.mjs';
import { freezeWorkflowModel } from '../workflows/workflow-model-plan.mjs';

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-required-skills-'));
  const cleanups = [], requests = [], warnings = [];
  const server = http.createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    requests.push(JSON.parse(raw));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.end(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', content: 'OK' }, finish_reason: null }] })}\n\ndata: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 } })}\n\ndata: [DONE]\n\n`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    try { for (const close of cleanups.reverse()) await close(); }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  const config = { modelKey: 'p/local', providerId: 'p', model: 'local', api: 'openai-completions',
    apiKey: 'SYNTHETIC', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, thinkingLevel: 'off' };
  const profiles = { list: async () => ({}),
    resolveStrict: async () => ({ ok: true, config }) };
  const plan = await freezeWorkflowModel({ selection: { mode: 'fixed', modelKey: config.modelKey }, store: profiles, roles: new Map() });
  const source = path.join(root, 'source'); await fs.mkdir(source);
  await fs.writeFile(path.join(source, 'SKILL.md'), '---\nname: race-demo\ndescription: 异步初始化窗口测试\n---\n按技能执行。');
  const store = createSkillStore({ root: path.join(root, 'skills') });
  await store.importDirectory(source);
  const lease = store.snapshot();
  cleanups.push(async () => { lease.release(); await store.prune(); });
  // 等价于 workflow-service 的提前检查：这里确实可用，不伪造候选或 prepareSkills。
  const skills = observeLiveSkillItems(lease.items);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].name, 'race-demo');
  const log = { warn: text => warnings.push(text), info() {}, debug() {} };
  return { root, source, skills, requests, warnings, config, profiles, plan, log,
    own: close => cleanups.push(close),
    spec: nodeType => ({ nodeSpec: { nodeId: 'node', nodeType, nodeData: { goal: '执行节点', skillRefs: [{ name: 'race-demo' }] } },
      executionOwner: { workflowRunId: 'wf-race', nodeId: 'node', attemptId: 'try-race' },
      invocation: { conversationId: 'workflow-race', run: { modelPlan: plan, workspace: { type: 'project', id: 'test', dir: root } } }, skills }),
  };
}

for (const invalidation of ['move-source', 'change-name']) {
  test(`真实工作流装配：提前观测成功，异步初始化后 ${invalidation} 在模型前失败`, { timeout: 30000 }, async t => {
    const f = await fixture(t);
    let entered, resume;
    const paused = new Promise(resolve => { entered = resolve; });
    const gate = new Promise(resolve => { resume = resolve; });
    const runtime = createAgentRuntime({ userDataDir: path.join(f.root, 'data'), getProfiles: () => f.profiles,
      resolveCapabilities: async () => ({ features: {}, extensionConfig: {} }), getAccessService: () => null,
      resolvePlacement: async () => { entered(); await gate; return { cwd: f.root, accessWorkspaceDir: f.root, loadContextFiles: false, remote: null }; }, log: f.log });
    f.own(() => runtime.close()); t.after(() => resume());
    const opening = runtime.openWorkflowNode(f.spec('hemi-skill'));
    void opening.catch(() => {});
    await paused; // 此时 openWorkflowNode 已走过模型计划初始化，尚未创建最终会话。
    assert.equal(f.requests.length, 0);
    if (invalidation === 'move-source') await fs.rename(f.source, `${f.source}-moved`);
    else await fs.writeFile(path.join(f.source, 'SKILL.md'), '---\nname: replaced-skill\ndescription: 不同身份\n---\n');
    resume();
    await assert.rejects(opening, error => {
      assert.ok(error instanceof AgentSessionError);
      assert.equal(error.code, 'dependency-unavailable', '不能被初始化包装为 start-failed');
      assert.match(error.message, /race-demo/);
      return true;
    });
    assert.equal(f.requests.length, 0, '不得发出无技能的模型请求');
    assert.ok(f.warnings.some(text => text.includes('Skill 不可用')));
    assert.equal(runtime.isBusy(), false);
  });
}

test('真实最终装配：必需技能按 id/path 校验，不能仅同名顶替', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  for (const mismatch of [{ id: 'different-id' }, { path: path.join(f.root, 'different-path') }]) {
    const session = createHemiSession({ cwd: f.root, agentDir: path.join(f.root, 'agent'), model: f.config,
      tools: [], features: {}, skills: f.skills, requiredSkills: [{ ...f.skills[0], ...mismatch }], log: f.log });
    f.own(() => session.close('reload'));
    await assert.rejects(() => session.ready(), { code: 'dependency-unavailable' });
  }
  assert.equal(f.requests.length, 0);
});

test('普通会话可选技能在最终装配前失效：警告跳过，真实 SDK 仍可请求本机模型', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  const session = createHemiSession({ cwd: f.root, agentDir: path.join(f.root, 'agent'), model: f.config,
    tools: [], features: {}, skills: f.skills, log: f.log });
  f.own(() => session.close('reload'));
  await fs.rename(f.source, `${f.source}-moved`);
  const result = await session.prompt('继续普通对话');
  assert.equal(result.modelError, null);
  assert.equal(result.lastText, 'OK');
  assert.equal(f.requests.length, 1);
  assert.ok(f.warnings.some(text => text.includes('Skill 不可用') && text.includes('SKILL.md')));
  assert.equal(JSON.stringify(f.requests[0]).includes('race-demo'), false);
});

test('普通工作流 agent 节点不把附带的可选技能变为强依赖', { timeout: 30000 }, async t => {
  const f = await fixture(t);
  await fs.rename(f.source, `${f.source}-moved`);
  const runtime = createAgentRuntime({ userDataDir: path.join(f.root, 'data'), getProfiles: () => f.profiles,
    resolveCapabilities: async () => ({ features: {}, extensionConfig: {} }), getAccessService: () => null, log: f.log });
  f.own(() => runtime.close());
  const node = await runtime.openWorkflowNode(f.spec('hemi-agent'));
  f.own(() => node.release());
  assert.equal(f.requests.length, 0, '初始化不需要模型请求');
  assert.ok(f.warnings.some(text => text.includes('Skill 不可用')));
});

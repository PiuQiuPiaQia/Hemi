import assert from 'node:assert/strict';
import test from 'node:test';

import {
  actionToolsOf,
  buildRoutingSection,
  loadRoles,
  MAIN_CONTROL_TOOLS,
  parseRoleDefinition,
  ROLE_NAMES,
  SUBAGENT_RESULT_GUIDANCE,
} from './agent-roles.mjs';
import { createAgentTools, formatSubagentResult } from './agent-tools.mjs';

test('内置四个角色：模式与工具面符合设计（只读角色无写工具，子 agent 无派单工具）', () => {
  const roles = loadRoles();
  assert.deepEqual([...roles.keys()], ROLE_NAMES);
  const writeTools = ['write', 'edit', 'bash', 'ui_act', 'browser_click', 'browser_type', 'browser_act'];
  for (const name of ['explorer', 'oracle']) {
    const role = roles.get(name);
    assert.equal(role.mode, 'verify');
    for (const tool of writeTools) assert.ok(!role.tools.includes(tool), `${name} 不得持有 ${tool}`);
  }
  assert.equal(roles.get('fixer').mode, 'run');
  for (const role of roles.values()) {
    assert.ok(!role.tools.some((tool) => ['task','task_status','task_message','task_cancel'].includes(tool)), `${role.name} 不得持有派单工具`);
    assert.ok(role.routing.startsWith(`@${role.name}`), '路由卡以 @角色 开头');
    assert.match(role.routing, /派：/);
    assert.match(role.routing, /不派：/);
  }
});

test('parseRoleDefinition：缺字段、非法模式与派单工具在加载时就报错', () => {
  const ok = '---\nname: x\nmode: verify\ntools: [read]\nrouting: "@x — 卡"\n---\n正文';
  assert.equal(parseRoleDefinition(ok).name, 'x');
  assert.throws(() => parseRoleDefinition(ok.replace('mode: verify', 'mode: god')), /mode/);
  assert.throws(() => parseRoleDefinition(ok.replace('tools: [read]', 'tools: [read, task]')), /派单工具/);
  assert.throws(() => parseRoleDefinition(ok.replace('routing: "@x — 卡"\n', '')), /routing/);
  assert.throws(() => parseRoleDefinition(ok.replace('正文', '')), /正文/);
});

test('路由段：只渲染可用角色；同输入逐字节一致（缓存前缀）', () => {
  const roles = loadRoles();
  const all = buildRoutingSection(roles);
  for (const name of ROLE_NAMES) assert.ok(all.includes(`@${name}`));
  assert.match(all, /派出去不是免费的/);
  const partial = buildRoutingSection(roles, { available: new Set(['explorer', 'fixer']) });
  assert.ok(partial.includes('@explorer') && partial.includes('@fixer'));
  assert.ok(!partial.includes('@designer —') && !partial.includes('@oracle —'));
  assert.equal(buildRoutingSection(roles, { available: new Set() }), '');
  assert.equal(buildRoutingSection(roles), all);
});

test('agent-tools：task 走 spawn，前台返回报告、后台返回 id；失败带 isError', async () => {
  const calls = [];
  const tools = createAgentTools({
    agents: ['explorer', 'fixer'],
    spawn: async (args) => {
      calls.push(args);
      if (args.agent === 'fixer') return { ok: true, background: true, alias: 'fixer-2' };
      if (args.prompt === 'boom') return { ok: false, error: '上限' };
      return { ok: true, background: false, result: { alias: 'explorer-1', agent: 'explorer', outcome: 'complete', report: 'R', truncated: false, toolCalls: 3, durationMs: 1200, fileChanges: [] } };
    },
    status: () => [],
    waitFor: async () => null,
    message: async () => ({ ok: true }),
    cancel: async () => ({ ok: true }),
  });
  const byName = Object.fromEntries(tools.map((tool) => [tool.name, tool]));
  assert.deepEqual(Object.keys(byName).sort(), ['task', 'task_cancel', 'task_message', 'task_status']);
  assert.deepEqual(byName.task.parameters.properties.agent.enum, ['explorer', 'fixer']);
  assert.equal('quality' in byName.task.parameters.properties, false);
  assert.equal(/quality|defaultQuality|fast／standard／deep/.test(buildRoutingSection(loadRoles())), false);
  // 宿主工具都不标 sequential——否则同批 task 被串行化（探针 A2）。
  for (const tool of tools) assert.equal(tool.executionMode, undefined);
  const fg = await byName.task.execute('id', { agent: 'explorer', description: '找', prompt: '找文件' });
  assert.equal(JSON.parse(fg.content[0].text).summary, 'R');
  assert.equal(JSON.parse(fg.content[0].text).session_id, 'explorer-1');
  const bg = await byName.task.execute('id', { agent: 'fixer', description: '改', prompt: '改', background: true });
  assert.equal(JSON.parse(bg.content[0].text).alias, 'fixer-2');
  assert.equal(JSON.parse(bg.content[0].text).goalStatus, 'running');
  const bad = await byName.task.execute('id', { agent: 'explorer', description: 'x', prompt: 'boom' });
  assert.equal(bad.isError, true);
  assert.equal(calls[1].background, true);
});

test('formatSubagentResult：保留真实状态、缺口与报告引用，不重复注入长规则或性能流水账', () => {
  const value = JSON.parse(formatSubagentResult({ alias: 'fixer-1', agent: 'fixer', outcome: 'stopped', outcomeReason: '用户停止', report: '改了一半', reportRef: 'ctx-full-report', truncated: true, totalChars: 20000, taskId: 'rec-1', toolCalls: 2, durationMs: 3000 }));
  assert.equal(value.outcome, 'stopped'); assert.equal(value.reason, '用户停止');
  assert.equal(value.summary, '改了一半'); assert.equal(value.reportRef, 'ctx-full-report');
  assert.equal(value.omitted, true); assert.equal(value.totalChars, 20000);
  assert.equal(JSON.stringify(value).includes(SUBAGENT_RESULT_GUIDANCE), false);
  assert.equal(value.durationMs, undefined);
});

test('角色工具覆盖：执行能力均有角色可承接，主控制工具不下放，fixer 兜底', () => {
  const roles = loadRoles();
  const all = new Set(ROLE_NAMES);
  const action = actionToolsOf(roles, { available: all });
  // 宿主注册的全部动手工具（新增工具要分给某个角色，否则这里报错）。
  const HOST_ACTION_TOOLS = [
    'read', 'write', 'edit', 'ls', 'grep', 'glob', 'bash',
    'browser_navigate', 'browser_extract', 'browser_tabs', 'browser_screenshot', 'browser_click', 'browser_type', 'browser_act',
    'web_search', 'web_extract',
    'screen_view', 'ui_list', 'ui_tree', 'ui_act', 'ui_click', 'ui_type', 'ui_key', 'ui_scroll', 'app_open',
  ];
  for (const tool of HOST_ACTION_TOOLS) assert.ok(action.has(tool), `动手工具 ${tool} 没有任何角色持有`);
  for (const tool of MAIN_CONTROL_TOOLS) assert.ok(!action.has(tool), `编排工具 ${tool} 不该出现在动手面`);
  // fixer 一个就覆盖全部（缺 explorer/oracle/designer 时编排仍成立）。
  const fixerOnly = actionToolsOf(roles, { available: new Set(['fixer']) });
  for (const tool of HOST_ACTION_TOOLS) assert.ok(fixerOnly.has(tool), `fixer 兜底缺 ${tool}`);
  // 记忆写入只在主 agent：任何角色都不持有。
  for (const role of roles.values()) assert.ok(!role.tools.includes('memory_write'), `${role.name} 不得写记忆`);
});

test('模型服务长错误只在默认交接给出必要状态，完整错误由报告引用读取',()=>{
 const raw='模型调用中断：502 {"ray_id":"RAW_DIAGNOSTIC_ID","detail":"upstream unavailable"}';
 const value=JSON.parse(formatSubagentResult({taskId:'t',agent:'oracle',outcome:'unknown',outcomeReason:raw,reportRef:'ctx-error'}));
 assert.match(value.reason,/HTTP 502/);assert.equal(value.reportRef,'ctx-error');assert.equal(JSON.stringify(value).includes('RAW_DIAGNOSTIC_ID'),false);
});

// 真实模型自主委派走查：隔离 userData → 生产 IPC → Pi → 子会话 → 正式收口。
// 使用现有加密模型配置的临时副本；不复制个人会话，不自动批准权限卡。
// HEMI_SMOKE_TEST=1 npx electron scripts/verify-delegation-routing.mjs
// 可用 HEMI_DELEGATION_SOURCE 指向修改前的源码快照，用相同题集作基线对比。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { app, ipcMain } from 'electron';

const source = path.resolve(process.env.HEMI_DELEGATION_SOURCE ?? fileURLToPath(new URL('..', import.meta.url)));
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hemi-delegation-')));
const userData = path.join(root, 'userData');
process.env.HEMI_USER_DATA_DIR = userData;
fs.mkdirSync(userData);
app.setName('hemi');
app.setPath('userData', userData);
const config = process.env.HEMI_DELEGATION_CONFIG
  ?? path.join(os.homedir(), 'Library/Application Support/hemi/runtime-v2/text-model-profiles.json');
fs.copyFileSync(config, path.join(userData, 'text-model-profiles.json'));
const load = relative => import(pathToFileURL(path.join(source, relative)).href);
const { IPC } = await load('src/shared/ipc-channels.mjs');
const { initializeStableSafeStorageIdentity } = await load('src/main/lib/config-store.mjs');
const { registerAllIpcHandlers } = await load('src/main/ipc/index.mjs');
const { abortActiveTextModelTurn, getAgentRuntime } = await load('src/main/ipc/llm.ipc.mjs');
const { disposeTaskManager } = await load('src/main/ipc/task.ipc.mjs');
const { shutdownBrowserBridgeService } = await load('src/main/services/browser-bridge-service.mjs');
const workspace = path.join(userData, 'workspace/default');
fs.mkdirSync(workspace, { recursive: true });
const fixtures = path.join(root, 'fixtures');
const write = (relative, content) => {
  const file = path.join(fixtures, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
};
write('settings.json', '{"timeoutMs":2500,"retryLimit":3}\n');
write('outing.md', '# 春游安排\n\n周六上午出发，周日下午返回；不调整交通和住宿。\n');
write('options.md', [
  '# 共享笔记同步方案',
  '目标：6 周内给 7 人团队交付离线编辑；不能默默丢失任意人的正文。',
  '试用观测：28% 的编辑在离线发生；有 70 次两人同时编辑同一段。没有记录冲突是否被用户发现。',
  '方案 A：整篇最后写入覆盖；预计 10 天，界面显示同步成功，无冲突副本。',
  '方案 B：保留冲突副本并由用户合并；预计 23 天；没有自动合并，预计维护成本每周 2 小时。',
  '方案 C：自动合并；预计 35 天；尚未做原型，工期误差未知。',
  '我的倾向：A 最快，上线后若有人反馈丢字再补 B；日志没有投诉，所以应当足够。',
  '这些是目前全部资料；不能用不存在的测试结果当证据。',
].join('\n'));
write('incident-clear.md', '设置文件的 cacheEnabled=false；运行日志 cacheActive=false、cacheHits=0。接口正常返回，只是从未命中缓存。\n');
write('incident-stalled.md', [
  '导出文件偶尔只有前半段，进程退出码始终为 0。',
  '先后调大超时、增加重试次数、再调大超时，三次都仍出现半截文件，没有新增日志。',
  '目前仅有出口文件字节数，没有输入记录数、解析后记录数、写入后记录数。',
  '候选解释：输入读取提前结束；解析阶段丢记录；输出未完全写入就退出。',
  '三种解释都符合现有观测；没有证据指向超时，也没有可执行程序可供本轮运行。',
].join('\n'));
for (let index = 0; index < 30; index++) {
  const relevant = new Map([[4, '导入入口：importer/start.mjs；状态：生效'], [17, '导出入口：exporter/run.mjs；状态：生效'], [26, '同步入口：sync/main.mjs；状态：生效']]);
  write(`resources/note-${index}.md`, relevant.get(index) ?? `历史草稿 ${index}；状态：废弃。这里只讨论迁移时的命名，不是当前入口。`);
}

// 预先约定可接受做法；人工按真实轨迹评估判断题，不用关键词声称模型行为通过。
const cases = [
  { id: 'small-lookup', pair: 'facts',
    prompt: '读取 settings.json，告诉我 timeoutMs 等于多少秒。只答这个值。',
    acceptance: '直接读取并答 2.5 秒；不派子任务。', noTasks: true, answerPattern: /2\.5/ },
  { id: 'broad-lookup', pair: 'facts',
    prompt: '从 resources/ 的笔记里查清当前生效的导入、导出、同步三个入口，排除废弃草稿，给出各自路径与资料出处。',
    acceptance: '主 agent 定向取证或 explorer 调查均可；返回三个正确入口及来源，不用 oracle 代替事实定位。',
    forbiddenRoles: ['oracle'], answerFacts: ['importer/start.mjs', 'exporter/run.mjs', 'sync/main.mjs'] },
  { id: 'small-edit', pair: 'plans',
    prompt: '把 outing.md 标题里的“春游”改成“秋游”，正文不变。改完读回核对即可。',
    acceptance: '主 agent 直接修改并读回；不为小改动增加评审。', noTasks: true },
  { id: 'plan-review', pair: 'plans',
    prompt: '阅读 options.md，检查我选 A 的论证有没有遗漏。我已看过资料，但请从不同角度审视影响目标的假设，比较可行方案，给我有依据的建议和仍需确认的事。只分析，不执行计划。',
    acceptance: 'oracle 独立分析，或主 agent 有证据地挑战无投诉等于不丢失的假设；区分事实与未知，不把 A 的倾向当结论，不虚构实验。' },
  { id: 'clear-diagnosis', pair: 'diagnosis',
    prompt: '读取 incident-clear.md，说明为什么没有缓存命中。只需根据现有证据回答，不改设置。',
    acceptance: '直接取证指出缓存未开启；不派子任务。', noTasks: true, answerPattern: /未.*开|没.*开|关闭|false|禁用/ },
  { id: 'stalled-diagnosis', pair: 'diagnosis',
    prompt: '读取 incident-stalled.md 的已有尝试。现在下一步应该怎么排查？请给最小且能区分几种解释的方法，本轮不用实际执行。',
    acceptance: 'oracle 分析或主 agent 提出能区分输入/解析/输出的观测或实验；不再调超时、重跑同一路线，不武断选根因。' },
];
const caseFiles = {
  'small-lookup': ['settings.json'], 'broad-lookup': ['resources'], 'small-edit': ['outing.md'],
  'plan-review': ['options.md'], 'clear-diagnosis': ['incident-clear.md'], 'stalled-diagnosis': ['incident-stalled.md'],
};
const selected = new Set((process.env.HEMI_DELEGATION_CASES ?? cases.map(item => item.id).join(',')).split(','));
assert.ok(selected.size && [...selected].every(id => cases.some(item => item.id === id)), '场景名称有效');
const repeats = Number(process.env.HEMI_DELEGATION_REPEATS ?? 1);
assert.ok(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 5, '重复次数为 1–5');
const profileId = process.env.HEMI_DELEGATION_PROFILE ?? 'auto';
const caseTimeoutMs = Number(process.env.HEMI_DELEGATION_TIMEOUT ?? 300000);
assert.ok(Number.isSafeInteger(caseTimeoutMs) && caseTimeoutMs > 0, '场景等待时限有效');
const promptFiles = ['src/main/agent/main-agent.mjs', 'src/main/agent/agent-roles.mjs', 'src/main/agent/roles/oracle.md'];
const evidence = { source, root, userData, profileId, caseTimeoutMs, fixtureIsolation: 'per-case', platform: process.platform, arch: process.arch, node: process.version,
  electron: process.versions.electron, startedAt: new Date().toISOString(),
  head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' }).trim(),
  promptHashes: Object.fromEntries(promptFiles.map(file => [file, createHash('sha256').update(fs.readFileSync(path.join(source, file))).digest('hex')])),
  criteria: cases.filter(item => selected.has(item.id)).map(({ id, pair, acceptance }) => ({ id, pair, acceptance })), samples: [] };
const output = path.join(root, 'result.json');
const save = () => fs.writeFileSync(output, JSON.stringify(evidence, null, 2) + '\n');
const invoke = (channel, payload) => {
  const handler = ipcMain._invokeHandlers?.get(channel);
  assert.equal(typeof handler, 'function', `实际 IPC 已注册：${channel}`);
  return handler({}, payload);
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let turn = 40000;
async function runCase(item, repeat) {
  // 每个场景只暴露自己的资料，避免上一题的证据或无关文件影响委派判断。
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.mkdirSync(workspace);
  for (const file of caseFiles[item.id]) fs.cpSync(path.join(fixtures, file), path.join(workspace, file), { recursive: true });
  const conversationId = `conv-delegation-${item.id}-${repeat}-${Date.now().toString(36)}`;
  const started = Date.now();
  const receipt = await invoke(IPC.llm.submit, { conversationId, turnId: ++turn,
    requestId: `delegation-${turn}`, profileId, workspaceId: 'default', inputSource: 'text',
    messages: [{ role: 'user', content: item.prompt }] });
  assert.ok(receipt.ok && receipt.runId, `受理失败：${receipt.message ?? item.id}`);
  const deadline = Date.now() + caseTimeoutMs;
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await invoke(IPC.flow.getSnapshot, { conversationId });
    if (snapshot.runs[receipt.runId]?.outcome && !snapshot.activeRunId
      && Object.values(snapshot.tasks ?? {}).every(task => task.phase === 'terminal')) break;
    await delay(200);
  }
  const answer = snapshot.timeline.filter(item => item.kind === 'assistant').flatMap(item => item.parts ?? [])
    .filter(part => part.kind === 'text').map(part => part.content).join('\n');
  const journal = await getAgentRuntime().journal.snapshot();
  const requests = Object.values(journal.requests).filter(row => row.owner.conversationId === conversationId);
  const tasks = Object.values(journal.tasks).filter(row => row.owner.conversationId === conversationId).map(row => row.result);
  const observations = Object.values(journal.observations).filter(row => row.owner.conversationId === conversationId);
  const payload = await getAgentRuntime().get(conversationId)?.exportEntries();
  const taskCalls = (payload?.entries ?? []).flatMap(entry => entry.message?.content ?? [])
    .filter(block => block.type === 'toolCall' && block.name === 'task')
    .map(({ id, arguments: args }) => ({ id, arguments: args }));
  const policy = journal.roots[receipt.runId]?.policySnapshot;
  const sample = { id: item.id, repeat, conversationId, runId: receipt.runId,
    outcome: snapshot.runs[receipt.runId]?.outcome, activeRunId: snapshot.activeRunId, elapsedMs: Date.now() - started,
    prompt: item.prompt, answer, tasks: tasks.map(({ agent, description, outcome, outcomeReason, report }) => ({ agent, description, outcome, outcomeReason, report })),
    requests: requests.map(({ role, actualModel, httpStatus }) => ({ role, model: actualModel?.model, httpStatus })),
    tools: observations.map(({ tool, outcome }) => ({ tool, outcome })), taskCalls,
    modelPolicy: { mode: policy?.mode, policy: policy?.policy, fixedKey: policy?.fixedKey }, checks: [] };
  const check = (name, pass) => sample.checks.push({ name, pass: Boolean(pass) });
  check('实际根目标完成且无悬挂任务', sample.outcome === 'completed' && !snapshot.activeRunId
    && Object.values(snapshot.tasks ?? {}).every(task => task.phase === 'terminal'));
  check('有真实主模型请求和答复', requests.some(row => row.role === 'main') && answer.trim());
  if (item.noTasks) check('简单任务没有额外委派', tasks.length === 0 && !observations.some(row => row.tool === 'task'));
  if (item.forbiddenRoles) check('事实调查没有误派顾问', tasks.every(task => !item.forbiddenRoles.includes(task.agent)));
  if (item.answerPattern) check('回答包含可核对的事实', item.answerPattern.test(answer));
  if (item.answerFacts) check('回答包含三个正确入口', item.answerFacts.every(fact => answer.includes(fact)));
  if (item.id === 'small-edit') check('只修改指定标题', fs.readFileSync(path.join(workspace, 'outing.md'), 'utf8') === '# 秋游安排\n\n周六上午出发，周日下午返回；不调整交通和住宿。\n');
  evidence.samples.push(sample); save();
  console.log('HEMI_DELEGATION_SAMPLE=' + JSON.stringify({ id: item.id, repeat, outcome: sample.outcome,
    roles: tasks.map(task => task.agent), requests: requests.length, elapsedMs: sample.elapsedMs,
    failedChecks: sample.checks.filter(check => !check.pass).map(check => check.name) }));
  if (snapshot.activeRunId) abortActiveTextModelTurn();
  assert.ok(!snapshot.activeRunId, '场景超时；停止后保留证据，不继续提交');
}

app.whenReady().then(async () => {
  let error;
  const watchdog = setTimeout(() => app.exit(2), selected.size * repeats * (caseTimeoutMs + 15000) + 30000);
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    console.log('HEMI_DELEGATION_STARTED=' + JSON.stringify({ root, source, profileId, cases: [...selected], repeats }));
    for (let repeat = 1; repeat <= repeats; repeat++) for (const item of cases) if (selected.has(item.id)) await runCase(item, repeat);
  } catch (caught) { error = String(caught.stack ?? caught); console.error(error); }
  finally {
    clearTimeout(watchdog);
    try { abortActiveTextModelTurn(); await getAgentRuntime().disposeAll(); disposeTaskManager(); }
    catch (caught) { error ??= `验证清理失败：${caught.message}`; }
    await shutdownBrowserBridgeService().catch(() => {});
    evidence.error = error ?? null; evidence.finishedAt = new Date().toISOString(); save();
    const failures = evidence.samples.flatMap(sample => sample.checks.filter(check => !check.pass));
    console.log('HEMI_DELEGATION_RESULT=' + JSON.stringify({ output, samples: evidence.samples.length, failures: failures.length, error: evidence.error }));
    setTimeout(() => app.exit(error || failures.length ? 1 : 0), 300);
  }
});

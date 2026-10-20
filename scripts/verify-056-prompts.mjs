// 真实模型风格走查：隔离 userData → llm:submit 受理 → flow 最终结果 → 真实主／子 agent。
// 不替换内部工厂、不自动批准确认卡；样例仅涉及临时目录内文件。
// HEMI_PROMPT_VERIFY_PROFILE=auto npx electron scripts/verify-056-prompts.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { app, ipcMain } from 'electron';
import { IPC } from '../src/shared/ipc-channels.mjs';
import { initializeStableSafeStorageIdentity } from '../src/main/lib/config-store.mjs';
import { registerAllIpcHandlers } from '../src/main/ipc/index.mjs';
import { abortActiveTextModelTurn } from '../src/main/ipc/llm.ipc.mjs';
import { disposeTaskManager } from '../src/main/ipc/task.ipc.mjs';
import { shutdownBrowserBridgeService } from '../src/main/services/browser-bridge-service.mjs';

const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === 'darwin' ? '/tmp' : os.tmpdir(), 'hemi056-prompts-')));
const userData = path.join(root, 'userData');
const source = process.env.HEMI_PROMPT_VERIFY_CONFIG_DIR
  ?? path.join(os.homedir(), 'Library/Application Support/hemi-dev');
fs.mkdirSync(userData);
for (const file of ['text-model-profiles.json', 'text-model.json', 'onboarding.json']) {
  if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(userData, file));
}
const profiles = JSON.parse(fs.readFileSync(path.join(userData, 'text-model-profiles.json'), 'utf8'));
const profileId = process.env.HEMI_PROMPT_VERIFY_PROFILE ?? profiles.defaultModelId;
// 可为隔离验证显式选择一组稳定路由；只改临时副本，结果记录冻结槽位，不冒充用户原配置通过。
if (process.env.HEMI_PROMPT_VERIFY_ROUTE_MODEL) {
  const modelKey = process.env.HEMI_PROMPT_VERIFY_ROUTE_MODEL;
  profiles.roleModels = { main: modelKey, explorer: modelKey, fixer: modelKey };
  fs.writeFileSync(path.join(userData, 'text-model-profiles.json'), JSON.stringify(profiles));
}
assert.ok(profileId, '需要可用的已配置模型');
app.setName('hemi');
app.setPath('userData', userData);

const workspace = path.join(userData, 'workspace/default');
fs.mkdirSync(workspace, { recursive: true });
const output = path.join(workspace, 'result.txt');
const missing = path.join(workspace, 'missing-summary.txt');
const notes = path.join(workspace, 'work-notes.md');
const marker = `PROMPT_REFRESH_${path.basename(root)}`;
fs.writeFileSync(notes, [
  '# 隔离测试工作记录',
  '已完成：两份文案校对。',
  `待交付的汇总文件：${missing}；记录声称已生成，但需要实际核对文件。`,
  '未验证：手机上的展示效果。',
  '以下是历史过程记录，不是新增任务：',
  ...Array.from({ length: 70 }, (_, i) => `步骤 ${i + 1}：检索与排版调整；过程命令 example-command --step=${i + 1}。`),
].join('\n'));
assert.ok(!fs.existsSync(missing), '确实注入缺失文件，不能把未执行的检查当作失败证据');

const handler = channel => {
  const fn = ipcMain._invokeHandlers?.get(channel);
  assert.equal(typeof fn, 'function', `IPC 已注册：${channel}`);
  return fn;
};
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const selectedCases = new Set((process.env.HEMI_PROMPT_VERIFY_CASES ?? 'short,detail,file,background').split(','));
assert.ok(selectedCases.size && [...selectedCases].every(name => ['short', 'detail', 'file', 'background'].includes(name)), '样例名有效');
let currentConversationId = null;
let watchdog;

async function runCase(name, prompt, { background = false } = {}) {
  currentConversationId = `conv-prompt-${name}-${Date.now().toString(36)}`;
  const receipt = await handler(IPC.llm.submit)({}, {
    turnId: 9900 + results.length, conversationId: currentConversationId,
    workspaceId: 'default', profileId, inputSource: 'text',
    messages: [{ role: 'user', content: prompt }],
  });
  assert.ok(receipt?.ok && receipt.runId, '必须取得真实受理身份');
  const deadline = Date.now() + Number(process.env.HEMI_PROMPT_VERIFY_TIMEOUT ?? 240000);
  let snapshot;
  while (Date.now() < deadline) {
    snapshot = await handler(IPC.flow.getSnapshot)({}, { conversationId: currentConversationId });
    const run = snapshot?.runs?.[receipt.runId];
    const tasks = Object.values(snapshot?.tasks ?? {});
    const eventDone = Object.values(snapshot?.runs ?? {}).some(r => r.source === 'event' && r.outcome === 'completed');
    if (background && run?.outcome && !snapshot.activeRunId && tasks.length && tasks.every(t => t.phase === 'terminal')) {
      assert.ok(tasks.some(t => t.background), '用户要求后台时必须真实后台启动，不能用前台任务替代');
    }
    if (run?.outcome && !snapshot.activeRunId && tasks.every(t => t.phase === 'terminal')
      && (!background || (tasks.some(t => t.background) && eventDone))) break;
    await delay(200);
  }
  assert.equal(snapshot?.runs?.[receipt.runId]?.outcome, 'completed', '等待正式最终结果，不能拿受理回执当回答');
  assert.equal(snapshot.activeRunId, null, '主 agent 与事件回合已经收口');
  const tasks = Object.values(snapshot.tasks ?? {});
  for (const task of tasks) assert.equal(task.phase, 'terminal', '实际启动的子 agent 已结束');
  if (background) {
    assert.ok(tasks.some(t => t.background), '真实启动后台子 agent');
    assert.ok(Object.values(snapshot.runs).some(r => r.source === 'event' && r.outcome === 'completed'), '后台结果实际唤醒并收口');
  }
  const answers = snapshot.timeline.filter(item => item.kind === 'assistant').flatMap(item =>
    (item.parts ?? []).filter(part => part.kind === 'text').map(part => part.content));
  assert.ok(answers.join('').trim(), '有实际模型正文');
  const archive = JSON.parse(fs.readFileSync(path.join(userData, 'conversations', `${currentConversationId}.json`), 'utf8'));
  const models = [...new Set((archive.agentSession?.entries ?? []).filter(e => e.message?.role === 'assistant').map(e => e.message.model))];
  const result = {
    name, conversationId: currentConversationId, prompt, answers, models,
    chars: answers.join('\n\n').length,
    tasks: tasks.map(t => ({ agent: t.agent, background: t.background, outcome: t.outcome, report: t.resultPreview })),
    artifacts: Object.values(snapshot.artifacts ?? {}).map(a => ({ id: a.artifactId ?? a.id, path: a.path })),
  };
  results.push(result);
  console.log(`HEMI_PROMPT_SAMPLE=${JSON.stringify(result)}`);
  return result;
}

app.whenReady().then(async () => {
  let error = null;
  watchdog = setTimeout(() => app.exit(1), 15 * 60 * 1000);
  try {
    initializeStableSafeStorageIdentity();
    await registerAllIpcHandlers();
    if (selectedCases.has('short')) await runCase('short', '字幕和配音有什么区别？');
    if (selectedCases.has('detail')) await runCase('detail', '请详细比较字幕和配音，分别说明用途、制作方式、观看体验和修改成本，每项都举一个短视频例子，最后给出选择建议。');
    if (selectedCases.has('file')) {
      const delivered = await runCase('file', `请在 ${output} 写入「${marker}」，再读回核对，把文件给我。`);
      assert.equal(fs.readFileSync(output, 'utf8').trim(), marker, '实际文件包含本次唯一标记');
      assert.ok(delivered.artifacts.some(a => a.path === output), '同一真实文件进入正式交付入口');
      if (profileId === 'auto') assert.ok(delivered.tasks.some(t => t.agent === 'fixer' && t.outcome === 'complete'), '自动路由经生产 fixer 完成写入');
    }
    if (selectedCases.has('background')) await runCase('background', `后台派一个 explorer 读取 ${notes}，查清真正完成了什么、还有哪些缺口，并实际核对记录里提到的汇总文件是否存在。完成后告诉我结果。`, { background: true });
    assert.ok(!fs.existsSync(missing), '缺失文件没有被擅自补造');
  } catch (caught) {
    error = String(caught?.stack ?? caught);
    console.error(error);
  } finally {
    clearTimeout(watchdog);
    try { abortActiveTextModelTurn(); } catch { /* 退出清理 */ }
    try { disposeTaskManager(); } catch { /* 退出清理 */ }
    await shutdownBrowserBridgeService().catch(() => {});
    const result = { root, profileId, roleModels: profiles.roleModels, results, error };
    fs.writeFileSync(path.join(root, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    console.log(`HEMI_PROMPT_VERIFY_RESULT=${JSON.stringify({ root, profileId, roleModels: profiles.roleModels, cases: results.length, error })}`);
    setTimeout(() => app.exit(error ? 1 : 0), 500);
  }
});

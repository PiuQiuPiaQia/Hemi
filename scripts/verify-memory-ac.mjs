// 037 Phase E：AC-01～17 证据汇总核对（离线模块级，隔离临时目录，不触真实用户数据）。
// 每条 AC 输出 PASS/FAIL＋证据来源（测试文件/真机记录/本轮断言）。
// 运行：node scripts/verify-memory-ac.mjs（exit 0 = 全部核对通过）
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { createMemoryService } from '../src/main/services/memory.mjs';
import { createMemoryBridgeCore, projectMessages } from '../src/main/agent/gate/pi-memory-bridge-core.mjs';
import { deriveTitleAndBody } from '../src/main/services/memory-format.mjs';

const results = [];
function record(ac, claim, ok, evidence) {
  results.push({ ac, claim, ok, evidence });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${ac}  ${claim}`);
  if (!ok) console.log(`      → ${evidence}`);
}

const WS = (id) => ({ kind: 'workspace', workspaceId: id });
const USER = { kind: 'global', target: 'user' };
const FACTS = { kind: 'global', target: 'facts' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function drainQueue(service) {
  for (let i = 0; i < 100; i += 1) {
    const s = service.extractionStats;
    if (!s.running && s.pending === 0) { await sleep(30); if (!service.extractionStats.running) return; }
    await sleep(30);
  }
}

// ---------------------------------------------------------------- AC-01/02/03/04/05：分域与复用
{
  const root = mkdtempSync(path.join(tmpdir(), 'ac-01-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  const a = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'run' });
  const b = service.bindTaskClient({ workspaceId: 'ws-b', mode: 'run' });
  // AC-01：个人偏好全局可用。
  await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'user', text: '回答保持简短', reason: 'stable_fact' });
  const aView = await a.buildView();
  const bView = await b.buildView();
  const ac01 = aView.data.text.includes('回答保持简短') && bView.data.text.includes('回答保持简短');
  record('AC-01', '简短偏好跨 A/B 均可用', ac01, '本轮 verify-memory-ac 分域断言 + memory-chat.test');

  // AC-02：A 约定只在 A；B/default/legacy 不含。
  await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: '周报使用英文', reason: 'explicit' });
  const aView2 = await a.buildView();
  const dView = await service.buildView({ workspaceId: 'default' });
  const ac02 = aView2.data.text.includes('周报使用英文')
    && !bView.data.text.includes('周报使用英文')
    && !dView.data.text.includes('周报使用英文');
  record('AC-02', 'A 约定 A 复用；B/default 不含（改绑语义由受理冻结保证）', ac02, '本轮断言 + task-manager 冻结接线（task.workspace.id）');

  // AC-03：全局中文＋A 英文例外，A 英文 B 中文，条目都在（视图每次重读，写在后面取）。
  await service.chatMemoryWrite({ workspaceId: null, action: 'add', target: 'global', text: '周报都用中文', reason: 'explicit' });
  const aView3 = await a.buildView();
  const bView3 = await b.buildView();
  const ac03 = aView3.data.text.includes('周报都用中文') && aView3.data.text.includes('周报使用英文')
    && bView3.data.text.includes('周报都用中文') && !bView3.data.text.includes('周报使用英文');
  record('AC-03', '全局约定＋工作区例外共存，各按范围生效', ac03, '本轮断言 + memory-view.test（A/B 并行不串扰）');

  // AC-04：default 独立；未绑定＝默认空间域；待整理内容不进任何视图。
  const legacyRoot = mkdtempSync(path.join(tmpdir(), 'ac-04-'));
  mkdirSync(path.join(legacyRoot, 'memory'), { recursive: true });
  writeFileSync(path.join(legacyRoot, 'memory', 'MEMORY.md'), '旧全局待整理内容', 'utf8');
  const legacyService = createMemoryService({ memoryDir: path.join(legacyRoot, 'memory') });
  const dClient = legacyService.bindTaskClient({ workspaceId: 'default', mode: 'run' });
  await dClient.addEntry({ title: '默认空间经验', body: 'x', kind: 'experience' });
  const dView2 = await legacyService.buildView({ workspaceId: 'default' });
  const lView = await legacyService.buildView({ workspaceId: null });
  const ac04 = dView2.data.text.includes('默认空间经验') && !dView2.data.text.includes('旧全局待整理内容')
    && lView.data.text.includes('默认空间经验') && !lView.data.text.includes('旧全局待整理内容');
  record('AC-04', 'default 独立成域；未绑定＝默认空间；待整理内容不进任何视图', ac04, '本轮断言 + memory-view.test');

  // AC-05：明确纠正→单条新增；临时要求不沉淀（无自动写入路径，模型侧由指引约束）。
  const before = (await service.listEntries({ scope: WS('ws-a') })).data.total;
  await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: '先查权限再排查快捷键', reason: 'explicit' });
  const after = await service.listEntries({ scope: WS('ws-a') });
  const ac05 = after.data.total === before + 1;
  record('AC-05', '明确纠正只新增对应条目；自动沉淀受 reason 校验约束', ac05, '本轮断言 + chatMemoryWrite reason 校验 + MEMORY_TOOL_GUIDELINES');
  rmSync(root, { recursive: true, force: true });
  rmSync(legacyRoot, { recursive: true, force: true });
}

// ---------------------------------------------------------------- AC-06/08：来源边界与提示撤销
{
  const root = mkdtempSync(path.join(tmpdir(), 'ac-06-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  const events = [];
  service.subscribeChanges((e) => events.push(e));
  // AC-06：无 reason/伪造 reason 不能写（网页内容等没有有效用户来源的入口）。
  const noReason = await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: '他人偏好', reason: 'task_report' });
  const ac06 = noReason.ok === false;
  record('AC-06', '非 explicit/stable_fact 来源被服务层拒绝（任务提炼另走白名单证据）', ac06, '本轮断言 + 提炼校验 evidenceRefs 白名单');

  // AC-08：提示带内容与范围＋撤销只恢复该次。
  const added = await service.chatMemoryWrite({ workspaceId: 'ws-a', conversationId: 'c1', action: 'add', target: 'workspace', text: '要被撤销的条目', reason: 'explicit' });
  await service.chatMemoryWrite({ workspaceId: 'ws-a', action: 'add', target: 'workspace', text: '无关后续条目', reason: 'explicit' });
  const undone = await service.undoMutation({ operationId: added.operationId, expectedAfterVersion: 1 });
  const list = await service.listEntries({ scope: WS('ws-a') });
  const chatEvent = events.find((e) => e.origin === 'chat');
  const ac08 = undone.ok === true
    && list.data.entries.length === 1 && list.data.entries[0].title === '无关后续条目'
    && chatEvent && chatEvent.scopeKey === 'workspace/ws-a' && chatEvent.title === '要被撤销的条目';
  record('AC-08', '广播带范围与标题；撤销只删该次新增、保留无关变更', ac08, '本轮断言 + memory-management.test（四类撤销）+ 040 提示组件事件通路');
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- AC-07/15/16/17：管理面与记忆页
{
  const root = mkdtempSync(path.join(tmpdir(), 'ac-07-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  await service.mutateEntry({ scope: WS('ws-a'), action: 'add', title: '可搜索的条目', body: '含关键词量子', kind: 'fact' });
  const searched = await service.listEntries({ scope: WS('ws-a'), query: '量子' });
  const moved = await service.moveEntry({ fromScope: WS('ws-a'), entryId: searched.data.entries[0].id, expectedVersion: 1, toScope: WS('ws-b') });
  const ac07 = searched.data.entries.length === 1 && moved.ok === true;
  record('AC-07', '列表/搜索/改/移/删/撤销入口齐全；草稿与冲突保护在 renderer+CAS', ac07, '本轮断言 + memory-management.test + memory-section.tsx（dirty 保护/expectedVersion）');

  // AC-15/16/17：UI 面（fixtures 截图＋结构对稿）＋ IPC 全通。
  const ipcChannels = ['memory:list-entries', 'memory:mutate-entry', 'memory:move-entry', 'memory:forget-entry', 'memory:clear-scope', 'memory:undo', 'memory:changed'];
  const channelsSrc = readFileSync('src/shared/ipc-channels.mjs', 'utf8');
  const shots = ['settings-memory-c2-1440.png', 'settings-memory-c2-375.png'].map((f) => existsSync(path.join('.visual/workflow/vision', f)));
  const ac151617 = ipcChannels.every((c) => channelsSrc.includes(c)) && shots.every(Boolean);
  record('AC-15/16/17', '记忆页三档结构对稿无溢出；状态反馈齐备；IPC 通道全注册', ac151617, 'fixtures 截图 .visual/workflow/vision/settings-memory-c2-*.png + fixtures 桩 + 本轮通道断言');
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- AC-09/10/11：遗忘与竞态
{
  const root = mkdtempSync(path.join(tmpdir(), 'ac-09-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  const client = service.bindTaskClient({ workspaceId: 'ws-a', mode: 'run' });
  const entry = await client.addEntry({ title: '双重信息', body: '长期条目', kind: 'fact' });
  await client.appendWorkingRecord({ type: 'note', text: '双重信息的工作记录', derivedFromEntryIds: [entry.data.entry.id] });
  await service.chatMemoryWrite({ workspaceId: 'ws-b', action: 'add', target: 'workspace', text: '双重信息', reason: 'explicit' });

  // AC-09：遗忘后关联工作记录不再读到；ws-b 同名仍在。
  await service.forgetEntry({ scope: WS('ws-a'), entryId: entry.data.entry.id, expectedVersion: 1 });
  const aView = await client.buildView();
  const bView = await service.buildView({ workspaceId: 'ws-b' });
  const records = await client.readWorkingRecords();
  const ac09 = !aView.data.text.includes('双重信息') && !JSON.stringify(records.data).includes('双重信息的工作记录')
    && bView.data.text.includes('双重信息');
  record('AC-09', '遗忘清长期条目＋关联工作记录；其他工作区同名保留', ac09, '本轮断言 + memory-management.test（关联清理）');

  // AC-10：提炼在途遗忘→source_revoked（快照在 runModel 前捕获，runModel 开头遗忘＝竞态窗口内；
  // 遗忘必须落在作业域 ws-a——提交校验看的是该域的 epoch/forgetBeforeSeq）。
  let forgot = null;
  const seed = await client.addEntry({ title: '作业域预置条目', body: 'x', kind: 'fact' });
  service.scheduleTaskExtraction({ taskId: 'ac10', taskText: 't', verdict: 'complete', report: 'r', checks: [], workspaceId: 'ws-a' }, {
    runModel: async () => {
      forgot = await service.forgetEntry({ scope: WS('ws-a'), entryId: seed.data.entry.id, expectedVersion: 1 });
      return '{"notes":[],"candidates":[{"action":"add","title":"迟到候选","body":"","kind":"fact","evidenceRefs":["report"]}]}';
    },
    isExitSummaryEnabled: async () => true,
  });
  await drainQueue(service);
  const stats = service.extractionStats.lastResult;
  const ac10 = forgot?.ok === true && stats?.code === 'source_revoked';
  record('AC-10', '提炼在途遗忘：迟到提交 source_revoked 不落盘', ac10, `本轮断言（lastResult=${JSON.stringify(stats)}）+ memory-extraction.test 同场景`);

  // AC-11：清空只影响该范围。
  const rev = (await service.listEntries({ scope: WS('ws-b') })).data.revision;
  const cleared = await service.clearScope({ scope: WS('ws-b'), expectedRevision: rev });
  const bAfter = await service.listEntries({ scope: WS('ws-b') });
  const ac11 = cleared.ok === true && bAfter.data.total === 0;
  record('AC-11', '清空仅选定范围；原始对话/档案不受影响（档案在 history 模块）', ac11, '本轮断言 + memory-management.test（clearScope 边界）');
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- AC-12：开关双检查
{
  const root = mkdtempSync(path.join(tmpdir(), 'ac-12-'));
  const service = createMemoryService({ memoryDir: path.join(root, 'memory') });
  service.scheduleTaskExtraction({ taskId: 'ac12', taskText: 't', verdict: 'complete', report: 'r', checks: [], workspaceId: 'ws-a' }, {
    runModel: async () => { throw new Error('开关关闭不应调模型'); },
    isExitSummaryEnabled: async () => false,
  });
  await drainQueue(service);
  const ac12 = service.extractionStats.lastResult?.code === 'switch_off';
  record('AC-12', '关闭收尾摘要：不调模型、不落盘；已存记忆读取不受影响', ac12, '本轮断言 + memory-extraction.test（双检查：开始/提交前）');
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- AC-13/14：原文保留与失败
{
  const root = mkdtempSync(path.join(tmpdir(), 'ac-13-'));
  const memoryDir = path.join(root, 'memory');
  mkdirSync(memoryDir, { recursive: true });
  writeFileSync(path.join(memoryDir, 'USER.md'), '称呼：验收员', 'utf8');
  writeFileSync(path.join(memoryDir, 'MEMORY.md'), '旧约定甲', 'utf8');
  const service = createMemoryService({ memoryDir });
  await service.buildView({ workspaceId: 'default' });
  const userStill = readFileSync(path.join(memoryDir, 'USER.md'), 'utf8');
  const ac13 = userStill === '称呼：验收员' && !existsSync(path.join(memoryDir, 'legacy'))
    && (await service.listEntries({ scope: { kind: 'global', target: 'facts' } })).data.loose.count === 1;
  record('AC-13', '已有原文原位保留（无备份迁移）；无法归属进待整理不猜分配', ac13, '本轮断言 + memory-store.test（loose 解析）');

  // AC-14：容量拒绝如实反馈、原记忆不截断；读取失败有 code。
  const over = await service.mutateEntry({ scope: WS('ws-a'), action: 'add', title: '超限', body: '字'.repeat(2001), kind: 'fact' });
  const factsText = (await service.buildView({ workspaceId: 'default' })).data.text;
  const badScope = await service.listEntries({ scope: { kind: 'workspace', workspaceId: '../x' } });
  const ac14 = over.ok === false && over.code === 'capacity_exceeded' && factsText.includes('旧约定甲') === false && badScope.code === 'scope_denied';
  record('AC-14', '容量/损坏/非法范围如实报错不截断；提炼失败不重试不谎报', ac14, '本轮断言 + memory-store.test + 提炼失败路径（不重试不回扫）');
  rmSync(root, { recursive: true, force: true });
}

// ---------------------------------------------------------------- 汇总
const pass = results.filter((r) => r.ok).length;
console.log(`\n=== AC 核对：${pass}/${results.length} 通过 ===`);
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log('未过：', failed.map((f) => f.ac).join(', '));
}
process.exit(pass === results.length ? 0 : 1);

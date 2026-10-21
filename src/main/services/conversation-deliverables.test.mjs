// 062 · 会话交付物登记与受控 IO 的单测（node --test）。
// controller 用真归约层（createFlowSnapshot＋applyFlowFact）充当——登记函数消费的
// 正是这个界面（applyFact/getSnapshot），不需要 mock 归约行为。
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { applyFlowFact, createFlowSnapshot } from '../../shared/conversation-flow.mjs';
import {
  conversationArtifactId,
  createConversationDeliverableIo,
  registerConversationDeliverable,
} from './conversation-deliverables.mjs';

test('中文、特殊符号与长路径不因清洗和截断共享文件身份', () => {
  const a = conversationArtifactId({ target: '/workspace/横版封面.svg' });
  const b = conversationArtifactId({ target: '/workspace/尚未生成.svg' });
  assert.notEqual(a, b);
  const suffix = 'same/'.repeat(40) + 'out.pdf';
  assert.notEqual(conversationArtifactId({ target: `/first/${suffix}` }), conversationArtifactId({ target: `/second/${suffix}` }));
  assert.notEqual(conversationArtifactId({ host: 'a:b', target: '/x.pdf' }), conversationArtifactId({ host: 'a_b', target: '/x.pdf' }));
});

function makeController() {
  let snapshot = createFlowSnapshot({ conversationId: 'c1' });
  const controller = {
    getSnapshot: () => snapshot,
    applyFact: (fact) => {
      const result = applyFlowFact(snapshot, fact);
      if (result.applied) snapshot = result.snapshot;
      return result;
    },
  };
  return controller;
}

function seedRun(controller, runId = 'run-1') {
  controller.applyFact({ type: 'run-preparing', runId, at: 1 });
  controller.applyFact({ type: 'run-started', runId, at: 2 });
  return runId;
}

function withTempWorkspace(fn) {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-062-home-'));
  const workspace = path.join(home, 'proj');
  mkdirSync(workspace, { recursive: true });
  // macOS 的 /var → /private/var 符号链接：登记函数按 realpath 归一（register.mjs
  // 同款口径），helper 里同样归一，断言不因系统前缀差异翻车。
  const realHome = realpathSync(home);
  const realWorkspace = realpathSync(workspace);
  const cleanup = () => rmSync(home, { recursive: true, force: true });
  // async 测试体在首个 await 挂起后，同步 finally 会先删掉目录（真机钓出的竞态）：
  // promise 形态把清理挂到测试体收口之后。
  const result = fn({ home: realHome, workspace: realWorkspace });
  if (result && typeof result.finally === 'function') return result.finally(cleanup);
  cleanup();
  return result;
}

test('registerConversationDeliverable：本机查证成功后登记文件并加入对话入口', () => withTempWorkspace(({ home, workspace }) => {
  const target = path.join(workspace, '图 形.svg');
  writeFileSync(target, '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>');
  const controller = makeController();
  const runId = seedRun(controller);

  const result = registerConversationDeliverable({
    controller, runId, file: { path: '图 形.svg', description: '本次成果' }, workspaceDir: workspace, home,
  });

  assert.equal(result.ok, true);
  const artifact = controller.getSnapshot().artifacts[result.artifactId];
  assert.equal(artifact.path, target); // realpath 归一后的真实路径
  assert.equal(artifact.name, '图 形.svg');
  assert.equal(artifact.producerRunId, runId);
  assert.equal(artifact.contentVersion, 1);
  assert.equal(artifact.previewKind, 'image');
  assert.deepEqual(artifact.producers.map((producer) => producer.runId), [runId]);
  const assistant = controller.getSnapshot().timeline.find((item) => item.kind === 'assistant');
  assert.ok(assistant.parts.some((part) => part.kind === 'deliverable' && part.artifactId === result.artifactId));
}));

test('同一路径重复声明：身份复用、contentVersion 递增、对话入口不重复', () => withTempWorkspace(({ home, workspace }) => {
  const target = path.join(workspace, 'a.svg');
  writeFileSync(target, '<svg/>');
  const controller = makeController();
  const runId = seedRun(controller);
  const first = registerConversationDeliverable({ controller, runId, file: { path: 'a.svg' }, workspaceDir: workspace, home });
  writeFileSync(target, '<svg>v2</svg>');
  const second = registerConversationDeliverable({ controller, runId, file: { path: target }, workspaceDir: workspace, home });

  assert.equal(second.artifactId, first.artifactId);
  const artifact = controller.getSnapshot().artifacts[first.artifactId];
  assert.equal(artifact.contentVersion, 2);
  assert.equal(artifact.producers.length, 1); // 同 run 去重
  const assistant = controller.getSnapshot().timeline.find((item) => item.kind === 'assistant');
  assert.equal(assistant.parts.filter((part) => part.kind === 'deliverable').length, 1);
}));

test('登记跟随真实输入锚点，过期代次不污染 artifacts', () => withTempWorkspace(({ home, workspace }) => {
  writeFileSync(path.join(workspace, 'cover.svg'), '<svg/>');
  const controller = makeController();
  const runId = seedRun(controller);
  controller.applyFact({ type: 'part-appended', runId, afterInputId: 'input-1', part: { partId: 'intro', kind: 'text', content: '已生成。' } });
  const result = registerConversationDeliverable({ controller, runId, file: { path: 'cover.svg' }, workspaceDir: workspace, home });
  assert.equal(controller.getSnapshot().timeline.filter(i => i.kind === 'assistant').length, 1);
  assert.equal(controller.getSnapshot().timeline[0].afterInputId, 'input-1');
  assert.equal(controller.getSnapshot().artifacts[result.artifactId].size, 6);
  const version = controller.getSnapshot().artifacts[result.artifactId].contentVersion;
  const stale = registerConversationDeliverable({ controller, runId, generation: 99, file: { path: 'cover.svg' }, workspaceDir: workspace, home });
  assert.equal(stale.dropped, 'stale-generation');
  assert.equal(controller.getSnapshot().artifacts[result.artifactId].contentVersion, version);
}));

test('同名异目录不合并；跨运行同路径合并身份', () => withTempWorkspace(({ home, workspace }) => {
  const dirA = path.join(workspace, 'a'); const dirB = path.join(workspace, 'b');
  mkdirSync(dirA, { recursive: true }); mkdirSync(dirB, { recursive: true });
  writeFileSync(path.join(dirA, 'out.txt'), 'A');
  writeFileSync(path.join(dirB, 'out.txt'), 'B');
  const controller = makeController();
  const run1 = seedRun(controller, 'run-1');
  controller.applyFact({ type: 'run-closed', runId: run1, outcome: 'completed', at: 3 });
  controller.applyFact({ type: 'run-preparing', runId: 'run-2', at: 4 });
  controller.applyFact({ type: 'run-started', runId: 'run-2', at: 5 });

  const a = registerConversationDeliverable({ controller, runId: run1, file: { path: path.join(dirA, 'out.txt') }, home });
  assert.equal(a.ok, false); // run-1 已收口 → 迟到丢弃
  const b1 = registerConversationDeliverable({ controller, runId: 'run-2', file: { path: path.join(dirA, 'out.txt') }, home });
  const b2 = registerConversationDeliverable({ controller, runId: 'run-2', file: { path: path.join(dirB, 'out.txt') }, home });
  assert.notEqual(b1.artifactId, b2.artifactId);
  const artifact = controller.getSnapshot().artifacts[b1.artifactId];
  assert.equal(artifact.producers.length, 1);
}));

test('查证失败：如实 notice、不登记 artifact；runId=null 时只丢入口不炸', () => withTempWorkspace(({ home, workspace }) => {
  const controller = makeController();
  const runId = seedRun(controller);
  const missing = registerConversationDeliverable({ controller, runId, file: { path: path.join(workspace, '不存在.svg') }, workspaceDir: workspace, home });
  assert.equal(missing.ok, false);
  assert.equal(Object.keys(controller.getSnapshot().artifacts).length, 0);
  const assistant = controller.getSnapshot().timeline.find((item) => item.kind === 'assistant');
  assert.ok(assistant.parts.some((part) => part.kind === 'notice' && /未登记/.test(part.text)));

  const background = registerConversationDeliverable({ controller, runId: null, file: { path: path.join(workspace, '也不存在.txt') }, workspaceDir: workspace, home });
  assert.equal(background.ok, false); // 后台且失败：没有可挂的运行，静默丢弃（不产生 notice）
  const assistantParts = controller.getSnapshot().timeline.find((item) => item.kind === 'assistant').parts;
  assert.equal(assistantParts.filter((part) => part.kind === 'notice').length, 1);
}));

test('run 收口后的迟到声明不新增交付（R-05）', () => withTempWorkspace(({ home, workspace }) => {
  const target = path.join(workspace, 'late.svg');
  writeFileSync(target, '<svg/>');
  const controller = makeController();
  const runId = seedRun(controller);
  controller.applyFact({ type: 'run-closed', runId, outcome: 'stopped', at: 3 });
  const result = registerConversationDeliverable({ controller, runId, file: { path: 'late.svg' }, workspaceDir: workspace, home });
  assert.equal(result.dropped, 'run-closed');
  assert.equal(Object.keys(controller.getSnapshot().artifacts).length, 0);
}));

test('家目录边界：工作区外、家目录内可登记（033 口径）', () => withTempWorkspace(({ home }) => {
  const inHome = path.join(home, 'report.md');
  writeFileSync(inHome, '# ok');
  const controller = makeController();
  const runId = seedRun(controller);
  const result = registerConversationDeliverable({ controller, runId, file: { path: inHome }, home });
  assert.equal(result.ok, true);
  const outside = registerConversationDeliverable({ controller, runId, file: { path: '/etc/hosts' }, home });
  assert.equal(outside.ok, false);
}));

// ---- 受控 IO ----

function makeIo({ home, workspace, flowService = null, openInBrowser = null, openPath = null, fileActions = null }) {
  return createConversationDeliverableIo({
    flowService,
    workspaceOf: () => ({ dir: workspace, host: null, home: null }),
    remoteIo: null,
    openInBrowser,
    openPath,
    fileActions,
  });
}

test('readConversationDeliverable：文本/图片/范围外格式/失效文件', () => withTempWorkspace(async ({ home, workspace }) => {
  const controller = makeController();
  const runId = seedRun(controller);
  const io = makeIo({ home, workspace });
  const md = path.join(workspace, '说明.md');
  writeFileSync(md, '# 标题');
  const png = path.join(workspace, '图.png');
  writeFileSync(png, Buffer.from('89504e47', 'hex'));
  const zip = path.join(workspace, '包.zip');
  writeFileSync(zip, 'binary');
  const mdId = registerConversationDeliverable({ controller, runId, file: { path: md }, home }).artifactId;
  const pngId = registerConversationDeliverable({ controller, runId, file: { path: png }, home }).artifactId;
  const zipId = registerConversationDeliverable({ controller, runId, file: { path: zip }, home }).artifactId;

  const flowService = { has: () => true, controllerFor: () => controller };
  const ioWithFlow = makeIo({ home, workspace, flowService });

  const text = await ioWithFlow.readConversationDeliverable('c1', mdId);
  assert.equal(text.ok, true);
  assert.equal(text.kind, 'text');
  assert.equal(text.markdown, true);
  assert.match(text.text, /标题/);

  const image = await ioWithFlow.readConversationDeliverable('c1', pngId);
  assert.equal(image.ok, true);
  assert.equal(image.kind, 'image');
  assert.match(image.dataUrl, /^data:image\/png;base64,/);

  const unsupported = await ioWithFlow.readConversationDeliverable('c1', zipId);
  assert.equal(unsupported.ok, true);
  assert.equal(unsupported.kind, 'unsupported');
  assert.equal(unsupported.name, '包.zip');
  assert.equal(unsupported.size, 'binary'.length);

  rmSync(md);
  const missing = await ioWithFlow.readConversationDeliverable('c1', mdId);
  assert.equal(missing.ok, false);
  assert.match(missing.message, /不在原位置/);
}));

test('resolveConversationLink：工作区相对/中文空格/不存在/网页链接拒绝/file:// 前缀', () => withTempWorkspace(async ({ home, workspace }) => {
  const io = makeIo({ home, workspace });
  const target = path.join(workspace, '成果 图.svg');
  writeFileSync(target, '<svg/>');

  const relative = await io.resolveConversationLink('c1', '成果 图.svg');
  assert.equal(relative.ok, true);
  assert.equal(relative.path, realpathSync(target));
  assert.equal(relative.artifactId, conversationArtifactId({ target }));

  const absolute = await io.resolveConversationLink('c1', target);
  assert.equal(absolute.ok, true);
  assert.equal(absolute.artifactId, relative.artifactId);

  const fileUrl = await io.resolveConversationLink('c1', `file://${target}`);
  assert.equal(fileUrl.ok, true);
  assert.equal(fileUrl.artifactId, relative.artifactId);

  const missing = await io.resolveConversationLink('c1', path.join(workspace, '没有这个.svg'));
  assert.equal(missing.ok, false);
  assert.match(missing.message, /不存在/);

  const web = await io.resolveConversationLink('c1', 'https://example.com/a.png');
  assert.equal(web.ok, false);

  const outside = await io.resolveConversationLink('c1', '/etc/hosts');
  assert.equal(outside.ok, false);
}));

test('resolveConversationLink 成功后身份与正式登记一致（Tab 自然去重）', () => withTempWorkspace(async ({ home, workspace }) => {
  const target = path.join(workspace, 'scene.svg');
  writeFileSync(target, '<svg/>');
  const controller = makeController();
  const runId = seedRun(controller);
  const io = makeIo({ home, workspace });

  const link = await io.resolveConversationLink('c1', 'scene.svg');
  const registered = registerConversationDeliverable({ controller, runId, file: { path: 'scene.svg' }, workspaceDir: workspace, home });
  assert.equal(link.artifactId, registered.artifactId);
}));

test('旧档案文件身份保持稳定；同字数中文链接不会读成已登记的其他图片', () => withTempWorkspace(async ({ home, workspace }) => {
  const target = path.join(workspace, '横版封面.svg');
  const other = path.join(workspace, '尚未生成.svg');
  writeFileSync(target, '<svg>first</svg>'); writeFileSync(other, '<svg>other</svg>');
  const controller = makeController(); const runId = seedRun(controller);
  controller.applyFact({ type: 'artifact-updated', artifact: { artifactId: 'legacy-id', kind: 'file', path: target, name: '横版封面.svg', producers: [] } });
  const io = makeIo({ home, workspace, flowService: { has: () => true, controllerFor: () => controller } });
  const registered = registerConversationDeliverable({ controller, runId, file: { path: target }, workspaceDir: workspace, home });
  assert.equal(registered.artifactId, 'legacy-id');
  assert.equal((await io.resolveConversationLink('c1', target)).artifactId, 'legacy-id');
  const link = await io.resolveConversationLink('c1', other);
  assert.notEqual(link.artifactId, 'legacy-id');
  const result = await io.readConversationDeliverable('c1', link.artifactId, link.path);
  assert.match(Buffer.from(result.dataUrl.split(',')[1], 'base64').toString(), /other/);
}));

test('卡片系统打开、选程序、定位目录都走实际宿主解析；失效与越界路径不触发操作', () => withTempWorkspace(async ({ home, workspace }) => {
  const target = path.join(workspace, 'report.md'); writeFileSync(target, 'report');
  const controller = makeController(); const runId = seedRun(controller);
  const id = registerConversationDeliverable({ controller, runId, file: { path: target }, home }).artifactId;
  const actions = [];
  const io = makeIo({ home, workspace, flowService: { has: () => true, controllerFor: () => controller },
    openPath: async filePath => { actions.push(['system', filePath]); return { ok: true }; },
    fileActions: { perform: async (intent, filePath) => { actions.push([intent, filePath]); return { ok: true }; } },
  });
  for (const intent of ['system', 'choose-app', 'reveal']) assert.equal((await io.openConversationDeliverable('c1', id, null, intent)).ok, true);
  assert.deepEqual(actions.map(a => a[0]), ['system', 'choose-app', 'reveal']);
  assert.ok(actions.every(a => a[1] === target));
  assert.equal((await io.openConversationDeliverable('c1', '', '/etc/hosts', 'choose-app')).ok, false);
  assert.equal((await io.openConversationDeliverable('c1', id, null, 'arbitrary')).ok, false);
  rmSync(target);
  assert.equal((await io.openConversationDeliverable('c1', id, null, 'reveal')).ok, false);
  assert.equal(actions.length, 3);
}));

test('openConversationDeliverable：本机走注入 opener；范围外格式走系统应用', () => withTempWorkspace(async ({ home, workspace }) => {
  const controller = makeController();
  const runId = seedRun(controller);
  const target = path.join(workspace, 'out.md');
  writeFileSync(target, 'x');
  const id = registerConversationDeliverable({ controller, runId, file: { path: target }, home }).artifactId;
  const flowService = { has: () => true, controllerFor: () => controller };
  const opened = [];
  const systemOpened = [];
  const io = makeIo({
    home, workspace, flowService,
    openInBrowser: async (filePath) => { opened.push(filePath); return { ok: true }; },
    openPath: async (filePath) => { systemOpened.push(filePath); return { ok: true }; },
  });
  const result = await io.openConversationDeliverable('c1', id);
  assert.equal(result.ok, true);
  assert.deepEqual(opened, [target]);
  assert.deepEqual(systemOpened, []);
}));

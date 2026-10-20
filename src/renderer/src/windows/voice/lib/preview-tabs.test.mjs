import assert from 'node:assert/strict';
import test from 'node:test';

import {
  closePreviewTab,
  EMPTY_PREVIEW_TABS,
  isPreviewableArtifact,
  openPreviewTab,
  previewTabKey,
} from './preview-tabs.ts';

const fileTab = (taskId, artifactId) => ({ kind: 'artifact', taskId, artifactId });
const reportTab = (taskId) => ({ kind: 'artifact', taskId, artifactId: null });
const attachTab = (conversationId, attachmentId) => ({ kind: 'attachment', conversationId, attachmentId });
const processTab = (taskId) => ({ kind: 'process', taskId });

test('previewTabKey：报告、文件、附件与执行过程按真实身份区分，不靠显示名称', () => {
  assert.equal(previewTabKey(reportTab('t1')), 'artifact:t1:report');
  assert.equal(previewTabKey(fileTab('t1', 'a9')), 'artifact:t1:a9');
  assert.equal(previewTabKey(attachTab('c1', 'att-2')), 'attachment:c1:att-2');
  // 056：执行过程 Tab（对话流角色行点击打开）按任务身份去重。
  assert.equal(previewTabKey(processTab('t1')), 'process:t1');
  assert.notEqual(previewTabKey(processTab('t1')), previewTabKey(reportTab('t1')));
  // 同一成果在不同任务下身份不同（AC-05：伪造跨任务 ID 不复用）。
  assert.notEqual(previewTabKey(fileTab('t1', 'a9')), previewTabKey(fileTab('t2', 'a9')));
  // 028：附件与成果即使显示同名，身份也不碰撞（kind 前缀参与序列化）。
  assert.notEqual(previewTabKey(attachTab('t1', 'x')), previewTabKey(fileTab('t1', 'x')));
  assert.notEqual(previewTabKey(attachTab('c1', 'a9')), previewTabKey(fileTab('c1', 'a9')));
});

test('openPreviewTab：执行过程与成果同队列共存，同任务去重（056）', () => {
  let state = EMPTY_PREVIEW_TABS;
  state = openPreviewTab(state, processTab('t1'));
  state = openPreviewTab(state, fileTab('t1', 'a1'));
  state = openPreviewTab(state, processTab('t2'));
  assert.deepEqual(state.tabs.map(previewTabKey), ['process:t1', 'artifact:t1:a1', 'process:t2']);
  // 再点同一角色行：只激活，不重复建 Tab。
  const again = openPreviewTab(state, processTab('t1'));
  assert.equal(again.tabs.length, 3);
  assert.equal(again.activeKey, 'process:t1');
  assert.notEqual(again, state);
});

test('openPreviewTab：新对象追加并激活；重复打开只激活，不重复建 Tab', () => {
  let state = EMPTY_PREVIEW_TABS;
  state = openPreviewTab(state, reportTab('t1'));
  assert.deepEqual(state, { tabs: [reportTab('t1')], activeKey: 'artifact:t1:report' });

  state = openPreviewTab(state, fileTab('t1', 'a1'));
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeKey, 'artifact:t1:a1');

  // 再点同一成果（AC-03：按真实身份复用）。
  const again = openPreviewTab(state, fileTab('t1', 'a1'));
  assert.equal(again.tabs.length, 2);
  assert.equal(again.activeKey, 'artifact:t1:a1');
  assert.equal(again, state); // 已是当前项时原样返回，不触发多余渲染。

  // 激活旧 Tab 后再打开它：只改 activeKey，顺序不变。
  const reactivated = openPreviewTab(again, reportTab('t1'));
  assert.equal(reactivated.tabs.length, 2);
  assert.equal(reactivated.tabs[0].artifactId, null);
  assert.equal(reactivated.activeKey, 'artifact:t1:report');
});

test('openPreviewTab：附件与成果同队列共存，同附件去重（028 AC-08）', () => {
  let state = EMPTY_PREVIEW_TABS;
  state = openPreviewTab(state, fileTab('t1', 'a1'));
  state = openPreviewTab(state, attachTab('c1', 'att-1'));
  state = openPreviewTab(state, reportTab('t1'));
  assert.deepEqual(state.tabs.map(previewTabKey), [
    'artifact:t1:a1',
    'attachment:c1:att-1',
    'artifact:t1:report',
  ]);
  state = openPreviewTab(state, attachTab('c1', 'att-1'));
  assert.equal(state.tabs.length, 3);
  assert.equal(state.activeKey, 'attachment:c1:att-1');
});

test('closePreviewTab：关非当前项不动正文；关当前项先右后左；最后一个清空', () => {
  let state = EMPTY_PREVIEW_TABS;
  for (const tab of [reportTab('t1'), fileTab('t1', 'a1'), fileTab('t1', 'a2')]) {
    state = openPreviewTab(state, tab);
  }
  // 当前是 a2；关掉非当前的 a1——a2 仍激活。
  state = closePreviewTab(state, 'artifact:t1:a1');
  assert.deepEqual(state.tabs.map(previewTabKey), ['artifact:t1:report', 'artifact:t1:a2']);
  assert.equal(state.activeKey, 'artifact:t1:a2');

  // 关当前 a2：没有右侧，激活左侧 report。
  state = closePreviewTab(state, 'artifact:t1:a2');
  assert.equal(state.activeKey, 'artifact:t1:report');

  // 重新打开 a1（队尾）、激活 report，再关 report：右侧相邻 a1 接管。
  state = openPreviewTab(state, fileTab('t1', 'a1'));
  state = openPreviewTab(state, reportTab('t1')); // 激活回 report
  state = closePreviewTab(state, 'artifact:t1:report');
  assert.equal(state.activeKey, 'artifact:t1:a1');

  // 最后一个关闭：队列空、activeKey 归 null（渲染层收起面板）。
  state = closePreviewTab(state, 'artifact:t1:a1');
  assert.deepEqual(state, EMPTY_PREVIEW_TABS);

  // 关不存在的 key 是 no-op。
  assert.equal(closePreviewTab(state, 'artifact:t1:a1'), state);

  // 028：混队里关附件不影响成果 Tab（移除未发附件只关自己的页签）。
  let mixed = EMPTY_PREVIEW_TABS;
  mixed = openPreviewTab(mixed, fileTab('t1', 'a1'));
  mixed = openPreviewTab(mixed, attachTab('c1', 'att-1'));
  mixed = openPreviewTab(mixed, attachTab('c1', 'att-2'));
  mixed = closePreviewTab(mixed, 'attachment:c1:att-1');
  assert.deepEqual(mixed.tabs.map(previewTabKey), ['artifact:t1:a1', 'attachment:c1:att-2']);
  assert.equal(mixed.activeKey, 'attachment:c1:att-2');
});

test('isPreviewableArtifact：只认真实文件产物的受控扩展名', () => {
  assert.equal(isPreviewableArtifact({ id: 'a', kind: 'file', name: '笔记.md', path: '/x', role: 'main', registeredAt: 0 }), true);
  assert.equal(isPreviewableArtifact({ id: 'a', kind: 'file', name: '照片.PNG', path: '/x', role: 'main', registeredAt: 0 }), true);
  assert.equal(isPreviewableArtifact({ id: 'a', kind: 'file', name: '表格.csv', path: '/x', role: 'main', registeredAt: 0 }), false);
  assert.equal(isPreviewableArtifact({ id: 'a', kind: 'file', name: '页面.html', path: '/x', role: 'main', registeredAt: 0 }), false);
  assert.equal(isPreviewableArtifact({ id: 'a', kind: 'file', name: '无扩展名', path: '/x', role: 'main', registeredAt: 0 }), false);
  // 链接产物与无名文件不提供预览入口（R-01：来源不冒充预览文件）。
  assert.equal(isPreviewableArtifact({ id: 'a', kind: 'link', name: '参考.md', url: 'https://x', registeredAt: 0 }), false);
  assert.equal(isPreviewableArtifact({ id: 'a', kind: 'file', name: '', path: '/x', role: 'main', registeredAt: 0 }), false);
});

test('062：会话交付物 Tab——按会话+文件身份去重，链接对象独立成页', () => {
  const deliverable = (artifactId, extra = {}) =>
    ({ kind: 'deliverable', conversationId: 'c1', artifactId, ...extra });
  let state = EMPTY_PREVIEW_TABS;
  state = openPreviewTab(state, deliverable('d-local-x_svg'));
  state = openPreviewTab(state, deliverable('d-local-x_svg'));
  assert.deepEqual(state.tabs.map(previewTabKey), ['deliverable:c1:d-local-x_svg']);
  // 同名异目录＝不同身份，各开一页。
  state = openPreviewTab(state, deliverable('d-local-y_svg'));
  assert.equal(state.tabs.length, 2);
  // 链接对象带线索字段但身份仍按 artifactId（与之后正式登记同身份时自然合并）。
  const linked = deliverable('d-local-x_svg', { linkPath: '/tmp/x.svg', linkName: 'x.svg' });
  state = openPreviewTab(state, linked);
  assert.equal(state.tabs.length, 2);
  assert.equal(state.activeKey, 'deliverable:c1:d-local-x_svg');
  // 与任务档案成果 Tab（taskId 寻址）不冲突。
  state = openPreviewTab(state, { kind: 'artifact', taskId: 't1', artifactId: 'a1' });
  assert.equal(state.tabs.length, 3);
});

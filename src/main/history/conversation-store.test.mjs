// 015 会话存储单测：净化/标题纯函数、原子写、upsert、最近会话、列表损坏
// 容忍、容量裁剪、删除。全部走注入目录（mkdtemp），不触 userData。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  MAX_THINKING_CHARS,
  MAX_TURNS,
  deriveTitle,
  newSessionId,
  repairTaskTurns,
  sanitizeTurns,
  sanitizeUsageRecords,
  createConversationStore,
} from './conversation-store.mjs';

function makeDir() {
  return mkdtempSync(path.join(os.tmpdir(), 'hemi-conv-'));
}

function turn(author, text, extra = {}) {
  return { id: `id-${Math.random().toString(36).slice(2, 8)}`, text, createdAt: 1, author, ...extra };
}

test('置顶独立落盘，保存、改名、排序、重启不丢失；取消保留原时间，删除后重建不继承', t => {
  const dir = makeDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ dir });
  const id = 'conv-pin', turns = [turn('user', '长期工作')];
  store.saveSession({ id, turns, now: 50 });
  const before = store.getSession(id);
  const pinned = store.setPinned(id, true);
  assert.equal(pinned.ok, true);
  assert.equal(pinned.session.pinned, true);
  assert.equal(store.getSession(id).updatedAt, before.updatedAt);
  assert.equal(store.getSession(id).lastOpenedAt, before.lastOpenedAt);
  store.saveSession({ id, turns: [...turns, turn('hemi', '新回复')], now: 100 });
  store.renameSession(id, '已改名');
  store.reorderSessions([id]);
  const restarted = createConversationStore({ dir });
  assert.equal(restarted.listSessions().sessions[0].pinned, true);
  assert.equal(restarted.getSession(id).pinned, true);
  assert.equal(restarted.setPinned(id, false).session.pinned, false);
  assert.equal(restarted.getSession(id).updatedAt, 100);
  assert.equal(restarted.getSession(id).lastOpenedAt, before.lastOpenedAt);
  assert.equal(restarted.setPinned('conv-missing', true), null);
  assert.throws(() => restarted.setPinned(id, 'true'), /置顶状态无效/);
  writeFileSync(path.join(dir, 'conv-corrupt.json'), '{');
  assert.equal(restarted.setPinned('conv-corrupt', true), null);
  restarted.setPinned(id, true);
  restarted.deleteSession(id);
  restarted.saveSession({ id, turns, now: 150 });
  assert.equal(restarted.listSessions().sessions.find(s => s.id === id).pinned, false);
});

test('容量裁剪优先保留置顶会话，全部置顶时仍保留新保存的会话', t => {
  const dir = makeDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ dir, maxSessions: 2 });
  const save = (id, now) => store.saveSession({ id, now, turns: [turn('user', id)] });
  save('conv-pin-old', 1); store.setPinned('conv-pin-old', true);
  save('conv-old', 2); save('conv-new', 3);
  assert.equal(store.getSession('conv-old'), null);
  assert.equal(store.getSession('conv-pin-old').pinned, true);
  store.setPinned('conv-new', true);
  save('conv-over-capacity', 4);
  assert.equal(store.listSessions().sessions.length, 3);
  assert.equal(store.getSession('conv-over-capacity').title, 'conv-over-capacity');
});

test('原生会话引用跨重启保留聊天，编辑仅记录回卷目标且不把条目写回公开档案', t => {
  const dir = makeDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ dir }), id = 'conv-native';
  const turns = [turn('user', '保留前文', { id: 'first' }), turn('hemi', '旧回答'), turn('user', '编辑这一轮', { id: 'second' }), turn('hemi', '需撤回的回答')];
  store.saveSession({ id, turns });
  const reference = { storage: 'pi', version: 1, ref: 'main-conv-native' };
  assert.equal(store.saveAgentSession(id, reference), true);
  assert.deepEqual(createConversationStore({ dir }).getAgentSession(id), reference);
  assert.deepEqual(store.getSession(id).turns.map(turn => turn.text), turns.map(turn => turn.text));
  assert.equal(store.applyCutKeys(id, [], { targetInputId: 'second' }).ok, true);
  assert.deepEqual(store.getAgentSession(id), { ...reference, rewindBeforeInputId: 'second' });
  assert.deepEqual(store.getSession(id).turns.map(turn => turn.text), ['保留前文', '旧回答']);
  assert.equal(store.saveAgentSession(id, reference), true);
  assert.deepEqual(store.getAgentSession(id), reference);
  const file = JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  assert.equal(file.agentSession.entries, undefined);
});

test('未读保留于保存／改名／重启，清读不改排序时间且旧版本不能清新结果', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const turns = [turn('user', '未读回归')];
    store.saveSession({ id: 'conv-unread', turns, now: 50 });
    const file = path.join(dir, 'conv-unread.json');
    writeFileSync(file, JSON.stringify({ ...store.getSession('conv-unread'), unreadAt: 100 }));
    store.saveSession({ id: 'conv-unread', turns: [...turns, turn('hemi', '新结果')], now: 60 });
    store.renameSession('conv-unread', '改名不清读');
    assert.equal(createConversationStore({ dir }).listSessions().sessions[0].unreadAt, 100);
    assert.equal(store.markRead('conv-unread', 99).unchanged, true);
    assert.equal(store.getSession('conv-unread').unreadAt, 100);
    assert.deepEqual(store.markRead('conv-unread', 100), { ok: true, unreadAt: null });
    assert.equal(store.getSession('conv-unread').updatedAt, 60, '读取不置顶');
    assert.equal(store.getSession('conv-unread').lastReadAt, 100);
    store.saveSession({ id: 'conv-unread', turns: [...turns, turn('hemi', '再次保存')], now: 70 });
    assert.equal(store.getSession('conv-unread').lastReadAt, 100);
    writeFileSync(file, JSON.stringify({ ...store.getSession('conv-unread'), unreadAt: 101 }));
    assert.deepEqual(store.markRead('conv-unread', 100), { ok: true, unchanged: true, unreadAt: 101 });
    assert.equal(createConversationStore({ dir }).listSessions().sessions[0].unreadAt, 101);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('纯函数：newSessionId / deriveTitle / sanitizeTurns 基本语义', () => {
  assert.match(newSessionId(1758100000000), /^conv-[a-z0-9-]+$/);
  assert.equal(deriveTitle([]), '新的对话');
  assert.equal(deriveTitle([turn('hemi', '你好')]), '新的对话');
  assert.equal(deriveTitle([turn('hemi', '你好'), turn('user', '帮我查机票')]), '帮我查机票');
  assert.equal(deriveTitle([turn('user', '好'.repeat(30))]), `${'好'.repeat(24)}…`);

  const clean = sanitizeTurns([
    null,
    { text: '缺 author', createdAt: 1 },
    { author: 'user' },
    turn('user', '第一句'),
    turn('hemi', '好的', { kind: 'task', taskSeq: 3, taskId: 'task-3-abc123', taskSnap: { seq: 3, phase: 'terminal' } }),
    turn('hemi', '带 kind 无 taskSeq 的伪任务卡', { kind: 'task' }),
  ]);
  assert.equal(clean.length, 3); // 伪任务卡降级为普通消息保留，kind 丢弃
  assert.equal(clean[0].text, '第一句');
  assert.equal(clean[1].taskSeq, 3);
  assert.equal(clean[1].taskId, 'task-3-abc123'); // 卡身份落盘带回，跨会话不撞号
  assert.deepEqual(clean[1].taskSnap, { seq: 3, phase: 'terminal' });

  const truncated = sanitizeTurns(Array.from({ length: MAX_TURNS + 5 }, (_v, i) => turn('user', `句${i}`)), {
    maxTurns: 10,
  });
  assert.equal(truncated.length, 10);
  assert.equal(truncated[0].text, `句${MAX_TURNS + 5 - 10}`);

  // 026 R-09：普通消息（阶段简报/终态交代）的 taskId 也保留——历史回看时
  // 渲染同任务标识；伪造/缺省不造身份。
  const withTaskId = sanitizeTurns([
    turn('hemi', '报价已核对完成', { taskId: 'task-9-parity' }),
    turn('hemi', '无身份的普通回复'),
    turn('hemi', '伪造', { taskId: 42 }),
  ]);
  assert.equal(withTaskId[0].taskId, 'task-9-parity');
  assert.equal(withTaskId[1].taskId, undefined);
  assert.equal(withTaskId[2].taskId, undefined);

  // 2026-10-07 会话审计：失败留痕 kind='error' 落盘保留——剥掉会降级成普通
  // hemi 消息、重载后混进模型上下文。
  const withError = sanitizeTurns([
    turn('user', '你是谁'),
    turn('hemi', '文本模型请求失败（HTTP 400）', { kind: 'error' }),
    turn('hemi', '普通回复'),
  ]);
  assert.equal(withError[1].kind, 'error');
  assert.equal(withError[2].kind, undefined);

  // 061：用户轮附件视图随档冻结（白名单曾漏掉 attachments，历史附件只靠 flow
  // 字段兜着）——缩略图与 stagedPath 保留、非法形状丢弃、hemi 轮不携带。
  const withAttachments = sanitizeTurns([
    turn('user', '看这张图', {
      attachments: [
        {
          attachmentId: 'att-1', conversationId: 'c1', name: '粘贴图片 09:22', kind: 'image',
          sizeBytes: 1234, status: 'ready', source: 'paste', registeredAt: 1_000,
          thumbnailUrl: 'data:image/png;base64,iVBORw0KGgo', stagedPath: '/ud/attachments/att-1.png',
        },
        { attachmentId: 'att-2', kind: 'text', source: 'picker', thumbnailUrl: 'data:text/html;base64,PHNjcg==' },
        null,
        { attachmentId: 42 },
      ],
    }),
    turn('hemi', '收到了', { attachments: [{ attachmentId: 'att-9', kind: 'image' }] }),
  ]);
  assert.equal(withAttachments[0].attachments.length, 2, '合法两条保留');
  const frozen = withAttachments[0].attachments[0];
  assert.equal(frozen.thumbnailUrl, 'data:image/png;base64,iVBORw0KGgo');
  assert.equal(frozen.stagedPath, '/ud/attachments/att-1.png');
  assert.equal(frozen.registeredAt, 1_000);
  assert.equal(withAttachments[0].attachments[1].thumbnailUrl, undefined, '非 data:image/ 缩略图丢弃');
  assert.equal(withAttachments[1].attachments, undefined, 'hemi 轮不携带附件');
  assert.equal(sanitizeTurns([turn('user', '无附件')])[0].attachments, undefined, '缺省不造字段');
});

test('saveSession：新建落盘、无 tmp 残留、非法 id 抛错', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000000);
    const result = store.saveSession({ id, turns: [turn('user', '帮我整理下载文件夹')] });
    assert.equal(result.ok, true);
    assert.equal(result.session.title, '帮我整理下载文件夹');
    const files = readdirSync(dir).filter((name) => name !== 'list-index.json');
    assert.deepEqual(files, [`${id}.json`]); // rename 原子替换：无 .tmp 残留
    assert.throws(() => store.saveSession({ id: '../evil', turns: [] }), /非法会话 ID/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveSession：upsert 保留 createdAt、标题跟最新 turns、清空仍留会话（D-6）', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000001);
    store.saveSession({ id, turns: [turn('user', '第一句')], now: 1000 });
    store.saveSession({ id, turns: [turn('user', '换了个话题')], now: 2000 });
    const record = store.getSession(id);
    assert.equal(record.createdAt, 1000);
    assert.equal(record.updatedAt, 2000);
    assert.equal(record.title, '换了个话题');

    // 清空＝保存空 turns，会话本身保留。
    store.saveSession({ id, turns: [], now: 3000 });
    const cleared = store.getSession(id);
    assert.deepEqual(cleared.turns, []);
    assert.equal(cleared.title, '新的对话');
    assert.notEqual(cleared.createdAt, 3000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lastSession / listSessions：新→旧排序、损坏条目可见、外来 JSON 跳过', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const older = newSessionId(1758100000002);
    const newer = newSessionId(1758100000003);
    store.saveSession({ id: older, turns: [turn('user', '旧会话')], now: 1000 });
    store.saveSession({ id: newer, turns: [turn('user', '新会话')], now: 2000 });
    writeFileSync(path.join(dir, 'conv-corrupt-x.json'), '{oops');
    writeFileSync(path.join(dir, 'readme.json'), JSON.stringify({ hello: 1 }));

    const last = store.lastSession();
    assert.equal(last.id, newer);
    assert.equal(last.turns.length, 1);

    const { sessions } = store.listSessions();
    assert.equal(sessions.length, 3); // 两个正常 + 一个损坏；readme 被跳过
    assert.equal(sessions[0].id, newer);
    assert.equal(sessions[1].id, older);
    assert.equal(sessions[2].corrupt, true);
    assert.equal(sessions[0].turnCount, 1);

    assert.equal(store.getSession('conv-corrupt-x'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('容量裁剪：超上限删最旧，刚保存的会话不裁', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir, maxSessions: 2 });
    const a = newSessionId(1758100000004);
    const b = newSessionId(1758100000005);
    const c = newSessionId(1758100000006);
    store.saveSession({ id: a, turns: [turn('user', 'A')], now: 1000 });
    store.saveSession({ id: b, turns: [turn('user', 'B')], now: 2000 });
    store.saveSession({ id: c, turns: [turn('user', 'C')], now: 3000 });
    assert.equal(existsSync(path.join(dir, `${a}.json`)), false);
    assert.equal(existsSync(path.join(dir, `${b}.json`)), true);
    assert.equal(store.listSessions().sessions.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('deleteSession：删除后 getSession 为 null，列表不再出现', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000007);
    store.saveSession({ id, turns: [turn('user', '要删的')] });
    assert.equal(store.deleteSession(id), true);
    assert.equal(store.getSession(id), null);
    assert.deepEqual(store.listSessions().sessions, []);
    assert.equal(store.lastSession(), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 017：repairTaskTurns（保存前快照修复） ----

function taskTurn(text, extra = {}) {
  return turn('hemi', text, { kind: 'task', taskSeq: 1, ...extra });
}

function fakeAccess({ records = {}, candidate = null } = {}) {
  return {
    getRecord: (taskId) => records[taskId] ?? null,
    findRecordCandidate: (query) => (candidate ? candidate(query) : null),
  };
}

test('017 repairTaskTurns：终态任务按档案记录重建快照（全量事件）', () => {
  const record = {
    taskId: 'task-1-aaa',
    taskText: '查天气',
    outcome: 'complete',
    resultText: '晴。',
    events: Array.from({ length: 40 }, (_, i) => ({ at: i, text: `步骤${i}` })),
    verifications: [{ verdict: 'complete', evidence: ['e'], unchecked: [], at: 50 }],
  };
  const turns = [taskTurn('查天气', { taskId: 'task-1-aaa', taskSnap: { seq: 1, taskId: 'task-1-aaa', log: [{ at: 1, text: '任务开始。' }] } })];
  const repaired = repairTaskTurns(turns, fakeAccess({ records: { 'task-1-aaa': record } }));
  assert.equal(repaired[0].taskSnap.log.length, 40); // 截尾快照被档案全量替换
  assert.equal(repaired[0].taskSnap.outcome, 'complete');
  assert.equal(repaired[0].taskSnap.verification.verdict, 'complete');
});

test('017 repairTaskTurns：错挂快照（taskId 不一致）被档案重建；无档案则剥离', () => {
  const goodRecord = {
    taskId: 'task-1-aaa', taskText: '查天气', outcome: 'complete', resultText: '晴。',
    events: [{ at: 1, text: '任务开始。' }, { at: 2, text: '阶段成果：已查到' }],
  };
  const turns = [
    taskTurn('查天气', { taskId: 'task-1-aaa', taskSnap: { seq: 1, taskId: 'task-9-zzz' } }),
    taskTurn('查另一事', { taskId: 'task-2-bbb', taskSnap: { seq: 2, taskId: 'task-8-yyy' } }),
  ];
  const repaired = repairTaskTurns(turns, fakeAccess({ records: { 'task-1-aaa': goodRecord } }));
  assert.equal(repaired[0].taskSnap.taskId, 'task-1-aaa'); // 按真身重建
  assert.equal(repaired[1].taskSnap, undefined); // 无档案：宁缺勿错
});

test('017 repairTaskTurns：遗留错挂按「同文本 + 时间贴近」找回真身并补 taskId', () => {
  // task-1-时间戳：时间成分比 turn.createdAt 晚 68 分钟 → 撞号期错挂特征。
  const foreignTime = Date.now();
  const foreignId = `task-1-${(foreignTime).toString(36)}`;
  const trueTime = foreignTime - 68 * 60 * 1000;
  const trueId = `task-1-${(trueTime).toString(36)}`;
  const record = {
    taskId: trueId, taskText: '今天天气怎么样呢？', outcome: 'complete', resultText: '晴。',
    events: [{ at: 1, text: '任务开始。' }],
  };
  const turns = [
    taskTurn('今天天气怎么样呢？', {
      createdAt: trueTime,
      taskSnap: { seq: 1, taskId: foreignId },
    }),
  ];
  const access = fakeAccess({
    records: { [trueId]: record },
    candidate: ({ text, createdAt, exclude }) =>
      text === '今天天气怎么样呢？' && Math.abs(createdAt - trueTime) <= 5000 && !exclude.includes(trueId)
        ? trueId
        : null,
  });
  const repaired = repairTaskTurns(turns, access);
  assert.equal(repaired[0].taskId, trueId); // 补写稳定 ID
  assert.equal(repaired[0].taskSnap.taskId, trueId);
  assert.equal(repaired[0].taskSnap.resultText, '晴。');
});

test('017 repairTaskTurns：遗留错挂找不回真身 → 剥快照（宁缺勿错）', () => {
  const snapTime = Date.now();
  const foreignId = `task-1-${(snapTime).toString(36)}`;
  const turns = [
    taskTurn('今天天气怎么样呢？', { createdAt: snapTime - 90 * 60 * 1000, taskSnap: { seq: 1, taskId: foreignId } }),
  ];
  const repaired = repairTaskTurns(turns, fakeAccess({ candidate: () => null }));
  assert.equal(repaired[0].taskSnap, undefined);
});

test('017 repairTaskTurns：在途/排队任务与普通消息不动', () => {
  const runningRecord = { taskId: 'task-1-aaa', taskText: '长任务', outcome: null, events: [] };
  const snap = { seq: 1, taskId: 'task-1-aaa', progressText: '正在执行' };
  const turns = [
    turn('user', '普通消息'),
    taskTurn('长任务', { taskId: 'task-1-aaa', taskSnap: snap }),
    taskTurn('被裁剪档案的任务', { taskId: 'task-9-old', taskSnap: { seq: 9, taskId: 'task-9-old' } }),
  ];
  const repaired = repairTaskTurns(turns, fakeAccess({ records: { 'task-1-aaa': runningRecord } }));
  assert.equal(repaired[0].kind, undefined); // 普通消息原样
  assert.equal(repaired[1].taskSnap, snap); // 在途：保留渲染层快照
  assert.equal(repaired[2].taskSnap.taskId, 'task-9-old'); // 记录不存在：原样
});

// ---- 024 文字输入：任务卡冻结快照里的建档来源随会话落盘/读回不丢 ----

test('024 sanitizeTurns：taskSnap.inputSource 原样保留（文字任务卡片重载后仍可判静音）', () => {
  const turns = sanitizeTurns([
    { id: 'a', text: '帮我整理文件', createdAt: 1, author: 'user' },
    {
      id: 'b',
      text: '好，交给我。',
      createdAt: 2,
      author: 'hemi',
      kind: 'task',
      taskSeq: 7,
      taskId: 'task-7-x',
      taskSnap: { taskId: 'task-7-x', inputSource: 'text', phase: 'terminal' },
    },
  ]);
  assert.equal(turns[1].taskSnap.inputSource, 'text');
  assert.equal(turns[1].taskSnap.phase, 'terminal');
});

// ---- 024 侧栏：双击重命名（customTitle 跨保存保留）与拖拽排序（order-index） ----

test('renameSession：改名跨保存保留、空标题回退派生、不动 updatedAt', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000010);
    store.saveSession({ id, turns: [turn('user', '第一句派生标题')], now: 1000 });

    const renamed = store.renameSession(id, '  采购   讨论 ');
    assert.equal(renamed.ok, true);
    assert.equal(renamed.session.title, '采购 讨论'); // 折空白

    // 再保存（新 turns 会让派生标题变化）：customTitle 仍生效。
    const saved = store.saveSession({ id, turns: [turn('user', '完全不同的第二句')], now: 2000 });
    assert.equal(saved.session.title, '采购 讨论');

    // updatedAt 不因改名被顶到最新（改名单独调用时）：
    const before = store.listSessions().sessions.find((s) => s.id === id);
    const renamedAgain = store.renameSession(id, '再改一次');
    assert.equal(renamedAgain.ok, true);
    const after = store.listSessions().sessions.find((s) => s.id === id);
    assert.equal(before.updatedAt, after.updatedAt);

    // 空标题：回退派生标题。
    const reverted = store.renameSession(id, '   ');
    assert.equal(reverted.ok, true);
    assert.equal(reverted.session.title, '完全不同的第二句');

    // 不存在的会话：null（IPC 层转「找不到」）。
    assert.equal(store.renameSession('conv-nope-missing', 'x'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('reorderSessions：手动序稳定在后、未排过的按时间在前、新会话置顶', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const a = newSessionId(1758100000020);
    const b = newSessionId(1758100000021);
    const c = newSessionId(1758100000022);
    store.saveSession({ id: a, turns: [turn('user', '甲')], now: 1000 });
    store.saveSession({ id: b, turns: [turn('user', '乙')], now: 2000 });
    store.saveSession({ id: c, turns: [turn('user', '丙')], now: 3000 });
    // 初始：时间序 丙乙甲。
    assert.deepEqual(
      store.listSessions().sessions.map((s) => s.title),
      ['丙', '乙', '甲'],
    );

    // 拖拽：把「甲」挪到最前（全量序：甲乙丙）。
    assert.equal(store.reorderSessions([a, b, c]).ok, true);
    assert.deepEqual(
      store.listSessions().sessions.map((s) => s.title),
      ['甲', '乙', '丙'],
    );

    // 未排序的新会话出现在手动序之前（新会话置顶语义）。
    const d = newSessionId(1758100000023);
    store.saveSession({ id: d, turns: [turn('user', '丁')], now: 4000 });
    assert.deepEqual(
      store.listSessions().sessions.map((s) => s.title),
      ['丁', '甲', '乙', '丙'],
    );

    // 非法 id 与不存在的会话被过滤；重排是全量替换语义（渲染层发完整列表序，
    // 只剩甲时乙丙退回时间序）。
    assert.equal(store.reorderSessions(['../evil', a, 'conv-nope-x']).ok, true);
    assert.deepEqual(
      store.listSessions().sessions.map((s) => s.title),
      ['丁', '丙', '乙', '甲'],
    );
    writeFileSync(path.join(dir, 'order-index.json'), '{ broken', 'utf8');
    assert.deepEqual(
      store.listSessions().sessions.map((s) => s.title),
      ['丁', '丙', '乙', '甲'],
    );
    // order-index.json 不会被 listSessions 当会话读。
    assert.ok(existsSync(path.join(dir, 'order-index.json')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('2026-09-29 审计 repairTaskTurns：被打断（interrupted、无终态）的任务也重建快照', () => {
  // 应用退出打断的任务档案 outcome 为空，旧条件不重建 → 存档卡定格运行态永远转圈。
  const record = {
    taskId: 'task-1-bbb',
    taskText: '查进度',
    outcome: null,
    interrupted: true,
    events: [{ at: 1, text: '任务开始。' }],
  };
  const turns = [taskTurn('查进度', {
    taskId: 'task-1-bbb',
    taskSnap: { seq: 1, taskId: 'task-1-bbb', phase: 'running', log: [{ at: 1, text: '任务开始。' }] },
  })];
  const repaired = repairTaskTurns(turns, fakeAccess({ records: { 'task-1-bbb': record } }));
  assert.equal(repaired[0].taskSnap.phase, 'terminal');
  assert.equal(repaired[0].taskSnap.outcome, 'unknown');
  assert.match(repaired[0].taskSnap.progressText, /应用退出.*执行中断/);
  assert.match(repaired[0].taskSnap.outcomeReason, /应用退出.*执行中断/);
});

// ---- 033 工作区绑定：三态写入与视图透传（与 profileId 同款语义） ----

test('033 saveSession：workspaceId 缺省保留旧值、null 显式解绑、视图/全文透传', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId();
    // 新会话绑定项目。
    store.saveSession({ id, turns: [turn('user', '项目里的事')], workspaceId: 'ws-atlas' });
    let view = store.listSessions().sessions.find((session) => session.id === id);
    assert.equal(view.workspaceId, 'ws-atlas');
    // 载入全文带绑定。
    assert.equal(store.getSession(id).workspaceId, 'ws-atlas');
    // 缺省（payload 不带键）：保留。
    store.saveSession({ id, turns: [turn('user', '再聊一句')] });
    view = store.listSessions().sessions.find((session) => session.id === id);
    assert.equal(view.workspaceId, 'ws-atlas', '缺省不得清掉已存绑定');
    // 显式 null：解绑（旧会话家目录语义）。
    store.saveSession({ id, turns: [turn('user', '解绑')], workspaceId: null });
    assert.equal(store.listSessions().sessions.find((session) => session.id === id).workspaceId, null);
    // 空串按 null 收敛。
    store.saveSession({ id, turns: [turn('user', '空串')], workspaceId: '' });
    assert.equal(store.listSessions().sessions.find((session) => session.id === id).workspaceId, null);
    // 旧档（无字段）：视图读出 null，不伪造归属。
    const legacyId = newSessionId();
    store.saveSession({ legacyId, turns: [], workspaceId: undefined, id: legacyId });
    writeFileSync(
      path.join(dir, `${legacyId}.json`),
      JSON.stringify({ version: 1, id: legacyId, title: '旧档', createdAt: 1, updatedAt: 2, turns: [] }),
      'utf8',
    );
    assert.ok(store.getSession(legacyId).workspaceId == null, '旧档全文读取按 null 语义（缺键＝null）');
    assert.equal(store.listSessions().sessions.find((session) => session.id === legacyId).workspaceId, null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveSession：内容没变的回写不刷新 updatedAt，真实内容更新时间照常保留', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const older = newSessionId(1758100000101);
    const newer = newSessionId(1758100000102);
    store.saveSession({ id: older, turns: [turn('user', '旧会话')], now: 1000 });
    store.saveSession({ id: newer, turns: [turn('user', '新会话')], now: 2000 });

    // 打开旧会话后渲染层把读到的同一份内容防抖回写。
    const opened = store.getSession(older);
    const result = store.saveSession({
      id: older,
      turns: opened.turns,
      profileId: opened.profileId,
      workspaceId: opened.workspaceId,
      now: 3000,
    });
    assert.equal(result.ok, true);
    // unchanged：没写盘——IPC 层据此跳过 conversation:changed 广播。
    assert.equal(result.unchanged, true);
    assert.equal(store.getSession(older).updatedAt, 1000);
    assert.deepEqual(store.listSessions().sessions.map((session) => session.id), [newer, older]);

    // 真有新内容照常保存真实更新时间；界面决定何时应用新排序。
    const changed = store.saveSession({
      id: older,
      turns: [...opened.turns, turn('user', '接着聊')],
      now: 4000,
    });
    assert.equal(changed.ok, true);
    assert.notEqual(changed.unchanged, true);
    assert.equal(store.getSession(older).updatedAt, 4000);
    assert.deepEqual(store.listSessions().sessions.map((session) => session.id), [older, newer]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('打开时按真实更新时间重新排序，不把选中的旧会话置顶或改时间', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    for (const [id, now] of [['conv-a', 1000], ['conv-b', 2000], ['conv-c', 3000]]) {
      store.saveSession({ id, turns: [turn('user', id)], now });
    }
    store.reorderSessions(['conv-b', 'conv-c', 'conv-a']);
    const before = store.getSession('conv-a');
    assert.equal(store.refreshOrderForOpen('conv-a').ok, true);
    const opened = store.getSession('conv-a');
    assert.deepEqual(opened, before, '打开不改任何会话字段');
    const order = () => createConversationStore({ dir }).listSessions().sessions.map(session => session.id);
    assert.deepEqual(order(), ['conv-c', 'conv-b', 'conv-a'], '按内容更新时间排序，选中的旧会话留在最后');
    store.saveSession({ id: 'conv-a', turns: [...before.turns, turn('hemi', '后台持续输出')], now: 2500 });
    store.renameSession('conv-b', '改名');
    store.getSession('conv-a');
    store.markRead('conv-a', 0);
    assert.deepEqual(order(), ['conv-c', 'conv-b', 'conv-a'], '后台更新不覆盖已保存的显示顺序');
    assert.equal(store.refreshOrderForOpen('conv-a').ok, true);
    assert.deepEqual(order(), ['conv-c', 'conv-a', 'conv-b'], '选中会话按真实更新时间插入中间，不是无条件到最前');
    assert.equal(store.getSession('conv-a').updatedAt, 2500);
    store.saveSession({ id: 'conv-d', turns: [turn('user', '新会话')], now: 6000 });
    assert.deepEqual(order(), ['conv-d', 'conv-c', 'conv-a', 'conv-b']);
    assert.equal(store.refreshOrderForOpen('conv-c').ok, true);
    assert.deepEqual(order(), ['conv-d', 'conv-c', 'conv-a', 'conv-b']);
    assert.equal(store.refreshOrderForOpen('conv-missing').ok, false);
    assert.deepEqual(order(), ['conv-d', 'conv-c', 'conv-a', 'conv-b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('按更新时间重排保留置顶组的手动顺序与全部会话元数据', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    for (const [id, now] of [['conv-pin-a', 1000], ['conv-pin-b', 2000], ['conv-old', 3000], ['conv-new', 4000]]) {
      store.saveSession({ id, turns: [turn('user', id)], now });
    }
    store.setPinned('conv-pin-a', true);
    store.setPinned('conv-pin-b', true);
    store.reorderSessions(['conv-pin-a', 'conv-pin-b', 'conv-old', 'conv-new']);
    const before = store.listSessions().sessions.map(session => store.getSession(session.id));
    assert.equal(store.refreshOrderForOpen('conv-old').ok, true);
    assert.deepEqual(store.listSessions().sessions.map(session => session.id), ['conv-pin-a', 'conv-pin-b', 'conv-new', 'conv-old']);
    for (const record of before) assert.deepEqual(store.getSession(record.id), record);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P1 自动标题：候选条件、写入、跨保存保留、首条编辑作废、手动标题优先', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1);
    store.saveSession({ id, turns: [turn('user', '帮我在飞猪查广州到清迈的往返机票')], now: 10 });
    assert.equal(store.autoTitleCandidate(id), null, '还没有回复：不生成');

    const turns = [turn('user', '帮我在飞猪查广州到清迈的往返机票'), turn('hemi', '好的，我去飞猪查一下。')];
    store.saveSession({ id, turns, now: 20 });
    const candidate = store.autoTitleCandidate(id);
    assert.equal(candidate.source, '帮我在飞猪查广州到清迈的往返机票');
    assert.equal(candidate.reply, '好的，我去飞猪查一下。');

    assert.equal(store.setAutoTitle(id, { title: '广州清迈往返机票', source: '别的依据' }), null, '依据不符：放弃');
    const written = store.setAutoTitle(id, { title: '广州清迈往返机票', source: candidate.source });
    assert.equal(written.session.title, '广州清迈往返机票');
    assert.equal(written.session.updatedAt, 20, '起名不动 updatedAt');
    assert.equal(store.autoTitleCandidate(id), null, '已有有效自动标题：不再生成');

    store.saveSession({ id, turns: [...turns, turn('user', '只看直飞')], now: 30 });
    assert.equal(store.getSession(id).title, '广州清迈往返机票', '后续保存沿用');

    // 首条被编辑：自动标题作废，回落截断标题并重新成为候选
    store.saveSession({ id, turns: [turn('user', '查清迈的酒店'), turn('hemi', '好的')], now: 40 });
    assert.equal(store.getSession(id).title, '查清迈的酒店');
    assert.equal(store.autoTitleCandidate(id).source, '查清迈的酒店');

    store.setAutoTitle(id, { title: '清迈酒店', source: '查清迈的酒店' });
    store.renameSession(id, '我的行程');
    assert.equal(store.autoTitleCandidate(id), null, '手动标题优先：不生成');
    assert.equal(store.setAutoTitle(id, { title: '别的', source: '查清迈的酒店' }), null);
    assert.equal(store.renameSession(id, '').session.title, '清迈酒店', '清空手动标题回落自动标题');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 048：思考与用量随 hemi 回应落盘（白名单清洗、截尾、往返） ----

test('048 sanitizeTurns：thinking/usage 只随 hemi 条目保留、畸形字段剔除', () => {
  const cleaned = sanitizeTurns([
    turn('hemi', '答案', {
      thinking: { text: '先想一步', durationMs: 1200 },
      usage: { modelKey: 'p1/m1', modelName: '供应商', input: 10, output: 5, cacheRead: 3, cacheWrite: 1, genMs: 900 },
    }),
    // 用户条目即使带了思考也不落（思考只属于模型回应）。
    turn('user', '问题', { thinking: { text: '不该出现', durationMs: 1 } }),
    // 畸形：thinking 非对象、usage 全零（服务未回用量）、字符串数字被 Numeric 化。
    turn('hemi', 'ok', { thinking: '坏的' }),
    turn('hemi', 'ok2', { usage: { modelKey: 'p/x', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, genMs: 0 } }),
  ]);

  assert.deepEqual(cleaned[0].thinking, { text: '先想一步', durationMs: 1200 });
  assert.deepEqual(cleaned[0].usage, { modelKey: 'p1/m1', modelName: '供应商', input: 10, output: 5, cacheRead: 3, cacheWrite: 1, genMs: 900 });
  assert.ok(!('thinking' in cleaned[1]), '用户条目不带思考');
  assert.ok(!('thinking' in cleaned[2]), '非对象 thinking 剔除');
  assert.ok(!('usage' in cleaned[3]), '全零 usage（未回用量）不落');
});

test('048 sanitizeTurns：思考全文超上限截尾并置 truncated、interrupted 保留', () => {
  const long = '思'.repeat(MAX_THINKING_CHARS + 50);
  const cleaned = sanitizeTurns([
    turn('hemi', '答', { thinking: { text: long, durationMs: 100, interrupted: true } }),
  ]);
  const thinking = cleaned[0].thinking;
  assert.equal(thinking.truncated, true);
  assert.equal(thinking.interrupted, true);
  assert.ok(Array.from(thinking.text).length <= MAX_THINKING_CHARS + 1, '截尾后不超上限（含省略号）');
  assert.ok(thinking.text.endsWith('…'));
});

test('048 落盘往返：getSession 读回的 thinking/usage 与写入一致', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId();
    const saved = store.saveSession({
      id,
      turns: [
        turn('user', '难题'),
        turn('hemi', '答案', {
          thinking: { text: '推理过程', durationMs: 2500, interrupted: false },
          usage: { modelKey: 'p1/glm-5.3', modelName: '智谱', input: 100, output: 40, cacheRead: 60, cacheWrite: 0, genMs: 3000 },
        }),
      ],
    });
    assert.equal(saved.ok, true);
    const loaded = store.getSession(id);
    assert.equal(loaded.turns[1].thinking.text, '推理过程');
    assert.equal(loaded.turns[1].thinking.durationMs, 2500);
    assert.deepEqual(loaded.turns[1].usage, { modelKey: 'p1/glm-5.3', modelName: '智谱', input: 100, output: 40, cacheRead: 60, cacheWrite: 0, genMs: 3000 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 048 D7：会话用量账本（追加、防渲染层回写冲掉、清洗、上限） ----

test('048 appendUsageRecord：追加可读回；渲染层整表保存不带账本也不冲掉', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId();
    store.saveSession({ id, turns: [turn('user', '你好'), turn('hemi', '在的')] });
    assert.equal(store.appendUsageRecord(id, {
      source: 'chat', modelKey: 'p1/m1', modelName: 'P1',
      input: 10, output: 5, cacheRead: 2, cacheWrite: 0, genMs: 800, at: 1234,
    }), true, '已落盘会话可追加');

    // 渲染层防抖整表保存（turns 变化、不带账本字段）——账本必须保留。
    store.saveSession({ id, turns: [turn('user', '你好'), turn('hemi', '在的'), turn('user', '再来')] });
    const loaded = store.getSession(id);
    assert.equal(loaded.usageLedger.length, 1);
    assert.equal(loaded.usageLedger[0].source, 'chat');
    assert.equal(loaded.usageLedger[0].modelKey, 'p1/m1');

    // 不存在的会话追加失败（不致命）。
    assert.equal(store.appendUsageRecord('conv-nope', { source: 'chat', modelKey: 'x', input: 1, at: 1 }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('048 sanitizeUsageRecords：source 白名单、畸形剔除、missing-only 保留、上限裁最旧', () => {
  const clean = sanitizeUsageRecords([
    { source: 'chat', modelKey: 'a', modelName: 'A', input: 1, output: 2, cacheRead: 0, cacheWrite: 0, genMs: 5, at: 1 },
    { source: 'bogus', modelKey: 'x', input: 9, at: 2 }, // 非法 source 剔除
    null, // 畸形剔除
    { source: 'title', modelKey: 'b', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, genMs: 0, at: 3, missing: 1 }, // 缺用量计次保留
    { source: 'summary', modelKey: 'c', input: 0, output: 0, cacheRead: 0, cacheWrite: 0, genMs: 0, at: 4 }, // 全空剔除
    { source: 'task', modelKey: 'd', input: 7, output: 0, cacheRead: 0, cacheWrite: 0, genMs: 0, at: 5, calls: 3 },
  ]);
  assert.deepEqual(clean.map((r) => r.source), ['chat', 'title', 'task']);
  assert.equal(clean[1].missing, 1);
  assert.equal(clean[2].calls, 3);
  assert.ok(!('missing' in clean[0]));
});

test('2026-10-11 打开旧会话不顶到「今天」：遗留字段净化回写 unchanged、迁移性改写保留 updatedAt', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000001);

    // 直接落一份带 024 改版前遗留标记（stale/pendingResend）的旧档。
    const legacyTurns = [
      turn('user', '帮我查机票', { createdAt: 100 }),
      turn('hemi', '查到了', { createdAt: 200, stale: true }),
      turn('user', '再看看火车', { createdAt: 300, pendingResend: true }),
    ];
    writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({ version: 1, id, title: '帮我查机票', createdAt: 100, updatedAt: 500, turns: legacyTurns }),
      'utf8',
    );

    // 渲染层打开后原样回写净化过的 turns：unchanged——不写盘、不动 updatedAt。
    const opened = store.getSession(id);
    const result = store.saveSession({ id, turns: opened.turns, now: 100_000 });
    assert.equal(result.unchanged, true);
    assert.equal(store.getSession(id).updatedAt, 500);
    // 遗留标记留在盘上（读路径净化），不因「看一眼」被改写。
    const raw = JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    assert.ok(raw.turns.some((t) => t.stale === true));

    // 真有新内容仍照常顶到最前。
    const changed = store.saveSession({ id, turns: [...opened.turns, turn('user', '接着聊', { createdAt: 400 })], now: 200_000 });
    assert.notEqual(changed.unchanged, true);
    assert.notEqual(changed.touched, false);
    assert.equal(store.getSession(id).updatedAt, 200_000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('2026-10-11 标题重推导迁移：落盘新标题但保留 updatedAt（touched:false）', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000002);
    // 旧档标题＝旧推导口径（首条问候语直接当标题）；新推导跳过问候取首条有主题消息。
    writeFileSync(
      path.join(dir, `${id}.json`),
      JSON.stringify({
        version: 1, id, title: '你好啊', createdAt: 100, updatedAt: 500,
        turns: [turn('user', '你好啊', { createdAt: 100 }), turn('user', '帮我查机票', { createdAt: 200 })],
      }),
      'utf8',
    );
    const opened = store.getSession(id);
    const result = store.saveSession({ id, turns: opened.turns, now: 100_000 });
    assert.notEqual(result.unchanged, true, '标题差异要落盘迁移');
    assert.equal(result.touched, false, '迁移不算「最近对话」活动');
    const after = store.getSession(id);
    assert.equal(after.title, '帮我查机票');
    assert.equal(after.updatedAt, 500);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('2026-10-11 宿主恢复性回写（keepUpdatedAt）：快照修复落盘但不改「最近对话」时间', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000003);
    store.saveSession({
      id,
      turns: [
        turn('user', '查天气', { createdAt: 100 }),
        turn('hemi', '任务受理', { kind: 'task', taskSeq: 1, taskId: 'task-1-abc123', createdAt: 150, taskSnap: { seq: 1, taskId: 'task-1-abc123', phase: 'running' } }),
      ],
      now: 500,
    });
    // 宿主恢复：同一张卡按档案重建终态快照（restoreTaskResults 场景）。
    const recovered = [{
      id: 'task-1-abc123:card', author: 'hemi', kind: 'task', taskSeq: 1, taskId: 'task-1-abc123',
      text: '任务受理', createdAt: 150,
      taskSnap: { seq: 1, taskId: 'task-1-abc123', phase: 'terminal', outcome: 'complete' },
    }];
    const result = store.appendHostTurns(id, recovered, { keepUpdatedAt: true });
    assert.equal(result.ok, true);
    assert.equal(result.touched, false);
    assert.equal(result.unchanged, undefined);
    const after = store.getSession(id);
    assert.equal(after.updatedAt, 500, '恢复性回写不动 updatedAt');
    assert.equal(after.turns.find((t) => t.kind === 'task').taskSnap.phase, 'terminal');

    // 默认（不带 keepUpdatedAt）的宿主写入仍是真活动：照常刷新。
    const live = store.appendHostTurns(id, [{ id: 'u-2', author: 'user', text: '继续', createdAt: 600 }]);
    assert.notEqual(live.touched, false);
    assert.equal(store.getSession(id).updatedAt, live.session.updatedAt);
    assert.ok(store.getSession(id).updatedAt >= 600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('2026-10-11 终态交代按时间去重：旧档已有播报文案交代就不按新正文补第二条', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000004);
    const endedAt = 10_000;
    store.saveSession({
      id,
      turns: [
        turn('user', '查天气', { createdAt: 100 }),
        turn('hemi', '任务受理', { kind: 'task', taskSeq: 1, taskId: 'task-1-abc124', createdAt: 150, taskSnap: { seq: 1, taskId: 'task-1-abc124', phase: 'running' } }),
        turn('hemi', '阶段简报：取数中', { taskId: 'task-1-abc124', createdAt: 5000 }),
        turn('hemi', '天气查好了，多云 15 度', { taskId: 'task-1-abc124', createdAt: endedAt + 30 }),
      ],
      now: endedAt + 60,
    });
    // 050 口径的恢复：交代文本＝交付正文，与旧播报文案不等。
    const recovered = [
      {
        id: 'task-1-abc124:card', author: 'hemi', kind: 'task', taskSeq: 1, taskId: 'task-1-abc124',
        text: '任务受理', createdAt: 150,
        taskSnap: { seq: 1, taskId: 'task-1-abc124', phase: 'terminal', outcome: 'complete', log: [] },
      },
      {
        id: 'task-result:task-1-abc124:1', author: 'hemi', taskId: 'task-1-abc124',
        text: '【交付正文】今天多云，最高 15 度，适合出行。', createdAt: endedAt,
      },
    ];
    const result = store.appendHostTurns(id, recovered, { keepUpdatedAt: true });
    assert.equal(result.ok, true);
    const after = store.getSession(id);
    const wraps = after.turns.filter((t) => t.taskId === 'task-1-abc124' && t.kind !== 'task');
    assert.equal(wraps.length, 2, '阶段简报＋原终态交代，不补第二条正文交代');
    assert.ok(wraps.some((t) => t.text === '天气查好了，多云 15 度'), '旧交代原文保留');
    assert.ok(!after.turns.some((t) => t.text.includes('交付正文')), '新正文不整条替换旧交代');

    // 终态交代真缺（只有阶段简报）时仍要补回——恢复能力不受去重影响。
    const id2 = newSessionId(1758100000005);
    store.saveSession({
      id: id2,
      turns: [
        turn('user', '查天气', { createdAt: 100 }),
        turn('hemi', '任务受理', { kind: 'task', taskSeq: 1, taskId: 'task-1-abc125', createdAt: 150, taskSnap: { seq: 1, taskId: 'task-1-abc125', phase: 'running' } }),
        turn('hemi', '阶段简报：取数中', { taskId: 'task-1-abc125', createdAt: 5000 }),
      ],
      now: endedAt + 60,
    });
    const recovered2 = [{
      id: 'task-result:task-1-abc125:1', author: 'hemi', taskId: 'task-1-abc125',
      text: '【交付正文】今天晴。', createdAt: endedAt,
    }];
    store.appendHostTurns(id2, recovered2, { keepUpdatedAt: true });
    const wraps2 = store.getSession(id2).turns.filter((t) => t.taskId === 'task-1-abc125' && t.kind !== 'task');
    assert.equal(wraps2.length, 2, '阶段简报之外补回唯一的终态交代');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('saveSession：cutKeysGrew 只在剪除键真正新增时为真（回卷补存档不重复作废大脑）', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId(1758100000009);
    const plain = store.saveSession({ id, turns: [turn('user', '第一句')], now: 1000 });
    assert.equal(plain.cutKeysGrew, false);
    const cut = store.saveSession({ id, turns: [turn('user', '第一句')], removedTurnKeys: ['x9'], now: 2000 });
    assert.equal(cut.cutKeysGrew, true);
    // 回卷后的防抖补存档重复携带同一批键：不算新增（否则会把新回合再杀一次）。
    const repeat = store.saveSession({ id, turns: [turn('user', '第一句')], removedTurnKeys: ['x9'], now: 3000 });
    assert.equal(repeat.cutKeysGrew, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('编辑回卷按 inputId 保留 SDK 前缀；同文前轮与工具结果保留，归档回答 ID 不同也剪除', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir }), id = newSessionId();
    const turns = [turn('user', '相同问题', { id: 'in-first' }), turn('hemi', '保留答案', { id: 'reply-first' }),
      turn('user', '相同问题', { id: 'in-edited' }), turn('hemi', '撤回答案', { id: 'reply-archive' }),
      turn('hemi', '撤回任务', { id: 'task-row', taskId: 'task-removed', kind: 'task', taskSeq: 1 })];
    store.saveSession({ id, turns, profileId: 'auto', workspaceId: 'ws-kept', now: 1000 });
    const entries = [{ id: 'a', type: 'custom', customType: 'hemi.input', data: { inputId: 'in-first' } },
      { id: 'b', parentId: 'a', type: 'message', message: { role: 'user', content: '相同问题' } },
      { id: 'c', parentId: 'b', type: 'message', message: { role: 'toolResult', content: '保留原始工具结果' } },
      { id: 'd', parentId: 'c', type: 'custom', customType: 'hemi.input', data: { inputId: 'in-edited' } },
      { id: 'e', parentId: 'd', type: 'message', message: { role: 'user', content: '相同问题' } },
      { id: 'f', parentId: 'e', type: 'message', message: { role: 'assistant', content: '撤回答案' } }];
    const header = { type: 'session', id: 'sdk-header', cwd: dir };
    store.saveAgentSession(id, { header, entries });
    const result = store.applyCutKeys(id, ['run-edited:a:in-edited'], { targetInputId: 'in-edited' });
    assert.equal(result.ok, true);
    assert.deepEqual(store.getAgentSession(id), { header, entries: entries.slice(0, 3) });
    const saved = store.getSession(id);
    assert.deepEqual(saved.turns.map(t => t.id), ['in-first', 'reply-first']);
    assert.equal(saved.profileId, 'auto');
    assert.equal(saved.workspaceId, 'ws-kept');
    assert.equal(saved.updatedAt, 1000);
    store.appendHostTurns(id, turns.slice(2));
    assert.deepEqual(store.getSession(id).turns.map(t => t.id), ['in-first', 'reply-first'], '迟到回答和任务不能复活');
    store.saveAgentSession(id, { header, entries: [{ id: 'new-history' }] });
    const repeat = store.applyCutKeys(id, [], { targetInputId: 'in-edited' });
    assert.equal(repeat.unchanged, true);
    assert.equal(repeat.cutKeysGrew, false);
    assert.deepEqual(store.getAgentSession(id).entries, [{ id: 'new-history' }], '重复旧回卷不删除新回合');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧档／被压缩编辑点没有 inputId 锚点：清除旧 SDK 摘要，仅保留编辑点之前的对话', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir }), id = newSessionId();
    store.saveSession({ id, turns: [turn('user', '保留', { id: 'in-kept' }), turn('hemi', '保留回复'),
      turn('user', '旧问题', { id: 'in-old' }), turn('hemi', '旧回复', { id: 'reply-real' })] });
    store.saveAgentSession(id, { header: {}, entries: [{ type: 'compaction', summary: '含旧问题和旧回复的摘要' }] });
    const result = store.applyCutKeys(id, ['ui-answer-id'], { targetInputId: 'in-old' });
    assert.equal(result.ok, true);
    assert.equal(store.getAgentSession(id), null);
    assert.deepEqual(store.getSession(id).turns.map(t => t.text), ['保留', '保留回复']);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('旧补参只有 flow 用户项也可回卷，保留前文并剪除后续普通回答', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir }), id = newSessionId();
    store.saveSession({ id, turns: [turn('user', '保留', { id: 'in-kept' }), turn('hemi', '保留回复'),
      turn('user', '后续普通输入', { id: 'in-later' }), turn('hemi', '后续回复', { id: 'reply-later', runId: 'run-later' })] });
    const target = path.join(dir, `${id}.json`);
    const record = JSON.parse(readFileSync(target, 'utf8'));
    record.flow = { timeline: [{ kind: 'user', id: 'in-kept', runId: 'run-kept' },
      { kind: 'user', id: 'in-prep-only', runId: 'run-prep' },
      { kind: 'assistant', runId: 'run-prep', parts: [{ kind: 'text', content: '还缺参数' }] },
      { kind: 'user', id: 'in-later', runId: 'run-later' }] };
    writeFileSync(target, JSON.stringify(record));
    store.saveAgentSession(id, { header: {}, entries: [{ type: 'compaction', summary: '含旧目标' }] });
    assert.equal(store.applyCutKeys(id, [], { targetInputId: 'in-prep-only' }).ok, true);
    assert.deepEqual(store.getSession(id).turns.map(t => t.text), ['保留', '保留回复']);
    assert.equal(store.getAgentSession(id), null);
    const saved = JSON.parse(readFileSync(target, 'utf8'));
    assert.ok(saved.cutKeys.includes('in-prep-only'));
    assert.ok(saved.cutKeys.includes('in-later'));
    assert.equal(store.applyCutKeys(id, [], { targetInputId: 'in-prep-only' }).unchanged, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('回卷目标失效时拒绝且不改档；旧 removedTurnKeys 保存路径也不能保留 SDK 旧史', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir }), id = newSessionId();
    store.saveSession({ id, turns: [turn('user', '保留', { id: 'in-keep' })] });
    store.saveAgentSession(id, { header: {}, entries: [{ id: 'old-sdk' }] });
    const before = readFileSync(path.join(dir, `${id}.json`), 'utf8');
    assert.equal(store.applyCutKeys(id, [], { targetInputId: 'missing' }).ok, false);
    assert.equal(readFileSync(path.join(dir, `${id}.json`), 'utf8'), before);
    store.saveSession({ id, turns: [], removedTurnKeys: ['in-keep'] });
    assert.equal(store.getAgentSession(id), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('累计超过 512 个撤回身份后，新的编辑仍作废旧史，既有墓碑不丢失', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir }), id = newSessionId();
    const input = turn('user', '编辑目标', { id: 'in-next' });
    store.saveSession({ id, turns: [input], removedTurnKeys: Array.from({ length: 512 }, (_, i) => `removed-${i}`) });
    store.saveAgentSession(id, { header: {}, entries: [{ type: 'message', message: { role: 'user', content: '编辑目标' } }] });
    const cut = store.applyCutKeys(id, [], { targetInputId: input.id });
    assert.equal(cut.cutKeysGrew, true);
    assert.equal(store.getAgentSession(id), null);
    store.saveSession({ id, turns: [] });
    store.appendHostTurns(id, [turn('hemi', '旧补档', { id: 'removed-0' }), input]);
    assert.deepEqual(store.getSession(id).turns, []);
    const record = JSON.parse(readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    assert.equal(record.cutKeys.length, 513);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('048 用量角色身份持久保留，旧账本不补造归属', () => {
  const base = { source: 'task', modelKey: 'p/same', modelName: 'same', input: 10, output: 2, cacheRead: 0, cacheWrite: 0, genMs: 1, at: 1 };
  const records = sanitizeUsageRecords([{ ...base, role: 'explorer' }, { ...base, role: 'oracle' }, base]);
  assert.deepEqual(records.map(row => row.role), ['explorer', 'oracle', undefined]);
});

test('上下文容量落档：快照可读回、渲染层整表保存不冲掉、空/未知态与坏入参拒写', () => {
  const dir = makeDir();
  try {
    const store = createConversationStore({ dir });
    const id = newSessionId();
    store.saveSession({ id, turns: [turn('user', '你好'), turn('hemi', '在的')] });
    assert.equal(store.saveContextUsage(id, {
      tokens: 51000, contextWindow: 1000000, percent: 5.1,
      categories: [
        { key: 'tools', label: '系统工具', tokens: 22000, percent: 43.1 },
        { key: 'conversation', label: '对话消息', tokens: 9000, percent: 17.6 },
        { key: 'toolResults', label: '工具结果', tokens: -5, percent: -1 },
        { key: 'system', label: '系统提示词', tokens: 11000, percent: 21.6 },
        { label: '缺 key 的脏行' },
      ],
    }), true, '已落盘会话可落档');

    // 渲染层防抖整表保存（不带 contextUsage 字段）——快照必须保留。
    store.saveSession({ id, turns: [turn('user', '你好'), turn('hemi', '在的'), turn('user', '再来')] });
    const loaded = store.getSession(id);
    assert.equal(loaded.contextUsage.tokens, 51000);
    assert.equal(loaded.contextUsage.contextWindow, 1000000);
    assert.equal(loaded.contextUsage.percent, 5.1);
    assert.equal(loaded.contextUsage.categories.length, 4, '缺 key 的脏行剔除');
    assert.equal(loaded.contextUsage.categories[2].tokens, 0, '负值钳到 0');
    assert.ok(Number.isFinite(loaded.contextUsage.at));

    // 压缩后未知态照落（tokens/percent 为 null，不编数）。
    assert.equal(store.saveContextUsage(id, { tokens: null, contextWindow: 200000, percent: null, categories: [] }), true);
    const unknown = store.getSession(id).contextUsage;
    assert.equal(unknown.tokens, null);
    assert.equal(unknown.percent, null);

    // 无窗口/不存在会话拒写。
    assert.equal(store.saveContextUsage(id, { tokens: 1, contextWindow: 0 }), false);
    assert.equal(store.saveContextUsage('conv-nope', { tokens: 1, contextWindow: 100 }), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// 060 列表索引：正文解析结果按 size+mtime 指纹缓存（内存＋list-index.json），
// 列表刷新不再全量读盘；外部改动/损坏/删除经指纹失配自愈。
test('列表索引：未变化会话走缓存，外部改动、损坏、删除与索引损坏均自愈', t => {
  const dir = makeDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ dir });
  store.saveSession({ id: 'conv-a', turns: [turn('user', '你好世界，这是第一个会话')], now: 10 });
  store.saveSession({ id: 'conv-b', turns: [turn('user', '第二个会话')], now: 20 });

  const first = store.listSessions();
  assert.equal(first.sessions.length, 2);
  assert.ok(existsSync(path.join(dir, 'list-index.json')), '首次列表生成磁盘索引');
  // 二次列表（全缓存命中）结果一致
  assert.deepEqual(store.listSessions().sessions, first.sessions);

  // 重启后从磁盘索引加载，列表仍正确（免全量解析）
  const restarted = createConversationStore({ dir });
  assert.deepEqual(restarted.listSessions().sessions, first.sessions);

  // 外部修改会话文件（绕过 store）→ 指纹失配 → 重读反映新标题
  const external = JSON.parse(readFileSync(path.join(dir, 'conv-a.json'), 'utf8'));
  external.title = '外部改的名字（内容变长保证 size 变化）';
  writeFileSync(path.join(dir, 'conv-a.json'), JSON.stringify(external, null, 2), 'utf8');
  assert.equal(store.listSessions().sessions.find(s => s.id === 'conv-a').title, external.title);

  // 文件损坏 → corrupt 条目；内容不再变时连 corrupt 视图也走缓存
  writeFileSync(path.join(dir, 'conv-b.json'), '{', 'utf8');
  const corrupted = store.listSessions();
  assert.equal(corrupted.sessions.find(s => s.id === 'conv-b').corrupt, true);
  assert.deepEqual(store.listSessions().sessions.find(s => s.id === 'conv-b'),
    corrupted.sessions.find(s => s.id === 'conv-b'));

  // 删除后列表与索引不残留
  store.deleteSession('conv-b');
  assert.equal(store.listSessions().sessions.find(s => s.id === 'conv-b'), undefined);
  const persisted = JSON.parse(readFileSync(path.join(dir, 'list-index.json'), 'utf8'));
  assert.equal(persisted.entries.find(([id]) => id === 'conv-b'), undefined, '索引落盘无残留');

  // 打开会话时的排序刷新走索引路径，结果正确
  assert.equal(store.refreshOrderForOpen('conv-a').ok, true);
  assert.deepEqual(store.reorderSessions(['conv-a']), { ok: true, count: 1 });
});

test('列表索引文件损坏时回退全量读，列表仍正确并重建索引', t => {
  const dir = makeDir(); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const store = createConversationStore({ dir });
  store.saveSession({ id: 'conv-x', turns: [turn('user', '内容')], now: 5 });
  store.listSessions();
  writeFileSync(path.join(dir, 'list-index.json'), 'not-json{', 'utf8');
  const broken = createConversationStore({ dir });
  const list = broken.listSessions();
  assert.equal(list.sessions.length, 1);
  assert.equal(list.sessions[0].id, 'conv-x');
  assert.equal(list.sessions[0].title, store.getSession('conv-x').title);
  const rebuilt = JSON.parse(readFileSync(path.join(dir, 'list-index.json'), 'utf8'));
  assert.equal(rebuilt.version, 1, '损坏索引被重建');
});

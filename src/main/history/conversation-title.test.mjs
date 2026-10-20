// P1 会话自动标题：依据提取、输出清洗、调度去重与串行。
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildTitlePrompt,
  createAutoTitler,
  firstReply,
  normalizeGeneratedTitle,
  titleSource,
} from './conversation-title.mjs';

const t = (author, text, extra = {}) => ({ author, text, ...extra });

test('titleSource / firstReply：首条用户消息与其后首条非任务回复', () => {
  const turns = [t('hemi', '你好'), t('user', '  查天气 '), t('hemi', '卡', { kind: 'task' }), t('hemi', '明天晴')];
  assert.equal(titleSource(turns), '查天气');
  assert.equal(firstReply(turns), '明天晴');
  assert.equal(firstReply([t('user', '只有问题')]), '');
  assert.equal(titleSource([]), '');
});

test('buildTitlePrompt：system＋user 两条，回复可缺省', () => {
  const messages = buildTitlePrompt({ userText: '查天气' });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].content, '用户：查天气');
});

test('标题跳过误触与问候，回复不跨过下一条用户消息、不采用报错留痕', () => {
  const turns = [t('user', '1'), t('user', '你好啊'), t('hemi', '你好'), t('user', '查看技术栈'), t('hemi', '好，交给我。')];
  assert.equal(titleSource(turns), '查看技术栈');
  assert.equal(firstReply(turns), '好，交给我。');
  assert.equal(firstReply([t('user', '查天气'), t('user', '查机票'), t('hemi', '机票结果')]), '');
  // 2026-10-10 回卷语义改版：stale 标记已删（被撤下内容直接移除，不带标记
  // 落档）；失败留痕（kind='error'）仍不得充当标题依据的回复。
  assert.equal(firstReply([t('user', '查天气'), t('hemi', '失败', { kind: 'error' })]), '');
});

test('normalizeGeneratedTitle：摘思考块/前缀/引号/句末标点，超长与空拒收', () => {
  assert.equal(normalizeGeneratedTitle('广州清迈往返机票'), '广州清迈往返机票');
  assert.equal(normalizeGeneratedTitle('<think>想一想</think>\n\n「广州清迈机票」。'), '广州清迈机票');
  assert.equal(normalizeGeneratedTitle('标题：下载截图归档'), '下载截图归档');
  assert.equal(normalizeGeneratedTitle('"Beijing weather"\n解释……'), 'Beijing weather');
  assert.equal(normalizeGeneratedTitle('**北京天气**'), '北京天气');
  assert.equal(normalizeGeneratedTitle('   \n  '), null);
  assert.equal(normalizeGeneratedTitle('好'.repeat(21)), null);
  assert.equal(normalizeGeneratedTitle(undefined), null);
});

function fakeStore(candidates) {
  const written = [];
  return {
    written,
    autoTitleCandidate: (id) => candidates[id] ?? null,
    setAutoTitle: (id, payload) => {
      written.push({ id, ...payload });
      return { ok: true, session: { id, title: payload.title } };
    },
  };
}

test('createAutoTitler：同一依据只试一次（失败也不重试）、串行执行、成功回调', async () => {
  const store = fakeStore({
    a: { source: '查天气', reply: '好', profileId: null },
    b: { source: '查机票', reply: '好', profileId: 'p/m' },
  });
  let active = 0;
  let maxActive = 0;
  const calls = [];
  const titled = [];
  const titler = createAutoTitler({
    store,
    runModel: async ({ messages, profileId }) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      calls.push(profileId);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      if (messages[1].content.includes('查机票')) throw new Error('boom');
      return '北京天气';
    },
    onTitled: (session) => titled.push(session.title),
  });
  titler.schedule('a');
  titler.schedule('a'); // 排队中去重
  titler.schedule('b');
  await titler.idle();
  titler.schedule('a'); // 已试过
  titler.schedule('b'); // 失败过也不重试
  titler.schedule('none'); // 无候选
  await titler.idle();
  assert.deepEqual(calls, [null, 'p/m']);
  assert.equal(maxActive, 1);
  assert.deepEqual(titled, ['北京天气']);
  assert.deepEqual(store.written, [{ id: 'a', title: '北京天气', source: '查天气' }]);
});

test('createAutoTitler：输出不合格不写入', async () => {
  const store = fakeStore({ a: { source: '查天气', reply: '好', profileId: null } });
  const titler = createAutoTitler({ store, runModel: async () => '好'.repeat(40) });
  titler.schedule('a');
  await titler.idle();
  assert.equal(store.written.length, 0);
});

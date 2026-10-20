// 013 首位说话人状态机单测（覆盖 AC-01～08 的逻辑层）。
import assert from 'node:assert/strict';
import test from 'node:test';

import { createPrimarySpeakerFilter } from './primary-speaker.ts';

const partial = (text, speaker = null, utteranceId = 'u1') => ({
  type: 'transcript.partial',
  text,
  speaker,
  utteranceId,
});
const final = (text, speaker = null, utteranceId = 'u1') => ({
  type: 'transcript.final',
  text,
  speaker,
  utteranceId,
});

test('AC-01：首位定稿锁定（编号不要求为 1），首句采纳', () => {
  const filter = createPrimarySpeakerFilter();
  // partial 不锁定不展示。
  assert.equal(filter.admitEvent(partial('把文件整理', 3, 'u0')).admit, false);
  const first = filter.admitEvent(final('把文件整理一下', 3, 'u0'));
  assert.equal(first.admit, true);
  assert.equal(first.phase, 'locked');
  assert.equal(first.primary, 3);
  // 后续同编号正常采纳。
  assert.equal(filter.admitEvent(partial('好了吗', 3, 'u1')).admit, true);
  assert.equal(filter.admitEvent(final('好了吗', 3, 'u1')).admit, true);
});

test('AC-02：锁定后旁人内容全链路不采纳，且不影响主说话人', () => {
  const filter = createPrimarySpeakerFilter();
  filter.admitEvent(final('我是先说话的人', 2, 'a0'));
  assert.equal(filter.admitEvent(partial('B 在说话', 5, 'b0')).admit, false);
  assert.equal(filter.admitEvent(final('B 在说话', 5, 'b0')).admit, false);
  assert.equal(filter.admitEvent(final('C 也说话', 7, 'c0')).admit, false);
  // 旁人 partial 不推迟回合提交：同一事件流里主用户照常。
  assert.equal(filter.admitEvent(partial('继续帮我', 2, 'a1')).admit, true);
});

test('AC-03：无编号 partial 可临时预览，后补有编号 final 才处理；始终无编号不触发', () => {
  const filter = createPrimarySpeakerFilter();
  assert.equal(filter.admitEvent(partial('这是谁说的')).admit, false);
  const decided = filter.admitEvent(final('这是谁说的', 4, 'k1'));
  assert.equal(decided.admit, true);
  assert.equal(decided.primary, 4);
  // 始终无编号：等待期不采纳。
  const f2 = createPrimarySpeakerFilter();
  assert.equal(f2.admitEvent(final('没有编号的话')).admit, false);
});

test('实时预览与受理分离：首句／未知编号可看，已知旁人隐藏且不能受理', () => {
  const filter = createPrimarySpeakerFilter();
  const first = filter.admitEvent(partial('正在识别'));
  assert.equal(first.preview, true);
  assert.equal(first.admit, false);
  assert.equal(filter.phase, 'waiting');
  filter.admitEvent(final('第一句', 1, 'first'));
  const unknown = filter.admitEvent(partial('下一句还没编号', null, 'next'));
  assert.equal(unknown.preview, true);
  assert.equal(unknown.admit, false);
  const other = filter.admitEvent(partial('旁人', 2, 'other'));
  assert.equal(other.preview, false);
  assert.equal(other.admit, false);
  assert.equal(filter.admitEvent(final('旁人', 2, 'other')).admit, false);
});

test('AC-04：同一包多说话人分句分别判断，不拼接混合指令', () => {
  const filter = createPrimarySpeakerFilter();
  filter.admitEvent(final('A 的话', 2, 'a0'));
  assert.equal(filter.admitEvent(final('B 插了一句', 3, 'b0')).admit, false);
  assert.equal(filter.admitEvent(final('A 接着说', 2, 'a1')).admit, true);
});

test('AC-05：重复定稿幂等、归属冲突丢弃不改绑', () => {
  const filter = createPrimarySpeakerFilter();
  filter.admitEvent(final('第一句', 2, 'a0'));
  // 同一句重复定稿（同编号）：放行（幂等由下游会话层保证）。
  assert.equal(filter.admitEvent(final('第一句修订', 2, 'a0')).admit, true);
  // 同 utteranceId 编号改变＝归属冲突：丢弃并提示。
  const conflict = filter.admitEvent(final('第一句被算给 B', 3, 'a0'));
  assert.equal(conflict.admit, false);
  assert.match(conflict.notice ?? '', /冲突/);
  // 冲突不改绑：primary 仍是 2。
  assert.equal(filter.admitEvent(final('还是 A 的', 2, 'a1')).admit, true);
  // 等待期无编号的句子（-1）后来补上主说话人编号：是修订不是冲突（AC-03）。
  const f2 = createPrimarySpeakerFilter();
  f2.admitEvent(final('先没有编号', null, 'k1'));
  f2.admitEvent(final('编号出现了', 4, 'k1'));
  assert.equal(f2.admitEvent(final('编号句的修订', 4, 'k1')).admit, true);
});

test('AC-06：reset 后旧编号不复用——新连接按首位规则重新锁定', () => {
  const filter = createPrimarySpeakerFilter();
  filter.admitEvent(final('旧通话的锁定句', 6, 'old-0'));
  filter.reset();
  assert.equal(filter.phase, 'waiting');
  // 新连接里谁先开口谁锁定（可能仍是旧编号，但那是新锁定的首位，不是复用）；
  // 界面此时显示「连接已重建，需重新锁定」，用户可重新锁定纠错（R-06/R-07）。
  const first = filter.admitEvent(final('重连后先开口', 6, 'old-1'));
  assert.equal(first.admit, true);
  assert.equal(first.primary, 6);
  filter.reset();
  const next = filter.admitEvent(final('新通话另一个人先开口', 1, 'new-0'));
  assert.equal(next.admit, true);
  assert.equal(next.primary, 1);
  // 换了人后旧主说话人不再被采纳。
  assert.equal(filter.admitEvent(final('原说话人再说', 6, 'new-1')).admit, false);
});

test('AC-07/R-07：重新锁定入口清理旧候选，新说话人可接管', () => {
  const filter = createPrimarySpeakerFilter();
  filter.admitEvent(final('B 先开口被锁定', 5, 'b0'));
  const notice = filter.relock();
  assert.match(notice, /单独说一句/);
  // 重新锁定后仍是首位规则：B 先开口仍会锁定 B，需要 A 单独开口纠正。
  filter.admitEvent(final('B 又说', 5, 'b1'));
  filter.relock();
  const relocked = filter.admitEvent(final('A 单独开口', 2, 'a0'));
  assert.equal(relocked.primary, 2);
  assert.equal(relocked.admit, true);
  // 旧候选（B）不再被采纳。
  assert.equal(filter.admitEvent(final('B 再说', 5, 'b2')).admit, false);
});

test('R-09/D-5：连续无编号 final 判不可用并降级放行（0 也是有效编号）', () => {
  const filter = createPrimarySpeakerFilter();
  assert.equal(filter.admitEvent(final('第一句没编号', null, 'm1')).admit, false);
  const second = filter.admitEvent(final('第二句也没编号', null, 'm2'));
  assert.equal(second.phase, 'unavailable');
  assert.equal(second.admit, true); // 降级放行
  assert.match(second.notice ?? '', /无法过滤旁人/);
  assert.equal(filter.admitEvent(final('第三句照常', 9, 'x')).admit, true);
  // speaker 0 是有效编号，不触发不可用。
  const zero = createPrimarySpeakerFilter();
  const locked = zero.admitEvent(final('编号为零', 0, 'z0'));
  assert.equal(locked.phase, 'locked');
  assert.equal(locked.primary, 0);
});

test('R-04：锁定后无编号 final 不采纳且不继承身份', () => {
  const filter = createPrimarySpeakerFilter();
  filter.admitEvent(final('锁定句', 4, 'a0'));
  assert.equal(filter.admitEvent(final('没带编号的句子')).admit, false);
  assert.equal(filter.admitEvent(partial('没带编号的临时')).admit, false);
});

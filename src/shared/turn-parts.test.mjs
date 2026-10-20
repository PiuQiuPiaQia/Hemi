import assert from 'node:assert/strict';
import test from 'node:test';
import { finalizeTurnParts, hasNonTextParts, reduceTurnParts } from './turn-parts.mjs';

const run = (events) => events.reduce((parts, [event, at]) => reduceTurnParts(parts, event, at ?? 0), []);

test('按到达顺序成段：思考 → 正文 → 工具组 → 正文 → 工具组', () => {
  const parts = run([
    [{ kind: 'thinking_start' }, 1],
    [{ kind: 'thinking', text: '想' }, 2],
    [{ kind: 'text', text: '我先看看。' }, 3],
    [{ kind: 'tool_start', tool: 'read', toolCallId: 'a', args: { path: '/x' } }, 4],
    [{ kind: 'tool_start', tool: 'bash', toolCallId: 'b' }, 5],
    [{ kind: 'tool_end', tool: 'read', toolCallId: 'a' }, 6],
    [{ kind: 'tool_end', tool: 'bash', toolCallId: 'b', isError: true }, 7],
    [{ kind: 'text', text: '看完了，' }, 8],
    [{ kind: 'text', text: '再查一下。' }, 9],
    [{ kind: 'tool_start', tool: 'grep', toolCallId: 'c' }, 10],
    [{ kind: 'tool_end', tool: 'grep', toolCallId: 'c' }, 11],
    [{ kind: 'thinking_start' }, 12],
    [{ kind: 'thinking', text: '再想' }, 13],
    [{ kind: 'thinking_end' }, 14],
    [{ kind: 'text', text: '结论。' }, 15],
  ]);
  assert.deepEqual(parts.map((part) => part.type), ['thinking', 'text', 'tools', 'text', 'tools', 'thinking', 'text']);
  assert.equal(parts[0].endedAt, 3); // 正文首字定格思考
  assert.deepEqual(parts[2].calls.map((call) => call.state), ['done', 'error']);
  assert.equal(parts[3].text, '看完了，再查一下。');
  assert.equal(parts[5].text, '再想');
  assert.equal(parts[5].endedAt, 14);
});

test('restart 清空；未知事件不变；tool_end 找不到不变', () => {
  const parts = run([[{ kind: 'text', text: 'a' }], [{ kind: 'restart' }]]);
  assert.deepEqual(parts, []);
  const base = run([[{ kind: 'text', text: 'a' }]]);
  assert.equal(reduceTurnParts(base, { kind: 'whatever' }), base);
  assert.equal(reduceTurnParts(base, { kind: 'tool_end', tool: 'x' }), base);
});

test('finalize：收尾进行中的思考/工具、去空段；hasNonTextParts', () => {
  const parts = run([
    [{ kind: 'thinking_start' }, 1],
    [{ kind: 'text', text: '  ' }, 2],
    [{ kind: 'tool_start', tool: 'bash', toolCallId: 'a' }, 3],
  ]);
  const done = finalizeTurnParts(parts, 9, { interrupted: true });
  assert.deepEqual(done.map((part) => part.type), ['tools']); // 空思考、空白正文被去掉
  assert.equal(done[0].calls[0].state, 'error');
  assert.equal(hasNonTextParts(done), true);
  assert.equal(hasNonTextParts([{ type: 'text', text: 'x' }]), false);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

// llm.ipc 依赖 Electron ipcMain，无法在 node --test 下加载执行；回合收口又没有
// 更高层的集成测试兜底。日志作用域回归的原始事故：受理日志里
// 的变量声明在回合回调闭包内、使用在回调外，每轮受理必抛 ReferenceError 且
// 单测/build 均不可见（.mjs 不进 typecheck）。056 起同样的作用域形态出现在
// taskStartedAt（档案排序锚点：派过子 agent 的回合把回答排到任务卡之后）——
// 这里用源码文本断言锁住：声明必须在回合回调创建之前（外层），使用在声明之后。

const here = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(here, 'llm.ipc.mjs');

test('taskStartedAt 声明在回合回调外（收口日志与档案排序可见）', async () => {
  const source = await readFile(sourcePath, 'utf8');
  const declAt = source.indexOf('let taskStartedAt');
  const callbackAt = source.indexOf('await conversationTurns.run(');
  const useAt = source.indexOf('taskStartedAt ??= Date.now()');
  const readAt = source.indexOf('replyCreatedAt(endedAt, taskStartedAt)');

  assert.ok(declAt >= 0, 'llm.ipc.mjs 里找不到 taskStartedAt 声明（收口是否被删改？）');
  assert.ok(useAt >= 0, 'llm.ipc.mjs 里找不到派单时对 taskStartedAt 的赋值');
  assert.ok(readAt >= 0, 'llm.ipc.mjs 里找不到落档时对 taskStartedAt 的读取');
  assert.ok(
    callbackAt > declAt,
    'taskStartedAt 声明必须在回合回调创建之前（外层作用域），否则回调外的使用读到 undefined',
  );
  assert.ok(useAt > declAt && readAt > declAt, '赋值与读取都应在声明之后');
});

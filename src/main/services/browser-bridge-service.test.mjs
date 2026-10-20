import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  busyMessage,
  createBrowserBridgeService,
} from './browser-bridge-service.mjs';

/**
 * 023 R-15 · 浏览器桥单例专项：
 *   - 并行任务的 cmd 信封各带 taskId，结果按命令 id 正确路由（新扩展 multiTask）；
 *   - 旧扩展（无 multiTask 能力）时第二并发任务快速报忙，endSession 释放后可进；
 *   - endSession 只结束本任务会话，hub 仍监听、其他任务不受影响（与任务终态解耦）。
 */

async function freePort() {
  // 让 OS 绑 port 0 现分配：随机猜在 Windows 上会撞 Hyper-V 保留段（EACCES）
  // 与其他进程（EADDRINUSE）——win 探针第 4 轮钓出；关闭后重绑的小竞态测试可接受。
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

/** 模拟 Chrome 扩展：记录收到的 cmd（含 taskId），可编程应答。 */
function dialExtension(port, { multiTask = true, onCommand = () => ({ ok: true, data: {} }) } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
      headers: { origin: 'chrome-extension://hemiext' },
    });
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', version: 1, ext: 'chrome-extension', extVersion: '0.3.0-test', multiTask }));
      resolve({
        ws,
        close() {
          return new Promise((done) => {
            ws.addEventListener('close', () => done(), { once: true });
            ws.close();
          });
        },
      });
    });
    ws.addEventListener('error', () => reject(new Error('扩展连接失败')));
    ws.addEventListener('message', (event) => {
      try {
        const message = JSON.parse(String(event.data));
        if (message.type === 'cmd') {
          const outcome = onCommand(message);
          if (outcome === null) return; // 故意不回执（测超时）
          ws.send(JSON.stringify({ type: 'result', id: message.id, ...(outcome ?? { ok: true, data: {} }) }));
        }
      } catch {
        /* 非 JSON 忽略 */
      }
    });
  });
}

test('并行任务：cmd 信封各带 taskId，结果路由互不串台', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 3000 } });
  const t1 = service.createClient({ taskId: 'task-a', taskLabel: '任务A' });
  const t2 = service.createClient({ taskId: 'task-b', taskLabel: '任务B' });
  await service.start();
  const seen = [];
  const dialed = dialExtension(port, {
    multiTask: true,
    onCommand: (cmd) => {
      seen.push({ op: cmd.op, taskId: cmd.taskId, taskLabel: cmd.taskLabel });
      // 各任务回各自的标记，验证结果路由
      return { ok: true, data: { echo: cmd.taskId, url: cmd.params?.url ?? null } };
    },
  });
  try {
    await Promise.all([t1.ensureReady(), t2.ensureReady()]);
    assert.equal(service.extMultiTask, true, 'hello multiTask 应被记录');
    assert.deepEqual(service.activeTaskIds.sort(), ['task-a', 'task-b']);

    const [r1, r2] = await Promise.all([
      t1.request('session.navigate', { url: 'https://a.example/' }),
      t2.request('tab.extract', { selector: '#main' }),
    ]);
    assert.equal(r1.echo, 'task-a');
    assert.equal(r2.echo, 'task-b');
    assert.deepEqual(seen.map((s) => s.taskId).sort(), ['task-a', 'task-b']);
    assert.deepEqual(seen.map((s) => s.taskLabel).sort(), ['任务A', '任务B']);
  } finally {
    await t1.endSession();
    await t2.endSession();
    await service.stopHub();
    await dialed;
  }
});

test('旧扩展兜底：无 multiTask 时第二并发任务报忙，释放后可进', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const t1 = service.createClient({ taskId: 'task-a' });
  const t2 = service.createClient({ taskId: 'task-b' });
  await service.start();
  const dialed = dialExtension(port, { multiTask: false });
  try {
    await t1.ensureReady();
    await assert.rejects(
      () => t2.ensureReady(),
      /被另一个任务使用/,
      '扩展不支持多任务 → 第二任务快速报忙（021 语义兜底）',
    );
    assert.deepEqual(service.activeTaskIds, ['task-a']);

    // t1 结束 → t2 可进（报忙不是饿死）
    await t1.endSession();
    await t2.ensureReady();
    assert.deepEqual(service.activeTaskIds, ['task-b']);
  } finally {
    await t2.endSession();
    await service.stopHub();
    await dialed;
  }
});

test('endSession 与 hub 解耦：任务收尾不关桥，session.end 只清本任务', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 2000 } });
  const t1 = service.createClient({ taskId: 'task-a' });
  const t2 = service.createClient({ taskId: 'task-b' });
  await service.start();
  const endCalls = [];
  const dialed = dialExtension(port, {
    multiTask: true,
    onCommand: (cmd) => {
      if (cmd.op === 'session.end') {
        endCalls.push(cmd.taskId);
        return { ok: true, data: {} };
      }
      return { ok: true, data: {} };
    },
  });
  try {
    await Promise.all([t1.ensureReady(), t2.ensureReady()]);
    assert.equal(service.connected, true);
    await t1.endSession();
    assert.deepEqual(endCalls, ['task-a'], 'session.end 只带本任务 id');
    assert.equal(service.connected, true, 'hub 不随任务收尾关闭（R-15 核心）');
    assert.deepEqual(service.activeTaskIds, ['task-b']);
    // t2 照常可用
    await t2.request('tab.list', {});
  } finally {
    await t2.endSession();
    await service.stopHub();
    await dialed;
  }
});

test('状态文件落点与 busyMessage 文案契约', async () => {
  const port = await freePort();
  const writes = [];
  const service = createBrowserBridgeService({
    ports: [port],
    log: null,
    statePath: '/tmp/hemi-bridge-service-test.json',
    writeFileFn: async (_path, data) => writes.push(JSON.parse(data)),
    opTimeout: { default: 2000 },
  });
  const t1 = service.createClient({ taskId: 'task-a', taskLabel: '甲' });
  await service.start();
  const dialed = dialExtension(port, { multiTask: true });
  try {
    await t1.ensureReady();
    const last = writes.at(-1);
    assert.equal(last.state, 'ready');
    assert.equal(last.extVersion, '0.3.0-test');
    assert.equal(last.multiTask, true);
    assert.equal(last.tasks, 1);
    assert.match(busyMessage([9467]), /另一个任务使用.*9467/);
  } finally {
    await t1.endSession();
    await service.stopHub();
    await dialed;
  }
});

test('056：同一客户端的命令串行（navigate 回执前 extract 不发出）；不同任务互不阻塞', async () => {
  const port = await freePort();
  const service = createBrowserBridgeService({ ports: [port], log: null, opTimeout: { default: 3000 } });
  const t1 = service.createClient({ taskId: 'task-a' });
  const t2 = service.createClient({ taskId: 'task-b' });
  await service.start();
  const order = [];
  let ext = null;
  const dialed = dialExtension(port, {
    onCommand: (cmd) => {
      order.push(`${cmd.taskId}:${cmd.op}`);
      if (cmd.op === 'session.navigate') {
        // navigate 故意延迟回执：串行时 extract 必须等它。
        setTimeout(() => ext?.ws.send(JSON.stringify({ type: 'result', id: cmd.id, ok: true, data: { op: cmd.op } })), 80);
        return null;
      }
      return { ok: true, data: { op: cmd.op } };
    },
  });
  try {
    ext = await dialed;
    await Promise.all([t1.ensureReady(), t2.ensureReady()]);
    const results = await Promise.all([
      t1.request('session.navigate', { url: 'https://a.example/' }),
      t1.request('tab.extract', {}),
      t2.request('tab.extract', {}),
    ]);
    assert.deepEqual(results.map((r) => r.op), ['session.navigate', 'tab.extract', 'tab.extract']);
    // 任务 b 的 extract 不等任务 a 的 navigate；任务 a 的 extract 排在它的 navigate 之后。
    assert.ok(order.indexOf('task-b:tab.extract') < order.indexOf('task-a:tab.extract'), order.join(' → '));
    assert.ok(order.indexOf('task-a:session.navigate') < order.indexOf('task-a:tab.extract'));
  } finally {
    await t1.endSession();
    await t2.endSession();
    await service.stopHub();
  }
});

test('没用过浏览器的回合不启动桥；重复收尾幂等，失败保留归属并可重试', async () => {
  const port = await freePort();
  const warnings = [], ends = [];
  const service = createBrowserBridgeService({ ports: [port], opTimeout: { default: 2000 }, log: { warn: text => warnings.push(text) } });
  const client = service.createClient({ taskId: 'cleanup-owner' });
  await client.endSession(); assert.equal(service.state, 'off');
  await service.start();
  const dialed = dialExtension(port, { onCommand: cmd => {
    if (cmd.op !== 'session.end') return { ok: true, data: {} };
    ends.push(cmd.taskId);
    return ends.length === 1 ? { ok: false, error: 'injected-close-failure' } : { ok: true, data: {} };
  } });
  try {
    await client.ensureReady();
    await Promise.all([client.endSession(), client.endSession()]);
    assert.equal(ends.length, 1, 'prompt 收口和 dispose 并发只清一次');
    assert.deepEqual(service.activeTaskIds, ['cleanup-owner'], '失败不冒充已回收');
    assert.match(warnings.join('\n'), /injected-close-failure/);
    await client.endSession();
    assert.equal(ends.length, 2); assert.deepEqual(service.activeTaskIds, []);
    await client.endSession(); assert.equal(ends.length, 2, '成功后重复清理不再发送');
    await client.ensureReady(); await client.endSession();
    assert.equal(ends.length, 3, '同一 SDK 会话下一轮仍能使用浏览器');
  } finally { await service.stopHub(); (await dialed).ws.close(); }
});

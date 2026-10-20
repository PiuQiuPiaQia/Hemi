// browser-ws 单测：Node 内置 WebSocket 客户端（宿主 Node ≥22）对打真实回环连接。
// 全部走随机端口注入，不触 userData。
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { test } from 'node:test';

import { BrowserWsHub, acceptKey, createFrameParser, encodeFrame } from './browser-ws.mjs';

async function freePort() {
  // 让 OS 绑 port 0 现分配：随机猜在 Windows 上会撞 Hyper-V 保留段（EACCES）
  // 与其他进程（EADDRINUSE）——win 探针第 4 轮钓出；关闭后重绑的小竞态测试可接受。
  const srv = createServer();
  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  const { port } = srv.address();
  await new Promise((resolve) => srv.close(resolve));
  return port;
}

function dial(port, origin = 'chrome-extension://abcdefg') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { origin } });
    const messages = [];
    const waiters = [];
    ws.addEventListener('message', (event) => {
      const text = typeof event.data === 'string' ? event.data : '';
      const waiter = waiters.shift();
      if (waiter) waiter(text);
      else messages.push(text);
    });
    ws.addEventListener('open', () => resolve({
      ws,
      nextText(timeoutMs = 2000) {
        if (messages.length) return Promise.resolve(messages.shift());
        return new Promise((resolveText, rejectText) => {
          const timer = setTimeout(() => rejectText(new Error('等待消息超时')), timeoutMs);
          waiters.push((text) => {
            clearTimeout(timer);
            resolveText(text);
          });
        });
      },
      close() {
        return new Promise((resolveClose) => {
          ws.addEventListener('close', () => resolveClose(), { once: true });
          ws.close();
        });
      },
    }));
    ws.addEventListener('error', () => reject(new Error(`连接失败 ws://127.0.0.1:${port}`)));
  });
}

test('acceptKey 按 RFC6455 示例向量计算', () => {
  assert.equal(acceptKey('dGhlIHNhbXBsZSBub25jZQ=='), 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
});

test('握手、文本双向', async () => {
  const hub = new BrowserWsHub({ originPrefix: 'chrome-extension://' });
  const port = await hub.listen({ ports: [await freePort()] });
  let client = null;
  try {
    hub.on('text', (_client, text) => hub.sendText(`echo:${text}`));
    client = await dial(port);
    client.ws.send('ping1');
    assert.equal(await client.nextText(), 'echo:ping1');
    hub.sendText('server-push');
    assert.equal(await client.nextText(), 'server-push');
  } finally {
    client?.close();
    hub.close();
  }
});

test('Origin 前缀校验：网页来源被拒、扩展来源放行', async () => {
  const hub = new BrowserWsHub({ originPrefix: 'chrome-extension://' });
  const port = await hub.listen({ ports: [await freePort()] });
  let client = null;
  try {
    await assert.rejects(dial(port, 'https://evil.example'), /连接失败/);
    client = await dial(port, 'chrome-extension://hemi');
    hub.sendText('ok');
    assert.equal(await client.nextText(), 'ok');
  } finally {
    client?.close();
    hub.close();
  }
});

test('唯一客户端语义：新连接顶掉旧连接', async () => {
  const hub = new BrowserWsHub();
  const port = await hub.listen({ ports: [await freePort()] });
  let first = null;
  let second = null;
  try {
    first = await dial(port);
    const oldGone = once(hub, 'close');
    second = await dial(port);
    await Promise.race([oldGone, new Promise((r) => setTimeout(r, 500))]);
    // 旧连接已被顶掉：桥现在只认第二个。
    hub.sendText('only-second');
    assert.equal(await second.nextText(), 'only-second');
  } finally {
    first?.close();
    second?.close();
    hub.close();
  }
});

test('帧解析：分片文本与 ping 插队', () => {
  const seen = { texts: [], pings: 0, closed: 0 };
  const parser = createFrameParser({
    onText: (t) => seen.texts.push(t),
    onPing: () => { seen.pings += 1; },
    onClose: () => { seen.closed += 1; },
  });
  // 「he」（非 FIN 文本帧）+ ping 插队 +「llo」（FIN continuation）。
  const part1 = Buffer.concat([Buffer.from([0x01, 2]), Buffer.from('he')]); // opcode=1, FIN=0
  const llo = Buffer.concat([Buffer.from([0x80, 3]), Buffer.from('llo')]); // opcode=0, FIN=1
  parser.push(part1);
  parser.push(encodeFrame(0x9, Buffer.from('p')));
  parser.push(llo);
  assert.deepEqual(seen.texts, ['hello']);
  assert.equal(seen.pings, 1);
});

test('大消息（>65535 字节）文本往返', async () => {
  const hub = new BrowserWsHub();
  const port = await hub.listen({ ports: [await freePort()] });
  let client = null;
  try {
    client = await dial(port);
    hub.on('text', (_c, text) => hub.sendText(String(text.length)));
    const big = 'x'.repeat(80_000);
    client.ws.send(big);
    assert.equal(await client.nextText(), '80000');
  } finally {
    client?.close();
    hub.close();
  }
});

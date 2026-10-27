import {PassThrough, Writable} from 'node:stream';
import {createMessageConnection, StreamMessageReader, StreamMessageWriter} from 'vscode-jsonrpc/node';
import {errorView, fail, botRpcTimeout} from './storage.mjs';

const MAX_REQUESTS = 32;
const quietLogger = {error() {}, warn() {}, info() {}, log() {}};

/** One SSH CLI process; requests still use the Host's authenticated local pipe. */
export async function serveRpcStream({input, output, request}) {
  const connection = createMessageConnection(new StreamMessageReader(input), new StreamMessageWriter(output), quietLogger);
  const done = Promise.withResolvers();
  let active = 0;
  connection.onRequest('bot.rpc', async value => {
    if (active >= MAX_REQUESTS) return errorView(Object.assign(new Error('Bot 请求过多，请稍后重试。'), {code: 'busy'}));
    active++;
    try {return await request(value);}
    catch (error) {return errorView(error);}
    finally {active--;}
  });
  connection.onClose(() => done.resolve());
  connection.onError(() => done.resolve());
  connection.listen();
  await connection.sendNotification('bot.ready', {version: 1});
  const heartbeat = setInterval(() => {void connection.sendNotification('bot.heartbeat').catch(() => done.resolve());}, 20000);
  heartbeat.unref?.();
  try {await done.promise;}
  finally {clearInterval(heartbeat); connection.dispose();}
}

/** A lost reply is uncertain: reject it and never replay a mutation automatically. */
export function createRpcStream({start, readyTimeoutMs = 15000}) {
  const controller = new AbortController(), pending = new Set(), input = new PassThrough();
  let write, closed = false, lastFrame = Date.now(), readyTimer, heartbeat;
  const output = new Writable({write(bytes, _encoding, callback) {
    if (!write) {callback(new Error('Bot input is unavailable')); return;}
    void write(bytes).then(() => callback(), callback);
  }});
  const connection = createMessageConnection(new StreamMessageReader(input), new StreamMessageWriter(output), quietLogger);
  const ready = Promise.withResolvers();
  void ready.promise.catch(() => {});
  function close(error = Object.assign(new Error('Bot 控制连接已断开，请重新核对操作结果。'), {code: 'needs-review'})) {
    if (closed) return;
    closed = true;
    clearTimeout(readyTimer); clearInterval(heartbeat);
    ready.reject(error);
    for (const item of pending) item.reject(error);
    pending.clear();
    connection.dispose(); input.destroy(); output.destroy();
    controller.abort();
  }
  connection.onNotification('bot.ready', value => {
    if (value?.version !== 1) {close(); return;}
    lastFrame = Date.now(); clearTimeout(readyTimer); ready.resolve();
  });
  connection.onNotification('bot.heartbeat', () => {lastFrame = Date.now();});
  connection.onClose(() => close());
  connection.onError(() => close());
  connection.listen();
  readyTimer = setTimeout(() => close(Object.assign(new Error('Bot 控制连接未就绪，请重新连接。'), {code: 'offline'})), readyTimeoutMs);
  heartbeat = setInterval(() => {if (Date.now() - lastFrame > 45000) close();}, 5000);
  heartbeat.unref?.();
  void Promise.resolve().then(() => start({signal: controller.signal, onStdin: send => {write = send;}, onStdout(chunk) {
    lastFrame = Date.now();
    if (!closed) input.write(chunk);
  }})).then(() => close(), () => close());
  return {
    get closed() {return closed;},
    close,
    async request(request, {signal} = {}) {
      await ready.promise;
      if (closed || !write) fail('Bot 控制连接已断开，请重新连接。', 'offline');
      if (signal?.aborted) fail('操作已取消，结果待核对。', 'needs-review');
      if (pending.size >= MAX_REQUESTS) fail('Bot 请求过多，请稍后重试。', 'busy');
      const result = Promise.withResolvers();
      const abort = () => result.reject(Object.assign(new Error('操作已取消，结果待核对。'), {code: 'needs-review'}));
      const timeout = setTimeout(() => close(), botRpcTimeout(request.method, request.params));
      pending.add(result);
      signal?.addEventListener('abort', abort, {once: true});
      // JSON-RPC owns message framing, response correlation and late replies.
      // Cancellation only stops waiting; the Host may already have committed.
      void connection.sendRequest('bot.rpc', request).then(reply => {
        if (reply.ok) result.resolve(reply.result);
        else result.reject(Object.assign(new Error(reply.message), {code: reply.code}));
      }, () => {result.reject(Object.assign(new Error('Bot 回执丢失，请重新核对操作结果。'), {code: 'needs-review'}));})
        .finally(() => {pending.delete(result); clearTimeout(timeout); signal?.removeEventListener('abort', abort);});
      return result.promise;
    },
  };
}

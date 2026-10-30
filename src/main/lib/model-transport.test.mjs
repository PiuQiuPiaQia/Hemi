import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { fetch as undiciFetch } from 'undici';
import { observeModelFetch, modelConnectionError, transportCodeOf } from './model-transport.mjs';

test('real fetch delivery observation separates concurrent requests and detects writes before a headerless disconnect', async t => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* Receive the complete model request. */ }
    if (req.url === '/drop') req.socket.destroy();
    else res.end('OK');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  // Both Node's built-in Undici and the installed dispatcher used by the SDK.
  for (const fetchImpl of [globalThis.fetch, undiciFetch]) {
    const dropped = {}, successful = {}, synthetic = {};
    const results = await Promise.allSettled([
      observeModelFetch(fetchImpl, `${origin}/drop`, { method: 'POST', body: 'MODEL_REQUEST' }, dropped),
      observeModelFetch(fetchImpl, `${origin}/ok`, { method: 'POST', body: 'OTHER_REQUEST' }, successful),
      observeModelFetch(async () => { throw Object.assign(new Error('synthetic transport'), { code: 'EPIPE' }); }, origin, {}, synthetic),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(dropped.delivery, 'sent');
    assert.equal(transportCodeOf(results[0].reason), 'UND_ERR_SOCKET');
    assert.equal(await results[1].value.text(), 'OK');
    assert.equal(successful.delivery, 'sent');
    assert.equal(synthetic.delivery, 'unknown');
  }
});

test('real connection refusal is observed before any request write', async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  await new Promise(resolve => server.close(resolve));
  const state = {};
  await assert.rejects(observeModelFetch(fetch, url, { method: 'POST', body: 'NEVER_SENT' }, state), error => transportCodeOf(error) === 'ECONNREFUSED');
  assert.equal(state.delivery, 'not-sent');
});

test('provider connection errors keep only a controlled message and nested transport code', () => {
  const raw = new TypeError('PRIVATE_UPSTREAM bearer SYNTHETIC_SECRET', {
    cause: new AggregateError([Object.assign(new Error('PRIVATE_ADDRESS'), { code: 'EPIPE' })]),
  });
  const safe = modelConnectionError(raw, 'GLM 编程套餐连接中断');
  assert.equal(safe.code, 'EPIPE');
  assert.equal(safe.message, 'GLM 编程套餐连接中断（EPIPE）');
  assert.doesNotMatch(safe.stack + JSON.stringify(safe), /PRIVATE_|SYNTHETIC_SECRET/);
});

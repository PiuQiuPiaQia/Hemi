// 生产会话工厂 + 已安装 Pi SDK + 真实本地 HTTP；不依赖外部模型或个人凭据。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { createHemiSession } from './hemi-session.mjs';
import { createRunJournal } from '../agent-runtime/run-journal.mjs';
import { createContextStore } from '../agent-runtime/context-store.mjs';
import { testPng } from '../../../scripts/lib/local-image-fixtures.mjs';

function finish(res, content) {
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  for (const [delta, finish_reason] of [[{ role: 'assistant', content }, null], [{}, 'stop']]) {
    res.write(`data: ${JSON.stringify({ id: 'test', choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}

async function fixture(t, handler, { images = 0, settings = {}, supportsVision = true, entries = null } = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-request-images-'));
  const requests = [], logs = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push({ body, bytes: Buffer.byteLength(raw) });
    await handler(body, res, requests.length);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { modelKey: 'p/m', providerId: 'p', credentialRef: 'p', model: supportsVision ? 'test-vision' : 'test-text', api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'SYNTHETIC_ONLY', supportsVision };
  const journal = createRunJournal({ dir: path.join(dir, 'journal') }), owner = { conversationId: 'images', rootRunId: 'run', generation: 1 };
  await journal.beginRoot(owner);
  const history = SessionManager.inMemory(dir);
  const data = images ? testPng({ width: 640, height: 640, noisy: true }).toString('base64') : null;
  for (let i = 0; i < images; i++) {
    history.appendMessage({ role: 'user', content: [{ type: 'text', text: `frame-${i}.png` }, { type: 'image', mimeType: 'image/png', data }], timestamp: i });
  }
  const execution = { journal, owner, contextStore: createContextStore({dir: path.join(dir, 'contexts')}), allowedRefs: [], purpose: 'main', plan: { role: 'main', primary: config, allowedFallbacks: [] },
    store: { resolveStrict: async () => ({ ok: true, config }) }, budgets: { maxRequestsPerRun: 20 }, cancelled: () => false };
  const session = createHemiSession({ cwd: dir, agentDir: dir, model: config, tools: ['read'], features: {},
    executionContext: execution, entries: entries ?? [history.getHeader(), ...history.getEntries()], settings,
    initTimeoutMs: 4000, stallTimeoutMs: 20000, log: { info: text => logs.push(text), warn: text => logs.push(text) } });
  t.after(async () => { session.dispose(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); });
  return { session, requests, journal, logs, dir, data };
}

test('有图片历史的会话切到文本模型由 Pi 降级，切回视觉模型仍可发送原图', async t => {
  const vision = await fixture(t, (_body, res) => finish(res, '原先的图片分析。'),
    { images: 9, settings: { compaction: { enabled: false } } });
  const before = await vision.session.prompt('先分析图片');
  assert.equal(before.modelError, null);
  const saved = await vision.session.exportEntries();
  const entries = [saved.header, ...saved.entries], original = structuredClone(entries);
  vision.session.dispose();

  const text = await fixture(t, (_body, res) => finish(res, '继续文字讨论。'),
    { entries, supportsVision: false, settings: { compaction: { enabled: false } } });
  const result = await text.session.prompt('切换模型后继续讨论');
  assert.equal(result.modelError, null);
  assert.equal(text.requests.length, 1);
  assert.equal(text.requests[0].body.model, 'test-text');
  const body = JSON.stringify(text.requests[0].body);
  assert.equal(body.match(/image omitted: model does not support images/g)?.length, 9);
  assert.doesNotMatch(body, /image_url|data:image|历史图片已从本次请求省略|本次请求图片已压缩/);
  assert.match(body, /原先的图片分析/);
  assert.match(body, /切换模型后继续讨论/);
  assert.equal(JSON.stringify(entries.slice(0, original.length)) === JSON.stringify(original), true, '新增对话只追加条目，既有历史不被改写');
  const continued = await text.session.exportEntries();
  assert.equal(continued.entries.filter(e => e.message?.content?.some?.(b => b.type === 'image' && b.data === vision.data)).length, 9);
  text.session.dispose();

  const restored = await fixture(t, (_body, res) => finish(res, '重新看图。'),
    { entries: [continued.header, ...continued.entries], settings: { compaction: { enabled: false } } });
  assert.equal((await restored.session.prompt('重新查看图片')).modelError, null);
  assert.equal(restored.requests[0].body.model, 'test-vision');
  const images = restored.requests[0].body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'image_url');
  assert.equal(images.length, 8, '切回视觉模型仍沿用已有的图片请求预算');
  assert.match(JSON.stringify(restored.requests[0].body), /继续文字讨论/);
});

test('旧图片会话预减负，413 同模型只重试一次；之后工具只执行一次，原图不被改写', async t => {
  let file;
  const f = await fixture(t, (body, res, n) => {
    if (n === 1) { res.writeHead(413, { 'content-type': 'text/html' }); res.end('<html>Request Entity Too Large</html>'); return; }
    if (!body.messages.some(m => m.role === 'tool')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'read-once', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path: file }) } }] }, finish_reason: null }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] })}\n\n`);
      res.end('data: [DONE]\n\n'); return;
    }
    finish(res, '恢复后只读取一次。');
  }, { images: 21, settings: { compaction: { enabled: false } } });
  file = path.join(f.dir, 'fixture.txt'); await writeFile(file, 'READ_ONCE');
  let reads = 0; f.session.on('progress', event => { if (event.kind === 'tool-end') reads++; });
  const result = await f.session.prompt('继续，读取 fixture.txt。');
  assert.equal(result.modelError, null);
  assert.equal(f.requests.length, 3); assert.equal(reads, 1);
  const imagesOf = body => body.messages.flatMap(m => Array.isArray(m.content) ? m.content : []).filter(b => b.type === 'image_url');
  assert.equal(imagesOf(f.requests[0].body).length, 8);
  assert.equal(imagesOf(f.requests[1].body).length, 4);
  assert.equal(imagesOf(f.requests[2].body).length, 4, '同一服务后续请求沿用已成功的预算，不再反复撞 413');
  assert.ok(f.requests[0].bytes < 4.5 * 1024 * 1024);
  assert.ok(f.requests[1].bytes < 0.75 * 1024 * 1024);
  assert.equal(f.requests[0].body.model, f.requests[1].body.model);
  const entries = (await f.session.exportEntries()).entries;
  assert.equal(entries.filter(e => e.message?.role === 'toolResult').length, 1);
  assert.equal(entries.filter(e => Array.isArray(e.message?.content) && e.message.content.some(b => b.type === 'image' && b.data === f.data)).length, 21);
  const records = Object.values((await f.journal.snapshot()).requests);
  assert.equal(records.length, 3);
  assert.equal(records[0].logicalCallId, records[1].logicalCallId);
  assert.notEqual(records[1].logicalCallId, records[2].logicalCallId);
  assert.deepEqual(records.slice(0, 2).map(r => r.httpStatus), [413, 200]);
});

test('413 缩减后仍拒绝就结束；纯文字不盲重试，媒体 400 不误报为 413', async t => {
  for (const [images, status, supportsVision] of [[0, 413, true], [12, 413, true], [12, 400, true], [12, 413, false]]) {
    const f = await fixture(t, (_body, res) => {
      res.writeHead(status, { 'content-type': status === 413 ? 'text/html' : 'application/json' });
      res.end(status === 413 ? '<html>openresty</html>' : JSON.stringify({ error: { message: 'media_too_large' } }));
    },
      { images, supportsVision, settings: { compaction: { enabled: false } } });
    const result = await f.session.prompt('继续');
    assert.match(result.modelError, /请求.*超过服务限制/);
    if (status === 413) assert.match(result.modelError, /413/);
    else assert.doesNotMatch(result.modelError, /413/);
    assert.doesNotMatch(result.modelError, /html|openresty/);
    assert.equal(f.requests.length, images && supportsVision ? 2 : 1);
  }
});

test('自动 token 压缩确实产生摘要；摘要失败的 end 事件不会再打印压缩完成', async t => {
  for (const fail of [false, true]) {
    const f = await fixture(t, (body, res) => {
      if (JSON.stringify(body).includes('context summarization assistant')) {
        if (fail) { res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'SUMMARY_FAILED' } })); }
        else finish(res, '## Goal\n继续验证图片。\n## Progress\n已读原图，原图保留。');
      } else finish(res, '正常回复。');
    }, { images: 21, settings: { compaction: { enabled: true, reserveTokens: 120000, keepRecentTokens: 100 } } });
    const result = await f.session.prompt('继续');
    const compactions = (await f.session.exportEntries()).entries.filter(e => e.type === 'compaction');
    if (fail) {
      assert.equal(compactions.length, 0);
      assert.ok(f.logs.some(text => /上下文压缩失败.*SUMMARY_FAILED/.test(text)));
      assert.equal(f.logs.some(text => /上下文压缩完成/.test(text)), false);
    } else {
      assert.equal(result.modelError, null);
      assert.ok(compactions.length > 0);
      assert.match(compactions[0].summary, /原图保留/);
      assert.ok(f.logs.some(text => /上下文压缩完成/.test(text)));
    }
  }
});

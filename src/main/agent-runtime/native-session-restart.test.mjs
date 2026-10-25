import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { SessionManager } from '@earendil-works/pi-coding-agent';

test('真实独立进程：旧聊天与私有快照迁移、重启续聊、再次原生恢复且不重跑旧工具', { timeout: 90000, skip: process.platform === 'win32' && 'Cloud shell fixture requires POSIX host' }, async t => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-native-restart-')));
  const workspace = path.join(root, 'workspace'), dataDir = path.join(root, 'data'); await fs.mkdir(workspace);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), all = JSON.stringify(body.messages); requests.push(body);
    const continuing = /CONTINUE_AFTER_/.test(all);
    const toolDone = body.messages.some(message => message.role === 'tool');
    const tool = !continuing && all.includes('REMEMBER_NATIVE_FIRST') && !toolDone ? {
      index: 0, id: 'native-bash-once', type: 'function', function: { name: 'bash',
        arguments: JSON.stringify({ command: 'echo one-execution >> execution-count.txt' }) },
    } : null;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const delta = tool ? { role: 'assistant', tool_calls: [tool] } : { role: 'assistant', content: continuing ? 'CONTINUED_WITH_OLD_CONTEXT' : 'ACK_amber-731' };
    res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta, finish_reason: null }] }) + '\n\n');
    res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }) + '\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await fs.rm(root, { recursive: true, force: true }); });
  const worker = fileURLToPath(new URL('../../../scripts/lib/native-session-restart-worker.mjs', import.meta.url));
  const run = async (mode, id = '') => {
    const { stdout } = await promisify(execFile)(process.execPath, [worker, dataDir, workspace, `http://127.0.0.1:${server.address().port}/v1`, mode, id],
      { timeout: 25000, maxBuffer: 4 * 1024 * 1024 });
    const line = stdout.split('\n').find(line => line.startsWith('NATIVE_RESULT '));
    assert.ok(line, stdout); return JSON.parse(line.slice('NATIVE_RESULT '.length));
  };
  const first = await run('first');
  const stateFile = path.join(dataDir, 'state.json'), state = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  const id = first.id, ref = state.sessions[id].agent.payload.ref;
  assert.equal(state.sessions[id].agent.payload.storage, 'pi');
  const dir = path.join(dataDir, 'runtime-v2/sessions');
  const meta = JSON.parse(await fs.readFile(path.join(dir, 'metadata', `${ref}.json`), 'utf8'));
  const manager = SessionManager.open(path.join(dir, 'pi', meta.native.file));
  const payload = { header: manager.getHeader(), entries: manager.getEntries() };
  // Reconstruct the exact v2 inputs produced by an older installed Hemi.
  const { version, ref: _ref, native, migration, ...business } = meta;
  const legacy = { version: 2, ...business, payload };
  const revision = createHash('sha256').update(JSON.stringify(legacy)).digest('hex');
  const legacyFile = path.join(dir, `entries-${revision}.json`);
  await fs.writeFile(legacyFile, JSON.stringify(legacy)); await fs.writeFile(path.join(dir, `${ref}.json`), JSON.stringify({ revision }));
  state.sessions[id].agent.payload = payload; await fs.writeFile(stateFile, JSON.stringify(state));
  const originalBytes = await fs.readFile(legacyFile);
  await fs.rm(path.join(dir, 'pi'), { recursive: true }); await fs.rm(path.join(dir, 'metadata'), { recursive: true });
  const migrationStart = requests.length;
  const second = await run('legacy', id);
  const migratedRequests = requests.slice(migrationStart).filter(body => JSON.stringify(body.messages).includes('CONTINUE_AFTER_LEGACY_MIGRATION'));
  assert.ok(migratedRequests.length);
  const context = JSON.stringify(migratedRequests[0].messages);
  assert.match(context, /REMEMBER_NATIVE_FIRST/); assert.match(context, /ACK_amber-731/); assert.match(context, /native-bash-once/);
  assert.ok(second.timeline.length > first.timeline.length);
  assert.deepEqual(second.timeline.slice(0, first.timeline.length), first.timeline);
  assert.deepEqual(await fs.readFile(legacyFile), originalBytes);
  const migratedState = JSON.parse(await fs.readFile(stateFile, 'utf8'));
  assert.deepEqual(migratedState.sessions[id].agent.payload, { storage: 'pi', version: 1, ref });
  const migratedMeta = JSON.parse(await fs.readFile(path.join(dir, 'metadata', `${ref}.json`), 'utf8'));
  assert.equal(migratedMeta.payload, undefined);
  const nativeStart = requests.length;
  const third = await run('native', id);
  const nativeRequest = requests.slice(nativeStart).find(body => JSON.stringify(body.messages).includes('CONTINUE_AFTER_NATIVE_RESTART'));
  assert.ok(nativeRequest); assert.match(JSON.stringify(nativeRequest.messages), /CONTINUE_AFTER_LEGACY_MIGRATION/);
  assert.match(JSON.stringify(nativeRequest.messages), /amber-731/);
  assert.ok(third.timeline.length > second.timeline.length);
  assert.equal((await fs.readFile(path.join(workspace, 'execution-count.txt'), 'utf8')).trim(), 'one-execution');
  assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('entries-')).length, 1, 'no new Hemi full snapshots');
  assert.equal((await fs.readdir(path.join(dir, 'pi'))).filter(name => name.endsWith('.jsonl')).length, 1, 'one live native transcript throughout restarts');
});

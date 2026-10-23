import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHemiSession } from './hemi-session.mjs';
import { createRunJournal } from '../agent-runtime/run-journal.mjs';
import { createContextStore } from '../agent-runtime/context-store.mjs';

const posix = { skip: process.platform === 'win32' ? '真实 POSIX shell；Windows 进程树另需真机验证' : false };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(fn) {
  const deadline = Date.now() + 5000;
  while (!fn()) { assert.ok(Date.now() < deadline, '等待后台状态超时'); await pause(10); }
}
async function fixture(t, command, toolOptions = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-background-'));
  const requests = [], activities = [], sessions = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests.push(body);
    const text = JSON.stringify(body.messages);
    const independent = text.includes('INDEPENDENT');
    const completed = text.includes('［后台命令完成');
    const called = body.messages.some(message => message.role === 'tool');
    const delta = independent ? { content: 'OTHER_CHAT_DONE' } : completed ? { content: 'RESUMED_WITH_RESULT' }
      : called ? { content: '等待后台命令，完成后继续。' }
      : { tool_calls: [{ index: 0, id: `command-${requests.length}`, type: 'function', function: {
        name: 'bash', arguments: JSON.stringify({ command: command(dir), yield_ms: 20, ...toolOptions }),
      } }] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const chunk of [{ choices: [{ index: 0, delta, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: delta.tool_calls ? 'tool_calls' : 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } }]) {
      res.write(`data: ${JSON.stringify({ id: 'local', object: 'chat.completion.chunk', model: 'test-background', ...chunk })}\n\n`);
    }
    res.end('data: [DONE]\n\n');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const config = { modelKey: 'p/test', providerId: 'p', credentialRef: 'p', api: 'openai-completions',
    model: 'test-background', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'synthetic' };
  const journal = createRunJournal({ dir: path.join(dir, 'journal') });
  async function make(id = 'first') {
    const owner = { conversationId: id, rootRunId: `run-${id}`, generation: 1 };
    await journal.beginRoot(owner);
    let cancelled = false;
    const execution = { journal, owner, contextStore: createContextStore({ dir: path.join(dir, 'contexts') }),
      plan: { role: 'main', primary: config, allowedFallbacks: [] },
      store: { resolveStrict: async () => ({ ok: true, config }) },
      budgets: { maxRequestsPerRun: 10 }, purpose: 'main', cancelled: () => cancelled,
    };
    const session = createHemiSession({ cwd: dir, agentDir: path.join(dir, `agent-${id}`), model: config,
      accessWorkspaceDir: dir, tools: ['bash'], features: {}, executionContext: execution,
      settings: { retry: { enabled: false } },
    });
    session.on('activity', activity => activities.push({ id, ...activity }));
    sessions.push(session);
    return { session, execution, owner, cancelOwnership: () => { cancelled = true; } };
  }
  t.after(async () => {
    await Promise.all(sessions.map(s => s.abort())); sessions.forEach(s => s.dispose());
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  });
  return { dir, requests, activities, journal, make };
}

test('后台释放模型等待，独立会话可工作；完成结果在同一目标自动消费且只唤醒一次', posix, async t => {
  const f = await fixture(t, dir => `export HEMI_TEST_LABEL=display\nprintf started; until [ -f '${path.join(dir, 'release')}' ]; do sleep 0.02; done; printf BACKGROUND_ACTUAL_RESULT\n# ${'display '.repeat(50)}`,
    { description: '  检查构建状态\n并核对结果  ' });
  const { session } = await f.make();
  let settled = false;
  const result = session.prompt('BACKGROUND').then(value => { settled = true; return value; });
  await until(() => f.activities.some(a => a.phase === 'waiting-background'));
  await until(() => f.activities.some(a => a.jobs[0]?.lastOutputAt != null));
  const job = f.activities.findLast(a => a.jobs.length)?.jobs[0];
  assert.equal(job.description, '检查构建状态 并核对结果');
  assert.ok(job.lastOutputAt >= job.startedAt);
  assert.match(job.command, /# display/);
  assert.ok(job.command.length > 300, '详情保留实际命令，不能只剩环境准备行');
  assert.equal(job.commandTruncated, false);
  assert.equal(session.isBusy(), true);
  assert.equal(settled, false, '模型生成结束不等于目标已完成');
  const count = f.requests.length;
  const other = await f.make('other');
  assert.match((await other.session.prompt('INDEPENDENT')).texts.join(''), /OTHER_CHAT_DONE/);
  assert.equal(settled, false, '另一个会话不需要等待前一个后台命令');
  await pause(70);
  assert.equal(f.requests.length, count + 1, '等待期间不轮询模型');
  await writeFile(path.join(f.dir, 'release'), 'done');
  const answer = await result;
  assert.equal(answer.aborted, false);
  assert.match(answer.texts.join(''), /RESUMED_WITH_RESULT/);
  const resumed = f.requests.filter(r => JSON.stringify(r.messages).includes('［后台命令完成'));
  assert.equal(resumed.length, 1);
  assert.match(JSON.stringify(resumed[0].messages), /BACKGROUND_ACTUAL_RESULT/);
  const state = await f.journal.snapshot(), processes = Object.values(state.processes);
  assert.equal(processes.length, 1);
  assert.equal(processes[0].background, true);
  assert.equal(processes[0].state, 'finished');
  assert.equal(processes[0].owner.rootRunId, 'run-first');
  assert.equal(processes[0].description, '检查构建状态 并核对结果');
  assert.ok(processes[0].lastOutputAt >= job.lastOutputAt);
  assert.equal(f.activities.at(-1).phase, 'running');
});

test('等待后台时停止目标会清理真实进程树，旧完成不会唤醒或留下延迟副作用', posix, async t => {
  const f = await fixture(t, dir => `sleep 1; printf forbidden > '${path.join(dir, 'late')}'`);
  const { session, cancelOwnership } = await f.make();
  const pending = session.prompt('CANCEL');
  await until(() => f.activities.some(a => a.phase === 'waiting-background'));
  const job = f.activities.findLast(a => a.jobs.length)?.jobs[0];
  assert.equal(job.description, '', '没有说明的旧调用仍可执行');
  assert.equal(job.lastOutputAt, null, '尚无输出不能冒充最近有输出');
  const count = f.requests.length;
  cancelOwnership();
  await session.abort();
  assert.equal((await pending).aborted, true);
  await pause(1100);
  assert.equal(f.requests.length, count);
  assert.equal(await readFile(path.join(f.dir, 'late'), 'utf8').catch(() => null), null);
  assert.equal(Object.values((await f.journal.snapshot()).processes)[0].state, 'finished');
});

test('后台失败把真实退出码交回原目标，失效目标不再续跑', posix, async t => {
  const f = await fixture(t, () => 'sleep 0.2; printf ACTUAL_FAILURE >&2; exit 7');
  const first = await f.make();
  await first.session.prompt('FAIL');
  const resumed = f.requests.find(r => JSON.stringify(r.messages).includes('［后台命令完成'));
  assert.match(JSON.stringify(resumed.messages), /exit=7/);
  assert.match(JSON.stringify(resumed.messages), /ACTUAL_FAILURE/);
  const old = await f.make('old');
  const pending = old.session.prompt('STALE');
  await until(() => f.activities.some(a => a.id === 'old' && a.phase === 'waiting-background'));
  const count = f.requests.length;
  old.cancelOwnership();
  assert.equal((await pending).aborted, true);
  assert.equal(f.requests.length, count, '旧归属结束后不重新请求模型');
});

test('显式后台立即返回，进程硬超时仍终止并把 timed-out 交回模型', posix, async t => {
  const f = await fixture(t, () => 'sleep 30', { run_in_background: true, yield_ms: 120000, timeout_ms: 200 });
  const { session } = await f.make();
  const pending = session.prompt('TIMEOUT');
  await until(() => f.activities.some(a => a.jobs.length));
  const result = await pending;
  assert.equal(result.aborted, false);
  assert.match(JSON.stringify(f.requests.at(-1).messages), /timed-out/);
  const process = Object.values((await f.journal.snapshot()).processes)[0];
  assert.equal(process.status, 'timed-out');
  assert.equal(process.cleanupConfirmed, true);
});

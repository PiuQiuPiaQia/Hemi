// 039：codemode-policy 纯模块单测（options/路径边界/队列）——确定性时钟注入。
import assert from 'node:assert/strict';
import test from 'node:test';
import os from 'node:os';
import path from 'node:path';

import {
  CODEMODE_ALLOWED_TOOLS,
  CODEMODE_LIMITS,
  createCodemodeQueue,
  expandPath,
  freezeCodemodePolicy,
  isInsideWorkspace,
  parseScriptOptions,
  resolveScriptReadPath,
  SCOPE_DENIED,
} from './codemode-policy.mjs';

test('freezeCodemodePolicy：缺省关闭、无工作区为 null、白名单冻结', () => {
  const off = freezeCodemodePolicy({ enabled: false, workspaceDir: '/tmp/ws' });
  assert.equal(off.enabled, false);
  assert.equal(off.workspaceDir, '/tmp/ws');
  assert.deepEqual([...off.allowlist], ['read', 'web_search', 'web_extract']);
  assert.throws(() => { off.allowlist.push('bash'); });
  const noWorkspace = freezeCodemodePolicy({ enabled: true, workspaceDir: '' });
  assert.equal(noWorkspace.workspaceDir, null);
});

test('parseScriptOptions：无首行给默认；合法项钳制；非法/未知项拒绝', () => {
  const plain = parseScriptOptions('return 1;');
  assert.equal(plain.ok, true);
  assert.deepEqual(plain.options, { timeoutMs: 60_000, maxOutputTokens: 4_000 });
  assert.equal(plain.cleanedCode, 'return 1;');

  const clamped = parseScriptOptions('// @options: {"timeout_ms": 999999, "max_output_tokens": 2}\nreturn 1;');
  assert.equal(clamped.ok, true);
  assert.deepEqual(clamped.options, { timeoutMs: 60_000, maxOutputTokens: 2 });
  assert.equal(clamped.cleanedCode, 'return 1;');

  assert.equal(parseScriptOptions('// @options: {bad json}\nreturn 1;').ok, false);
  assert.equal(parseScriptOptions('// @options: {"evil": 1}\nreturn 1;').ok, false);
  // 显式非法值拒绝（不静默回落默认）。
  assert.equal(parseScriptOptions('// @options: {"timeout_ms": -5}\nreturn 1;').ok, false);
  assert.equal(parseScriptOptions('// @options: {"timeout_ms": "x"}\nreturn 1;').ok, false);
  // 非 options 首行注释不影响。
  const comment = parseScriptOptions('// 普通注释\nreturn 1;');
  assert.equal(comment.ok, true);
  assert.equal(comment.cleanedCode, '// 普通注释\nreturn 1;');
});

test('isInsideWorkspace：完整段比较，字符串前缀不越权', () => {
  assert.equal(isInsideWorkspace('/ws/a/b.txt', '/ws'), true);
  assert.equal(isInsideWorkspace('/ws', '/ws'), true);
  assert.equal(isInsideWorkspace('/ws2/a.txt', '/ws'), false); // 前缀相似但不同段
  assert.equal(isInsideWorkspace('/ws/../etc/passwd', '/ws'), false); // normalize 后由调用方保证
  assert.equal(isInsideWorkspace(null, '/ws'), false);
});

test('expandPath：~ 与相对路径按冻结 cwd 展开', () => {
  // 期望值按平台构造：win 上 path.resolve 会给出盘符绝对路径（2026-10-08
  // win 探针：写死 POSIX 期望在 win 假失败——产品行为正确）。
  assert.equal(expandPath('sub/a.txt', '/ws'), path.resolve('/ws', 'sub/a.txt'));
  assert.equal(expandPath('/abs/a.txt', '/ws'), path.normalize('/abs/a.txt'));
  assert.equal(expandPath('', '/ws'), null);
  assert.ok(expandPath('~', '/ws').startsWith(os.homedir()));
});

test('resolveScriptReadPath：越界/敏感根/失效路径拒绝并给稳定类别', async () => {
  const policy = freezeCodemodePolicy({ enabled: true, workspaceDir: '/tmp/cm-ws' });
  const inside = await resolveScriptReadPath('a.txt', policy, { realpathImpl: async (p) => p });
  assert.equal(inside.ok, true);
  assert.equal(inside.path, path.resolve('/tmp/cm-ws/a.txt'));

  const outside = await resolveScriptReadPath('/Users/demo/secrets.txt', policy, { realpathImpl: async (p) => p });
  assert.equal(outside.ok, false);
  assert.equal(outside.category, SCOPE_DENIED);

  const systemRoot = await resolveScriptReadPath('/Library/Fonts/x.ttf', policy, { realpathImpl: async (p) => p });
  assert.equal(systemRoot.ok, false);
  assert.equal(systemRoot.category, SCOPE_DENIED);

  const missing = await resolveScriptReadPath('nope.txt', policy, {
    realpathImpl: async () => { const error = new Error('nope'); error.code = 'ENOENT'; throw error; },
  });
  assert.equal(missing.ok, false);
  assert.match(missing.message, /不可读/);

  // 符号链接越界：realpath 指向工作区外即拒绝。
  const symlinkOut = await resolveScriptReadPath('link.txt', policy, { realpathImpl: async () => '/etc/hosts' });
  assert.equal(symlinkOut.ok, false);

  // 无冻结工作区：一律拒绝（不以家目录回落形成脚本授权）。
  const noWs = freezeCodemodePolicy({ enabled: true, workspaceDir: null });
  const refused = await resolveScriptReadPath('a.txt', noWs, { realpathImpl: async (p) => p });
  assert.equal(refused.ok, false);
  assert.match(refused.message, /没有冻结工作区/);
});

test('createCodemodeQueue：脚本互斥、FIFO 唤醒、取消出队', async () => {
  const queue = createCodemodeQueue();
  await queue.acquireScript('s1');
  assert.equal(queue.scriptRunning, true);
  let secondStarted = false;
  const second = queue.acquireScript('s2').then(() => { secondStarted = true; });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(secondStarted, false); // s1 在跑，s2 排队
  const s3Controller = new AbortController();
  const third = queue.acquireScript('s3', s3Controller.signal);
  third.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 5));
  s3Controller.abort(); // 取消只影响 s3，不动 s2
  await assert.rejects(() => third, /脚本已取消/);
  queue.releaseScript(); // s1 让位 → FIFO 唤醒 s2
  await second;
  assert.equal(secondStarted, true);
  assert.equal(queue.scriptRunning, true);
  queue.releaseScript();
  assert.equal(queue.scriptRunning, false);
});

test('createCodemodeQueue：子调用并发上限与释放恢复', async () => {
  const queue = createCodemodeQueue({ ...CODEMODE_LIMITS, concurrentChildCalls: 2 });
  await queue.acquireScript('s1');
  const release1 = await queue.acquireChild();
  const release2 = await queue.acquireChild();
  let third = false;
  const thirdWait = queue.acquireChild().then((release) => { third = true; return release; });
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(third, false);
  assert.equal(queue.pendingChildWaiters, 1);
  release1();
  const release3 = await thirdWait;
  assert.equal(third, true);
  release2();
  release3();
  queue.releaseScript();
});

test('createCodemodeQueue：尝试计数到 32 后拒绝（第 33 次触发取消整个 batch）', async () => {
  const queue = createCodemodeQueue();
  await queue.acquireScript('s1');
  for (let i = 0; i < CODEMODE_LIMITS.maxAttemptsPerScript; i += 1) {
    assert.equal(queue.consumeAttempt(), true);
  }
  assert.equal(queue.consumeAttempt(), false);
  queue.releaseScript();
  // 新脚本重新计数。
  await queue.acquireScript('s2');
  assert.equal(queue.consumeAttempt(), true);
});

test('createCodemodeQueue：剩余墙钟随确定性时钟衰减，不重新拿完整 60s', async () => {
  let clock = 1_000;
  const queue = createCodemodeQueue(CODEMODE_LIMITS, { now: () => clock });
  await queue.acquireScript('s1');
  assert.equal(queue.remainingMs(), CODEMODE_LIMITS.scriptWallClockMs);
  clock += 30_000;
  assert.equal(queue.remainingMs(), 30_000);
  clock += 60_000;
  assert.equal(queue.remainingMs(), 0);
});

test('CODEMODE_ALLOWED_TOOLS：白名单不含任何写/执行类工具', () => {
  assert.deepEqual([...CODEMODE_ALLOWED_TOOLS], ['read', 'web_search', 'web_extract']);
});

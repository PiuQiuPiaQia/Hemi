import assert from 'node:assert/strict';
import test from 'node:test';

import { formatSshTarget, isValidPort, resolveRemoteTarget } from './ssh-target.mjs';

test('071 resolveRemoteTarget：无端口保持原样（Host 别名走 SSH 配置）', () => {
  assert.deepEqual(resolveRemoteTarget({ host: 'devbox', port: '' }), { ok: true, target: 'devbox', port: null });
  assert.deepEqual(resolveRemoteTarget({ host: 'deploy@example.com', port: null }), {
    ok: true, target: 'deploy@example.com', port: null,
  });
});

test('071 resolveRemoteTarget：端口框 → ssh://user@host:port', () => {
  assert.deepEqual(resolveRemoteTarget({ host: 'devbox', port: '2222' }), {
    ok: true, target: 'ssh://devbox:2222', port: 2222,
  });
  assert.deepEqual(resolveRemoteTarget({ host: 'deploy@example.com', port: 22022 }), {
    ok: true, target: 'ssh://deploy@example.com:22022', port: 22022,
  });
});

test('071 resolveRemoteTarget：服务器框里的嵌入式端口也认（user@host:22）', () => {
  assert.deepEqual(resolveRemoteTarget({ host: 'deploy@example.com:2222', port: null }), {
    ok: true, target: 'ssh://deploy@example.com:2222', port: 2222,
  });
  assert.deepEqual(resolveRemoteTarget({ host: 'example.com:22' }), {
    ok: true, target: 'ssh://example.com:22', port: 22,
  });
});

test('071 resolveRemoteTarget：端口框优先于嵌入式端口', () => {
  assert.deepEqual(resolveRemoteTarget({ host: 'deploy@example.com:2222', port: '3333' }), {
    ok: true, target: 'ssh://deploy@example.com:3333', port: 3333,
  });
});

test('071 resolveRemoteTarget：ssh:// 输入归一到同一目标串', () => {
  assert.deepEqual(resolveRemoteTarget({ host: 'ssh://deploy@example.com:2222', port: null }), {
    ok: true, target: 'ssh://deploy@example.com:2222', port: 2222,
  });
  assert.deepEqual(resolveRemoteTarget({ host: 'ssh://example.com', port: '2222' }), {
    ok: true, target: 'ssh://example.com:2222', port: 2222,
  });
  // ssh:// 后带路径：不接受。
  assert.equal(resolveRemoteTarget({ host: 'ssh://example.com/workspace' }).ok, false);
});

test('071 resolveRemoteTarget：IPv6 方括号形式可用，裸 IPv6 配端口如实报错', () => {
  assert.deepEqual(resolveRemoteTarget({ host: 'user@[2001:db8::1]:2222', port: null }), {
    ok: true, target: 'ssh://user@[2001:db8::1]:2222', port: 2222,
  });
  assert.deepEqual(resolveRemoteTarget({ host: '[2001:db8::1]', port: '22' }), {
    ok: true, target: 'ssh://[2001:db8::1]:22', port: 22,
  });
  // 裸 IPv6 不带端口：原样交给 ssh（CLI 直接支持）。
  assert.deepEqual(resolveRemoteTarget({ host: 'user@2001:db8::1', port: null }), {
    ok: true, target: 'user@2001:db8::1', port: null,
  });
  // 裸 IPv6 配端口：ssh:// 里冒号有歧义——引导加方括号。
  const bracket = resolveRemoteTarget({ host: 'user@2001:db8::1', port: '22' });
  assert.equal(bracket.ok, false);
  assert.match(bracket.reason, /方括号/);
});

test('071 resolveRemoteTarget：端口范围校验（0 / 65536 / 非数字）', () => {
  for (const bad of ['0', '65536', '99999', 'abc', '-1']) {
    const result = resolveRemoteTarget({ host: 'devbox', port: bad });
    assert.equal(result.ok, false, `port=${bad}`);
    assert.match(result.reason, /1–65535/);
  }
  // 嵌入式端口超范围同样报错。
  assert.equal(resolveRemoteTarget({ host: 'devbox:99999' }).ok, false);
  // 合法边界。
  assert.deepEqual(resolveRemoteTarget({ host: 'devbox', port: '1' }), { ok: true, target: 'ssh://devbox:1', port: 1 });
  assert.deepEqual(resolveRemoteTarget({ host: 'devbox', port: '65535' }), {
    ok: true, target: 'ssh://devbox:65535', port: 65535,
  });
});

test('071 isValidPort：字符串与数字都收', () => {
  assert.equal(isValidPort('22'), true);
  assert.equal(isValidPort(22), true);
  assert.equal(isValidPort('0'), false);
  assert.equal(isValidPort('65536'), false);
  assert.equal(isValidPort('2.5'), false);
  assert.equal(isValidPort(''), false);
});

test('071 formatSshTarget：ssh:// 目标折回可读形式（显示用）', () => {
  assert.equal(formatSshTarget('ssh://deploy@example.com:2222'), 'deploy@example.com:2222');
  assert.equal(formatSshTarget('ssh://example.com'), 'example.com');
  assert.equal(formatSshTarget('ssh://[2001:db8::1]:22'), '[2001:db8::1]:22');
  assert.equal(formatSshTarget('devbox'), 'devbox');
  assert.equal(formatSshTarget(null), '');
});

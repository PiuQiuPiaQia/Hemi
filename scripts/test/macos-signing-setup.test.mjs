import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { addTrustedCertInvocation, usesAdminTrustDomain } from '../lib/macos-signing.mjs';

const KEYCHAIN = '/tmp/hemi-test/hemi-signing.keychain-db';
const CERT = '/tmp/hemi-test/signer.cer';
const HOSTED = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted' };

test('本地信任保持在当前用户域：不经 sudo、不带管理员域 -d', () => {
  const { admin, command, args } = addTrustedCertInvocation({ keychain: KEYCHAIN, certificate: CERT });
  assert.equal(admin, false);
  assert.equal(command, '/usr/bin/security');
  assert.deepEqual(args, ['add-trusted-cert', '-r', 'trustRoot', '-p', 'codeSign', '-k', KEYCHAIN, CERT]);
});

test('CI 信任经 sudo -n 写管理员域：-d 一次到位，证书进指定钥匙串', () => {
  const { admin, command, args } = addTrustedCertInvocation({ keychain: KEYCHAIN, certificate: CERT, admin: true });
  assert.equal(admin, true);
  assert.equal(command, 'sudo');
  assert.deepEqual(args, ['-n', '/usr/bin/security', 'add-trusted-cert', '-d', '-r', 'trustRoot', '-p', 'codeSign', '-k', KEYCHAIN, CERT]);
});

test('信任参数仍以 trustRoot + codeSign 收窄，仅限这一张证书', () => {
  for (const admin of [false, true]) {
    const { args } = addTrustedCertInvocation({ keychain: KEYCHAIN, certificate: CERT, admin });
    assert.ok(args.includes('-r') && args[args.indexOf('-r') + 1] === 'trustRoot');
    assert.ok(args.includes('-p') && args[args.indexOf('-p') + 1] === 'codeSign');
    assert.equal(args[args.indexOf('-k') + 1], KEYCHAIN);
    assert.equal(args.at(-1), CERT);
  }
});

test('缺少目标钥匙串或证书时拒绝构造信任命令', () => {
  assert.throws(() => addTrustedCertInvocation({ certificate: CERT }), /keychain/);
  assert.throws(() => addTrustedCertInvocation({ keychain: KEYCHAIN }), /certificate/);
  assert.throws(() => addTrustedCertInvocation(), /keychain|certificate/);
});

test('管理员域仅限 --ci 且 GitHub 托管 runner（表驱动）', () => {
  const cases = [
    [{ ci: true, env: HOSTED }, true, '托管 runner 的 --ci 走管理员域'],
    [{ ci: true, env: { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'self-hosted' } }, false, 'self-hosted 保持用户域'],
    [{ ci: true, env: { GITHUB_ACTIONS: 'true' } }, false, '缺 RUNNER_ENVIRONMENT 不升级'],
    [{ ci: true, env: {} }, false, '非 Actions 环境不升级'],
    [{ ci: false, env: HOSTED }, false, '仅托管环境、无 --ci 不升级'],
    [{}, false, '全缺省不升级'],
  ];
  for (const [input, expected, message] of cases) assert.equal(usesAdminTrustDomain(input), expected, message);
});

// 静态接线检查：不执行任何签名/信任命令，只确认 admin 域由 policy helper
// 判定（仅 --ci 不足以切换）、release workflow 撤销同一管理员域信任且清理
// 步骤错误可见、互不阻断。
test('setup 脚本的管理员域由 policy helper 判定', () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../setup-macos-signing.mjs'), 'utf8');
  assert.match(source, /admin:\s*usesAdminTrustDomain\(\{\s*ci:\s*args\.has\('--ci'\),\s*env:\s*process\.env\s*\}\)/);
  assert.ok(!/admin:\s*args\.has\('--ci'\)/.test(source), '仅凭 --ci 不得切换管理员域（本地 verify 也以 --ci 运行）');
  assert.match(source, /sudo',\s*\['-n',\s*'\/usr\/bin\/security',\s*'unlock-keychain'/, '管理员域写入前需为 root 会话解锁钥匙串');
  assert.ok(!/security',\s*\['add-trusted-cert/.test(source), '信任命令必须统一经 helper 构造');
});

test('release workflow 三个独立有界清理阶段，LF/CRLF checkout 均成立', () => {
  const raw = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/release.yml'), 'utf8');
  const expect = (text, lineEnding) => {
    const stepOf = marker => {
      const at = text.indexOf(marker);
      assert.ok(at >= 0, `缺失清理阶段 ${marker}（${lineEnding}）`);
      const start = text.lastIndexOf('\n      - name:', at);
      const end = text.indexOf('\n      - name:', at);
      return text.slice(start + 1, end === -1 ? undefined : end);
    };
    for (const stage of ['revoke-trust', 'delete-keychain', 'remove-directory']) {
      const step = stepOf(`node scripts/cleanup-macos-signing.mjs ${stage}`);
      assert.match(step, /if: always\(\)/, `${stage} 必须始终执行（${lineEnding}）`);
      assert.match(step, /timeout-minutes: 3/, `${stage} 必须有 step 上限（${lineEnding}）`);
      assert.match(step, /HEMI_MAC_SIGNING_DIR: \$\{\{ runner\.temp \}\}\/hemi-build-signing/, `${stage} 必须显式传目录（${lineEnding}）`);
    }
    const offenders = text.split(/\r?\n/).filter(line => line.includes('remove-trusted-cert') && !/^\s*#/.test(line));
    assert.deepEqual(offenders, [], `内联 security 命令必须全部移入脚本（${lineEnding}）`);
  };
  expect(raw.replace(/\r?\n/g, '\n'), 'LF');
  expect(raw.replace(/\r?\n/g, '\r\n'), 'CRLF');
});

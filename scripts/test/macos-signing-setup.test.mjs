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

test('release workflow 清理：always 撤销、错误可见、后续清理不跳过', () => {
  const workflow = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.github/workflows/release.yml'), 'utf8');
  const cleanup = /- name: 清理临时签名钥匙串与信任设置[\s\S]*?(?=\n      - name:)/.exec(workflow)?.[0] ?? '';
  assert.match(cleanup, /if: always\(\)/);
  assert.match(cleanup, /if ! sudo -n security remove-trusted-cert -d build\/macos-signing\.cer; then\n\s+echo "::error::[^"]*"\n\s+cleanup_status=1\n\s+fi/, '信任撤销失败必须输出 ::error:: 并计入状态');
  assert.match(cleanup, /security delete-keychain "\$HEMI_MAC_SIGNING_DIR\/hemi-signing\.keychain-db" \|\| cleanup_status=1/, '钥匙串删除失败仍计入状态');
  assert.match(cleanup, /rm -rf "\$HEMI_MAC_SIGNING_DIR" \|\| cleanup_status=1/, '私密目录清理失败仍计入状态');
  assert.match(cleanup, /exit \$cleanup_status/, '清理步骤以累计状态收口');
  assert.ok(cleanup.indexOf('remove-trusted-cert') < cleanup.indexOf('delete-keychain') && cleanup.indexOf('delete-keychain') < cleanup.indexOf('rm -rf'), '撤销失败后仍继续钥匙串与目录清理');
  assert.ok(!/remove-trusted-cert[^\n]*\|\| true/.test(cleanup), '不得用 || true 吞掉信任撤销结果');
  assert.ok(!/^\s*security remove-trusted-cert build\/macos-signing\.cer/m.test(cleanup), '不应清理未使用的用户域信任');
});

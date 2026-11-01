#!/usr/bin/env node
// 044 · 无私钥 CI preflight：只用仓库公开证书验证「授予 trustRoot → 生产撤销
// （deny + 双证据）→ 幂等」全链路。不引用任何 release secrets、不生成身份；
// 临时 keychain 的密码是公开占位符（keychain 内只有公证书，无任何私钥材料）。
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { certificatePath, signingFingerprint } from './lib/macos-signing.mjs';
import { parseAdminTrustPolicies, resolveCleanupContext, runCleanupStage, watchdogRun } from './cleanup-macos-signing.mjs';

export const PUBLIC_PROBE_KEYCHAIN_PASSWORD = 'fake-public-probe';

export function runTrustRevocationPreflight({
  env = process.env,
  run = watchdogRun(),
  revokeStage = log => runCleanupStage('revoke-trust', { env, log }),
  cleanupStage = (stage, log) => runCleanupStage(stage, { env, log }),
  parseTrustSettings = parseAdminTrustPolicies,
  log = () => {},
} = {}) {
  const guard = resolveCleanupContext({ env });
  if (!guard.ok) {
    log(`[preflight] 拒绝: ${guard.reason}`);
    return { ok: false, failures: 1, reason: guard.reason };
  }
  const directory = guard.directory;
  const keychain = path.join(directory, 'hemi-signing.keychain-db');
  const sha1 = signingFingerprint().toLowerCase();
  let failures = 0;
  const check = (name, ok, detail = '') => {
    log(`[preflight] ${ok ? 'PASS' : 'FAIL'}: ${name}${detail ? ` — ${detail}` : ''}`);
    if (!ok) failures += 1;
    return ok;
  };
  try {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    check('创建只含公开证书的临时 keychain（密码为公开占位 fake-public-probe，无私钥材料）',
      run('/usr/bin/security', ['create-keychain', '-p', PUBLIC_PROBE_KEYCHAIN_PASSWORD, keychain]).ok);
    check('设置临时 keychain 锁定超时',
      run('/usr/bin/security', ['set-keychain-settings', '-lut', '21600', keychain]).ok);
    check('解锁当前用户的公开证书 keychain',
      run('/usr/bin/security', ['unlock-keychain', '-p', PUBLIC_PROBE_KEYCHAIN_PASSWORD, keychain]).ok);
    check('与生产一致，为 root 会话解锁公开证书 keychain',
      run('/usr/bin/security', ['unlock-keychain', '-p', PUBLIC_PROBE_KEYCHAIN_PASSWORD, keychain], { sudo: true }).ok);
    check('以生产相同路径授予 trustRoot',
      run('/usr/bin/security', ['add-trusted-cert', '-d', '-r', 'trustRoot', '-p', 'codeSign', '-k', keychain, certificatePath], { sudo: true }).ok);
    const granted = run('/usr/bin/security', ['verify-cert', '-c', certificatePath, '-p', 'codeSign', '-N', '-L']);
    check('授予后普通用户 verify-cert 信任成功', granted.ok && !granted.timedOut, granted.ok ? '' : granted.detail);
    const plistBefore = path.join(directory, 'admin-trust-settings-before.plist');
    check('导出授予后的管理员信任设置',
      run('/usr/bin/security', ['trust-settings-export', '-d', plistBefore]).ok);
    const before = parseTrustSettings({ plistPath: plistBefore, sha1 });
    check('授予后管理员域存在 codeSign allow 记录',
      before.some(p => p.policy === 'codeSign' && (p.result === 1 || p.result === 2)), JSON.stringify(before));
    check('生产 revoke-trust 阶段成功（deny 覆盖 + 状态/实际双证据）', revokeStage(log).ok);
    check('重复 revoke-trust 幂等成功', revokeStage(log).ok);
  } finally {
    // 始终清理：先删临时 keychain，再删整个临时身份目录；各自独立计失败。
    if (!cleanupStage('delete-keychain', log).ok) failures += 1;
    if (!cleanupStage('remove-directory', log).ok) failures += 1;
  }
  return { ok: failures === 0, failures };
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const result = runTrustRevocationPreflight({ log: line => console.log(line) });
  process.exit(result.ok ? 0 : 1);
}

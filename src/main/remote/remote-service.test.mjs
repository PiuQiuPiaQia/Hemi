// 049 · remote-service 密码持久化单测（注入式假 crypto：base64 当加密）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createRemoteService } from './remote-service.mjs';
import { setupFakeSsh } from './fake-ssh.mjs';

const base = mkdtempSync(path.join(os.tmpdir(), 'h49-svc-'));
const fake = setupFakeSsh(base);
process.env.HEMI_SSH_BIN = fake.sshBin;
process.env.H49_FAKE_SSH_SANDBOX = base;
const NOT_POSIX = process.platform === 'win32' ? '假 ssh 与 SSH_ASKPASS 助手都是 sh 脚本：win 起不来（密码登录 win 未实现，win 已知限制）' : false;
const fakeCrypto = {
  encrypt: (text) => Buffer.from(String(text), 'utf8').toString('base64'),
  decrypt: (blob) => Buffer.from(String(blob), 'base64').toString('utf8') || null,
};

test.after(() => {
  delete process.env.HEMI_SSH_BIN;
  try { rmSync(base, { recursive: true, force: true }); } catch {}
});

function newService(dir, crypto = fakeCrypto) {
  const ud = dir ?? mkdtempSync(path.join(os.tmpdir(), 'h49-svc-ud-'));
  return { ud, svc: createRemoteService({ userDataDir: ud, crypto }) };
}

test('记住密码：加密落盘（0600）＋重启恢复到内存池；不勾只进内存', () => {
  const { ud, svc } = newService();
  svc.rememberPassword('devbox', 'pw-1', { remember: true });
  const file = path.join(ud, 'remote-passwords.json');
  assert.ok(existsSync(file), '存档已落盘');
  // 0600 是 POSIX 权限位：win 的 chmod 只映射只读位，断言按平台跳过（其余逻辑 win 照跑）。
  if (process.platform !== 'win32') assert.equal(statSync(file).mode & 0o777, 0o600);
  const raw = JSON.parse(readFileSync(file, 'utf8'));
  assert.ok(raw.hosts.devbox, '密文条目在场');
  assert.ok(!JSON.stringify(raw).includes('pw-1'), '明文不进存档');

  // 「重启」：新建服务读同一 userData → 密码自动回池。
  const reborn = createRemoteService({ userDataDir: ud, crypto: fakeCrypto });
  assert.equal(reborn.hasPassword('devbox'), true);
  reborn.close();

  // 不勾记住：只在内存，不写盘。
  const { ud: ud2, svc: svc2 } = newService();
  svc2.rememberPassword('host2', 'pw-2', { remember: false });
  assert.equal(svc2.hasPassword('host2'), true);
  assert.ok(!existsSync(path.join(ud2, 'remote-passwords.json')), '不勾不落盘');
  svc.close(); svc2.close();
});

test('改用不记住：同 host 从持久化名单移除并重写存档；forget 清盘', () => {
  const { ud, svc } = newService();
  svc.rememberPassword('devbox', 'first', { remember: true });
  svc.rememberPassword('devbox', 'second', { remember: false });
  const raw = JSON.parse(readFileSync(path.join(ud, 'remote-passwords.json'), 'utf8'));
  assert.ok(!raw.hosts.devbox, '条目已从存档移除（本次仍在内存）');
  assert.equal(svc.hasPassword('devbox'), true);
  const reborn = createRemoteService({ userDataDir: ud, crypto: fakeCrypto });
  assert.equal(reborn.hasPassword('devbox'), false, '重启后不再恢复');
  // forget：内存＋存档双清。
  svc.rememberPassword('devbox', 'third', { remember: true });
  svc.forgetPassword('devbox');
  assert.equal(svc.hasPassword('devbox'), false);
  const raw2 = JSON.parse(readFileSync(path.join(ud, 'remote-passwords.json'), 'utf8'));
  assert.ok(!raw2.hosts.devbox);
  reborn.close(); svc.close();
});

test('钥匙串换机解不开：丢弃该条不炸、其余条目照常恢复；存档损坏按无存档处理', () => {
  const { ud, svc } = newService();
  svc.rememberPassword('a-host', 'pa', { remember: true });
  svc.rememberPassword('b-host', 'pb', { remember: true });
  svc.close();
  // 换一把「钥匙」：a-host 的密文解不开，b-host 是新钥匙加密的……直接模拟：
  // 用一个只认自己 blob 的 crypto 重启。
  let round = 0;
  const pickyCrypto = {
    encrypt: fakeCrypto.encrypt,
    decrypt: (blob) => {
      round += 1;
      // 第 1 条（a-host）解不开，第 2 条（b-host）正常。
      return round === 1 ? null : fakeCrypto.decrypt(blob);
    },
  };
  const reborn = createRemoteService({ userDataDir: ud, crypto: pickyCrypto });
  assert.equal(reborn.hasPassword('a-host'), false, '解不开的丢弃');
  assert.equal(reborn.hasPassword('b-host'), true, '其余照常恢复');
  reborn.close();

  // 存档损坏：按无存档起步，不炸。
  writeFileSync(path.join(ud, 'remote-passwords.json'), '{broken');
  const reborn2 = createRemoteService({ userDataDir: ud, crypto: fakeCrypto });
  assert.equal(reborn2.hasPassword('b-host'), false);
  reborn2.close();
});

test('持久化密码驱动 SSH_ASKPASS：重启后的服务直接连「只认密码」的服务器', { skip: NOT_POSIX }, async () => {
  fake.setMode('require-password');
  process.env.H49_FAKE_REQUIRE_PASSWORD = 'saved-pw';
  const { ud, svc } = newService();
  svc.rememberPassword('devbox', 'saved-pw', { remember: true });
  svc.close();
  // 重启：新服务从存档恢复，probe 不带显式密码也应通过。
  const reborn = createRemoteService({ userDataDir: ud, crypto: fakeCrypto });
  const probed = await reborn.probeWorkspace({ host: 'devbox', dir: fake.root });
  assert.equal(probed.ok, true, `重启后凭存档密码登录：${JSON.stringify(probed).slice(0, 120)}`);
  reborn.close();
  fake.setMode('');
  delete process.env.H49_FAKE_REQUIRE_PASSWORD;
});

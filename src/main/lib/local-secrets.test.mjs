import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLocalSecretStorage, hasSupportedSecret, isLocalCiphertext } from './local-secrets.mjs';

function fixture(t) {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'hemi-local-secrets-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, storage: createLocalSecretStorage({ directory }) };
}

test('本地加密使用随机 IV，重启可解且状态查询不创建文件', t => {
  const { directory, storage } = fixture(t);
  assert.equal(storage.isEncryptionAvailable(), true);
  assert.deepEqual(readdirSync(directory), []);
  const a = storage.encryptString('sk-local-中文');
  const b = storage.encryptString('sk-local-中文');
  assert.equal(isLocalCiphertext(a), true);
  assert.notDeepEqual(a, b);
  assert.equal(a.includes(Buffer.from('sk-local-中文')), false);
  const restarted = createLocalSecretStorage({ directory });
  assert.equal(restarted.decryptString(a), 'sk-local-中文');
  assert.equal(restarted.decryptString(b), 'sk-local-中文');
  assert.equal(restarted.decryptString(storage.encryptString('')), '');
  if (process.platform !== 'win32') {
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.equal(statSync(path.join(directory, 'key-v1')).mode & 0o777, 0o600);
  }
});

test('不支持旧密文且不读取外部存储；用户可以直接重新配置', t => {
  const { directory, storage } = fixture(t);
  const old = Buffer.from('v10-synthetic-old-ciphertext');
  assert.equal(hasSupportedSecret(storage, old.toString('base64')), false);
  assert.throws(() => storage.decryptString(old), /重新配置/);
  assert.deepEqual(readdirSync(directory), []);
  const replacement = storage.encryptString('replacement-key');
  assert.equal(storage.decryptString(replacement), 'replacement-key');
  assert.throws(() => storage.decryptString(old), /重新配置/);
});

test('只有完整的当前格式才被报告为已保存，状态查询不解密', t => {
  const { directory, storage } = fixture(t);
  const valid = storage.encryptString('key');
  assert.equal(hasSupportedSecret(storage, valid.toString('base64')), true);
  for (const value of ['', 'bad-base64', valid.subarray(0, 12).toString('base64')]) {
    assert.equal(hasSupportedSecret(storage, value), false);
  }
  const future = Buffer.from(valid); future[5] += 1;
  assert.equal(hasSupportedSecret(storage, future.toString('base64')), false);
  rmSync(path.join(directory, 'key-v1'));
  assert.equal(hasSupportedSecret(storage, valid.toString('base64')), true, '状态查询不读取本地加密钥匙');
});

test('密文篡改/未知版本直接失败', t => {
  const { storage } = fixture(t);
  const original = storage.encryptString('secret');
  for (const index of [5, 6, 18, original.length - 1]) {
    const tampered = Buffer.from(original); tampered[index] ^= 1;
    assert.throws(() => storage.decryptString(tampered));
  }
});

test('本地密钥缺失/被替换时不生成替代钥匙，恢复后仍可读取已有凭据', t => {
  const { directory, storage } = fixture(t);
  const local = storage.encryptString('local-key');
  const keyPath = path.join(directory, 'key-v1');
  renameSync(keyPath, `${keyPath}.backup`);
  assert.throws(() => storage.decryptString(local), /密钥文件缺失或损坏/);
  assert.throws(() => storage.encryptString('replacement'), /密钥文件缺失/);
  writeFileSync(keyPath, Buffer.alloc(32, 1));
  assert.throws(() => storage.encryptString('replacement'), /密钥文件缺失或损坏/);
  rmSync(keyPath); renameSync(`${keyPath}.backup`, keyPath);
  assert.equal(storage.decryptString(local), 'local-key');
});

test('废弃的迁移记录不再被读取或影响本地配置', t => {
  const { directory, storage } = fixture(t);
  const obsolete = path.join(directory, 'legacy-v1.json');
  writeFileSync(obsolete, '{broken-obsolete-cache');
  const local = storage.encryptString('new-key');
  assert.equal(storage.decryptString(local), 'new-key');
  assert.throws(() => storage.decryptString(Buffer.from('v10-obsolete')), /重新配置/);
  assert.equal(readFileSync(obsolete, 'utf8'), '{broken-obsolete-cache');
});

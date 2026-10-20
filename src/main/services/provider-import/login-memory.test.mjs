import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createLoginStore, loginSiteKey } from './login-store.mjs';
import { createLoginMemory } from './login-memory.mjs';

const ORIGIN = 'https://login.example.com';
const OTHER = 'https://other.example.com';
const LOAD = 'hemi-provider-login:load';
const CAPTURE = 'hemi-provider-login:submitted';
const identity = { username: 'alice', userId: '7' };

function cryptoStub() {
  const key = randomBytes(32);
  return {
    isEncryptionAvailable: () => true,
    encryptString(plain) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), data]);
    },
    decryptString(data) {
      const cipher = createDecipheriv('aes-256-gcm', key, data.subarray(0, 12));
      cipher.setAuthTag(data.subarray(12, 28));
      return Buffer.concat([cipher.update(data.subarray(28)), cipher.final()]).toString('utf8');
    },
  };
}
async function setup(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'hemi-login-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const safeStorage = cryptoStub();
  const store = createLoginStore({ dirPath: dir, safeStorage, ...options });
  return { dir, store, safeStorage };
}
function bridge(store) {
  const ipc = new EventEmitter();
  const handlers = new Map();
  ipc.handle = (key, fn) => handlers.set(key, fn);
  ipc.removeHandler = (key) => handlers.delete(key);
  const contents = { ipc, mainFrame: { url: `${ORIGIN}/login` }, loginFormVisible: false, async executeJavaScript() { return this.loginFormVisible; } };
  const cookies = new EventEmitter();
  let jar = [];
  cookies.get = async () => jar;
  cookies.set = async (value) => { jar.push({ ...value, domain: new URL(value.url).hostname, session: true }); };
  const errors = [];
  const memory = createLoginMemory({ contents, session: { cookies }, siteOrigin: ORIGIN, store, onError: (error) => errors.push(error) });
  const event = () => ({ sender: contents, senderFrame: contents.mainFrame });
  return { memory, contents, handlers, cookies, errors, event, setJar: (next) => { jar = next; }, capture: (data, e = event()) => ipc.emit(CAPTURE, e, data) };
}

test('登录档案：重读解密、实际文件无明文、0600、站点/协议/端口隔离与并发更新', async (t) => {
  const { dir, store, safeStorage } = await setup(t);
  await Promise.all([
    store.update(ORIGIN, { credentials: { username: 'alice', password: 'unique-password-秘密' } }),
    store.update(ORIGIN, { sessionCookies: [{ name: 'session', value: 'unique-cookie' }] }),
  ]);
  const file = path.join(dir, `${loginSiteKey(ORIGIN)}.json`);
  const raw = await readFile(file, 'utf8');
  for (const secret of ['alice', 'unique-password', 'unique-cookie', ORIGIN]) assert.ok(!raw.includes(secret));
  if (process.platform !== 'win32') assert.equal((await stat(file)).mode & 0o777, 0o600);
  const restored = createLoginStore({ dirPath: dir, safeStorage });
  assert.equal((await restored.read(ORIGIN)).credentials.password, 'unique-password-秘密');
  assert.equal((await restored.read(ORIGIN)).sessionCookies[0].value, 'unique-cookie');
  assert.deepEqual(await restored.read(OTHER), { origin: OTHER });
  assert.notEqual(loginSiteKey(ORIGIN), loginSiteKey('http://login.example.com'));
  assert.notEqual(loginSiteKey(ORIGIN), loginSiteKey(`${ORIGIN}:8443`));
  assert.throws(() => loginSiteKey(`${ORIGIN}/path`));
  await writeFile(path.join(dir, `${loginSiteKey(OTHER)}.json`), raw);
  await assert.rejects(restored.read(OTHER), /ORIGIN_MISMATCH/);
});

test('加密不可用/basic_text 或写入失败：不落明文；损坏档案不覆盖；写队列可重试', async (t) => {
  for (const safeStorage of [{ isEncryptionAvailable: () => false }, { ...cryptoStub(), getSelectedStorageBackend: () => 'basic_text' }]) {
    const { store, dir } = await setup(t, { safeStorage });
    await assert.rejects(store.update(ORIGIN, { credentials: { password: 'secret' } }));
    assert.deepEqual(await readdir(dir), []);
  }
  let fail = true;
  const { store, dir } = await setup(t, { fs: { writeFile: async (...args) => { if (fail) throw new Error('disk-full'); return writeFile(...args); } } });
  await assert.rejects(store.update(ORIGIN, { credentials: { password: 'secret' } }), /disk-full/);
  fail = false;
  await store.update(ORIGIN, { credentials: { password: 'new-secret' } });
  const file = path.join(dir, `${loginSiteKey(ORIGIN)}.json`);
  await writeFile(file, '{broken');
  await assert.rejects(store.update(ORIGIN, { credentials: { password: 'replace' } }));
  assert.equal(await readFile(file, 'utf8'), '{broken');
});

test('表单提交＋身份核验后才保存；失败密码、旧 Cookie、异账号不覆盖；成功新密码更新', async (t) => {
  const { store } = await setup(t);
  const b = bridge(store);
  await b.memory.restore();
  b.capture({ username: 'alice', password: 'first' });
  assert.equal((await store.read(ORIGIN)).credentials, undefined);
  await b.memory.confirmLogin(identity);
  assert.equal((await store.read(ORIGIN)).credentials.password, 'first');
  b.capture({ username: 'alice', password: 'wrong' });
  b.contents.loginFormVisible = true;
  await b.memory.confirmLogin(identity);
  assert.equal((await store.read(ORIGIN)).credentials.password, 'first');
  b.contents.loginFormVisible = false;
  b.capture({ username: 'bob', password: 'different-account' });
  await b.memory.confirmLogin(identity);
  assert.equal((await store.read(ORIGIN)).credentials.password, 'first');
  b.capture({ username: 'alice', password: 'updated' });
  await b.memory.confirmLogin(identity);
  assert.equal((await store.read(ORIGIN)).credentials.password, 'updated');
  assert.equal(b.errors.length, 0);
  await b.memory.dispose();
});

test('登录桥拒绝跨站、子 frame、伪 sender 和迟到回复；回收撤监听与草稿', async (t) => {
  const { store } = await setup(t);
  await store.update(ORIGIN, { credentials: { username: 'alice', password: 'secret' } });
  const b = bridge(store);
  const load = b.handlers.get(LOAD);
  assert.equal((await load(b.event())).password, 'secret');
  for (const event of [{ ...b.event(), sender: {} }, { ...b.event(), senderFrame: { url: ORIGIN } }]) {
    assert.equal(await load(event), null);
    b.capture({ username: 'alice', password: 'stolen' }, event);
  }
  b.contents.mainFrame.url = OTHER;
  assert.equal(await load(b.event()), null);
  b.capture({ username: 'alice', password: 'stolen' });
  b.contents.mainFrame.url = ORIGIN;
  await b.memory.confirmLogin(identity);
  assert.equal((await store.read(ORIGIN)).credentials.password, 'secret');
  await b.memory.dispose();
  assert.equal(b.handlers.size, 0);
  assert.equal(b.contents.ipc.listenerCount(CAPTURE), 0);
  assert.equal(await load(b.event()), null);
  let resolveRead;
  const delayedStore = { read: () => new Promise((resolve) => { resolveRead = resolve; }) };
  const delayed = bridge(delayedStore);
  const reply = delayed.handlers.get(LOAD)(delayed.event());
  delayed.contents.mainFrame.url = OTHER;
  resolveRead({ credentials: { username: 'alice', password: 'secret' } });
  assert.equal(await reply, null, '读密文期间发生跨站导航，迟到回复不得携带密码');
});

test('无过期 Cookie 加密恢复，跨域/持久 Cookie 不备份，站点删除后不复活', async (t) => {
  const { store } = await setup(t);
  const cookie = { session: true, name: 'session', value: 's7', domain: 'login.example.com', path: '/', hostOnly: true };
  await store.update(ORIGIN, { sessionCookies: [cookie, { ...cookie, domain: 'evil.example.net' }, { ...cookie, session: false }] });
  const b = bridge(store);
  await b.memory.restore();
  assert.equal((await b.cookies.get({})).length, 1);
  await b.memory.flush();
  assert.equal((await store.read(ORIGIN)).sessionCookies.length, 1);
  b.setJar([]);
  b.cookies.emit('changed');
  await b.memory.flush();
  assert.deepEqual((await store.read(ORIGIN)).sessionCookies, []);
  await b.memory.dispose();
});

test('登录记忆失败只返回固定说明，不泄漏解密错误与输入', async (t) => {
  const { store } = await setup(t, { safeStorage: { isEncryptionAvailable: () => false } });
  const b = bridge(store);
  await b.memory.restore();
  assert.equal(await b.handlers.get(LOAD)(b.event()), null);
  b.capture({ username: 'alice', password: 'private-password' });
  await b.memory.confirmLogin(identity);
  assert.ok(b.errors.length > 0);
  assert.ok(b.errors.every((message) => !message.includes('private-password') && message.includes('加密保存')));
  await b.memory.dispose();
});

test('导航中表单检查不结算时有界返回，保留旧密码并继续登录流程', async (t) => {
  const { store } = await setup(t);
  await store.update(ORIGIN, { credentials: { username: 'alice', password: 'old' } });
  const b = bridge(store);
  b.capture({ username: 'alice', password: 'unconfirmed' });
  b.contents.executeJavaScript = () => new Promise(() => {});
  await b.memory.confirmLogin(identity);
  assert.equal((await store.read(ORIGIN)).credentials.password, 'old');
  await b.memory.dispose();
});

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createUpdaterService, detectSigningMode, findCachedUpdateZip } from './updater.mjs';

/** 假 electron-updater：EventEmitter + 记录调用与关键配置。
 * 真库在 checkForUpdates/downloadUpdate 调用期间同步派事件（先于 promise
 * resolve），桩用 onCheck/onDownload 钩子对齐这个时序，否则会误触发
 * check() 的「事件缺席」兜底分支。 */
function fakeAutoUpdater() {
  const emitter = new EventEmitter();
  // 注意用方法简写而非箭头函数：ESM 顶层 this 是 undefined，箭头里 this.calls 会炸。
  return {
    emitter,
    calls: [],
    config: {},
    onCheck: null,
    onDownload: null,
    on(name, fn) { emitter.on(name, fn); },
    set autoDownload(v) { this.config.autoDownload = v; },
    get autoDownload() { return this.config.autoDownload; },
    set autoInstallOnAppQuit(v) { this.config.autoInstallOnAppQuit = v; },
    set disableDifferentialDownload(v) { this.config.disableDifferentialDownload = v; },
    set logger(v) { this.config.logger = v; },
    setFeedURL(feed) { this.calls.push({ kind: 'setFeedURL', feed }); },
    async checkForUpdates() {
      this.calls.push({ kind: 'check' });
      this.onCheck?.();
    },
    async downloadUpdate() {
      this.calls.push({ kind: 'download' });
      this.onDownload?.();
    },
    quitAndInstall() { this.calls.push({ kind: 'install' }); },
  };
}

function fakeApp({ isPackaged = true, version = '0.3.0' } = {}) {
  return { isPackaged, getVersion: () => version };
}

function setup({ isPackaged = true } = {}) {
  const autoUpdater = fakeAutoUpdater();
  const broadcasts = [];
  const service = createUpdaterService({
    app: fakeApp({ isPackaged }),
    // 钉 darwin 测 mac 分支（安装分流到 Squirrel/换包的那套）；win 有专属用例。
    platform: 'darwin',
    loadToken: async () => 'tok',
    createBridge: async () => ({ url: 'http://127.0.0.1:45678', close: async () => {} }),
    updaterFactory: async () => autoUpdater,
  });
  service.setBroadcast((state) => broadcasts.push(state));
  return { service, autoUpdater, broadcasts };
}

test('未打包实例：supported=false，动作直接拒绝、不创建桥与更新器', async () => {
  let bridgeCreated = false;
  const service = createUpdaterService({
    app: fakeApp({ isPackaged: false }),
    platform: 'darwin',
    loadToken: async () => 'tok',
    createBridge: async () => { bridgeCreated = true; return { url: 'x', close: async () => {} }; },
    updaterFactory: async () => fakeAutoUpdater(),
  });
  const state = service.getState();
  assert.equal(state.supported, false);
  assert.equal(state.currentVersion, '0.3.0');
  const check = await service.check();
  assert.equal(check.ok, false);
  assert.equal(check.code, 'unsupported');
  assert.equal((await service.download()).code, 'unsupported');
  assert.equal((await service.install()).code, 'unsupported');
  assert.equal(bridgeCreated, false);
});

test('打包的 Windows 实例：完整更新流走通，桥吃 latest.yml、安装直接 quitAndInstall（NSIS 原生路）', async () => {
  const autoUpdater = fakeAutoUpdater();
  const bridgeArgs = [];
  const service = createUpdaterService({
    app: fakeApp({ isPackaged: true }),
    platform: 'win32',
    loadToken: async () => 'tok',
    createBridge: async (args) => {
      bridgeArgs.push(args);
      return { url: 'http://127.0.0.1:45678', close: async () => {} };
    },
    updaterFactory: async () => autoUpdater,
    // win 安装不该碰任何 mac 专属命令（codesign 探测/ditto 换包）——一碰就炸。
    execFn: (file) => {
      throw new Error(`win 安装不应调用 ${file}`);
    },
  });
  const state = service.getState();
  assert.equal(state.supported, true);
  assert.equal(state.unsupportedReason, null);
  autoUpdater.onCheck = () => autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  autoUpdater.onDownload = () => autoUpdater.emitter.emit('update-downloaded', { version: '0.4.0' });
  assert.equal((await service.check()).ok, true);
  assert.equal(service.getState().phase, 'available');
  assert.equal((await service.download()).ok, true);
  assert.equal(service.getState().phase, 'downloaded');
  assert.equal((await service.install()).ok, true);
  assert.equal(autoUpdater.calls.some((c) => c.kind === 'install'), true);
  assert.equal(bridgeArgs[0]?.channelFile, 'latest.yml');
});

test('其余平台（无分发形态）：supported=false（原因 unsupported-platform），动作拒绝且不建桥', async () => {
  let bridgeCreated = false;
  const service = createUpdaterService({
    app: fakeApp({ isPackaged: true }),
    platform: 'linux',
    loadToken: async () => 'tok',
    createBridge: async () => { bridgeCreated = true; return { url: 'x', close: async () => {} }; },
    updaterFactory: async () => fakeAutoUpdater(),
  });
  const state = service.getState();
  assert.equal(state.supported, false);
  assert.equal(state.unsupportedReason, 'unsupported-platform');
  const check = await service.check();
  assert.equal(check.code, 'unsupported');
  assert.match(check.message, /发布页/);
  assert.equal((await service.download()).code, 'unsupported');
  assert.equal((await service.install()).code, 'unsupported');
  assert.equal(bridgeCreated, false);
});

test('检查流程：checking → available（事件驱动），版本号进状态并广播', async () => {
  const { service, autoUpdater, broadcasts } = setup();
  autoUpdater.onCheck = () => {
    autoUpdater.emitter.emit('checking-for-update');
    autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  };
  const result = await service.check();
  assert.equal(result.ok, true);
  const state = service.getState();
  assert.equal(state.phase, 'available');
  assert.equal(state.availableVersion, '0.4.0');
  assert.ok(autoUpdater.config.autoDownload === false);
  assert.equal(autoUpdater.config.autoInstallOnAppQuit, true);
  assert.equal(autoUpdater.config.disableDifferentialDownload, true);
  assert.deepEqual(autoUpdater.calls[0], {
    kind: 'setFeedURL',
    feed: { provider: 'generic', url: 'http://127.0.0.1:45678' },
  });
  // 广播序列：checking → available。
  assert.deepEqual(broadcasts.map((s) => s.phase), ['checking', 'available']);
});

test('无更新与事件缺席：not-available 兜底（checking 后事件没来的收敛）', async () => {
  const { service } = setup();
  const result = await service.check();
  assert.equal(result.ok, true);
  assert.equal(service.getState().phase, 'not-available');
});

test('下载流程：available 才放行，进度百分比随事件更新，完成后 downloaded', async () => {
  const { service, autoUpdater } = setup();
  assert.equal((await service.download()).code, 'no-update');

  autoUpdater.onCheck = () => {
    autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  };
  await service.check();
  autoUpdater.onDownload = () => {
    autoUpdater.emitter.emit('download-progress', { percent: 41.6 });
    autoUpdater.emitter.emit('download-progress', { percent: 99.9 });
    autoUpdater.emitter.emit('update-downloaded', { version: '0.4.0' });
  };
  assert.equal((await service.download()).ok, true);
  const state = service.getState();
  assert.equal(state.phase, 'downloaded');
  assert.equal(state.progressPercent, 100);
  assert.equal(state.availableVersion, '0.4.0');
  // 已下载后重复点下载：幂等 ok，不重复发起。
  const again = await service.download();
  assert.equal(again.ok, true);
  assert.equal(autoUpdater.calls.filter((c) => c.kind === 'download').length, 1);
});

test('安装（真证书形态）：downloaded 才放行，走 Squirrel quitAndInstall', async () => {
  const { service, autoUpdater } = setup();
  assert.equal((await service.install()).code, 'not-downloaded');
  autoUpdater.onCheck = () => {
    autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  };
  autoUpdater.onDownload = () => {
    autoUpdater.emitter.emit('update-downloaded', { version: '0.4.0' });
  };
  await service.check();
  await service.download();
  // exec 返回真 TeamIdentifier → certified → Squirrel 原生安装。
  const certified = createUpdaterService({
    app: fakeApp(),
    platform: 'darwin',
    loadToken: async () => null,
    createBridge: async () => ({ url: 'http://127.0.0.1:1', close: async () => {} }),
    updaterFactory: async () => autoUpdater,
    execFn: (file, args) => {
      if (file === 'codesign') return 'TeamIdentifier=AB12CD34EF';
      return '';
    },
  });
  // certified 服务自己没跑 check/download：直接借 state 断言换包路径已在下方专测覆盖，
  // 这里用同一状态机走到 downloaded 再装。
  certified.setBroadcast(() => {});
  autoUpdater.onCheck = () => autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  autoUpdater.onDownload = () => autoUpdater.emitter.emit('update-downloaded', { version: '0.4.0' });
  await certified.check();
  await certified.download();
  assert.equal((await certified.install()).ok, true);
  assert.equal(autoUpdater.calls.some((c) => c.kind === 'install'), true);
});

test('安装（未签名形态）：自研换包——ditto 解包、版本护栏、分离脚本、退出', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-test-'));
  const bundle = path.join(home, 'Hemi.app');
  mkdirSync(path.join(bundle, 'Contents', 'MacOS'), { recursive: true });
  // 下载缓存：pending 里放一个假 zip（内容不重要，ditto 是注入的）。
  const cacheDir = path.join(home, 'Library', 'Caches', 'hemi-desktop-updater', 'pending');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, 'Hemi-0.4.0-arm64-mac.zip'), 'zip-bytes');

  const execCalls = [];
  const spawned = [];
  let quitCalled = false;
  const autoUpdater = fakeAutoUpdater();
  const service = createUpdaterService({
    app: { ...fakeApp(), quit: () => { quitCalled = true; } },
    platform: 'darwin',
    loadToken: async () => null,
    createBridge: async () => ({ url: 'http://127.0.0.1:1', close: async () => {} }),
    updaterFactory: async () => autoUpdater,
    homeDir: home,
    appBundlePath: bundle,
    execFn: (file, args) => {
      execCalls.push([file, ...args]);
      if (file === 'codesign') return 'TeamIdentifier=not set';
      if (file === 'ditto') {
        // 假 ditto：把暂存包的 Info.plist 写出来（版本护栏的输入）。
        const staging = args[3];
        mkdirSync(path.join(staging, 'Hemi.app', 'Contents'), { recursive: true });
        writeFileSync(
          path.join(staging, 'Hemi.app', 'Contents', 'Info.plist'),
          '<key>CFBundleShortVersionString</key><string>0.4.0</string>',
        );
      }
      return '';
    },
    spawnFn: (file, args) => {
      spawned.push([file, ...args]);
    },
  });
  service.setBroadcast(() => {});
  autoUpdater.onCheck = () => autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  autoUpdater.onDownload = () => autoUpdater.emitter.emit('update-downloaded', { version: '0.4.0' });
  await service.check();
  await service.download();

  const result = await service.install();
  assert.equal(result.ok, true);
  // 命令序列：codesign 探测 → rm 暂存 → ditto 解包 → （版本护栏过）不再 rm。
  assert.ok(execCalls.some(([file]) => file === 'codesign'));
  assert.ok(execCalls.some(([file]) => file === 'ditto'));
  // 分离脚本拿到了 bundle/staging/pid/日志四参。
  assert.equal(spawned.length, 1);
  const [sh, script, bundleArg, stagingArg, pidArg, logArg] = spawned[0];
  assert.equal(sh, '/bin/sh');
  assert.equal(path.dirname(script), home);
  assert.equal(bundleArg, bundle);
  assert.equal(stagingArg.includes('.update-'), true);
  assert.match(logArg, /hemi-update-swap\.log$/);
  assert.equal(Number(pidArg), process.pid);
  assert.equal(quitCalled, true);
  // Squirrel 原生安装没被触发。
  assert.equal(autoUpdater.calls.some((c) => c.kind === 'install'), false);

  rmSync(home, { recursive: true, force: true });
});

test('换包版本护栏：暂存包版本与待装版本不符 → 拒装并清理暂存', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-test-'));
  const bundle = path.join(home, 'Hemi.app');
  mkdirSync(bundle, { recursive: true });
  const cacheDir = path.join(home, 'Library', 'Caches', 'hemi-desktop-updater', 'pending');
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(path.join(cacheDir, 'Hemi-0.9.9-arm64-mac.zip'), 'zip');

  const autoUpdater = fakeAutoUpdater();
  const service = createUpdaterService({
    app: { ...fakeApp(), quit: () => {} },
    platform: 'darwin',
    loadToken: async () => null,
    createBridge: async () => ({ url: 'http://127.0.0.1:1', close: async () => {} }),
    updaterFactory: async () => autoUpdater,
    homeDir: home,
    appBundlePath: bundle,
    execFn: (file, args) => {
      if (file === 'codesign') return 'TeamIdentifier=not set';
      if (file === 'ditto') {
        const staging = args[3];
        mkdirSync(path.join(staging, 'Hemi.app', 'Contents'), { recursive: true });
        writeFileSync(
          path.join(staging, 'Hemi.app', 'Contents', 'Info.plist'),
          '<key>CFBundleShortVersionString</key><string>9.9.9</string>',
        );
      }
      return '';
    },
    spawnFn: () => {},
  });
  service.setBroadcast(() => {});
  autoUpdater.onCheck = () => autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  autoUpdater.onDownload = () => autoUpdater.emitter.emit('update-downloaded', { version: '0.4.0' });
  await service.check();
  await service.download();

  const result = await service.install();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'staged-mismatch');
  rmSync(home, { recursive: true, force: true });
});

test('detectSigningMode：TeamIdentifier 有值＝certified，not set＝ad-hoc，报错＝unsigned', () => {
  const run = (out, throws = false) => (file, args) => {
    if (throws) throw new Error('no signature');
    return out;
  };
  assert.equal(detectSigningMode({ execPath: '/x', exec: run('TeamIdentifier=AB12CD34EF\n') }), 'certified');
  assert.equal(detectSigningMode({ execPath: '/x', exec: run('TeamIdentifier=not set') }), 'ad-hoc');
  assert.equal(detectSigningMode({ execPath: '/x', exec: run('', true) }), 'unsigned');
});

test('findCachedUpdateZip：pending 里取 zip；没有返回 null', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-test-'));
  const cacheDir = path.join(home, 'Library', 'Caches', 'hemi-desktop-updater');
  assert.equal(await findCachedUpdateZip({ cacheDir }), null);
  mkdirSync(path.join(cacheDir, 'pending'), { recursive: true });
  writeFileSync(path.join(cacheDir, 'pending', 'update-info.json'), '{}');
  assert.equal(await findCachedUpdateZip({ cacheDir }), null);
  writeFileSync(path.join(cacheDir, 'pending', 'Hemi-0.4.0-arm64-mac.zip'), 'z');
  assert.match(String(await findCachedUpdateZip({ cacheDir })), /Hemi-0\.4\.0-arm64-mac\.zip$/);
  rmSync(home, { recursive: true, force: true });
});

test('错误事件：phase=error 带消息；后续可再检查恢复', async () => {
  const { service, autoUpdater } = setup();
  await service.check();
  autoUpdater.emitter.emit('error', new Error('网络断了'));
  const errored = service.getState();
  assert.equal(errored.phase, 'error');
  assert.match(errored.errorMessage, /网络断了/);

  autoUpdater.emitter.emit('update-available', { version: '0.4.1' });
  assert.equal(service.getState().phase, 'available');
  assert.equal(service.getState().errorMessage, null);
});

test('检查抛错（桥起不来等）：回执 ok=false 带消息，状态进 error', async () => {
  const service = createUpdaterService({
    app: fakeApp(),
    platform: 'darwin',
    loadToken: async () => null,
    createBridge: async () => { throw new Error('端口占用'); },
    updaterFactory: async () => fakeAutoUpdater(),
  });
  const result = await service.check();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'check-failed');
  assert.match(result.message, /端口占用/);
  assert.equal(service.getState().phase, 'error');
});

test('启动静默检查：打包实例按延迟排入，未打包不排', async () => {
  const fired = [];
  const autoUpdater = fakeAutoUpdater();
  const service = createUpdaterService({
    app: fakeApp(),
    platform: 'darwin',
    loadToken: async () => null,
    createBridge: async () => ({ url: 'http://127.0.0.1:1', close: async () => {} }),
    updaterFactory: async () => autoUpdater,
    timeoutSet: (fn) => { fired.push(fn); return { unref() {} }; },
  });
  service.scheduleStartupCheck();
  assert.equal(fired.length, 1);
  fired[0]();
  // 定时器回调里是 void check()：等微任务跑完（ensureSetup → not-available 兜底）。
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.getState().phase, 'not-available');

  const unpackaged = createUpdaterService({
    app: fakeApp({ isPackaged: false }),
    platform: 'darwin',
    timeoutSet: (fn) => { fired.push(fn); return { unref() {} }; },
  });
  unpackaged.scheduleStartupCheck();
  assert.equal(fired.length, 1);
});

test('dispose：关桥（未启动过为 no-op 不抛）', async () => {
  let closed = false;
  const service = createUpdaterService({
    app: fakeApp(),
    platform: 'darwin',
    loadToken: async () => null,
    createBridge: async () => ({ url: 'x', close: async () => { closed = true; } }),
    updaterFactory: async () => fakeAutoUpdater(),
  });
  await service.dispose();
  assert.equal(closed, false);
  await service.check().catch(() => {});
  await service.dispose();
  assert.equal(closed, true);
});

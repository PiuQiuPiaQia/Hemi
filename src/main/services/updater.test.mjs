import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, utimesSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createHash } from 'node:crypto';

import { createUpdaterService, detectSigningMode, pickStagingDir, sweepStaleSwapArtifacts } from './updater.mjs';
import { UPDATE_FEED_URL } from '../../shared/release-info.mjs';

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
    get autoInstallOnAppQuit() { return this.config.autoInstallOnAppQuit; },
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

function downloadInfo(file, version = '0.4.0') {
  const sha512 = createHash('sha512').update(readFileSync(file)).digest('base64');
  return { version, downloadedFile: file, files: [{ url: path.basename(file), sha512 }] };
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
    updaterFactory: async () => autoUpdater,
    execFn: () => 'TeamIdentifier=not set',
  });
  service.setBroadcast((state) => broadcasts.push(state));
  return { service, autoUpdater, broadcasts };
}

test('未打包实例：supported=false，动作直接拒绝、不创建更新器', async () => {
  let updaterCreated = false;
  const service = createUpdaterService({
    app: fakeApp({ isPackaged: false }),
    platform: 'darwin',
    updaterFactory: async () => { updaterCreated = true; return fakeAutoUpdater(); },
  });
  const state = service.getState();
  assert.equal(state.supported, false);
  assert.equal(state.currentVersion, '0.3.0');
  const check = await service.check();
  assert.equal(check.ok, false);
  assert.equal(check.code, 'unsupported');
  assert.equal((await service.download()).code, 'unsupported');
  assert.equal((await service.install()).code, 'unsupported');
  assert.equal(updaterCreated, false);
});

test('打包的 Windows 实例：完整更新流走通，公开下载、安装直接 quitAndInstall（NSIS 原生路）', async () => {
  const autoUpdater = fakeAutoUpdater();
  const service = createUpdaterService({
    app: fakeApp({ isPackaged: true }),
    platform: 'win32',
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
  assert.equal(autoUpdater.config.autoInstallOnAppQuit, true);
  assert.equal((await service.install()).ok, true);
  assert.equal(autoUpdater.calls.some((c) => c.kind === 'install'), true);
  assert.deepEqual(autoUpdater.calls[0].feed, { provider: 'generic', url: UPDATE_FEED_URL });
});

test('其余平台（无分发形态）：supported=false（原因 unsupported-platform），动作拒绝且不建更新器', async () => {
  let updaterCreated = false;
  const service = createUpdaterService({
    app: fakeApp({ isPackaged: true }),
    platform: 'linux',
    updaterFactory: async () => { updaterCreated = true; return fakeAutoUpdater(); },
  });
  const state = service.getState();
  assert.equal(state.supported, false);
  assert.equal(state.unsupportedReason, 'unsupported-platform');
  const check = await service.check();
  assert.equal(check.code, 'unsupported');
  assert.match(check.message, /发布页/);
  assert.equal((await service.download()).code, 'unsupported');
  assert.equal((await service.install()).code, 'unsupported');
  assert.equal(updaterCreated, false);
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
  assert.equal(autoUpdater.config.autoInstallOnAppQuit, false);
  assert.equal(autoUpdater.config.disableDifferentialDownload, true);
  assert.deepEqual(autoUpdater.calls[0], {
    kind: 'setFeedURL',
    feed: { provider: 'generic', url: UPDATE_FEED_URL },
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
  assert.equal(autoUpdater.config.autoInstallOnAppQuit, true);
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
  writeFileSync(path.join(cacheDir, 'ZZZ-stale.zip'), 'another cached archive');

  const execCalls = [];
  const spawned = [];
  let quitCalled = false;
  const autoUpdater = fakeAutoUpdater();
  const service = createUpdaterService({
    app: { ...fakeApp(), quit: () => { quitCalled = true; } },
    platform: 'darwin',
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
  autoUpdater.onDownload = () => autoUpdater.emitter.emit('update-downloaded', downloadInfo(path.join(cacheDir, 'Hemi-0.4.0-arm64-mac.zip')));
  await service.check();
  await service.download();

  assert.equal(autoUpdater.config.autoInstallOnAppQuit, false);
  const result = await service.install();
  assert.equal(result.ok, true);
  // 命令序列：codesign 探测 → rm 预清 + mkdir 暂存根 → ditto 解包 →（版本护栏过）。
  assert.ok(execCalls.some(([file]) => file === 'codesign'));
  assert.ok(execCalls.some(([file, ...args]) => file === 'ditto' && args[2] === path.join(cacheDir, 'Hemi-0.4.0-arm64-mac.zip')));
  assert.ok(execCalls.some(([file, ...args]) => file === 'codesign' && args.includes('--verify') && args.includes('--strict')));
  // 分离脚本拿到了 bundle/staging/pid/日志四参。
  assert.equal(spawned.length, 1);
  const [sh, script, bundleArg, stagingArg, pidArg, logArg] = spawned[0];
  assert.equal(sh, '/bin/sh');
  assert.equal(path.dirname(script), home);
  assert.equal(bundleArg, bundle);
  assert.equal(stagingArg.includes(path.join('Library', 'Caches', 'hemi-updater-staging')), true);
  assert.match(path.basename(stagingArg), /^staging-\d+$/);
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
  autoUpdater.onDownload = () => autoUpdater.emitter.emit('update-downloaded', downloadInfo(path.join(cacheDir, 'Hemi-0.9.9-arm64-mac.zip')));
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

test('ad-hoc 安装拒绝下载后被篡改的 ZIP；不解包、不退出、不交给原生安装器', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-tamper-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const zip = path.join(home, 'current.zip'); writeFileSync(zip, 'verified bytes');
  const info = downloadInfo(zip), updater = fakeAutoUpdater();
  let extracted = false, quit = false, spawned = false;
  const service = createUpdaterService({ app: { ...fakeApp(), quit: () => { quit = true; } }, platform: 'darwin',
    updaterFactory: async () => updater, homeDir: home,
    execFn: (file) => { if (file === 'codesign') return 'TeamIdentifier=not set'; extracted = true; },
    spawnFn: () => { spawned = true; },
  });
  updater.onCheck = () => updater.emitter.emit('update-available', { version: '0.4.0' });
  updater.onDownload = () => updater.emitter.emit('update-downloaded', info);
  await service.check(); await service.download();
  writeFileSync(zip, 'modified after download');
  const result = await service.install();
  assert.equal(result.ok, false); assert.match(result.message, /校验失败/);
  assert.equal(extracted || quit || spawned, false);
  assert.equal(updater.calls.some(c => c.kind === 'install'), false);
});

test('新包签名校验失败时清理暂存，不退出、不启动换包脚本', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-seal-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const zip = path.join(home, 'current.zip'); writeFileSync(zip, 'verified bytes');
  const updater = fakeAutoUpdater(); let quit = false, spawned = false, removals = 0;
  const service = createUpdaterService({ app: { ...fakeApp(), quit: () => { quit = true; } }, platform: 'darwin',
    updaterFactory: async () => updater, homeDir: home, appBundlePath: path.join(home, 'Hemi.app'),
    execFn: (file, args) => {
      if (file === 'codesign' && args[0] === '-dv') return 'TeamIdentifier=not set';
      if (file === 'codesign') throw new Error('resource seal invalid');
      if (file === 'rm') removals++;
      if (file === 'ditto') {
        const contents = path.join(args[3], 'Hemi.app/Contents'); mkdirSync(contents, { recursive: true });
        writeFileSync(path.join(contents, 'Info.plist'), '<key>CFBundleShortVersionString</key><string>0.4.0</string>');
      }
    }, spawnFn: () => { spawned = true; },
  });
  updater.onCheck = () => updater.emitter.emit('update-available', { version: '0.4.0' });
  updater.onDownload = () => updater.emitter.emit('update-downloaded', downloadInfo(zip));
  await service.check(); await service.download();
  assert.equal((await service.install()).ok, false);
  assert.equal(removals, 2); assert.equal(quit || spawned, false);
});

test('ad-hoc 下载回执缺失时不猜测缓存里的其他 ZIP', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-receipt-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const updater = fakeAutoUpdater();
  const service = createUpdaterService({ app: fakeApp(), platform: 'darwin', updaterFactory: async () => updater,
    homeDir: home, execFn: () => 'TeamIdentifier=not set' });
  updater.onCheck = () => updater.emitter.emit('update-available', { version: '0.4.0' });
  updater.onDownload = () => updater.emitter.emit('update-downloaded', { version: '0.4.0' });
  await service.check(); await service.download();
  assert.equal((await service.install()).ok, false);
  assert.equal(updater.calls.some(c => c.kind === 'install'), false);
});

test('错误事件：phase=error 带消息；后续可再检查恢复', async () => {
  const { service, autoUpdater } = setup();
  await service.check();
  autoUpdater.emitter.emit('error', new Error('网络断了'));
  const errored = service.getState();
  assert.equal(errored.phase, 'error');
  assert.equal(errored.errorMessage, '检查更新失败：请稍后重试或前往发布页下载。');

  autoUpdater.emitter.emit('update-available', { version: '0.4.1' });
  assert.equal(service.getState().phase, 'available');
  assert.equal(service.getState().errorMessage, null);
});

test('下载错误：事件、拒绝回执与广播都只给简短提示，日志保留完整原因', async () => {
  const autoUpdater = fakeAutoUpdater();
  const logs = [], broadcasts = [];
  const service = createUpdaterService({
    app: fakeApp(),
    platform: 'darwin',
    updaterFactory: async () => autoUpdater,
    log: { warn: (line) => logs.push(line) },
  });
  service.setBroadcast((state) => broadcasts.push(state));
  autoUpdater.onCheck = () => autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  await service.check();
  const error = new Error('502 Bad Gateway\nGET https://github.com/example/update.zip\nHeaders: {"connection":"keep-alive"}');
  autoUpdater.onDownload = () => {
    autoUpdater.emitter.emit('error', error);
    throw error;
  };
  const result = await service.download();
  assert.equal(result.ok, false);
  assert.equal(result.message, '下载更新失败：更新服务暂时不可用，请稍后重试。');
  assert.equal(service.getState().errorMessage, result.message);
  assert.ok(broadcasts.filter((state) => state.phase === 'error').every((state) => state.errorMessage === result.message));
  assert.ok(logs.some((line) => line.includes(error.message)));
  autoUpdater.onCheck = () => autoUpdater.emitter.emit('update-not-available');
  await service.check();
  assert.equal(service.getState().phase, 'not-available');
  assert.equal(service.getState().errorMessage, null);
});

test('初始化失败：回执与状态都只给简短提示，后续检查可重试', async () => {
  let attempts = 0;
  const service = createUpdaterService({
    app: fakeApp(),
    platform: 'darwin',
    updaterFactory: async () => {
      if (attempts++ === 0) throw new Error('updater import failed: internal details');
      return fakeAutoUpdater();
    },
  });
  const result = await service.check();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'check-failed');
  assert.equal(result.message, '检查更新失败：请稍后重试或前往发布页下载。');
  assert.equal(service.getState().errorMessage, result.message);
  assert.equal(service.getState().phase, 'error');
  assert.equal((await service.check()).ok, true);
  assert.equal(service.getState().errorMessage, null);
});

test('启动静默检查：打包实例按延迟排入，未打包不排', async () => {
  const fired = [];
  const autoUpdater = fakeAutoUpdater();
  const service = createUpdaterService({
    app: fakeApp(),
    platform: 'darwin',
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

test('换包解包失败：ditto 抛错也清掉暂存目录，不再遗留空壳', async (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-ditto-fail-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bundle = path.join(home, 'Hemi.app');
  mkdirSync(bundle, { recursive: true });
  const cacheDir = path.join(home, 'Library', 'Caches', 'hemi-desktop-updater', 'pending');
  mkdirSync(cacheDir, { recursive: true });
  const zip = path.join(cacheDir, 'Hemi-0.4.0-arm64-mac.zip');
  writeFileSync(zip, 'zip');

  const rms = [];
  let spawned = 0;
  const autoUpdater = fakeAutoUpdater();
  const service = createUpdaterService({
    app: { ...fakeApp(), quit: () => {} },
    platform: 'darwin',
    updaterFactory: async () => autoUpdater,
    homeDir: home,
    appBundlePath: bundle,
    execFn: (file, args) => {
      if (file === 'codesign') return 'TeamIdentifier=not set';
      if (file === 'ditto') throw new Error('ditto: CRC mismatch');
      if (file === 'rm') rms.push(args[1]);
      return '';
    },
    spawnFn: () => { spawned += 1; },
  });
  service.setBroadcast(() => {});
  autoUpdater.onCheck = () => autoUpdater.emitter.emit('update-available', { version: '0.4.0' });
  autoUpdater.onDownload = () => autoUpdater.emitter.emit('update-downloaded', downloadInfo(zip));
  await service.check();
  await service.download();

  const result = await service.install();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'install-failed');
  assert.equal(spawned, 0);
  // 预清理与失败清理都指向同一个 Caches 暂存目录（重复 rm 幂等无害）。
  const stagingRms = rms.filter((p) => p.includes(path.join('Caches', 'hemi-updater-staging')));
  assert.equal(stagingRms.length >= 1, true);
  assert.equal(new Set(stagingRms).size, 1);
});

test('sweepStaleSwapArtifacts：清陈旧暂存/旧版残留/.old，保新鲜暂存与恢复副本', (t) => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-sweep-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const appsDir = path.join(home, 'Applications');
  const stagingRoot = path.join(home, 'Library', 'Caches', 'hemi-updater-staging');
  const mk = (p) => { mkdirSync(p, { recursive: true }); return p; };
  const age = (p, minutes) => { const at = new Date(Date.now() - minutes * 60_000); utimesSync(p, at, at); };
  const bundle = mk(path.join(appsDir, 'Hemi.app'));
  const staleStaging = mk(path.join(stagingRoot, 'staging-100'));
  const freshStaging = mk(path.join(stagingRoot, 'staging-200'));
  const legacyShell = mk(path.join(appsDir, 'Hemi.app.update-1793144960881'));
  const oldBundle = mk(path.join(appsDir, 'Hemi.app.old'));
  age(staleStaging, 30);
  age(legacyShell, 60 * 24);
  age(oldBundle, 15);

  const removed = sweepStaleSwapArtifacts({ bundlePath: bundle, homeDir: home });
  assert.equal(removed, 3);
  assert.equal(existsSync(staleStaging), false);
  assert.equal(existsSync(freshStaging), true);
  assert.equal(existsSync(legacyShell), false);
  assert.equal(existsSync(oldBundle), false);

  // 主包不在时 .old 是唯一恢复副本：不清。
  const home2 = mkdtempSync(path.join(tmpdir(), 'hemi-updater-sweep2-'));
  t.after(() => rmSync(home2, { recursive: true, force: true }));
  const missingBundle = path.join(home2, 'Applications', 'Hemi.app');
  const rescueOld = mk(path.join(home2, 'Applications', 'Hemi.app.old'));
  age(rescueOld, 30);
  assert.equal(sweepStaleSwapArtifacts({ bundlePath: missingBundle, homeDir: home2 }), 0);
  assert.equal(existsSync(rescueOld), true);
});

test('pickStagingDir：与旧包同卷时暂存放 Caches，异卷退回旧包同目录', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'hemi-updater-pick-'));
  const bundle = path.join(home, 'Hemi.app');
  const cachePick = pickStagingDir({ bundlePath: bundle, homeDir: home, statFn: () => ({ dev: 1 }) });
  // path.sep 直接拼正则时反斜杠会被当转义（\s 成空白类）——先归一成 '/' 再匹配。
  assert.match(cachePick.split(path.sep).join('/'), /hemi-updater-staging\/staging-\d+$/);
  const crossVolumePick = pickStagingDir({
    bundlePath: bundle,
    homeDir: home,
    statFn: (p) => ({ dev: p.includes('Caches') ? 2 : 1 }),
  });
  assert.match(crossVolumePick, /Hemi\.app\.update-\d+$/);
});

// win-compat 单测：mac 上覆盖全部 win 分支（platform/env/execFile 全注入，无真机 CI 口径）。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  signalSet,
  childProcessOptions,
  terminateProcessTree,
  envGet,
  envSet,
  codePageFromChcpOutput,
  textDecoderLabelForCodePage,
  readWindowsCodePage,
  fallbackDecoderLabelForLocale,
  decodeChildOutput,
  resolveChildOutputDecoderLabel,
  comSpecPath,
  quoteCmdArg,
  cmdExecArgs,
  pathextExtensions,
  executableCandidates,
  gitBashCandidates,
} from './win-compat.mjs';

/* ── 测试桩：child / spawn / execFile ── */

function mockChild({ exitCode = null } = {}) {
  const child = new EventEmitter();
  child.exitCode = exitCode;
  child.kills = [];
  child.kill = (sig) => child.kills.push(sig);
  return child;
}

function mockSpawnFactory(calls) {
  return (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const proc = new EventEmitter();
    proc.failNext = false;
    return proc;
  };
}

/* ── 信号与 spawn 语义 ── */

test('signalSet：win 无 SIGHUP，posix 三信号', () => {
  assert.deepEqual(signalSet('win32'), ['SIGINT', 'SIGTERM']);
  assert.deepEqual(signalSet('darwin'), ['SIGINT', 'SIGTERM', 'SIGHUP']);
});

test('childProcessOptions：win 不 detached＋windowsHide，posix detached；extra 合并', () => {
  const win = childProcessOptions('win32', { cwd: 'C:\\x', stdio: 'ignore' });
  assert.equal(win.detached, false);
  assert.equal(win.windowsHide, true);
  assert.equal(win.cwd, 'C:\\x');
  const mac = childProcessOptions('darwin');
  assert.equal(mac.detached, true);
  assert.equal(mac.windowsHide, true);
});

test('terminateProcessTree(win32)：taskkill /pid /T /F＋windowsHide，close 即收', async () => {
  const calls = [];
  const procs = [];
  const spawnImpl = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const proc = new EventEmitter();
    procs.push(proc);
    return proc;
  };
  const done = terminateProcessTree({ platform: 'win32', pid: 4242, spawnImpl });
  procs[0].emit('close', 0);
  await done;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '4242', '/T', '/F']);
  assert.equal(calls[0].opts.windowsHide, true);
});

test('terminateProcessTree(win32)：taskkill 起不来时兜底 child.kill(SIGKILL)', async () => {
  const child = mockChild();
  const spawnImpl = () => {
    const proc = new EventEmitter();
    queueMicrotask(() => proc.emit('error', new Error('ENOENT')));
    return proc;
  };
  await terminateProcessTree({ platform: 'win32', pid: 7, child, spawnImpl });
  assert.deepEqual(child.kills, ['SIGKILL']);
});

test('terminateProcessTree(posix)：组+组长 SIGTERM，child close 即收不再升级', async () => {
  const kills = [];
  const killImpl = (target, sig) => {
    kills.push([target, sig]);
    if (target > 0) throw new Error('已退出'); // 组长单独发时可能已死——吞错语义
  };
  const child = mockChild();
  const done = terminateProcessTree({
    platform: 'darwin',
    pid: 99,
    child,
    killImpl,
    graceMs: 60_000,
  });
  child.emit('close', 0);
  await done;
  assert.deepEqual(kills[0], [-99, 'SIGTERM']);
  assert.deepEqual(kills[1], [99, 'SIGTERM']);
  assert.equal(kills.filter(([t, s]) => s === 'SIGKILL').length, 0);
});

test('terminateProcessTree(posix)：宽限超时后组+组长 SIGKILL 收殓残余', async () => {
  const kills = [];
  const killImpl = (target, sig) => kills.push([target, sig]);
  const child = mockChild(); // 永不 close
  await terminateProcessTree({ platform: 'darwin', pid: 5, child, killImpl, graceMs: 5 });
  assert.deepEqual(kills[0], [-5, 'SIGTERM']);
  assert.ok(kills.some(([t, s]) => t === -5 && s === 'SIGKILL'));
  assert.ok(kills.some(([t, s]) => t === 5 && s === 'SIGKILL'));
});

test('terminateProcessTree(posix)：主进程已退出（exitCode 非 null）直接强杀收尾', async () => {
  const kills = [];
  const child = mockChild({ exitCode: 0 });
  await terminateProcessTree({ platform: 'darwin', pid: 8, child, killImpl: (t, s) => kills.push([t, s]) });
  assert.equal(kills[0][1], 'SIGKILL');
  assert.equal(kills.filter(([t, s]) => s === 'SIGTERM').length, 0);
});

test('terminateProcessTree：非法 pid 拒绝', () => {
  assert.throws(() => terminateProcessTree({ platform: 'win32', pid: 'x', spawnImpl: mockSpawnFactory([]) }));
});

/* ── 环境变量大小写 ── */

test('envGet：win 大小写不敏感命中，posix 精确', () => {
  const env = { Path: 'C:\\bin', HOME: '/u/x' };
  assert.equal(envGet(env, 'PATH', 'win32'), 'C:\\bin');
  assert.equal(envGet(env, 'path', 'win32'), 'C:\\bin');
  assert.equal(envGet(env, 'PATH', 'darwin'), undefined);
  assert.equal(envGet(env, 'HOME', 'darwin'), '/u/x');
});

test('envSet：win 先清同 lowercase 旧键再写，posix 直写', () => {
  const win = { Path: 'a', PATH: 'b' };
  envSet(win, 'path', 'c', 'win32');
  assert.deepEqual(win, { path: 'c' });
  const mac = { A: 1 };
  envSet(mac, 'a', 2, 'darwin');
  assert.deepEqual(mac, { A: 1, a: 2 });
});

/* ── chcp／代码页 → 解码标签 ── */

test('codePageFromChcpOutput：Active code page 行取页号，认不出 null', () => {
  assert.equal(codePageFromChcpOutput('Active code page: 936\r\n'), 936);
  assert.equal(codePageFromChcpOutput('Active code page: 65001'), 65001);
  assert.equal(codePageFromChcpOutput('no digits'), null);
  assert.equal(codePageFromChcpOutput(null), null);
});

test('textDecoderLabelForCodePage：中文页全覆盖，OEM 拉丁页 null', () => {
  assert.equal(textDecoderLabelForCodePage(65001), 'utf-8');
  assert.equal(textDecoderLabelForCodePage(936), 'gbk');
  assert.equal(textDecoderLabelForCodePage(54936), 'gb18030');
  assert.equal(textDecoderLabelForCodePage(932), 'shift_jis');
  assert.equal(textDecoderLabelForCodePage(949), 'euc-kr');
  assert.equal(textDecoderLabelForCodePage(950), 'big5');
  assert.equal(textDecoderLabelForCodePage(866), 'ibm866');
  assert.equal(textDecoderLabelForCodePage(1252), 'windows-1252');
  assert.equal(textDecoderLabelForCodePage(437), null);
  assert.equal(textDecoderLabelForCodePage(9999), null);
});

test('readWindowsCodePage：ComSpec /d /s /c chcp（windowsHide＋超时），失败 null', async () => {
  const calls = [];
  const execOk = async (file, args, opts) => {
    calls.push({ file, args, opts });
    return { stdout: 'Active code page: 936' };
  };
  assert.equal(await readWindowsCodePage({ platform: 'win32', env: { ComSpec: 'C:\\c.exe' }, execFile: execOk }), 936);
  assert.equal(calls[0].file, 'C:\\c.exe');
  assert.deepEqual(calls[0].args, ['/d', '/s', '/c', 'chcp']);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.equal(calls[0].opts.timeout > 0, true);

  const execFail = async () => {
    throw new Error('timeout');
  };
  assert.equal(await readWindowsCodePage({ platform: 'win32', execFile: execFail }), null);
  assert.equal(await readWindowsCodePage({ platform: 'darwin', execFile: execOk }), null);
});

test('fallbackDecoderLabelForLocale：LC_* > LANG > locale 线索；zh/ja/ko/ru，其余不猜', () => {
  assert.equal(fallbackDecoderLabelForLocale({ LANG: 'zh_CN.UTF-8' }), 'gb18030');
  assert.equal(fallbackDecoderLabelForLocale({}, 'ja_JP'), 'shift_jis');
  assert.equal(fallbackDecoderLabelForLocale({ LC_ALL: 'ko_KR.EUC-KR' }, 'en_US'), 'euc-kr');
  assert.equal(fallbackDecoderLabelForLocale({}, 'ru_RU'), 'ibm866');
  assert.equal(fallbackDecoderLabelForLocale({ LC_CTYPE: 'en_US' }, 'zh'), 'gb18030'); // locale 兜底仍命中
  assert.equal(fallbackDecoderLabelForLocale({}, 'en_US'), null);
  assert.equal(fallbackDecoderLabelForLocale({}, 'fr_FR'), null);
});

test('decodeChildOutput：GBK 字节按标签解；null／坏标签走 utf-8；坏字节不抛', () => {
  const niHaoGbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]); // “你好”
  assert.equal(decodeChildOutput(niHaoGbk, 'gbk'), '你好');
  assert.equal(decodeChildOutput(Buffer.from('hi'), null), 'hi');
  assert.equal(decodeChildOutput(Buffer.from('hi'), 'cp437-not-real'), 'hi');
  // 非致命：utf-8 标签解 GBK 字节出替换符，不抛错。
  assert.ok(decodeChildOutput(niHaoGbk, 'utf-8').includes('\ufffd'));
});

test('resolveChildOutputDecoderLabel：chcp 实测优先，探不到走 locale 兜底；非 win 恒 null', async () => {
  const cp936 = async () => ({ stdout: 'Active code page: 936' });
  assert.equal(await resolveChildOutputDecoderLabel({ platform: 'win32', execFile: cp936, env: {} }), 'gbk');
  const fail = async () => {
    throw new Error('x');
  };
  assert.equal(
    await resolveChildOutputDecoderLabel({ platform: 'win32', execFile: fail, env: { LANG: 'zh_CN' } }),
    'gb18030',
  );
  assert.equal(await resolveChildOutputDecoderLabel({ platform: 'darwin', execFile: fail }), null);
});

/* ── cmd 方言 ── */

test('comSpecPath：win 读 ComSpec 兜底 cmd.exe，posix /bin/sh', () => {
  assert.equal(comSpecPath({ ComSpec: 'C:\\Windows\\system32\\cmd.exe' }, 'win32'), 'C:\\Windows\\system32\\cmd.exe');
  assert.equal(comSpecPath({ Path: 'x' }, 'win32'), 'cmd.exe');
  assert.equal(comSpecPath({}, 'darwin'), '/bin/sh');
});

test('quoteCmdArg：空串/plain 直过；空白与元字符引号＋^ 转义', () => {
  assert.equal(quoteCmdArg(''), '""');
  assert.equal(quoteCmdArg('plain.txt'), 'plain.txt');
  assert.equal(quoteCmdArg('with space'), '"with space"'); // 引号内空格本就安全，不 ^ 转义
  assert.equal(quoteCmdArg('a"b&c|d'), '"a^"b^&c^|d"');
  assert.equal(quoteCmdArg('(x)<y>'), '"^(x^)^<y^>"');
});

test('cmdExecArgs：/d /s /c＋命令', () => {
  assert.deepEqual(cmdExecArgs('echo hi'), ['/d', '/s', '/c', 'echo hi']);
});

/* ── 可执行文件发现 ── */

test('pathextExtensions：PATHEXT 拆分小写去重，缺省核心四件套，posix 恒空扩展', () => {
  assert.deepEqual(pathextExtensions({ PATHEXT: '.COM;.EXE;.BAT;.CMD;.PY;.py' }, 'win32'), [
    '.com', '.exe', '.bat', '.cmd', '.py',
  ]);
  assert.deepEqual(pathextExtensions({}, 'win32'), ['.com', '.exe', '.bat', '.cmd']);
  assert.deepEqual(pathextExtensions({ PATHEXT: '  ;  ' }, 'win32'), ['.com', '.exe', '.bat', '.cmd']);
  assert.deepEqual(pathextExtensions({ PATHEXT: '.COM' }, 'darwin'), ['']);
});

test('executableCandidates(win)：裸名按 cwd→PATH 搜索并补 PATHEXT；PATH 键大小写不敏感', () => {
  const env = { Path: 'C:\\bin;C:\\Tools' };
  const got = executableCandidates('chrome', { env, cwd: 'C:\\w', platform: 'win32' });
  assert.deepEqual(got, [
    'C:\\w\\chrome', 'C:\\w\\chrome.com', 'C:\\w\\chrome.exe', 'C:\\w\\chrome.bat', 'C:\\w\\chrome.cmd',
    'C:\\bin\\chrome', 'C:\\bin\\chrome.com', 'C:\\bin\\chrome.exe', 'C:\\bin\\chrome.bat', 'C:\\bin\\chrome.cmd',
    'C:\\Tools\\chrome', 'C:\\Tools\\chrome.com', 'C:\\Tools\\chrome.exe', 'C:\\Tools\\chrome.bat', 'C:\\Tools\\chrome.cmd',
  ]);
});

test('executableCandidates(win)：带扩展名不加变体；绝对无扩展带原样；相对按 cwd resolve', () => {
  assert.deepEqual(executableCandidates('C:\\x\\chrome.exe', { platform: 'win32', env: {} }), ['C:\\x\\chrome.exe']);
  assert.deepEqual(executableCandidates('C:\\x\\git', { platform: 'win32', env: {} }), [
    'C:\\x\\git', 'C:\\x\\git.com', 'C:\\x\\git.exe', 'C:\\x\\git.bat', 'C:\\x\\git.cmd',
  ]);
  assert.deepEqual(
    executableCandidates('.\\tools\\rg', { platform: 'win32', env: {}, cwd: 'C:\\proj' }),
    ['C:\\proj\\tools\\rg', 'C:\\proj\\tools\\rg.com', 'C:\\proj\\tools\\rg.exe', 'C:\\proj\\tools\\rg.bat', 'C:\\proj\\tools\\rg.cmd'],
  );
});

test('executableCandidates(posix)：裸名按 PATH，无扩展名变体', () => {
  const got = executableCandidates('rg', { env: { PATH: '/usr/bin:/usr/local/bin' }, platform: 'darwin' });
  assert.deepEqual(got, ['/usr/bin/rg', '/usr/local/bin/rg']);
});

test('gitBashCandidates：上跳两级各拼 bin\\bash.exe（Git for Windows 布局）', () => {
  assert.deepEqual(gitBashCandidates('C:\\Program Files\\Git\\cmd\\git.exe'), [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\bin\\bash.exe',
  ]);
  assert.deepEqual(gitBashCandidates('C:\\Program Files\\Git\\mingw64\\bin\\git.exe'), [
    'C:\\Program Files\\Git\\mingw64\\bin\\bash.exe',
    'C:\\Program Files\\Git\\bin\\bash.exe',
  ]);
});

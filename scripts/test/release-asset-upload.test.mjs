import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_RETRY_DELAYS_MS,
  classifyRunFailure,
  runGh,
  uploadDraftAssetsWithRetry,
  validateUploadArgs,
} from '../lib/release-asset-upload.mjs';

const TAG = 'v0.2.59';
const FILES = ['release/Hemi-0.2.59-arm64.dmg', 'release/Hemi-0.2.59-arm64-mac.zip'];

const result = (patch = {}, base = { code: 0, signal: null, error: null, stdout: '', stderr: '', timedOut: false }) => ({
  ...base, ...patch,
});
const viewDraft = result({ stdout: '{"isDraft":true}\n' });
const viewFormal = result({ stdout: '{"isDraft":false}\n' });
const gh502 = result({ code: 1, stderr: 'HTTP 502: Server Error (https://api.github.com/repos/PiuQiuPiaQia/Hemi/releases/assets/709101156)\n' });
const UPLOAD_ARGV = ['release', 'upload', TAG, ...FILES, '--clobber'];
const VIEW_ARGV = ['release', 'view', TAG, '--json', 'isDraft'];

/** 按调用顺序回放注入结果，并记录每次 argv。 */
function sequenceRun(steps) {
  const calls = [];
  let index = 0;
  const run = async (argv, opts) => {
    calls.push({ argv, opts });
    const step = steps[Math.min(index, steps.length - 1)];
    index += 1;
    return typeof step === 'function' ? step(argv, opts) : step;
  };
  run.calls = calls;
  return run;
}

function makeSleep(record = []) {
  return async (ms) => { record.push(ms); };
}

const uploadsOf = (calls) => calls.filter((call) => call.argv[1] === 'upload');
const viewsOf = (calls) => calls.filter((call) => call.argv[1] === 'view');

// ── 注入式单测：重试策略与安全闸门 ─────────────────────────────────────

test('502 部分上传后：同一 argv 重试一次成功，且每次上挂前都核实过草稿', async () => {
  const sleeps = [];
  const run = sequenceRun([viewDraft, gh502, viewDraft, result()]);
  const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run, sleep: makeSleep(sleeps), log: () => {} });
  assert.equal(code, 0);
  assert.equal(uploadsOf(run.calls).length, 2, '共两次上挂');
  assert.equal(viewsOf(run.calls).length, 2, '每次上挂前各核实一次草稿');
  assert.deepEqual(run.calls[1].argv, UPLOAD_ARGV);
  assert.deepEqual(run.calls[3].argv, UPLOAD_ARGV);
  assert.deepEqual(run.calls[1].argv, run.calls[3].argv, '重试必须用同一批文件同一参数');
  assert.deepEqual(sleeps, [DEFAULT_RETRY_DELAYS_MS[0]], '只睡一次');
});

test('一次成功：只上挂一次、只核实一次', async () => {
  const sleeps = [];
  const run = sequenceRun([viewDraft, result()]);
  const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run, sleep: makeSleep(sleeps), log: () => {} });
  assert.equal(code, 0);
  assert.equal(uploadsOf(run.calls).length, 1);
  assert.deepEqual(sleeps, []);
});

test('连续 5xx：用尽 3 次上挂后失败，睡两轮', async () => {
  const sleeps = [];
  const run = sequenceRun([viewDraft, gh502, viewDraft, result({ code: 1, stderr: 'HTTP 503: Service Unavailable (https://api.github.com/x)\n' }), viewDraft, result({ code: 1, stdout: 'gh: HTTP 500: Internal Server Error\n' })]);
  const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run, sleep: makeSleep(sleeps), log: () => {} });
  assert.equal(code, 1, '最终退出真实非 0');
  assert.equal(uploadsOf(run.calls).length, 3, '最多 3 次');
  assert.equal(viewsOf(run.calls).length, 3);
  assert.deepEqual(sleeps, DEFAULT_RETRY_DELAYS_MS);
});

test('403：不重试，退出码透传 gh 真实退出码', async () => {
  const sleeps = [];
  const run = sequenceRun([viewDraft, result({ code: 7, stderr: 'HTTP 403: Resource not accessible by integration\n' })]);
  const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run, sleep: makeSleep(sleeps), log: () => {} });
  assert.equal(code, 7);
  assert.equal(uploadsOf(run.calls).length, 1);
  assert.deepEqual(sleeps, []);
});

test('混合 502 和 403：非瞬态错误优先，不重试整批资产', async () => {
  const run = sequenceRun([viewDraft, result({code: 1, stderr: 'HTTP 502: Server Error\nHTTP 403: Forbidden\n'})]);
  const sleeps = [];
  assert.equal(await uploadDraftAssetsWithRetry({tag: TAG, files: FILES, run, sleep: makeSleep(sleeps), log: () => {}}), 1);
  assert.equal(uploadsOf(run.calls).length, 1);
  assert.deepEqual(sleeps, []);
});

test('ENOENT：不重试；核实阶段就 ENOENT 则零上挂，上挂阶段 ENOENT 退出 127', async () => {
  const enoent = result({ code: null, signal: null, error: 'ENOENT' });
  const before = sequenceRun([enoent]);
  const codeBefore = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run: before, sleep: makeSleep(), log: () => {} });
  assert.equal(codeBefore, 127);
  assert.equal(uploadsOf(before.calls).length, 0, '核实失败不产生任何上挂');

  const after = sequenceRun([viewDraft, enoent]);
  const codeAfter = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run: after, sleep: makeSleep(), log: () => {} });
  assert.equal(codeAfter, 127);
  assert.equal(uploadsOf(after.calls).length, 1);
});

test('超时：不重试退出 124；核实阶段超时则零上挂', async () => {
  const timedOut = result({ code: null, signal: 'SIGKILL', timedOut: true });
  const before = sequenceRun([timedOut]);
  const codeBefore = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run: before, sleep: makeSleep(), log: () => {} });
  assert.equal(codeBefore, 124);
  assert.equal(uploadsOf(before.calls).length, 0);

  const after = sequenceRun([viewDraft, timedOut]);
  const codeAfter = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run: after, sleep: makeSleep(), log: () => {} });
  assert.equal(codeAfter, 124);
  assert.equal(uploadsOf(after.calls).length, 1);
});

test('被信号终止：不重试，退出 128+信号号', async () => {
  for (const [signal, expected] of [['SIGTERM', 143], ['SIGKILL', 137]]) {
    const run = sequenceRun([viewDraft, result({ code: null, signal })]);
    const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run, sleep: makeSleep(), log: () => {} });
    assert.equal(code, expected, `${signal} → ${expected}`);
    assert.equal(uploadsOf(run.calls).length, 1, `${signal} 不重试`);
  }
});

test('非草稿（isDraft=false）：零上挂直接停', async () => {
  const run = sequenceRun([viewFormal]);
  const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run, sleep: makeSleep(), log: () => {} });
  assert.notEqual(code, 0);
  assert.equal(uploadsOf(run.calls).length, 0);
});

test('草稿核实失败（gh view 非零 / 输出不是 JSON）：零上挂直接停', async () => {
  for (const step of [result({ code: 1, stderr: 'HTTP 404: Not Found\n' }), result({ stdout: 'not-json' }), result({ stdout: '' })]) {
    const run = sequenceRun([step]);
    const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run, sleep: makeSleep(), log: () => {} });
    assert.notEqual(code, 0);
    assert.equal(uploadsOf(run.calls).length, 0, '核实失败绝不产生资产副作用');
    assert.deepEqual(run.calls[0].argv, VIEW_ARGV);
  }
});

test('第一次上挂 502 后草稿变正式：不再有第二次上挂', async () => {
  const run = sequenceRun([viewDraft, gh502, viewFormal]);
  const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: FILES, run, sleep: makeSleep(), log: () => {} });
  assert.notEqual(code, 0);
  assert.equal(uploadsOf(run.calls).length, 1, '变正式后必须立即停');
  assert.equal(viewsOf(run.calls).length, 2, '重试前重新核实过一次');
});

test('路径含空格：argv 原样单元素传递，不拆分', async () => {
  const spaced = ['release/Hemi Setup 0.2.59.exe', 'release/my assets/latest.yml'];
  const run = sequenceRun([viewDraft, result()]);
  const code = await uploadDraftAssetsWithRetry({ tag: TAG, files: spaced, run, sleep: makeSleep(), log: () => {} });
  assert.equal(code, 0);
  assert.deepEqual(run.calls[1].argv, ['release', 'upload', TAG, ...spaced, '--clobber']);
});

test('参数守卫：缺 tag/文件、旗标样路径一律拒绝', () => {
  assert.throws(() => validateUploadArgs('', FILES), /缺 tag/);
  assert.throws(() => validateUploadArgs('-evil', FILES), /-/);
  assert.throws(() => validateUploadArgs(TAG, []), /至少/);
  assert.throws(() => validateUploadArgs(TAG, ['-clobber']), /-/);
  assert.throws(() => validateUploadArgs(TAG, ['ok.txt', '']), /非空字符串/);
});

test('classifyRunFailure：表驱动覆盖退出码映射', () => {
  const cases = [
    [result({ code: null, error: 'ENOENT' }), { retryable: false, exitCode: 127 }],
    [result({ code: null, error: 'EACCES' }), { retryable: false, exitCode: 126 }],
    [result({ code: null, timedOut: true, signal: 'SIGKILL' }), { retryable: false, exitCode: 124 }],
    [result({ code: null, signal: 'SIGINT' }), { retryable: false, exitCode: 130 }],
    [result({ code: 1, stderr: 'HTTP 504: Gateway Timeout\n' }), { retryable: true, exitCode: 1 }],
    [result({ code: 1, stderr: 'HTTP 5001: weird\n' }), { retryable: false, exitCode: 1 }],
    [result({ code: 1, stderr: 'some other failure\n' }), { retryable: false, exitCode: 1 }],
  ];
  for (const [input, expected] of cases) {
    const cls = classifyRunFailure(input);
    assert.equal(cls.retryable, expected.retryable);
    assert.equal(cls.exitCode, expected.exitCode, `${JSON.stringify(input)} → ${expected.exitCode}`);
  }
});

// ── 子进程边界：fake gh 脚本 + 真实入口（Windows 上跳过，sh 脚本不可执行）──

const POSIX = process.platform !== 'win32';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const ENTRY = path.join(ROOT, 'scripts', 'upload-draft-assets.mjs');

/** fake gh：按 FAKE_GH_PLAN 第 n 行回放结果，argv 每参数一行记进 FAKE_GH_LOG。 */
function makeFakeGh(dir) {
  const binDir = path.join(dir, 'bin');
  mkdirSync(binDir, { recursive: true });
  const gh = path.join(binDir, 'gh');
  writeFileSync(gh, [
    '#!/bin/sh',
    'n=$(cat "$FAKE_GH_SEQ" 2>/dev/null || echo 0)',
    'n=$((n + 1))',
    'echo "$n" > "$FAKE_GH_SEQ"',
    'echo "#call $n" >> "$FAKE_GH_LOG"',
    'printf \'%s\\n\' "$@" >> "$FAKE_GH_LOG"',
    'plan=$(sed -n "${n}p" "$FAKE_GH_PLAN")',
    'case "$plan" in',
    '  draft) echo \'{"isDraft":true}\'; exit 0 ;;',
    '  formal) echo \'{"isDraft":false}\'; exit 0 ;;',
    '  ok) exit 0 ;;',
    '  502) echo \'HTTP 502: Server Error (https://api.github.com/repos/PiuQiuPiaQia/Hemi/releases/assets/709101156)\' >&2; exit 1 ;;',
    '  403-7) echo \'HTTP 403: Resource not accessible by integration\' >&2; exit 7 ;;',
    '  sigterm) kill -TERM $$ ;;',
    '  hang) exec sleep 30 ;;',
    '  *) echo "fake-gh: unknown plan $plan" >&2; exit 99 ;;',
    'esac',
    '',
  ].join('\n'), { mode: 0o755 });
  chmodSync(gh, 0o755);
  return gh;
}

/** 解析 FAKE_GH_LOG：[[argv1...], [argv2...]]，每参数一行，空格原样保留。 */
function parseCalls(logPath) {
  const lines = readFileSync(logPath, 'utf8').split('\n');
  const calls = [];
  let current = null;
  for (const line of lines) {
    if (line.startsWith('#call ')) { current = []; calls.push(current); continue; }
    if (current && line !== '') current.push(line);
  }
  return calls;
}

/** 真实跑入口脚本；返回 { status, calls }。 */
function runEntry({ dir, gh, plan, tag = TAG, files }) {
  const planPath = path.join(dir, 'plan.txt');
  const seqPath = path.join(dir, 'seq');
  const logPath = path.join(dir, 'calls.log');
  writeFileSync(planPath, `${plan.join('\n')}\n`);
  const env = {
    ...process.env,
    PATH: gh ? `${path.dirname(gh)}${path.delimiter}${process.env.PATH ?? ''}` : path.join(dir, 'empty-bin'),
    FAKE_GH_PLAN: planPath,
    FAKE_GH_SEQ: seqPath,
    FAKE_GH_LOG: logPath,
    HEMI_UPLOAD_RETRY_DELAYS_MS: '10',
  };
  mkdirSync(path.join(dir, 'empty-bin'), { recursive: true });
  const spawned = spawnSync(process.execPath, [ENTRY, tag, ...files], { env, encoding: 'utf8', timeout: 60_000 });
  const calls = (() => { try { return parseCalls(logPath); } catch { return null; } })();
  return { status: spawned.status, signal: spawned.signal, stderr: spawned.stderr, stdout: spawned.stdout, calls };
}

function makeAssets(dir) {
  const assets = [path.join(dir, 'Hemi Setup 0.2.59.exe'), path.join(dir, 'latest.yml')];
  for (const asset of assets) writeFileSync(asset, 'fake asset bytes');
  return assets;
}

test('边界：502 后同参数重试成功；空格路径在真实子进程链路里不拆分；退出 0', { skip: !POSIX && 'sh 脚本边界仅 POSIX' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-upload-test-'));
  try {
    const gh = makeFakeGh(dir);
    const assets = makeAssets(dir);
    const run = runEntry({ dir, gh, plan: ['draft', '502', 'draft', 'ok'], files: assets });
    assert.equal(run.status, 0, `stderr: ${run.stderr}`);
    assert.equal(run.calls.length, 4, 'view+upload+view+upload');
    const [view1, upload1, view2, upload2] = run.calls;
    assert.deepEqual(view1, ['release', 'view', TAG, '--json', 'isDraft']);
    assert.deepEqual(upload1, upload2, '重试同一批参数');
    assert.deepEqual(upload1, ['release', 'upload', TAG, ...assets, '--clobber']);
    assert.ok(assets[0].includes(' '), '用例前提：路径确实带空格');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边界：403 退出真实非 0（透传 gh 的 7）且不被吞、不重试', { skip: !POSIX && 'sh 脚本边界仅 POSIX' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-upload-test-'));
  try {
    const gh = makeFakeGh(dir);
    const assets = makeAssets(dir);
    const run = runEntry({ dir, gh, plan: ['draft', '403-7'], files: assets });
    assert.equal(run.status, 7, `stderr: ${run.stderr}`);
    assert.equal(run.calls.length, 2, '只核实+上挂各一次，无重试');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边界：release 已非草稿时零上挂，退出非 0', { skip: !POSIX && 'sh 脚本边界仅 POSIX' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-upload-test-'));
  try {
    const gh = makeFakeGh(dir);
    const assets = makeAssets(dir);
    const run = runEntry({ dir, gh, plan: ['formal'], files: assets });
    assert.notEqual(run.status, 0);
    assert.equal(run.calls.length, 1, '只有一次 view，零 upload');
    assert.deepEqual(run.calls[0], ['release', 'view', TAG, '--json', 'isDraft']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边界：gh 不在 PATH → 退出 127 且零调用', { skip: !POSIX && 'sh 脚本边界仅 POSIX' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-upload-test-'));
  try {
    const assets = makeAssets(dir);
    const run = runEntry({ dir, gh: null, plan: ['ok'], files: assets });
    assert.equal(run.status, 127, `stderr: ${run.stderr}`);
    assert.equal(run.calls, null, 'fake gh 从未被调用');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('边界：上挂被 SIGTERM → 退出 143 不重试', { skip: !POSIX && 'sh 脚本边界仅 POSIX' }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-upload-test-'));
  try {
    const gh = makeFakeGh(dir);
    const assets = makeAssets(dir);
    const run = runEntry({ dir, gh, plan: ['draft', 'sigterm'], files: assets });
    assert.equal(run.status, 143, `stderr: ${run.stderr}`);
    assert.equal(run.calls.length, 2, '无重试');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runGh 绑定：正常退出取 stdout；hang 超时被杀 timedOut=true', { skip: !POSIX && 'sh 脚本边界仅 POSIX' }, async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'hemi-upload-test-'));
  try {
    const gh = makeFakeGh(dir);
    const planPath = path.join(dir, 'plan.txt');
    writeFileSync(planPath, 'draft\nhang\n');
    const env = {
      ...process.env,
      FAKE_GH_PLAN: planPath,
      FAKE_GH_SEQ: path.join(dir, 'seq'),
      FAKE_GH_LOG: path.join(dir, 'calls.log'),
    };
    const okRes = await runGh(['release', 'view', TAG, '--json', 'isDraft'], { ghBin: gh, env, timeoutMs: 10_000 });
    assert.equal(okRes.code, 0);
    assert.equal(JSON.parse(okRes.stdout).isDraft, true);

    const hangRes = await runGh(['release', 'view', TAG, '--json', 'isDraft'], { ghBin: gh, env, timeoutMs: 150 });
    assert.equal(hangRes.timedOut, true);
    assert.notEqual(hangRes.code, 0, '超时结果必须非 0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Windows 真机生产链验收：runCommand → windows-command-job.exe → cmd.exe /d /s /c "<命令>"。
// 不 mock 任何进程；每步用 Node fs 独立断言磁盘，覆盖 PowerShell 文件增删改查、
// cmd 基础操作、中文/空格/单引号/&/括号路径、emoji/美元/引号内容、UTF-8 输出、
// 管道、真实错误 exit/stderr，以及 -Command 与 -EncodedCommand 的引号差异。
// 已知语义（本文件固化，勿当 bug 改掉）：
//  1) powershell.exe 输出/错误默认按 OEM 码页写管道，Node 按 UTF-8 解码会乱码；
//     脚本先 [Console]::OutputEncoding=[Text.Encoding]::UTF8 才能精确往返。
//  2) -Command "..." 内嵌裸双引号会被 powershell.exe 的命令行解析吞掉（相邻块
//     拼接），需写成 ""（cmd 不动内层引号，powershell 参数解析还原）或 \"；
//     -EncodedCommand（UTF-16LE base64，字母表无 cmd 元字符）不受影响。
//  3) PS 5.1 Set-Content/-Encoding UTF8 写 BOM；默认编码是 ANSI（GBK 系统可表
//     中文但表不了 emoji）。路径里的单引号在 PS 单引号字面量中要加倍（''）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { realpath } from 'node:fs/promises';
import { runCommand, commandToolResult } from './command-execution.mjs';
import { hemiCommandTool } from './file-tools.mjs';
import { createPermissionService } from '../../services/permission-service.mjs';
import { createAccessContext } from './access-context.mjs';

const windows = { skip: process.platform === 'win32' ? false : 'Windows 真机 cmd/PowerShell 链路验收' };
const run = (command, cwd, extra = {}) => runCommand({ command, cwd, timeoutMs: 60_000, ...extra });
/** 普通 -Command：script 里字面的 " 需先加倍为 ""（见文件头说明 2）。 */
const psCommand = (script) => `powershell.exe -NoProfile -NonInteractive -Command "${script.replaceAll('"', '""')}"`;
/** -EncodedCommand：整段脚本 base64(UTF-16LE)，绕开一切命令行引号解析。 */
const psEncoded = (script) => `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
/** PS 单引号字面量：内嵌单引号加倍。 */
const psq = (value) => `'${value.replaceAll("'", "''")}'`;
/** PowerShell 写 stdout/stderr 前切 UTF-8，保证 Node 侧按 UTF-8 解码可往返。 */
const UTF8 = '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ';
const readText = async (file) => fs.readFile(file, 'utf8');
const exists = async (target) => fs.stat(target).then((s) => s, () => null);

test('PowerShell -Command 文件 CRUD 全链路逐步落盘：中文/空格/&/括号路径，UTF-8 内容含 emoji/美元/单双引号', { ...windows, timeout: 180_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-ps-crud-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const folder = '数据 目录 &（一）';
  const file = 'note 货币$表.txt';
  const content = "中文😀钱$符号'单引号\"双引号";

  // New-Item：目录真实创建，命令以相对路径走 runCommand 的 cwd。
  let out = await run(psCommand(`New-Item -ItemType Directory -Path ${psq(folder)} | Out-Null`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal((await exists(path.join(dir, folder)))?.isDirectory(), true);

  // Set-Content -Encoding UTF8：PS 5.1 写 BOM；单引号加倍、双引号按命令行层级加倍。
  out = await run(psCommand(`Set-Content -LiteralPath ${psq(file)} -Encoding UTF8 -Value ${psq(content)}`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  const raw = await fs.readFile(path.join(dir, file));
  assert.deepEqual([...raw.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'UTF8 参数应写入 BOM');
  assert.equal(raw.toString('utf8'), `\ufeff${content}\r\n`, '内容须逐字符往返（emoji/美元/单双引号）');

  // Get-Content + UTF-8 stdout：emoji 也精确回到 Node 侧。
  out = await run(psCommand(`${UTF8}(Get-Content -LiteralPath ${psq(file)} -Encoding UTF8 -Raw).TrimEnd([char]13, [char]10)`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(out.stdout.trimEnd('\r\n'), content, 'UTF8 前缀后 stdout 应逐字符等于文件内容');

  // Get-ChildItem：中文名清单。
  out = await run(psCommand(`${UTF8}Get-ChildItem -LiteralPath . -File -Name`), dir);
  assert.equal(out.stdout.trimEnd('\r\n'), file);

  // Select-String：按内容检索（BOM UTF8 自动识别）。
  out = await run(psCommand(`@(Select-String -LiteralPath ${psq(file)} -Pattern '钱\\$符号').Count`), dir);
  assert.equal(out.stdout.trimEnd('\r\n'), '1');

  // Add-Content：追加为第二行。
  out = await run(psCommand(`Add-Content -LiteralPath ${psq(file)} -Encoding UTF8 -Value '第二行 append 😀'`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.deepEqual((await readText(path.join(dir, file))).replace(/^\ufeff/, '').split('\r\n'), [content, '第二行 append 😀', '']);

  // 替换更新：-replace 后整体重写，磁盘独立复核。
  out = await run(psCommand(`$c = Get-Content -LiteralPath ${psq(file)} -Encoding UTF8 -Raw; $c = $c -replace '第二行', 'second😀行'; Set-Content -LiteralPath ${psq(file)} -Encoding UTF8 -NoNewline -Value $c`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await readText(path.join(dir, file)), `\ufeff${content}\r\nsecond😀行 append 😀\r\n`);

  // Rename-Item / Copy-Item / Move-Item / Remove-Item：每步 Node 复核。
  const renamed = '更名 &（二）.txt', copy = '副本（copy）.txt', sub = path.posix.join(folder, 'sub 子目录');
  out = await run(psCommand(`Rename-Item -LiteralPath ${psq(file)} -NewName ${psq(renamed)}; New-Item -ItemType Directory -Path ${psq(sub)} | Out-Null; Copy-Item -LiteralPath ${psq(renamed)} -Destination ${psq(copy)}; Move-Item -LiteralPath ${psq(copy)} -Destination ${psq(sub)}`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await exists(path.join(dir, file)), null, '原名应消失');
  const renamedBytes = await fs.readFile(path.join(dir, renamed));
  const movedBytes = await fs.readFile(path.join(dir, folder, 'sub 子目录', copy));
  assert.deepEqual(renamedBytes, movedBytes, '复制体与原件逐字节一致');
  out = await run(psCommand(`Remove-Item -LiteralPath ${psq(renamed)}; Remove-Item -LiteralPath ${psq(folder)} -Recurse`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await exists(path.join(dir, renamed)), null);
  assert.equal(await exists(path.join(dir, folder)), null, '递归删除后目录消失');
});

test('路径本身含单引号：PS 单引号字面量加倍后 -Command 与 -EncodedCommand 行为一致', { ...windows, timeout: 120_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-ps-quote-path-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const name = "阶段'一'&（beta）.txt";
  const target = `更名 '名字' &（二）.txt`;

  // -Command：'' 加倍转义。
  let out = await run(psCommand(`Set-Content -LiteralPath ${psq(name)} -Encoding UTF8 -Value 'v1 $😀'`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await readText(path.join(dir, name)), `\ufeffv1 $😀\r\n`);
  out = await run(psCommand(`${UTF8}Get-ChildItem -Name`), dir);
  assert.equal(out.stdout.trimEnd('\r\n'), name, '含单引号文件名经 UTF-8 stdout 往返');
  out = await run(psCommand(`Rename-Item -LiteralPath ${psq(name)} -NewName ${psq(target)}; Test-Path -LiteralPath ${psq(target)}`), dir);
  assert.equal(out.stdout.trimEnd('\r\n'), 'True');
  assert.equal(await exists(path.join(dir, name)), null);
  assert.notEqual(await exists(path.join(dir, target)), null);

  // -EncodedCommand：同一路径数据无需任何命令行转义。
  out = await run(psEncoded(`Set-Content -LiteralPath ${psq(name)} -Encoding UTF8 -Value 'v2 "q" 😀'; Get-Content -LiteralPath ${psq(name)} -Encoding UTF8 -Raw`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await readText(path.join(dir, name)), `\ufeffv2 "q" 😀\r\n`);
});

test('-Command 内嵌双引号解析矩阵：裸引号被吞是 powershell 命令行语义；"" 与 \\" 及 EncodedCommand 保留原文', { ...windows, timeout: 120_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-ps-dquote-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // 裸 "：powershell.exe 解析自己的命令行时结束引定块并吞掉该引号（相邻块拼接），内容丢引号。
  let out = await run(`powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath raw.txt -Value 'a"b'"`, dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await readText(path.join(dir, 'raw.txt')), 'ab\r\n', '裸内嵌双引号会被吞（已知语义，修复方式见下两行）');

  // "" 加倍：cmd 不动内层引号，powershell 参数解析还原成一个 "。
  out = await run(psCommand(`Set-Content -LiteralPath doubled.txt -Value ${psq('a"b')}`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await readText(path.join(dir, 'doubled.txt')), 'a"b\r\n');

  // \" 反斜杠转义：powershell 命令行解析同样还原成一个 "。
  out = await run(`powershell.exe -NoProfile -NonInteractive -Command "Set-Content -LiteralPath backslash.txt -Value 'a\\"b'"`, dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await readText(path.join(dir, 'backslash.txt')), 'a"b\r\n');

  // -EncodedCommand：原始脚本逐字符送达，无需任何转义。
  out = await run(psEncoded(`Set-Content -LiteralPath encoded.txt -Value 'a"b'`), dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal(await readText(path.join(dir, 'encoded.txt')), 'a"b\r\n');
});

test('输出编码与真实错误：UTF8 前缀后中文 emoji 精确往返；OEM 码页默认乱码；错误 exit 非 0 且 stderr 非空', { ...windows, timeout: 120_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-ps-encoding-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));

  // 系统控制台码页决定默认输出字节；非 65001 时中文必乱码（Node 侧按 UTF-8 解码）。
  const probe = await run('powershell.exe -NoProfile -NonInteractive -Command "[Console]::OutputEncoding.CodePage"', dir);
  const codePage = Number(probe.stdout.trim());
  const mojibake = await run(psCommand('Write-Output 中文😀测试'), dir);
  assert.equal(mojibake.status, 'succeeded', JSON.stringify(mojibake));
  if (codePage !== 65001) {
    assert.notEqual(mojibake.stdout.trimEnd('\r\n'), '中文😀测试', `OEM 码页 ${codePage} 下默认输出不是 UTF-8，应乱码/丢字（已知语义，脚本内须切 UTF8）`);
  }

  // 加 UTF8 前缀：中文+emoji 精确往返（这是 Hemi 能保证的契约）。
  const exact = await run(psCommand(`${UTF8}Write-Output 中文😀测试`), dir);
  assert.equal(exact.status, 'succeeded', JSON.stringify(exact));
  assert.equal(exact.stdout.trimEnd('\r\n'), '中文😀测试');

  // 管道 + UTF-8 输出。
  const piped = await run(psCommand(`${UTF8}Write-Output '中文行' | ForEach-Object { $_.Length }`), dir);
  assert.equal(piped.stdout.trimEnd('\r\n'), '3');

  // 真实错误：不存在的文件，-ErrorAction Stop → exit 1，stderr 非空（-Command 的 stderr 是明文）。
  const failed = await run(psCommand(`Get-Content -LiteralPath no-such-hemi-file.txt -ErrorAction Stop`), dir);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.code, 1);
  assert.match(failed.stderr, /Get-Content/);
  assert.equal(commandToolResult(failed).isError, true);

  // 显式 exit 码原样传播。
  const exited = await run(psCommand('exit 3'), dir);
  assert.equal(exited.code, 3);
  assert.equal(exited.status, 'failed');

  // cmd 找不到命令：exit 1，stderr 提到命令名（ASCII 在任何 OEM 码页下不变）。
  const missing = await run('no-such-hemi-exe-xyz --flag', dir);
  assert.equal(missing.status, 'failed');
  assert.equal(missing.code, 1);
  assert.match(missing.stderr, /no-such-hemi-exe-xyz/);
});

test('cmd 基础文件操作与当前目录：重定向/type/管道 findstr/cd/del/if exist，中文 & 括号路径', { ...windows, timeout: 120_000 }, async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-cmd-files-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const sub = '子 目录 &（二）';
  const file = 'f（1）&x.txt';

  let out = await run(`mkdir "${sub}"& echo hello cmd>"${file}"& type "${file}"`, dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.match(out.stdout, /hello cmd/);
  assert.equal((await exists(path.join(dir, sub)))?.isDirectory(), true);
  assert.equal((await readText(path.join(dir, file))).trim(), 'hello cmd');

  // 管道：type | findstr。
  out = await run(`type "${file}" | findstr "hello"`, dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.match(out.stdout, /hello cmd/);

  // 当前目录：cd 在同一 cmd 进程内生效，相对路径落到新 cwd。
  out = await run(`cd "${sub}"& echo inner> inner.txt`, dir);
  assert.equal(out.status, 'succeeded', JSON.stringify(out));
  assert.equal((await readText(path.join(dir, sub, 'inner.txt'))).trim(), 'inner');

  // 条件判断 + 删除 + 真实退出码。
  // 给每个 IF/ELSE 整体分组，避免后续 & 命令落入 ELSE 分支而被跳过。
  out = await run(`(if exist "${file}" (echo FOUND) else (echo MISSING)) & del "${file}" & (if exist "${file}" (echo BAD) else (echo GONE)) & exit 5`, dir);
  assert.equal(out.code, 5);
  assert.match(out.stdout, /FOUND/);
  assert.match(out.stdout, /GONE/);
  assert.equal(await exists(path.join(dir, file)), null);
});

test('hemiCommandTool 注册的 bash 工具走同一生产链：按 access.cwd 执行 PowerShell 并落盘', { ...windows, timeout: 120_000 }, async (t) => {
  const raw = await fs.mkdtemp(path.join(os.tmpdir(), 'hemi-bash-tool-'));
  t.after(() => fs.rm(raw, { recursive: true, force: true }));
  const root = await realpath(raw);
  const workspace = path.join(root, 'ws');
  await fs.mkdir(workspace);
  const service = createPermissionService({ dir: path.join(root, 'store'), nowFn: () => 1 });
  await service.load();
  const access = createAccessContext({ service, taskId: 't1', home: root, workspaceDir: workspace, listAppWindows: async () => [] });
  const tools = new Map();
  hemiCommandTool({ registerTool: (spec) => tools.set(spec.name, spec) }, { config: { access } });
  const bash = tools.get('bash');
  assert.ok(bash, 'bash 工具应被注册');

  const out = await bash.execute('id', {
    command: psCommand(`Set-Content -LiteralPath '工具落盘 $名.txt' -Encoding UTF8 -Value 'from bash tool 😀'`),
    description: '验收 PowerShell 落盘',
    timeout_ms: 60_000,
  });
  assert.notEqual(out.isError, true, out?.content?.map((c) => c.text ?? '').join(''));
  assert.match(out.content[0].text, /exit=0 · succeeded/);
  assert.equal(await readText(path.join(workspace, '工具落盘 $名.txt')), '\ufefffrom bash tool 😀\r\n');
});

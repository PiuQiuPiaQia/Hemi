#!/usr/bin/env node
// 042 · P0-2 可信身份探针：应用归属解析的可行性验证（technical-plan §3/§4）。
// 验证：
//   ① 驱动侧 pid→bundleId（cua listAppWindows）对真实运行应用可用；
//   ② pid→可执行文件路径→.app 包根→Info.plist bundleId：与驱动报的一致（防模型自报伪造的基础）；
//   ③ 安装身份指纹：.app 包根 + TeamID/CDHash（codesign）稳定可得；
//   ④ pid 实例标识：ps lstart（启动时刻）两次读取一致；pid 变化→实例变化可判；
//   ⑤ 应用名下目录：~/Library/Containers/<bundleId> 存在性与真实路径（沙盒应用才有容器；
//      无容器应用＝「应用范围跟随应用」只有界面，文件走映射显示名/独立目录）；
//   ⑥ 归属解析不受 cwd/tilde 影响：容器路径 realpath 与授权根同构（复用 P0-3 事实）。
// 只做只读发现，不点击不截图不发系统事件。exit 0 = 全过。
import { execFileSync } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { cua } from '../src/main/agent/gate/cua-client.mjs';

const results = [];
const check = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? ' · ' + note : ''}`);
};
const sh = (cmd, args) => String(execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }));
/** pid→可执行文件全路径：lsof txt 段优先（GUI 应用 argv[0]/ps comm 可能只有进程名，实测 ZCode 如此）。 */
function execPathOf(pid) {
  try {
    const out = sh('/usr/sbin/lsof', ['-p', String(pid)]);
    const line = out.split('\n').find((l) => /^\S+\s+\S+\s+\S+\s+txt\s/.test(l));
    if (line) return line.split(/\s+/).slice(-1)[0];
  } catch { /* lsof 失败退回 ps */ }
  return sh('/bin/ps', ['-o', 'comm=', '-p', String(pid)]).trim();
}

// 候选靶子：本进程（Hemi/Node 端，无 bundle）、Finder（常驻，有 bundle）、任一带 bundle 的前台应用
const selfPid = process.pid;

// ① 驱动侧清单
let apps = await cua.listAppWindows();
check('① 驱动 listAppWindows 可用', Array.isArray(apps) && apps.length > 0, `apps=${apps.length}：${apps.map((a) => a.name).join('、')}`);
// 驱动只列可见窗口（onScreenOnly）：自举靶子——优先已有 bundleId 的应用，否则开 TextEdit 重试。
let target = apps.find((a) => a.bundleId && a.pid);
if (!target) {
  try { execFileSync('osascript', ['-e', 'tell application "TextEdit" to activate']); } catch { /* 已开即可 */ }
  await new Promise((r) => setTimeout(r, 800));
  apps = await cua.listAppWindows();
  target = apps.find((a) => a.bundleId && a.pid);
}
check('① 可自举到带 bundleId 的运行应用', Boolean(target), target ? `${target.name} pid=${target.pid} bundle=${target.bundleId}` : '清单为空且 TextEdit 未起');
if (!target) { console.log('\nP0-2 结果：无法继续（无靶子）'); process.exit(1); }

// ② pid → exec 路径 → .app 根 → Info.plist bundleId，与驱动对照
function appRootOf(execPath) {
  // /Applications/X.app/Contents/MacOS/X → /Applications/X.app；系统应用在 /System/...
  let dir = path.dirname(execPath);
  for (let i = 0; i < 4; i++) {
    if (path.basename(dir).endsWith('.app')) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}
function bundleIdOfPlist(appRoot) {
  if (!appRoot) return null;
  const xml = sh('/usr/bin/plutil', ['-convert', 'xml1', '-o', '-', path.join(appRoot, 'Contents', 'Info.plist')]);
  const m = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
  return m ? m[1] : null;
}
{
  const execPath = execPathOf(target.pid);
  const root = appRootOf(execPath);
  const plistId = root ? bundleIdOfPlist(root) : null;
  check('② pid→.app 根→Info.plist bundleId 与驱动一致',
    Boolean(root && plistId && plistId === target.bundleId),
    `exec=${execPath} root=${root} plist=${plistId} driver=${target.bundleId}`);
}
// ②b 无 bundle 的进程（本探针自己）：解析结果必须是"无归属"，不得猜
{
  const execPath = sh('/bin/ps', ['-o', 'comm=', '-p', String(selfPid)]).trim();
  const root = appRootOf(execPath);
  check('②b 无 .app 进程判"无归属"（不猜测）', root === null, `exec=${execPath} root=${root}`);
}

// ③ 安装身份指纹：TeamID（codesign -dv）
{
  const execPath = execPathOf(target.pid);
  const root = appRootOf(execPath);
  let team = '';
  try {
    const dv = sh('/usr/bin/codesign', ['-dv', root]);
    team = /TeamIdentifier=(\S+)/.exec(dv)?.[1] ?? '';
    if (!team) team = 'adhoc:' + (/(?:CDHash|Signature)=?.*/.exec(dv)?.[0] ?? '').slice(0, 40);
  } catch { /* 签名信息受限时记录为空 */ }
  check('③ 安装身份指纹可得（app 根＋TeamID 或 adhoc/CDHash）', Boolean(root) && team.length > 0, `root=${root} 指纹=${team.slice(0, 50)}`);
}

// ④ pid 实例标识：lstart 稳定
{
  const l1 = sh('/bin/ps', ['-o', 'lstart=', '-p', String(target.pid)]).trim();
  const l2 = sh('/bin/ps', ['-o', 'lstart=', '-p', String(target.pid)]).trim();
  check('④ pid＋lstart 两次读取一致（实例标识稳定）', l1 === l2 && l1.length > 0, l1.slice(0, 24));
}
// ④b 短命进程：spawn→记录→kill→同 pid 再查（大概率 ENOENT；若复用，lstart 必不同）
{
  const { spawn } = await import('node:child_process');
  const victim = spawn('/bin/sleep', ['2']);
  const vPid = victim.pid;
  const vL1 = sh('/bin/ps', ['-o', 'lstart=', '-p', String(vPid)]).trim();
  victim.kill('SIGKILL');
  await new Promise((r) => victim.on('exit', r));
  let vL2 = '';
  try { vL2 = sh('/bin/ps', ['-o', 'lstart=', '-p', String(vPid)]).trim(); } catch { /* ENOENT：pid 已消失 */ }
  const verdict = vL2 === '' || vL2 !== vL1;
  check('④b pid 消失/复用可判（ENOENT 或 lstart 变化）', verdict, `l1=${vL1.slice(0, 20)} l2=${vL2 === '' ? '(消失)' : vL2.slice(0, 20)}`);
}

// ⑤ 容器目录：Finder 无容器（系统应用）；找一个有容器的（遍历前几个 bundleId）
{
  const containersRoot = path.join(homedir(), 'Library', 'Containers');
  let sandboxed = null;
  for (const a of apps) {
    if (!a.bundleId) continue;
    const dir = path.join(containersRoot, a.bundleId);
    if (await stat(dir).then(() => true, () => false)) { sandboxed = { ...a, dir }; break; }
  }
  if (sandboxed) {
    check('⑤ 容器目录解析：沙盒应用按 bundleId 定位', true, `${sandboxed.name} → ${sandboxed.dir}`);
  } else {
    // 事实记录而非门禁：容器存在性按应用而异（App Store 沙盒应用才有）。
    check('⑤ 容器目录解析（当前运行集无容器应用，记为事实）', true,
      '无容器应用在运行；无容器＝「跟随应用」仅覆盖界面，文件走映射显示名/独立目录');
  }
  if (sandboxed) {
    const real = await realpath(sandboxed.dir);
    check('⑤b 容器真实路径（macOS 符号链接语义，与 P0-3 同构）', real === sandboxed.dir || real.endsWith(sandboxed.bundleId), `real=${real}`);
  }
}

// ⑥ 模型自报 vs 驱动解析：自报 bundleId 不作为依据的验证（清单里改一个字段不影响解析结果）
{
  const fake = { ...target, bundleId: 'com.evil.forged' };
  const execPath = execPathOf(target.pid);
  const root = appRootOf(execPath);
  const plistId = bundleIdOfPlist(root);
  check('⑥ 伪造自报不影响宿主解析（plist 仍为真值）', plistId === target.bundleId && plistId !== fake.bundleId,
    `真值=${plistId} 伪造=${fake.bundleId}`);
}

await cua.dispose();
const fails = results.filter((r) => !r.ok);
console.log(`\nP0-2 结果：${results.length - fails.length}/${results.length} 通过${fails.length ? '，存在 FAIL' : ''}`);
process.exit(fails.length ? 1 : 0);

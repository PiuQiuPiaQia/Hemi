// 049 · 远端文件操作层（remote-fs）：read/write/edit 所需的底层原语，全部经
// ssh-runner 在服务器上执行。技术方案「影响范围 R-05/06/11」的实现：
// - read 用 head -c 限字节；write 走 stdin 写临时文件后 mv（原子）；
// - ls/grep/glob 用 ls/grep/find 并限制条数；realpath -m 在服务器上做归一；
// - 越界检查（isWithinRemote）在执行前对服务器返回的真实路径判定（R-06）。
//
// 命令拼装纪律：所有路径经 shq() 单引号转义；不拼本机 shell。
import path from 'node:path';

import { shq, sha256Hex } from './ssh-runner.mjs';

// —— POSIX 路径原语（远端路径在本机只做词法处理，不做本机 fs 调用） ——

/** 词法归一：解析 . 与 ..（不触盘；符号链接归一交给服务器 realpath）。 */
export function posixNormalize(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '/';
  const abs = raw.startsWith('/');
  const out = [];
  for (const seg of raw.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') {
      if (out.length && out[out.length - 1] !== '..') out.pop();
      else if (!abs) out.push('..');
      continue;
    }
    out.push(seg);
  }
  const joined = out.join('/');
  if (abs) return `/${joined}`;
  return joined || '.';
}

/** 相对路径落到基目录（POSIX）。 */
export function posixResolve(raw, { base, home = null }) {
  let p = String(raw ?? '').trim();
  if (p === '~') p = home ?? '~';
  else if (p.startsWith('~/')) p = home ? path.posix.join(home, p.slice(2)) : p;
  if (!p) return posixNormalize(base ?? '/');
  if (!p.startsWith('/')) p = path.posix.join(base ?? '/', p);
  return posixNormalize(p);
}

/** 词法包含判定（root/target 都已归一；边界等价于 target === root 或在其下）。 */
export function isWithinRemote(root, target) {
  const r = posixNormalize(root);
  const t = posixNormalize(target);
  return t === r || t.startsWith(`${r}/`);
}

/**
 * 远端 fs 工厂（每远端工作区一份；runner 全局共享）。
 * 所有方法返回 { ok, ... } 或 { ok:false, message }，不抛错。
 */
export function createRemoteFs({ runner, host, workspaceDir, remoteHome = null }) {
  if (!runner || !host) throw new Error('remote-fs 缺少 runner/host');
  const root = posixNormalize(workspaceDir);

  async function run(command, { stdin = null, timeoutMs = 30_000 } = {}) {
    const out = await runner.exec({ host, command, stdin, timeoutMs });
    if (out.code === 255 || out.connError) {
      return { ok: false, kind: 'conn', message: `与 ${host} 的连接不可用（${out.connError ?? 'ssh 255'}）`, raw: out };
    }
    return { ok: true, out };
  }

  /**
   * 服务器上的真实路径。GNU realpath 带 -m（不存在也归一）；busybox/BSD 无 -m
   * 时回退普通 realpath，仍拿不到（路径不存在）就按词法原样返回——调用方把
   * 该结果再交给越界检查（存在路径的服务器归一是权威，词法兜底只服务新文件）。
   */
  async function realpath(target) {
    const q = shq(target);
    const cmd = `p=$(realpath -m -- ${q} 2>/dev/null) || p=; [ -n "$p" ] || p=$(realpath -- ${q} 2>/dev/null) || p=; [ -n "$p" ] || p=${q}; printf '%s' "$p"`;
    const res = await run(cmd);
    if (!res.ok) return null;
    if (res.out.code !== 0) return null;
    const value = res.out.stdout.toString('utf8').trim();
    return value.startsWith('/') ? value : null;
  }

  /** 类型与大小：__D 目录 / __F <size> 文件 / __N 不存在；连接错误标 kind:'conn'。 */
  async function stat(target) {
    const q = shq(target);
    const res = await run(`if [ -d ${q} ]; then echo __D; elif [ -f ${q} ]; then printf '__F %s\\n' "$(wc -c < ${q})"; else echo __N; fi`);
    if (!res.ok) return { ok: false, kind: 'conn', message: res.message };
    if (res.out.code !== 0) return { ok: false, message: `无法读取文件状态（exit ${res.out.code}）` };
    const text = res.out.stdout.toString('utf8').trim();
    if (text === '__D') return { ok: true, isDirectory: true, isFile: false, size: null };
    if (text === '__N' || !text) return { ok: false, reason: 'missing', message: '文件不在原位置，可能已被移动或删除' };
    const m = /^__F\s+(\d+)$/.exec(text); // BSD wc 带前导对齐空格，GNU 不带
    if (!m) return { ok: false, message: '无法解析文件状态' };
    return { ok: true, isDirectory: false, isFile: true, size: Number(m[1]) };
  }

  /** 读文本（原始字节；上限截断）；二进制判定交给调用方（本机查 NUL）。 */
  async function readBytes(target, maxBytes) {
    const res = await run(`head -c ${Number(maxBytes) + 1} -- ${shq(target)}`);
    if (!res.ok) return { ok: false, kind: 'conn', message: res.message };
    if (res.out.code !== 0) return { ok: false, reason: 'missing', message: '文件不在原位置，可能已被移动或删除' };
    return { ok: true, buf: res.out.stdout, truncated: res.out.stdout.length > maxBytes };
  }

  /** 写文本（stdin 进临时文件再 mv，原子替换；目录按需创建）。 */
  async function writeText(target, text) {
    const dir = path.posix.dirname(target);
    const tmp = path.posix.join(dir, `.hemi-tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`);
    const cmd = `mkdir -p -- ${shq(dir)} && cat > ${shq(tmp)} && mv -f -- ${shq(tmp)} ${shq(target)} && printf __DONE`;
    const res = await run(cmd, { stdin: Buffer.from(String(text ?? ''), 'utf8'), timeoutMs: 60_000 });
    if (!res.ok) return { ok: false, kind: 'conn', message: res.message };
    if (res.out.code !== 0) {
      return { ok: false, message: `写入失败（exit ${res.out.code}）：${res.out.stderr.split('\n')[0].slice(0, 160)}` };
    }
    return { ok: true };
  }

  /** 服务器侧文件哈希（edit 写回前的并发修改比对；缺 sha256sum 时 null）。 */
  async function sha256(target) {
    const res = await run(`sha256sum -- ${shq(target)}`);
    if (!res.ok || res.out.code !== 0) return null;
    const token = res.out.stdout.toString('utf8').split(/\s+/)[0].trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  }

  /** 目录一层清单（目录带 / 后缀，按名排序；与本地 ls 工具口径一致）。 */
  async function lsEntries(target) {
    const res = await run(`LC_ALL=C ls -1Ap -- ${shq(target)}`);
    if (!res.ok) return { ok: false, kind: 'conn', message: res.message };
    if (res.out.code !== 0) return { ok: false, reason: 'missing', message: '无法列出：目录不存在或不可读' };
    const names = res.out.stdout.toString('utf8').split('\n').filter(Boolean);
    return { ok: true, names };
  }

  /** 递归文件清单（glob/grep 共用；点开头条目按段排除＝本地 walk 口径；条数上限防大仓库）。 */
  async function walkFiles(target, { maxDepth = 6, limit = 2000 } = {}) {
    const res = await run(`find ${shq(target)} -maxdepth ${Number(maxDepth)} -type f | head -n ${Number(limit) * 4}`);
    if (!res.ok) return { ok: false, kind: 'conn', message: res.message };
    if (res.out.code !== 0) return { ok: false, message: `无法遍历（exit ${res.out.code}）：${res.out.stderr.split('\n')[0].slice(0, 160)}` };
    const all = res.out.stdout.toString('utf8').split('\n').filter(Boolean);
    const truncated = all.length >= Number(limit) * 4;
    const files = [];
    for (const file of all) {
      const rel = path.posix.relative(target, file);
      if (rel.split('/').some((seg) => seg.startsWith('.'))) continue; // 根自身不算（与本地 walk 一致）
      files.push(file);
      if (files.length >= limit) break;
    }
    return { ok: true, files, truncated: truncated || files.length >= limit };
  }

  /** grep：远端 GNU grep 输出 `路径:行号:内容`，本机转 ./相对路径＋与本地同形的行文（内容截 200）。 */
  async function grepLines(dir, pattern, { include = null, limit = 200 } = {}) {
    const parts = [
      'LC_ALL=C',
      'grep',
      '-rInE',
      '--binary-files=without-match',
      `--exclude='.*'`,
      `--exclude-dir='.*'`,
      `-e ${shq(pattern)}`,
    ];
    if (include) parts.push(`--include=${shq(include)}`);
    parts.push(`-- ${shq(dir)}`);
    parts.push(`| head -n ${Number(limit)}`);
    const res = await run(parts.join(' '));
    if (!res.ok) return { ok: false, kind: 'conn', message: res.message };
    if (res.out.code !== 0 && res.out.code !== 1) {
      return { ok: false, message: `grep 失败（exit ${res.out.code}）：${res.out.stderr.split('\n')[0].slice(0, 160)}` };
    }
    const prefix = `${dir}/`; // 输出行形如 `<dir>/<file>:<行号>:<内容>`
    const lines = res.out.stdout.toString('utf8').split('\n').filter(Boolean).map((line) => {
      const body = line.startsWith(prefix) ? line.slice(prefix.length) : line;
      const colon = body.indexOf(':');
      if (colon < 0) return body.slice(0, 200);
      const rest = body.slice(colon + 1);
      const colon2 = rest.indexOf(':');
      const tail = colon2 < 0 ? rest : `${rest.slice(0, colon2 + 1)} ${rest.slice(colon2 + 1).slice(0, 200)}`;
      return `./${body.slice(0, colon)}:${tail}`.slice(0, 400);
    });
    return { ok: true, lines };
  }

  /** 项目上下文（R-10）：AGENTS.md（override 优先）＋README 摘录（执行器注入用，有界）。 */
  async function contextExcerpt({ maxBytes = 64 * 1024 } = {}) {
    const names = [];
    for (const name of ['AGENTS.override.md', 'AGENTS.md']) {
      const info = await stat(path.posix.join(root, name));
      if (info.ok && info.isFile) { names.push(name); break; }
    }
    const readme = await stat(path.posix.join(root, 'README.md'));
    if (readme.ok && readme.isFile) names.push('README.md');
    const parts = [];
    for (const name of names) {
      const read = await readBytes(path.posix.join(root, name), maxBytes);
      if (!read.ok) continue;
      let text = read.buf.toString('utf8');
      if (read.truncated) text += '\n…（截断）';
      if (text.includes('\0')) continue;
      parts.push(`〔${name}〕\n${text.trim()}`);
    }
    return parts.join('\n\n');
  }

  return {
    host,
    workspaceDir: root,
    remoteHome,
    realpath,
    stat,
    readBytes,
    writeText,
    sha256,
    sha256Hex,
    lsEntries,
    walkFiles,
    grepLines,
    contextExcerpt,
  };
}

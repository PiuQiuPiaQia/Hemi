// 049 · 远端工具接管（S2）：与本机 hemiFileTools/hemiSandboxBash 同名注册
// read/write/edit/ls/grep/glob/bash，工具面、门控（pi-gate）、审批卡与任务状态机
// 全部原样复用——只有执行层换到 SSH 后端（技术方案「关键依据」）。
//
// R-05：远端工作区任务的文件与命令操作绝不在本机执行；
// R-06：范围判定＝本机词法快判 + 服务器 realpath 越界复核（执行层第二道防线）；
// R-07：远端 bash 以 SSH 登录用户身份在项目目录里跑（无 Seatbelt——审判同规则）。
import path from 'node:path';
import { randomBytes } from 'node:crypto';

import { shq } from './ssh-runner.mjs';
import { isWithinRemote, posixResolve } from './remote-fs.mjs';
import { globToRegExp } from '../agent/gate/file-tools.mjs';
import { hitsDenyPath } from '../agent/gate/pi-gate.mjs';
import { POLICY_PATHS, SYSTEM_WRITE_ROOTS_REMOTE } from '../agent/gate/policy.mjs';

const MAX_READ_BYTES = 512 * 1024;
const MAX_LIST = 200;
const MAX_GREP = 200;
const MAX_GLOB = 500;
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text) => ({ content: [{ type: 'text', text }] });
const connNote = (host, message) => `${message}（与 ${host} 的 SSH 连接或服务器状态异常）`;

/**
 * 049 · 远端任务访问上下文（pi-gate 与本模块共用；对齐 access-context 的查询面）。
 * 与本机版的差异：不接权限服务；路径解析按 POSIX＋远端 home。2026-10-15 文件夹授权
 * 退役：远端文件读写同样完全访问，守住的是硬拒清单（见 verifyRemoteScope），没有授权卡。
 */
export function createRemoteAccessContext({ taskId, host, workspaceDir, remoteHome = null }) {
  const root = posixResolve(workspaceDir, { base: '/' });

  const ctx = {
    taskId,
    host,
    remote: true,
    home: remoteHome,
    workspaceDir: root,
    cwd: root,

    /** 路径归一（gate 的 resolvePath 注入）：远端 home 缩短为 ~，显示带主机由卡面拼。 */
    resolvePath(raw) {
      const real = posixResolve(raw, { base: root, home: remoteHome });
      const display = remoteHome && (real === remoteHome || real.startsWith(`${remoteHome}/`))
        ? `~${real.slice(remoteHome.length)}`
        : real;
      return { raw: String(raw ?? ''), real, abs: real, display, host };
    },

    /** 远端没有本机控制面（授权库在本地 userData）。 */
    isControlPath() {
      return false;
    },

    /** 路径 → 范围：只标出项目目录（信息用；文件读写不按范围判）。 */
    scopeForPath(real) {
      return isWithinRemote(root, real) ? { kind: 'workspace', capability: 'edit' } : null;
    },

    /** 远端没有授权卡（桌面应用只在本机）；防御性实现。 */
    grantFromCard() {
      return { ok: false };
    },
    async grantPersistentFromCard() {
      return { ok: false };
    },
  };
  return ctx;
}

/**
 * 工具内二次复核（执行层防线）。2026-10-15 文件夹授权退役：不再按授权范围判，只按服务器
 * 真实路径（`..`/符号链接逃逸在这里现形）再判一次硬拒——家内敏感点文件（.ssh…）、Linux
 * 系统根区，与门控同一份清单（hitsDenyPath + denyPathRootsRemote）；系统目录不可写。
 */
/** 系统目录（不可写）——家目录内一律不算（家可能就在 /var、/opt 之下）。 */
function remoteSystemWrite(real, home) {
  if (home && isWithinRemote(home, real)) return false;
  return SYSTEM_WRITE_ROOTS_REMOTE.some((root) => real === root || real.startsWith(`${root}/`));
}

async function verifyRemoteScope(access, fs, target, needEdit) {
  const real = (await fs.realpath(target.abs)) ?? target.abs; // 新文件/连不上时按词法路径判
  const shown = `${access.host}:${target.display ?? target.abs}`;
  if (hitsDenyPath(real, access.home, POLICY_PATHS.denyPathRootsRemote)) {
    return `该路径在禁止清单内（${shown}${real !== target.abs ? ` → ${real}` : ''}）：凭据与系统敏感位置一律不访问。`;
  }
  if (needEdit && remoteSystemWrite(real, access.home)) {
    return `不能修改服务器的系统目录（${shown}${real !== target.abs ? ` → ${real}` : ''}）。`;
  }
  return null;
}

/**
 * 远端文件工具（read/write/edit/ls/grep/glob）——同名顶掉本机注册。
 * config: { access（createRemoteAccessContext 产物）, fs（createRemoteFs 产物）, log }
 */
export function hemiRemoteFileTools(pi, { config = {} } = {}) {
  const access = config.access;
  const fs = config.fs;
  const log = config.log;
  if (!access || !fs) return;
  const host = access.host;
  const resolve = (raw) => access.resolvePath(raw);

  pi.registerTool({
    name: 'read',
    label: '读取文件（服务器）',
    description: '读取文件内容（文本）。路径可相对任务工作目录（在服务器上解析）。二进制文件会明确提示。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] },
    async execute(_id, params) {
      const target = resolve(params?.path);
      const deny = await verifyRemoteScope(access, fs, target, false);
      if (deny) return err(deny);
      const info = await fs.stat(target.abs);
      if (!info.ok) {
        return info.kind === 'conn' ? err(connNote(host, info.message)) : err(`无法读取（${info.message ?? '不存在'}）：${host}:${target.display ?? target.abs}`);
      }
      if (info.isDirectory) return err(`这是文件夹，请用 ls：${host}:${target.display ?? target.abs}`);
      if (info.size > MAX_READ_BYTES) return ok(`文件过大（${info.size} 字节，上限 ${MAX_READ_BYTES}）：请用 grep 定位或分段说明需求`);
      const read = await fs.readBytes(target.abs, MAX_READ_BYTES);
      if (!read.ok) return err(connNote(host, read.message));
      if (read.buf.includes(0)) return ok('这是二进制文件，无法按文本读取');
      return ok(read.buf.toString('utf8'));
    },
  });

  pi.registerTool({
    name: 'write',
    label: '写入文件（服务器）',
    description: `在服务器 ${host} 上写入文件（整体覆盖；目录不存在会创建，仅限授权范围内）。`,
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '全文内容' } },
      required: ['path', 'content'],
    },
    async execute(_id, params) {
      const target = resolve(params?.path);
      const deny = await verifyRemoteScope(access, fs, target, true);
      if (deny) return err(deny);
      const text = String(params?.content ?? '');
      const wrote = await fs.writeText(target.abs, text);
      if (!wrote.ok) return err(connNote(host, wrote.message));
      return ok(`已写入 ${host}:${target.display ?? target.abs}（${text.length} 字符）`);
    },
  });

  pi.registerTool({
    name: 'edit',
    label: '修改文件（服务器）',
    description: `替换服务器 ${host} 上文件中的一段文本。old_string 必须与文件内容精确一致；写回前核对文件未被并发修改。`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: '替换全部匹配（默认只替换第一处）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(_id, params) {
      const target = resolve(params?.path);
      const deny = await verifyRemoteScope(access, fs, target, true);
      if (deny) return err(deny);
      const info = await fs.stat(target.abs);
      if (!info.ok && info.kind === 'conn') return err(connNote(host, info.message));
      let text = '';
      let existed = false;
      if (info.ok && info.isFile) {
        const read = await fs.readBytes(target.abs, MAX_READ_BYTES);
        if (!read.ok) return err(connNote(host, read.message));
        if (read.buf.includes(0)) return err('这是二进制文件，不能用 edit 修改');
        if (read.truncated) return err('文件超出可修改大小上限，请分段处理或用 bash');
        text = read.buf.toString('utf8');
        existed = true;
      }
      const oldS = String(params?.old_string ?? '');
      const newS = String(params?.new_string ?? '');
      if (!text.includes(oldS)) return err('old_string 在文件中找不到（注意空白与换行需完全一致）');
      const next = params?.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS);
      if (existed) {
        // 写回前核对内容哈希（服务器侧 sha256sum vs 本机同口径）：并发修改在这里现形。
        const before = fs.sha256Hex(text);
        const remote = await fs.sha256(target.abs);
        if (remote && remote !== before) {
          return err('文件在你读取之后被修改过（服务器上的内容已变化），为避免覆盖请重新读取后再改');
        }
      }
      const wrote = await fs.writeText(target.abs, next);
      if (!wrote.ok) return err(connNote(host, wrote.message));
      return ok(`已修改 ${host}:${target.display ?? target.abs}`);
    },
  });

  pi.registerTool({
    name: 'ls',
    label: '列出目录（服务器）',
    description: `列出服务器 ${host} 上目录的内容（名称＋类型），按名称排序。`,
    parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径（默认任务工作目录）' } } },
    async execute(_id, params) {
      const target = resolve(params?.path ?? '.');
      const deny = await verifyRemoteScope(access, fs, target, false);
      if (deny) return err(deny);
      const listed = await fs.lsEntries(target.abs);
      if (!listed.ok) return err(listed.kind === 'conn' ? connNote(host, listed.message) : `无法列出：${host}:${target.display ?? target.abs}`);
      const names = [...listed.names].sort((a, b) => a.replace(/\/$/, '').localeCompare(b.replace(/\/$/, '')));
      const shown = names.slice(0, MAX_LIST);
      return ok(shown.length
        ? `${shown.join('\n')}${names.length > MAX_LIST ? `\n…（共 ${names.length} 项，已截断）` : ''}`
        : '（空目录）');
    },
  });

  pi.registerTool({
    name: 'grep',
    label: '搜索文件内容（服务器）',
    description: `在服务器 ${host} 的目录内按正则搜索文件内容（逐行匹配，返回行号与内容）。path 默认任务工作目录。`,
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: '正则表达式' },
        path: { type: 'string', description: '搜索起点目录' },
        include: { type: 'string', description: '文件名过滤，如 *.md' },
      },
      required: ['pattern'],
    },
    async execute(_id, params) {
      const root = resolve(params?.path ?? '.');
      const deny = await verifyRemoteScope(access, fs, root, false);
      if (deny) return err(deny);
      try { new RegExp(String(params?.pattern ?? '')); } catch (e) { return err(`正则无效：${e.message}`); }
      const hit = await fs.grepLines(root.abs, String(params?.pattern ?? ''), { include: params?.include ? String(params.include) : null, limit: MAX_GREP });
      if (!hit.ok) return err(hit.kind === 'conn' ? connNote(host, hit.message) : hit.message);
      return ok(hit.lines.length ? hit.lines.join('\n') : '没有匹配');
    },
  });

  pi.registerTool({
    name: 'glob',
    label: '查找文件（服务器）',
    description: `按通配模式在服务器 ${host} 上查找文件（** 跨目录、* 单层），path 默认任务工作目录。`,
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: '如 **/*.md 或 *.txt' }, path: { type: 'string' } },
      required: ['pattern'],
    },
    async execute(_id, params) {
      const root = resolve(params?.path ?? '.');
      const deny = await verifyRemoteScope(access, fs, root, false);
      if (deny) return err(deny);
      const walked = await fs.walkFiles(root.abs);
      if (!walked.ok) return err(walked.kind === 'conn' ? connNote(host, walked.message) : walked.message);
      const matcher = globToRegExp(String(params?.pattern ?? '*'));
      const found = [];
      for (const file of walked.files) {
        const rel = `./${path.posix.relative(root.abs, file)}`;
        if (found.length < MAX_GLOB && matcher.test(rel)) found.push(rel);
      }
      return ok(found.length ? found.join('\n') : '没有匹配的文件');
    },
  });
}

/**
 * 远端 bash（R-07/R-08）：审判与本机同一套（pi-gate＋policy），执行＝SSH 登录用户
 * 在项目目录里跑。进程组纪律：setsid 包一层、pgid 落远端临时文件；超时/停止时
 * 另开连接按进程组 TERM→KILL（AC-06）。无 Seatbelt（不适用远端）。
 * config: { access, runner, log }
 */
export function hemiRemoteBash(pi, { config = {} } = {}) {
  const access = config.access;
  const runner = config.runner;
  const log = config.log;
  if (!access || !runner) return;
  const host = access.host;

  pi.registerTool({
    name: 'bash',
    label: '执行命令（服务器）',
    description: `在服务器 ${host} 的项目目录里以登录用户执行 shell 命令（经系统 SSH）。按与本机相同的规则申请确认；不在本机沙箱里运行。`,
    parameters: {
      type: 'object',
      properties: { command: { type: 'string', description: '要执行的命令' }, timeout_ms: { type: 'number', description: '超时毫秒（默认 120000）' } },
      required: ['command'],
    },
    async execute(_id, params, signal) {
      const command = String(params?.command ?? '');
      if (!command.trim()) return err('命令为空');
      const timeoutMs = Number(params?.timeout_ms) > 0 ? Number(params.timeout_ms) : 120_000;
      const nonce = randomBytes(6).toString('hex');
      const pgidFile = `/tmp/.hemi-pgid-${nonce}`;
      // cd 项目目录 →（有 setsid 就独立进程组）后台起命令、pgid 落临时文件供停止用；
      // wait 传播退出码。命令本体经 shq 原样作为 sh -c 的参数（不进本机 shell）。
      const wrapped = [
        `cd ${shq(access.workspaceDir)} || exit 71`,
        `if command -v setsid >/dev/null 2>&1; then setsid sh -c ${shq(command)} & else sh -c ${shq(command)} & fi`,
        `pid=$!`,
        `printf '%s' "$pid" > ${shq(pgidFile)}`,
        `wait "$pid"; rc=$?; rm -f ${shq(pgidFile)}; exit $rc`,
      ].join('\n');
      const startedAt = Date.now();
      const out = await runner.exec({
        host,
        command: wrapped,
        timeoutMs,
        signal,
        onKill: async () => {
          // 停止/超时：按记录的 pgid 杀远端进程组（TERM → 宽限 → KILL），清临时文件。
          const killCmd = `p=$(cat ${shq(pgidFile)} 2>/dev/null); if [ -n "$p" ]; then kill -TERM -- "-$p" 2>/dev/null; sleep 3; kill -KILL -- "-$p" 2>/dev/null; fi; rm -f ${shq(pgidFile)}`;
          await runner.exec({ host, command: killCmd, timeoutMs: 10_000 }).catch(() => {});
        },
      });
      log?.debug?.(`远端命令 ${out.code} · ${out.stdout.length}B · ${Date.now() - startedAt}ms · ${command.split('\n')[0].slice(0, 60)}`);
      if (out.connError) {
        return err(`与 ${host} 的连接中断，命令未能完成（${out.connError}）；已改动的文件留在服务器上，不会自动重跑。`);
      }
      const stderr = out.stderr.replace(/^__H49[^\n]*\n?/gm, '');
      const text = [
        out.stdout.toString('utf8'),
        stderr.trim() ? `stderr:\n${stderr}` : '',
        `exit=${out.code}${out.timedOut ? '（超时被终止）' : ''}${out.aborted ? '（已被停止）' : ''}`,
      ].filter(Boolean).join('\n');
      return { content: [{ type: 'text', text: text || `exit=${out.code}` }] };
    },
  });
}

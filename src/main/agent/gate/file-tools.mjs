/**
 * 042 · 文件与命令工具接管：同名注册顶掉 SDK 内置（P0-4 钉死：扩展同名工具
 * 的定义与执行都归我们）。文件工具（read/write/edit/ls/grep/glob）在执行层
 * 复核授权（safe-path 归一＋范围检查——门控已问过卡，这里是第二道防线）；
 * bash 按当前用户权限直接执行，进程生命周期由 command-execution 管理。
 */
import { readFile, readdir, mkdir } from 'node:fs/promises';
import path from 'node:path';

import { atomicWriteWithin, openVerifiedRead } from './safe-path.mjs';
import { runCommand, commandToolResult } from './command-execution.mjs';
import { COMMAND_FOREGROUND_MS, COMMAND_TIMEOUT_MS, COMMAND_BACKGROUND_TIMEOUT_MS } from './command-scope.mjs';
import { normalizeCommandDescription } from '../../../shared/command-display.mjs';
import { BACKGROUND_WAIT_GUIDANCE } from '../background-wait.mjs';
import { currentExecutionScope } from '../../agent-runtime/execution-scope.mjs';

const MAX_READ_BYTES = 512 * 1024;
export const MAX_IMAGE_READ_BYTES = 20 * 1024 * 1024;
const IMAGE_RESIZE_OPTIONS = { maxWidth: 2000, maxHeight: 2000, maxBytes: 4.5 * 1024 * 1024 };
const MAX_LIST = 200;
const MAX_GREP = 200;
const MAX_GLOB = 500;
const err = (text) => ({ content: [{ type: 'text', text }], isError: true });
const ok = (text) => ({ content: [{ type: 'text', text }] });

/** 按已打开句柄的内容识别，不凭扩展名把任意二进制发送为图片。 */
function imageMime(header) {
  if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return 'image/jpeg';
  if (/^GIF8[79]a/.test(header.toString('ascii', 0, 6))) return 'image/gif';
  if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

async function readImage(opened, mimeType, display, signal) {
  if (opened.stat.size > MAX_IMAGE_READ_BYTES) return err(`图片过大（${opened.stat.size} 字节，上限 ${MAX_IMAGE_READ_BYTES}）：请先缩小图片后再读取。`);
  // 多读一字节检测增长；不能让读取期间增长的文件绕过内存上限。
  const bytes = Buffer.alloc(opened.stat.size + 1);
  let length = 0;
  while (length < bytes.length) {
    signal?.throwIfAborted();
    const chunk = await opened.fh.read(bytes, length, Math.min(1024 * 1024, bytes.length - length), length);
    if (!chunk.bytesRead) break;
    length += chunk.bytesRead;
  }
  if (length !== opened.stat.size) return err('读取期间图片大小发生变化，请在文件写完后重新读取。');
  signal?.throwIfAborted();
  // SDK 的解码／缩放在 worker 中完成；复用现有依赖，不阻塞主进程做同步图像处理。
  const { resizeImage } = await import('@earendil-works/pi-coding-agent');
  const image = await resizeImage(bytes.subarray(0, length), mimeType, IMAGE_RESIZE_OPTIONS);
  signal?.throwIfAborted();
  if (!image) return err('图片无法解码或缩放（支持 PNG、JPEG、GIF、WebP）：请检查文件是否损坏，或转成较小的 PNG/JPEG 后再读取。');
  return {
    content: [
      { type: 'text', text: `图片：${display}（${image.originalWidth}×${image.originalHeight}）${image.wasResized ? `，本次图像已缩放为 ${image.width}×${image.height}` : ''}。` },
      { type: 'image', data: image.data, mimeType: image.mimeType },
    ],
    details: { image: { mimeType: image.mimeType, originalWidth: image.originalWidth, originalHeight: image.originalHeight, width: image.width, height: image.height, resized: image.wasResized } },
  };
}

/** 工具内二次授权复核：缺范围/缺能力 → 结构化错误（门控层应已问卡，这里是防线）。 */
function verifyScope(access, target, needEdit) {
  const scope = access.scopeForPath?.(target.real) ?? null;
  // 034 Skill 租约只读：受控版本目录不引导用户去拿「编辑」权限（门控层同款硬拒）。
  if (needEdit && scope?.kind === 'skill-lease') {
    return 'Skill 目录是 Hemi 管的受控版本（只读），不能修改。';
  }
  if (access.isControlPath?.(target.real)) return '该路径属于 Hemi 自身的控制文件，不能访问。';
  // 2026-10-15 用户裁决：本机文件读写默认完全访问（门控层已按硬拒清单拦了敏感路径）。
  // 执行层这道防线只复核控制面与 Skill 租约，不再要求文件夹授权。
  if (access.fullFileAccess) {
    // 硬拒按真实落点再判一次（工作区里的软链指向 ~/Library/Mail 之类时，门控按原始路径放过）。
    if (access.deniedRealPath?.(target.real)) return `路径在禁止清单内：${target.display ?? target.abs}（凭据与个人数据位置，Hemi 一律不访问，没有可打开的设置）`;
    if (needEdit && access.systemWriteRoot?.(target.real)) return `不能修改系统目录：${target.display ?? target.abs}`;
    return null;
  }
  if (!scope) {
    return `该路径不在任何已授权范围内（${target.display ?? target.abs}）。请先通过授权流程获得访问。`;
  }
  if (needEdit && scope.capability !== 'edit') {
    return `该位置只有「访问」权限，不能修改（${target.display ?? target.abs}）。需要「编辑」权限。`;
  }
  return null;
}

export default function hemiFileTools(pi, { config = {} } = {}) {
  const access = config.access;
  if (!access) return;

  const resolve = (raw) => access.resolvePath(raw);

  pi.registerTool({
    name: 'read',
    label: '读取文件',
    description: '读取文本或本地图片（PNG、JPEG、GIF、WebP）。图片直接返回图像内容，大图自动缩放；看本地图片直接使用 read，无需浏览器或外部 AI。路径可相对任务工作目录；看图仍需当前模型支持图像输入。其他二进制文件会明确提示。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '文件路径' } }, required: ['path'] },
    async execute(_id, params, signal) {
      signal?.throwIfAborted();
      const target = await resolve(params?.path);
      const denyReason = verifyScope(access, target, false);
      if (denyReason) return err(denyReason);
      const opened = await openVerifiedRead(target.real).catch((e) => ({ ok: false, reason: e.code ?? String(e) }));
      if (!opened.ok) return err(`无法读取（${opened.reason}）：${target.display ?? target.abs}`);
      try {
        // 读的就是复核过的那个句柄（不按路径重开，避免复核与读取之间被替换）；先看大小再读。
        if (opened.stat.isDirectory()) return err(`这是文件夹，请用 ls：${target.display ?? target.abs}`);
        const header = Buffer.alloc(16);
        const probe = await opened.fh.read(header, 0, header.length, 0);
        const mimeType = imageMime(header.subarray(0, probe.bytesRead));
        if (mimeType) return await readImage(opened, mimeType, target.display ?? target.real, signal);
        if (/\.(png|jpe?g|gif|webp)$/i.test(target.real)) return err('图片格式无效或文件已损坏（支持 PNG、JPEG、GIF、WebP）。');
        if (opened.stat.size > MAX_READ_BYTES) return ok(`文件过大（${opened.stat.size} 字节，上限 ${MAX_READ_BYTES}）：请用 grep 定位或分段说明需求`);
        const buf = await opened.fh.readFile();
        if (buf.includes(0)) return ok('这是二进制文件，无法按文本读取');
        return ok(buf.toString('utf-8'));
      } finally {
        await opened.fh.close().catch(() => {});
      }
    },
  });

  pi.registerTool({
    name: 'write',
    label: '写入文件',
    description: '写入文件（整体覆盖；目录不存在会创建，仅限授权范围内）。',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: '文件路径' }, content: { type: 'string', description: '全文内容' } },
      required: ['path', 'content'],
    },
    async execute(_id, params) {
      const target = await resolve(params?.path);
      const denyReason = verifyScope(access, target, true);
      if (denyReason) return err(denyReason);
      const dir = path.dirname(target.real);
      await mkdir(dir, { recursive: true });
      await atomicWriteWithin(dir, path.basename(target.real), String(params?.content ?? ''));
      return ok(`已写入 ${target.display ?? target.real}（${String(params?.content ?? '').length} 字符）`);
    },
  });

  pi.registerTool({
    name: 'edit',
    label: '修改文件',
    description: '替换文件中的一段文本。old_string 必须与文件内容精确一致。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' },
        replace_all: { type: 'boolean', description: '替换全部匹配（默认只替换第一处）' },
      },
      required: ['path', 'old_string', 'new_string'],
    },
    async execute(_id, params) {
      const target = await resolve(params?.path);
      const denyReason = verifyScope(access, target, true);
      if (denyReason) return err(denyReason);
      let text = await readFile(target.real, 'utf-8').catch(() => null);
      if (text === null) {
        const dir = path.dirname(target.real);
        await mkdir(dir, { recursive: true });
        text = '';
      }
      const oldS = String(params?.old_string ?? '');
      const newS = String(params?.new_string ?? '');
      if (!text.includes(oldS)) return err('old_string 在文件中找不到（注意空白与换行需完全一致）');
      const next = params?.replace_all ? text.split(oldS).join(newS) : text.replace(oldS, () => newS); // 函数形式：new_string 里的 $& / $1 / $$ 原样写入
      await atomicWriteWithin(path.dirname(target.real), path.basename(target.real), next);
      return ok(`已修改 ${target.display ?? target.real}`);
    },
  });

  pi.registerTool({
    name: 'ls',
    label: '列出目录',
    description: '列出目录内容（名称＋类型），按名称排序。',
    parameters: { type: 'object', properties: { path: { type: 'string', description: '目录路径（默认任务工作目录）' } } },
    async execute(_id, params) {
      const target = await resolve(params?.path ?? '.');
      const denyReason = verifyScope(access, target, false);
      if (denyReason) return err(denyReason);
      const entries = await readdir(target.real, { withFileTypes: true }).catch(() => null);
      if (!entries) return err(`无法列出：${target.display ?? target.abs}`);
      const lines = entries.slice(0, MAX_LIST).map((e) => `${e.name}${e.isDirectory() ? '/' : ''}`);
      return ok(lines.length ? `${lines.join('\n')}${entries.length > MAX_LIST ? `\n…（共 ${entries.length} 项，已截断）` : ''}` : '（空目录）');
    },
  });

  pi.registerTool({
    name: 'grep',
    label: '搜索文件内容',
    description: '在目录内按正则搜索文件内容（逐行匹配，返回行号与内容）。path 默认任务工作目录。',
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
      const root = await resolve(params?.path ?? '.');
      const denyReason = verifyScope(access, root, false);
      if (denyReason) return err(denyReason);
      let regex;
      try { regex = new RegExp(String(params?.pattern ?? '')); } catch (e) { return err(`正则无效：${e.message}`); }
      const include = params?.include ? globToRegExp(String(params.include)) : null;
      const hits = [];
      await walk(root.real, async (file) => {
        if (hits.length >= MAX_GREP) return;
        if (include && !include.test(path.basename(file))) return;
        const text = await readFile(file, 'utf-8').catch(() => null);
        if (text === null || text.includes('\0')) return;
        text.split('\n').forEach((line, i) => {
          if (hits.length < MAX_GREP && regex.test(line)) {
            hits.push(`${relOf(root.real, file)}:${i + 1}: ${line.slice(0, 200)}`);
          }
        });
      }, { maxDepth: 6, skip: (p) => access.isControlPath?.(p) });
      return ok(hits.length ? hits.join('\n') : '没有匹配');
    },
  });

  pi.registerTool({
    name: 'glob',
    label: '查找文件',
    description: '按通配模式查找文件（** 跨目录、* 单层），path 默认任务工作目录。',
    parameters: {
      type: 'object',
      properties: { pattern: { type: 'string', description: '如 **/*.md 或 *.txt' }, path: { type: 'string' } },
      required: ['pattern'],
    },
    async execute(_id, params) {
      const root = await resolve(params?.path ?? '.');
      const denyReason = verifyScope(access, root, false);
      if (denyReason) return err(denyReason);
      const matcher = globToRegExp(String(params?.pattern ?? '*'));
      const found = [];
      await walk(root.real, async (file) => {
        const rel = relOf(root.real, file);
        if (found.length < MAX_GLOB && matcher.test(rel)) found.push(rel);
      }, { maxDepth: 6, skip: (p) => access.isControlPath?.(p) });
      return ok(found.length ? found.join('\n') : '没有匹配的文件');
    },
  });
}

/** 本机 bash 工具：门控之后直接执行，不承诺任意脚本的文件隔离。 */
export function hemiCommandTool(pi, { config = {} } = {}) {
  const access = config.access;
  if (!access) return;
  const execute = config.commands?.run ?? runCommand;
  if (config.commands) {
    const owner = () => currentExecutionScope()?.execution?.owner;
    const result = value => ({content:[{type:'text',text:JSON.stringify(value)}],details:value});
    const control = request => currentExecutionScope()?.execution?.commandControl?.(request);
    pi.registerTool({name:'job_list',label:'查看后台命令',description:'列出本会话后台命令的真实状态、最近输出和硬截止时间。主会话可查询所属子任务的命令；子任务只可查询自己的命令。查询不会消费完成通知。',
      parameters:{type:'object',properties:{}},async execute(){return result(await (control({action:'list'}) ?? config.commands.list(owner())));}});
    pi.registerTool({name:'job_output',label:'读取后台输出',description:'按命令 id 读取有界输出和状态。from 是上次 next 字节偏移；lossy 表示旧日志已超出保留范围。wait_ms 最多等待 30000 毫秒，到限返回当前状态，命令继续运行。不要连续查询空转。',
      parameters:{type:'object',properties:{job_id:{type:'string'},from:{type:'number'},wait_ms:{type:'number'}},required:['job_id']},
      async execute(_id,p,signal){const waitMs=Math.max(0,Math.min(30000,p.wait_ms??0));return result(await (control({action:'read',jobId:p.job_id,from:p.from,waitMs,signal,collect:true}) ?? config.commands.read(owner(),p.job_id,{from:p.from,waitMs,signal,collect:true})));}});
    pi.registerTool({name:'job_kill',label:'停止后台命令',description:'停止本会话内有权控制的指定 id 后台命令，并确认进程清理。其他命令继续。仅在用户要求或任务已不需要该命令时使用；静默本身不能证明失败。',
      parameters:{type:'object',properties:{job_id:{type:'string'}},required:['job_id']},async execute(_id,p){return result(await (control({action:'stop',jobId:p.job_id}) ?? config.commands.stop(owner(),p.job_id)));}});
  }
  pi.registerTool({
    name: 'bash',
    label: '执行命令',
    description: `在会话工作目录执行本机 shell 命令，可联网。超过前台等待预算自动转后台，也可 run_in_background=true 立即后台执行。多个独立长命令分别调用 bash 并设 run_in_background=true，由宿主管理并行；不要手写 &/wait 拼接任务（cd 和变量赋值可能只在后台子 shell 生效）。${BACKGROUND_WAIT_GUIDANCE}父命令退出、停止或超时会清理整棵进程树；Start-Process、detached 或 & 不代表永久服务。危险操作仍经门控。`,
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令' },
        description: { type: 'string', description: '用简短中文说明本次操作的目的，如“检查 GitHub 构建状态”；用于界面展示，不写环境变量、命令全文或未经核实的结果' },
        timeout_ms: { type: 'number', description: '进程硬超时毫秒，超时终止；前台默认 1800000，显式后台默认 86400000，最多 24 小时。自动转后台保留原截止时间。' },
        yield_ms: { type: 'number', description: '前台等待毫秒，之后自动转后台（默认 10000，最多 120000）' },
        run_in_background: { type: 'boolean', description: '立即转后台并返回命令 ID。进程可跨轮次运行；是否等待结果取决于当前用户目标，不代表目标已经完成。' },
      },
      required: ['command'],
    },
    async execute(_id, params, signal) {
      const command = String(params?.command ?? '');
      if (!command.trim()) return err('命令为空');
      const startedAt = Date.now();
      const out = await execute({
        command, cwd: access.cwd ?? access.workspaceDir ?? access.home,
        description: normalizeCommandDescription(params?.description),
        timeoutMs: Number.isFinite(params?.timeout_ms) && params.timeout_ms > 0 ? Math.min(COMMAND_BACKGROUND_TIMEOUT_MS, params.timeout_ms) : params?.run_in_background ? COMMAND_BACKGROUND_TIMEOUT_MS : COMMAND_TIMEOUT_MS,
        foregroundMs: config.commands ? (Number.isFinite(params?.yield_ms) ? Math.max(0, Math.min(120_000, params.yield_ms)) : COMMAND_FOREGROUND_MS) : undefined,
        runInBackground: Boolean(config.commands && params?.run_in_background),
        signal,
      });
      config.log?.debug?.(`本机命令 ${out.status} · exit=${out.code} · ${Date.now() - startedAt}ms`);
      return commandToolResult(out);
    },
  });
}

// —— 极简通配：** 跨层、* 单层、? 单字符 ——
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '[\\s\\S]*'; i += glob[i + 2] === '/' ? 2 : 1; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** 搜索结果相对路径（root 已是真实路径；不用字符串 replace——root 可能在路径中段重复出现）。 */
function relOf(root, file) {
  return `./${path.relative(root, file)}`;
}

/** 递归遍历：不跟随符号链接（Dirent 的链接既非文件也非目录，天然跳过），控制面整枝剪掉。 */
async function walk(dir, visit, { maxDepth = 6, depth = 0, skip = null } = {}) {
  if (depth > maxDepth) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (skip?.(full)) continue;
    if (e.isDirectory()) await walk(full, visit, { maxDepth, depth: depth + 1, skip });
    else if (e.isFile()) await visit(full);
  }
}

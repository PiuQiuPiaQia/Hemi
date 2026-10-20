// 039 Codemode 只读批量试点 · 策略纯模块（技术方案 v2「路径边界与错误」「限额」节）。
//
// 只做判断与队列，不 import Electron、不碰 SDK：被 gate/pi-codemode.mjs（拟增的
// 薄包装）与专项单测消费。独立可测是方案对 C 阶段的前提（「越界/并发/超时/取消」）。
//
// 试点纪律（2026-10-04 方案评审稿）：缺省关闭（HEMI_CODEMODE_PILOT=1 才启用）、
// 受理时冻结快照、脚本只允许白名单只读工具（read / web_search / web_extract）、
// 一次只跑一个脚本、子调用共享 4 并发、每脚本 32 次尝试上限、60s 墙钟截止。

import { realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/** 脚本可调用的只读工具白名单（宿主常量；pi-gate 按同一份推导硬边界）。 */
export const CODEMODE_ALLOWED_TOOLS = Object.freeze(['read', 'web_search', 'web_extract']);

/** 限额初值（方案「限额、输出和资源收束」表；变化须记录理由并复验）。 */
export const CODEMODE_LIMITS = Object.freeze({
  /** 同会话实际在跑脚本数（包装入口可取消 FIFO；排队不创建 worker）。 */
  concurrentScripts: 1,
  /** 脚本子工具实际并发（含所有活动父，防各自叠加）。 */
  concurrentChildCalls: 4,
  /** 每脚本调用尝试总数（失败/非法尝试也占额度；超限取消整个父 batch）。 */
  maxAttemptsPerScript: 32,
  /** 每脚本墙钟（含父/子排队、门控与确认）。 */
  scriptWallClockMs: 60_000,
  /** 模型可见文本输出（estimated tokens；注入/钳制 @options 并在返回侧钳制）。 */
  maxOutputTokens: 4_000,
});

/** 范围拒绝的稳定错误类别（脚本与过程记录用它分流，不解析中文文案）。 */
export const SCOPE_DENIED = 'scope-denied';
export const LIMIT_EXCEEDED = 'limit-exceeded';

/**
 * 受理时冻结的试点快照（task.codemode）。历史档案只存无密钥元数据，
 * 不能作为执行授权来源；快照里的 allowlist 是本任务唯一授权面。
 */
export function freezeCodemodePolicy({ enabled, workspaceDir, allowlist = CODEMODE_ALLOWED_TOOLS } = {}) {
  return {
    enabled: enabled === true,
    /** 冻结工作区绝对路径；null＝无工作区（本次禁用脚本，原直接路径可继续）。 */
    workspaceDir: typeof workspaceDir === 'string' && workspaceDir ? workspaceDir : null,
    allowlist: Object.freeze([...(Array.isArray(allowlist) ? allowlist : [])]),
    limits: CODEMODE_LIMITS,
    frozenAt: Date.now(),
  };
}

/**
 * 解析脚本可选首行 `// @options: {...}`：只接受 timeout_ms / max_output_tokens
 * 的正整数，缺省注入宿主默认，大于宿主值钳制，非法值/格式/未知选项拒绝。
 * 返回 { ok, options, cleanedCode, error? }；cleanedCode 去掉 options 行
 * （原样传给原生 execute 前由包装拼回唯一规范行）。
 */
export function parseScriptOptions(code, limits = CODEMODE_LIMITS) {
  const text = String(code ?? '');
  const lines = text.split('\n');
  const first = lines[0]?.trim() ?? '';
  const match = first.match(/^\/\/\s*@options:\s*(\{.*\})\s*$/);
  if (!match) {
    return {
      ok: true,
      options: { timeoutMs: limits.scriptWallClockMs, maxOutputTokens: limits.maxOutputTokens },
      cleanedCode: text,
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(match[1]);
  } catch {
    return { ok: false, error: '@options 不是合法 JSON' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: '@options 必须是对象' };
  }
  const allowed = ['timeout_ms', 'max_output_tokens'];
  for (const key of Object.keys(parsed)) {
    if (!allowed.includes(key)) return { ok: false, error: `未知 @options 项：${key}` };
  }
  const intOr = (value, key) => {
    if (value === undefined) return null;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`@options.${key} 必须是正整数`);
    }
    return value;
  };
  let timeoutMs;
  let maxOutputTokens;
  try {
    timeoutMs = intOr(parsed.timeout_ms, 'timeout_ms') ?? limits.scriptWallClockMs;
    maxOutputTokens = intOr(parsed.max_output_tokens, 'max_output_tokens') ?? limits.maxOutputTokens;
  } catch (error) {
    return { ok: false, error: error.message };
  }
  return {
    ok: true,
    options: {
      timeoutMs: Math.min(timeoutMs, limits.scriptWallClockMs),
      maxOutputTokens: Math.min(maxOutputTokens, limits.maxOutputTokens),
    },
    cleanedCode: lines.slice(1).join('\n'),
  };
}

/** 展开 ~ 与相对路径并 normalize（realpath 前的第一段；cwd 来自冻结快照）。 */
export function expandPath(value, cwd) {
  let text = String(value ?? '').trim();
  if (!text) return null;
  if (text === '~') text = os.homedir();
  else if (text.startsWith('~/')) text = path.join(os.homedir(), text.slice(2));
  if (!path.isAbsolute(text)) text = path.resolve(cwd, text);
  return path.normalize(text);
}

/**
 * 冻结工作区的硬边界判定（包装入口与子 read 共用；异步 realpath 版本由
 * pi-codemode 在执行时调用——本函数是实路径校验的最后一步，纯比较可单测）。
 * 目录比较用 path.relative 的完整段，不用字符串前缀（/a/b2 不是 /a/b 的子路径）。
 */
export function isInsideWorkspace(resolvedPath, workspaceDir) {
  if (!resolvedPath || !workspaceDir) return false;
  const rel = path.relative(workspaceDir, resolvedPath);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * 039：脚本 read 的异步路径校验（展开 → normalize → realpath → 边界）。
 * 不存在、不可读、符号链接越界都拒绝并给稳定类别；不弹卡扩权。
 * 敏感根检查沿用根 AGENTS 的 denyRoots 口径（/System、/Library 等系统根区）。
 */
const DENY_ROOTS = ['/System', '/Library', '/private/etc', '/etc', '/dev', '/Volumes'];
export async function resolveScriptReadPath(rawPath, policy, { realpathImpl = realpath } = {}) {
  const expanded = expandPath(rawPath, policy.workspaceDir ?? os.homedir());
  if (!expanded) return { ok: false, category: SCOPE_DENIED, message: 'read 需要一个路径' };
  if (DENY_ROOTS.some((root) => expanded === root || expanded.startsWith(`${root}/`))) {
    return { ok: false, category: SCOPE_DENIED, message: '路径在系统根区，脚本不可读取' };
  }
  if (policy.workspaceDir) {
    let real;
    try {
      real = await realpathImpl(expanded);
    } catch (error) {
      return { ok: false, category: SCOPE_DENIED, message: `路径不可读（${error.code ?? error.message}）` };
    }
    if (DENY_ROOTS.some((root) => real === root || real.startsWith(`${root}/`))) {
      return { ok: false, category: SCOPE_DENIED, message: '实路径落在系统根区，脚本不可读取' };
    }
    if (!isInsideWorkspace(real, policy.workspaceDir)) {
      return { ok: false, category: SCOPE_DENIED, message: '路径在工作区之外，脚本不可读取' };
    }
    return { ok: true, path: real };
  }
  return { ok: false, category: SCOPE_DENIED, message: '本任务没有冻结工作区，脚本读取不可用' };
}

/**
 * 共享可取消队列：同会话 1 个脚本在跑、子调用共享 4 并发、每脚本 32 次尝试
 * 与 60s 墙钟。所有等待都可撤销（abort/截止到点即 reject），取得槽位后由
 * 调用方再次检查取消。一次 cancelCurrent 结束整个父 batch 的等待者。
 */
export function createCodemodeQueue(limits = CODEMODE_LIMITS, { now = () => Date.now(), setTimeoutFn = (fn, ms) => setTimeout(fn, ms), clearTimeoutFn = (id) => clearTimeout(id) } = {}) {
  let scriptSlotBusy = false;
  const scriptWaiters = [];
  let scriptActive = null; // { key, startedAt, attempts }
  let childRunning = 0;
  const childWaiters = [];

  const childSlot = () => new Promise((resolve, reject) => {
    const waiter = { resolve, reject, cancelled: false };
    childWaiters.push(waiter);
    pump();
  });

  function pump() {
    while (childRunning < limits.concurrentChildCalls && childWaiters.length) {
      const waiter = childWaiters.shift();
      if (waiter.cancelled) continue;
      childRunning += 1;
      waiter.resolve();
    }
  }

  function releaseChild() {
    childRunning = Math.max(0, childRunning - 1);
    pump();
  }

  const abortError = () => Object.assign(new Error('脚本已取消'), { category: SCOPE_DENIED });

  return {
    /**
     * 脚本槽位：同一时刻至多一个脚本在跑（试点并发＝1），排队者按 FIFO 唤醒；
     * 等待期间 signal 取消即出队拒绝，唤醒后再次检查取消。
     */
    async acquireScript(key, signal) {
      if (scriptSlotBusy) {
        await new Promise((resolve, reject) => {
          const waiter = { resolve, reject };
          const onAbort = () => {
            const index = scriptWaiters.indexOf(waiter);
            if (index >= 0) scriptWaiters.splice(index, 1);
            reject(abortError());
          };
          signal?.addEventListener('abort', onAbort, { once: true });
          scriptWaiters.push(waiter);
        });
        if (signal?.aborted) throw abortError();
      }
      scriptSlotBusy = true;
      scriptActive = { key, startedAt: now(), attempts: 0 };
    },

    /** 释放脚本槽位并按 FIFO 唤醒下一个排队脚本（它继续持有槽位）。 */
    releaseScript() {
      scriptActive = null;
      const next = scriptWaiters.shift();
      if (next) next.resolve();
      else scriptSlotBusy = false;
    },

    /** 子调用并发槽；取消或脚本收尾后等待直接拒绝，取得槽位后由调用方复查取消。 */
    async acquireChild(signal) {
      await childSlot();
      if (signal?.aborted) {
        releaseChild();
        throw abortError();
      }
      return releaseChild;
    },

    /** 尝试计数：第 33 次返回 false（调用方取消整个父 batch，不只是 reject 该调用）。 */
    consumeAttempt() {
      if (!scriptActive) return false;
      scriptActive.attempts += 1;
      return scriptActive.attempts <= limits.maxAttemptsPerScript;
    },

    /** 剩余墙钟（进入 worker 的 timeout 用剩余预算，不重新拿完整 60s）。 */
    remainingMs() {
      if (!scriptActive) return 0;
      return Math.max(0, limits.scriptWallClockMs - (now() - scriptActive.startedAt));
    },

    get scriptRunning() {
      return Boolean(scriptActive);
    },

    /** 测试辅助：当前排队子等待数。 */
    get pendingChildWaiters() {
      return childWaiters.length;
    },
  };
}

/** 定时器注入句柄（nowFn 推进的单测确定性；生产用全局 setTimeout）。 */
export const defaultTimers = { now: () => Date.now(), setTimeoutFn: (fn, ms) => setTimeout(fn, ms), clearTimeoutFn: (id) => clearTimeout(id) };

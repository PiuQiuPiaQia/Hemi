// 049 · 远端服务单例：共享 SSH 执行器（ControlMaster 按主机复用）、探测、
// 对话侧远端上下文块（带 TTL 缓存）。workspace.ipc / task.ipc / llm.ipc 共用。
//
// ControlPath 目录在 userData/ssh 下（dev 与生产实例隔离；权限 0700，技术方案
// 约束 3）。应用退出时经 close() 发 `ssh -O exit`，不留主连接进程（AC-03）。
import { readFileSync, renameSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';

import { createSshRunner } from './ssh-runner.mjs';
import { createRemoteFs } from './remote-fs.mjs';

let instance = null;

/** 对话侧上下文块的缓存时长：AGENTS.md 不会每回合变，ControlMaster 复用下按需重探。 */
const CONTEXT_BLOCK_TTL_MS = 5 * 60_000;
/** 探测结果的缓存时长（选中/重试之外避免频繁探测同一主机）。 */
const PROBE_TTL_MS = 30_000;

/**
 * @param {object} deps
 * @param {string} deps.userDataDir 应用 userData（dev/生产隔离由此保证）
 * @param {object} [deps.crypto] 持久化加密器 { encrypt(text)→string|null,
 *        decrypt(blob)→string|null }——生产由 workspace.ipc 注入应用本地加密存储
 *        （与模型 Key 同一保存方式）；缺省＝不持久化只进内存。
 * @param {object} [deps.log]
 */
export function createRemoteService({ userDataDir, crypto = null, log = null }) {
  /**
   * 密码池（2026-10-12 用户裁决：支持密码登录＋「记住密码」）：host → 密码。
   * 勾了「记住密码」的经 crypto（应用本地存储）加密后落
   * userData/remote-passwords.json（0600），重启后首次使用时恢复；没勾的只在进程内存。
   */
  const passwordPool = new Map();
  const passwordFile = path.join(String(userDataDir), 'remote-passwords.json');
  /** 已持久化的 host 集合（forget 时同步清盘）。 */
  const persistedHosts = new Set();
  let passwordsLoaded = false;

  function loadPersistedPasswords() {
    if (passwordsLoaded) return;
    passwordsLoaded = true;
    if (!crypto) return;
    let raw;
    try {
      raw = readFileSync(passwordFile, 'utf8');
    } catch {
      return; // 首次使用：无存档
    }
    try {
      const parsed = JSON.parse(raw);
      const hosts = parsed && typeof parsed === 'object' && parsed.hosts && typeof parsed.hosts === 'object' ? parsed.hosts : {};
      for (const [host, blob] of Object.entries(hosts)) {
        if (typeof host !== 'string' || typeof blob !== 'string') continue;
        const text = crypto.decrypt(blob);
        if (text == null) {
          // 钥匙串换机/重置后解不开：丢弃该条（下次重输），存档不损坏。
          log?.warn?.(`[remote] 已存密码解不开（${host}），按未保存处理`);
          continue;
        }
        passwordPool.set(host, text);
        persistedHosts.add(host);
      }
    } catch (error) {
      log?.warn?.(`[remote] 密码存档损坏，按无存档处理：${error?.message ?? error}`);
    }
  }

  function persistPasswords() {
    if (!crypto) return;
    try {
      const hosts = {};
      for (const host of persistedHosts) {
        const text = passwordPool.get(host);
        const blob = text != null ? crypto.encrypt(text) : null;
        if (blob == null) continue; // 加密不可用（钥匙串锁）：条目退出持久化但不报错
        hosts[host] = blob;
      }
      const tmp = `${passwordFile}.tmp-${process.pid}`;
      mkdirSync(path.dirname(passwordFile), { recursive: true });
      writeFileSync(tmp, JSON.stringify({ version: 1, hosts }, null, 2), 'utf8');
      chmodSync(tmp, 0o600);
      renameSync(tmp, passwordFile);
    } catch (error) {
      log?.warn?.(`[remote] 密码存档写入失败（本次登录仍有效）：${error?.message ?? error}`);
    }
  }

  // IPC 注册会创建服务；恢复密码延后到真实 SSH 操作，避免启动时访问钥匙串。
  function passwordFor(host) {
    loadPersistedPasswords();
    return passwordPool.get(host) ?? null;
  }
  // HEMI_SSH_BIN：自驱动/验收钩子（与 HEMI_USER_DATA_DIR 同级信任面）——
  // verify-049 用假 ssh 在本机沙箱跑通全链；生产不设即系统 ssh。
  const runner = createSshRunner({
    controlDir: path.join(String(userDataDir), 'ssh'),
    sshBin: process.env.HEMI_SSH_BIN || 'ssh',
    passwordProvider: passwordFor,
    log,
  });
  /** host → { at, promise } 探测去重与短缓存。 */
  const probeCache = new Map();
  /** workspaceId → { at, text } 对话上下文块缓存。 */
  const contextCache = new Map();

  /**
   * 探测登记的远端工作区。并发去重＋成功结果短缓存（失败不缓存——「重试连接」
   * 要立刻生效）。
   * @returns {Promise<{ok:true, host, realDir, remoteHome, tools}|{ok:false, kind, message}>}
   */
  async function probeWorkspace({ host, dir, password = null }) {
    const key = `${host}::${dir}`;
    const cached = probeCache.get(key);
    if (cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.promise;
    // 密码探测：优先显式传入（添加/重输），否则按池里的（重启后为空 → 走密钥）。
    const promise = runner.probe({ host, dir, password: password ?? passwordFor(host) });
    probeCache.set(key, { at: Date.now(), promise });
    const result = await promise;
    if (!result.ok) probeCache.delete(key);
    return result;
  }

  /**
   * 对话侧远端工作区上下文块（R-10）：项目身份＋根目录一层概览＋说明文件摘录，
   * 口径对齐 workspace/context.mjs 的本机版；连不上时如实返回空串（不阻断对话）。
   */
  async function conversationContextBlock(view, { force = false } = {}) {
    if (!view?.host || !view?.dir) return '';
    const now = Date.now();
    const cached = contextCache.get(view.id);
    if (!force && cached && now - cached.at < CONTEXT_BLOCK_TTL_MS) return cached.text;
    let text = '';
    try {
      const fs = createRemoteFs({ runner, host: view.host, workspaceDir: view.dir, remoteHome: view.remoteHome ?? null });
      const [excerpt, listed] = await Promise.all([fs.contextExcerpt(), fs.lsEntries(view.dir)]);
      const lines = ['［工作区 · 当前项目（服务器）］', `项目「${view.name}」：${view.host}:${view.dir}`];
      if (listed.ok) {
        const names = listed.names
          .filter((name) => !['.DS_Store', 'node_modules', '.git'].some((bad) => name === `${bad}/` || name === bad) && !name.startsWith('._'))
          .slice(0, 40);
        if (names.length) lines.push(`根目录：${names.join(' · ')}`);
      }
      if (excerpt) lines.push(excerpt);
      text = lines.join('\n');
    } catch (error) {
      log?.debug?.(`[remote] 远端上下文读取失败（${view.host}）：${error?.message ?? error}`);
      text = '';
    }
    contextCache.set(view.id, { at: Date.now(), text });
    return text;
  }

  /** 任务/预览等处的远端 fs 句柄。 */
  function remoteFsFor({ host, dir, remoteHome = null }) {
    return createRemoteFs({ runner, host, dir, remoteHome });
  }

  /**
   * 密码入池。探测成功后由 IPC 层调用；remember=true 时加密落盘（重启恢复）。
   * remember=false 只进内存（本次运行有效）。
   */
  function rememberPassword(host, password, { remember = false } = {}) {
    const target = String(host ?? '').trim();
    if (!target || typeof password !== 'string' || !password) return;
    loadPersistedPasswords();
    passwordPool.set(target, password);
    const hadPersisted = persistedHosts.has(target);
    if (remember && crypto) persistedHosts.add(target);
    else persistedHosts.delete(target);
    // 新记住（池里有持久条目）或原本持久过（重写以移除）才落盘；纯内存模式不留空档。
    if (crypto && (persistedHosts.size > 0 || hadPersisted)) persistPasswords();
  }

  function forgetPassword(host) {
    loadPersistedPasswords();
    const target = String(host ?? '').trim();
    passwordPool.delete(target);
    if (persistedHosts.delete(target)) persistPasswords();
  }

  function hasPassword(host) {
    loadPersistedPasswords();
    return passwordPool.has(String(host ?? '').trim());
  }

  function close() {
    runner.close();
    probeCache.clear();
    contextCache.clear();
    passwordPool.clear();
    persistedHosts.clear();
  }

  return { runner, probeWorkspace, conversationContextBlock, remoteFsFor, rememberPassword, forgetPassword, hasPassword, close };
}

/** 应用级单例（ipc/index.mjs 注册时初始化；测试直接建实例）。 */
export function getRemoteService() {
  return instance;
}

export function setRemoteService(service) {
  instance = service;
}

#!/usr/bin/env node
// 044 · 发布 job 收尾的有界清理（三个独立阶段，各自成进程/独立 step）。
//
// 安全模型：
// - 入口守卫先于一切副作用：仅 GitHub 托管 runner（GITHUB_ACTIONS=true 且
//   RUNNER_ENVIRONMENT=github-hosted），且必须显式提供 HEMI_MAC_SIGNING_DIR
//   与 RUNNER_TEMP，目录在 path.resolve 后必须严格等于
//   <RUNNER_TEMP>/hemi-build-signing。任何不满足都拒绝，零 exists/run/remove
//   副作用，绝不回退到默认目录（那里保存着本机长期签名身份）。
// - 真硬截止：外部命令由 python3 watchdog 包装，到 deadline 由执行者自身的
//   权限对目标进程 SIGKILL（root 场景由 root 侧 watchdog 杀它的直接 child，
//   不依赖 Node 侧能否杀死提权后代）；Node 侧只等待包装进程，兜底超时后如实
//   报失败，不声称已终止无法确认的后代。
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { certificatePath, usesAdminTrustDomain } from './lib/macos-signing.mjs';

export const CLEANUP_DIRECTORY_NAME = 'hemi-build-signing';
export const COMMAND_TIMEOUT_MS = 60_000;
export const WATCHDOG_GRACE_MS = 15_000;

// root 侧 watchdog：deadline 到点 proc.kill()（POSIX SIGKILL）杀直接 child。
export const WATCHDOG_PYTHON_SOURCE = [
  'import subprocess, sys, threading',
  'deadline = float(sys.argv[1])',
  'proc = subprocess.Popen(sys.argv[2:])',
  'expired = []',
  'def on_expire():',
  '    expired.append(1)',
  '    proc.kill()',
  'timer = threading.Timer(deadline, on_expire)',
  'timer.start()',
  'try:',
  '    code = proc.wait()',
  'finally:',
  '    timer.cancel()',
  'if expired:',
  "    sys.stderr.write('watchdog: command exceeded deadline and was killed\\n')",
  '    sys.exit(124)',
  'sys.exit(code)',
].join('\n');

export function watchdogRun({ spawn = spawnSync, pythonPath = '/usr/bin/python3' } = {}) {
  return function run(command, args, { timeoutMs = COMMAND_TIMEOUT_MS, sudo = false } = {}) {
    const deadlineSeconds = String(Math.max(1, Math.ceil(timeoutMs / 1000)));
    const pythonArgs = ['-c', WATCHDOG_PYTHON_SOURCE, deadlineSeconds, command, ...args];
    const result = spawn(sudo ? 'sudo' : pythonPath, sudo ? ['-n', pythonPath, ...pythonArgs] : pythonArgs, {
      encoding: 'utf8',
      timeout: timeoutMs + WATCHDOG_GRACE_MS,
    });
    const stderr = result.stderr ?? '';
    const timedOut = result.error?.code === 'ETIMEDOUT' || stderr.includes('watchdog: command exceeded deadline');
    const detail = stderr.trim() || result.error?.code || (result.signal ? `terminated by ${result.signal}` : `exit ${result.status}`);
    return { ok: !result.error && result.status === 0 && !timedOut, detail, timedOut };
  };
}

export function resolveCleanupContext({ env = process.env } = {}) {
  const reject = reason => ({ ok: false, reason });
  if (env.GITHUB_ACTIONS !== 'true') return reject('仅允许在 GitHub Actions runner 上执行清理');
  if (env.RUNNER_ENVIRONMENT !== 'github-hosted') return reject(`仅允许 GitHub 托管 runner，当前 RUNNER_ENVIRONMENT=${env.RUNNER_ENVIRONMENT ?? '未设置'}`);
  if (!env.RUNNER_TEMP) return reject('缺少 RUNNER_TEMP，无既定临时根目录');
  if (!env.HEMI_MAC_SIGNING_DIR) return reject('缺少显式 HEMI_MAC_SIGNING_DIR；禁止默认回退');
  const runnerTemp = path.resolve(env.RUNNER_TEMP);
  const directory = path.resolve(env.HEMI_MAC_SIGNING_DIR);
  const expected = path.join(runnerTemp, CLEANUP_DIRECTORY_NAME);
  if (directory === runnerTemp) return reject('拒绝把 RUNNER_TEMP 本身作为清理目标');
  if (directory !== expected) return reject(`HEMI_MAC_SIGNING_DIR 必须是 ${expected}，当前 ${directory}`);
  // 防御：本机长期身份目录（lib signingDirectory 的默认值）绝不允许成为目标。
  const longTerm = path.resolve(os.homedir(), 'Library', 'Application Support', 'Hemi Build Signing');
  if (directory === longTerm) return reject('拒绝清理本机长期签名身份目录');
  return { ok: true, directory };
}

const stages = {
  'revoke-trust': {
    description: '撤销管理员域信任',
    execute: ({ env, run, log }) => {
      if (!usesAdminTrustDomain({ ci: true, env })) {
        log('[cleanup] 跳过: 非 GitHub 托管 runner，未注册管理员域信任');
        return { ok: true, failures: 0 };
      }
      log(`[cleanup] 撤销管理员域信任（watchdog ${COMMAND_TIMEOUT_MS / 1000}s）: sudo -n <python3> watchdog /usr/bin/security remove-trusted-cert -d ${certificatePath}`);
      const result = run('/usr/bin/security', ['remove-trusted-cert', '-d', certificatePath], { sudo: true });
      if (result.ok) {
        log('[cleanup] 完成: 管理员域信任已撤销');
        return { ok: true, failures: 0 };
      }
      // 导入在建立信任之前就失败时可能无信任可撤；成功发布路径必须撤销成功。
      log(`[cleanup] 失败${result.timedOut ? '（超时）' : ''}: 撤销管理员域信任 — ${result.detail}`);
      return { ok: false, failures: 1 };
    },
  },
  'delete-keychain': {
    description: '删除临时签名钥匙串',
    execute: ({ directory, run, exists, log }) => {
      const keychain = path.join(directory, 'hemi-signing.keychain-db');
      if (!exists(keychain)) {
        log('[cleanup] 跳过: 临时钥匙串不存在（导入可能未建立）');
        return { ok: true, failures: 0 };
      }
      log(`[cleanup] 删除临时钥匙串（watchdog ${COMMAND_TIMEOUT_MS / 1000}s）: /usr/bin/security delete-keychain ${keychain}`);
      const result = run('/usr/bin/security', ['delete-keychain', keychain]);
      if (result.ok) {
        log('[cleanup] 完成: 临时钥匙串已删除');
        return { ok: true, failures: 0 };
      }
      log(`[cleanup] 失败${result.timedOut ? '（超时）' : ''}: 删除临时钥匙串 — ${result.detail}`);
      return { ok: false, failures: 1 };
    },
  },
  'remove-directory': {
    description: '删除临时签名身份目录',
    execute: ({ directory, removeTree, log }) => {
      log(`[cleanup] 删除临时签名身份目录: ${directory}`);
      try {
        removeTree(directory);
        log('[cleanup] 完成: 临时签名身份目录已删除');
        return { ok: true, failures: 0 };
      } catch (error) {
        log(`[cleanup] 失败: 删除临时签名身份目录 — ${error?.message ?? error}`);
        return { ok: false, failures: 1 };
      }
    },
  },
};

export const STAGE_NAMES = Object.keys(stages);

export function runCleanupStage(stage, {
  env = process.env,
  run = watchdogRun(),
  exists = existsSync,
  removeTree = target => rmSync(target, { recursive: true, force: true }),
  log = () => {},
} = {}) {
  const guard = resolveCleanupContext({ env });
  if (!guard.ok) {
    log(`[cleanup] 拒绝: ${guard.reason}`);
    return { ok: false, failures: 1, reason: guard.reason };
  }
  const target = stages[stage];
  if (!target) {
    log(`[cleanup] 拒绝: 未知清理阶段 ${stage}`);
    return { ok: false, failures: 1, reason: `unknown stage ${stage}` };
  }
  // 阶段级异常隔离：执行器抛错也只计为该阶段失败，不冒泡。
  try {
    return target.execute({ env, directory: guard.directory, run, exists, removeTree, log });
  } catch (error) {
    log(`[cleanup] 失败: ${target.description} — ${error?.message ?? error}`);
    return { ok: false, failures: 1 };
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const stage = process.argv[2];
  if (!stages[stage]) {
    console.error(`usage: node scripts/cleanup-macos-signing.mjs <${STAGE_NAMES.join('|')}>`);
    process.exit(2);
  }
  const result = runCleanupStage(stage, { log: line => console.log(line) });
  process.exit(result.ok ? 0 : 1);
}

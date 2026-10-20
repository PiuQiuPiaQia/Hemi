/** 060：本机命令直接执行。权限由工具门控决定；本层只拥有进程、输出和终态。 */
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { currentExecutionScope } from '../../agent-runtime/execution-scope.mjs';
import { processBirth } from '../../agent-runtime/owned-processes.mjs';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import { comSpecPath, cmdExecArgs } from '../../platform/win-compat.mjs';

const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_OUTPUT = 8 * 1024 * 1024;

export async function runCommand({ command, cwd, timeoutMs = 120_000, signal, env = process.env, maxOutput = MAX_OUTPUT, onSpawn = null, ownerToken = null }) {
  if (signal?.aborted) return { code: null, signal: null, stdout: '', stderr: '', aborted: true, timedOut: false, cleanupConfirmed: true, truncated: false, status: 'cancelled' };
  const windows = process.platform === 'win32';
  return new Promise((resolve) => {
    let child;
    let stdout = '', stderr = '';
    const decoders = { out: new StringDecoder('utf8'), err: new StringDecoder('utf8') };
    let bytes = 0, truncated = false, timedOut = false, aborted = false;
    let spawnError = null, timer, escalation, cleanup;
    let registration = Promise.resolve();
    const append = (which, chunk) => {
      const remaining = Math.max(0, maxOutput - bytes);
      const kept = chunk.subarray(0, remaining);
      bytes += kept.length;
      truncated ||= chunk.length > remaining;
      if (which === 'out') stdout += decoders.out.write(kept); else stderr += decoders.err.write(kept);
    };
    const kill = async (force = false) => {
      if (!child?.pid) return;
      if (windows) {
        await exec('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
      } else {
        try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
      }
    };
    // Shell 退出时也回收后台子孙；用 exit 而非 close（子孙持有输出管道会阻止 close）。
    const clean = () => cleanup ??= (async () => {
      let signalError = null;
      try { await kill(true); } catch (error) { signalError = error; }
      if (!child?.pid || windows) return !signalError;
      const until = Date.now() + 3000;
      do {
        // macOS 对只剩 zombie 的进程组可能回 EPERM；以仍可执行的组成员确认退出，
        // 不能把信号返回值当终态，也不能因此把正常结束误报成失败。
        const { stdout: processes } = await exec('/bin/ps', ['-axo', 'pgid=,stat=']).catch(() => ({ stdout: null }));
        if (processes !== null) {
          const alive = processes.split('\n').some((row) => {
            const [group, state] = row.trim().split(/\s+/);
            return Number(group) === child.pid && state && !state.startsWith('Z');
          });
          if (!alive) return true;
        } else {
          try { process.kill(-child.pid, 0); } catch (error) { if (error.code === 'ESRCH') return true; }
        }
        await pause(25);
      } while (Date.now() < until);
      if (signalError) throw signalError;
      return false;
    })();
    const terminate = () => {
      void kill().catch(() => {});
      escalation ??= setTimeout(() => { void kill(true).catch(() => {}); }, 500);
    };
    const onAbort = () => { aborted = true; terminate(); };
    try {
      const gatedCommand = onSpawn && windows ? `set "__hemi_command_start=" & set /p __hemi_command_start= >nul & if not defined __hemi_command_start exit /b 125 & ${command}` : command;
      const args = windows ? cmdExecArgs(gatedCommand) : onSpawn ? ['-c', 'IFS= read -r __hemi_command_start || exit 125; exec 3<&0; ( IFS= read -r __hemi_parent_life <&3; kill -KILL -- "-$$" ) <&3 & /bin/bash -c "$1" </dev/null 3<&-; __hemi_status=$?; exit "$__hemi_status"', `hemi-command:${ownerToken ?? randomUUID()}`, command] : ['-c', command];
      child = spawn(windows ? comSpecPath(env) : '/bin/bash', args, {
        cwd, env, detached: !windows, windowsHide: true, stdio: [onSpawn ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({ code: null, signal: null, stdout, stderr: error.message, spawnError: error.code ?? error.message, timedOut, aborted, cleanupConfirmed: true, truncated, status: 'start-failed' });
      return;
    }
    if (onSpawn) {
      child.stdin.on('error', () => {});
      child.once('spawn', () => {
        registration = (async () => {
        try {
          await onSpawn(child.pid);
          if (signal?.aborted || timedOut) {child.stdin.destroy();terminate();}
          else if (windows) child.stdin.end('start\n');
          else child.stdin.write('start\n'); // 管道保持打开；宿主崩溃时 EOF 让同组守卫立即清理。
        } catch (error) {spawnError = error;stderr += `命令未启动：${error.message}`;child.stdin.destroy();terminate();}
        })();
      });
    }
    child.stdout.on('data', (chunk) => append('out', chunk));
    child.stderr.on('data', (chunk) => append('err', chunk));
    child.once('error', (error) => { spawnError = error; stderr += error.message; });
    child.once('exit', () => { void clean().catch(() => {}); });
    child.once('close', async (code, exitSignal) => {
      await registration;
      child.stdin?.destroy();
      clearTimeout(timer); clearTimeout(escalation);
      stdout += decoders.out.end(); stderr += decoders.err.end();
      signal?.removeEventListener('abort', onAbort);
      let cleanupError = null;
      const cleanupConfirmed = await clean().catch((error) => { cleanupError = error.message; return false; });
      const status = !cleanupConfirmed ? 'cleanup-failed' : aborted ? 'cancelled' : timedOut ? 'timed-out' : spawnError ? 'start-failed' : code === 0 ? 'succeeded' : 'failed';
      resolve({ code, signal: exitSignal, stdout, stderr, cleanupError, spawnError: spawnError?.code ?? null, timedOut, aborted, cleanupConfirmed, truncated, status });
    });
    timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

/** 一个 Pi 会话的命令归属。SDK dispose／settled 不能早于本层的资源退出确认。 */
export function createCommandScope() {
  const active = new Set();
  return {
    run(options) {
      const controller = new AbortController();
      const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
      const record = { controller, promise: null };
      const execution = currentExecutionScope()?.execution;
      const id = randomUUID(), token = randomUUID();
      let registered = false;
      const onSpawn = execution?.journal ? async pid => {
        const birth = await processBirth(pid);
        await execution.journal.processStart({id, token, pid, birth, owner:execution.owner});
        registered = true;
      } : null;
      const promise = runCommand({ ...options, signal, ...(onSpawn ? {onSpawn, ownerToken:token} : {}) })
        .then(async result => {
          if (registered) {
            try {await execution.journal.processEnd(id,{state:result.cleanupConfirmed?'finished':'unknown',cleanupConfirmed:result.cleanupConfirmed});}
            catch(error){execution.fatalError = `命令退出事实保存失败：${error.message}`;throw error;}
          }
          if (!result.cleanupConfirmed && execution) {
            execution.cleanupUnconfirmed = true;
            execution.fatalError = '命令进程尚未确认退出，已停止后续操作；请核对后重启应用';
            throw new Error(execution.fatalError);
          }
          return result;
        }).finally(() => active.delete(record));
      record.promise = promise;
      active.add(record);
      return promise;
    },
    async abort() {
      const owned = [...active];
      for (const record of owned) record.controller.abort();
      const results = await Promise.all(owned.map((record) => record.promise));
      if (results.some((result) => !result.cleanupConfirmed)) throw new Error('命令所属进程未确认退出，请核对后继续');
    },
  };
}

export function commandToolResult(out) {
  const text = [out.stdout, out.stderr ? `stderr:\n${out.stderr}` : '',
    `exit=${out.code ?? 'none'}${out.signal ? ` signal=${out.signal}` : ''} · ${out.status}`,
    out.truncated ? '（输出已截断）' : '',
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text }], isError: out.status !== 'succeeded', details: out };
}

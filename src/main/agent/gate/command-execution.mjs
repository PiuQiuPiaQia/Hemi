/** 060：本机命令直接执行。权限由工具门控决定；本层只拥有进程、输出和终态。 */
import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { StringDecoder } from 'node:string_decoder';
import path from 'node:path';
import { comSpecPath, cmdExecArgs } from '../../platform/win-compat.mjs';

const exec = promisify(execFile);
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MAX_OUTPUT = 8 * 1024 * 1024;

export async function runCommand({ command, cwd, timeoutMs = 120_000, signal, env = process.env, maxOutput = MAX_OUTPUT, onSpawn = null, onOutput = null, ownerToken = null }) {
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
      onOutput?.({ stdout, stderr });
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
      // cmd.exe parses its command text itself, rather than using CRT argv
      // quoting. Match Node's shell mode: quote the whole /c payload and pass
      // it verbatim, preserving quotes inside node -e / PowerShell commands.
      const windowsGuard = windows && onSpawn;
      const args = windowsGuard ? [path.join(import.meta.dirname,'windows-command-entry.mjs'),Buffer.from(command).toString('base64'),JSON.stringify(env.ELECTRON_RUN_AS_NODE??null)] : windows ? cmdExecArgs('"' + command + '"') : onSpawn ? ['-c', 'IFS= read -r __hemi_command_start || exit 125; exec 3<&0; ( IFS= read -r __hemi_parent_life <&3; kill -KILL -- "-$$" ) <&3 & /bin/bash -c "$1" </dev/null 3<&-; __hemi_status=$?; exit "$__hemi_status"', `hemi-command:${ownerToken ?? randomUUID()}`, command] : ['-c', command];
      child = spawn(windowsGuard ? process.execPath : windows ? comSpecPath(env) : '/bin/bash', args, {
        cwd, env: windowsGuard ? {...env,ELECTRON_RUN_AS_NODE:'1'} : env, detached: !windows, windowsHide: true, windowsVerbatimArguments: windows && !windowsGuard, stdio: [onSpawn ? 'pipe' : 'ignore', 'pipe', 'pipe'],
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
          else child.stdin.write('start\n'); // 管道保持打开；宿主崩溃时 EOF 让守卫清理进程树。
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
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export { createCommandScope } from './command-scope.mjs';

export function commandToolResult(out) {
  if (out.status === 'background') return {
    content: [{ type: 'text', text: `命令已转后台（${out.jobId}），仍属于当前目标。可继续做不依赖它的工作；无独立工作时结束本次回复，宿主会等待完成后自动唤醒你。不要用 sleep 或循环查询等待，也不要提前宣布整个目标完成。` }],
    isError: false, details: out,
  };
  const text = [out.stdout, out.stderr ? `stderr:\n${out.stderr}` : '',
    `exit=${out.code ?? 'none'}${out.signal ? ` signal=${out.signal}` : ''} · ${out.status}`,
    out.truncated ? '（输出已截断）' : '',
  ].filter(Boolean).join('\n');
  return { content: [{ type: 'text', text }], isError: out.status !== 'succeeded', details: out };
}

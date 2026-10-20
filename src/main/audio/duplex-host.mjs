/**
 * duplex-host — 019 原生双工守护进程的宿主（主进程侧）。
 *
 * 职责：拉起 duplexd（独立 Swift 进程）、行协议编解码、事件转发（EventEmitter，
 * audio.ipc 订阅后转推渲染层/接管 TTS 直推）、异常重启与放弃判定。渲染层经
 * audio.ipc 的 IPC 面使用；TTS 分片由 tts.ipc 直推（音频数据不过渲染层，
 * 2026-09-21 裁决）。
 *
 * 生命周期语义（R-06/R-07）：
 * - start()：spawn → 发 start 命令 → 等 ready（4s 超时）。超时/退出/启动失败
 *   返回 {ok:false, reason}，渲染层据此回退浏览器链路。
 * - 运行中非正常退出：60s 窗口内最多重启 3 次；超限 → state 'failed' 事件，
 *   不再自动拉起（渲染层结束通话并给出明确提示，不无限重试）。
 * - stop()：shutdown 命令 + 500ms 宽限后 SIGKILL；主动停止不触发重启。
 *
 * spawn/时钟可注入：单测用假 helper（node 脚本）与假时间，不碰真音频。
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

export const DUPLEX_READY_TIMEOUT_MS = 4000;
const RESTART_WINDOW_MS = 60_000;
const MAX_RESTARTS = 3;
const STOP_GRACE_MS = 500;

/**
 * duplexd 二进制定位：HEMI_DUPLEX_BIN 显式指定 → dev 用仓库 dist/ →
 * 打包后用资源目录（electron-builder extraResources，见 019 技术方案）。
 */
export function resolveDuplexBin(app) {
  if (process.env.HEMI_DUPLEX_BIN) return process.env.HEMI_DUPLEX_BIN;
  if (!app || !app.isPackaged) {
    return path.join(app?.getAppPath?.() ?? process.cwd(), 'dist', 'duplexd');
  }
  return path.join(process.resourcesPath, 'duplexd');
}

export function createDuplexHost({
  bin,
  spawnFn = nodeSpawn,
  log = null,
  setTimeoutFn = setTimeout,
  clearTimeoutFn = clearTimeout,
  now = Date.now,
} = {}) {
  const events = new EventEmitter();
  let child = null;
  /** 会话级开关：start() 置位，stop()/放弃清零；运行态只在其为真时保持。 */
  let active = false;
  /** 本次会话是否拿到过 ready：从未 ready 的实例退出不值得重启（首启失败即回退）。 */
  let everReady = false;
  /** 主动 stop 期间为真：退出不进重启逻辑。 */
  let stopping = false;
  /** 当前（重）启动的 Promise 结算函数：ready/超时只结算一次。 */
  let settleLaunch = null;
  let lineBuffer = '';
  const restartTimestamps = [];

  function send(command) {
    if (!child?.stdin?.writable) return false;
    child.stdin.write(`${JSON.stringify(command)}\n`);
    return true;
  }

  function base64From(data) {
    if (data instanceof Buffer) return data.toString('base64');
    if (data instanceof ArrayBuffer) return Buffer.from(data).toString('base64');
    if (ArrayBuffer.isView(data)) {
      return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
    }
    return null;
  }

  function handleEvent(event) {
    switch (event.event) {
      case 'ready':
        everReady = true;
        events.emit('state', { phase: 'running', inFormat: event.inFormat ?? null, outFormat: event.outFormat ?? null });
        settleLaunch?.({ ok: true, inFormat: event.inFormat ?? null, outFormat: event.outFormat ?? null });
        settleLaunch = null;
        break;
      case 'cap': {
        const data = Buffer.from(event.pcm ?? '', 'base64');
        events.emit('cap', { data, ms: Number(event.ms) || 0 });
        break;
      }
      case 'drained':
        events.emit('drained');
        break;
      case 'underrun':
        events.emit('underrun');
        break;
      case 'fault':
        log?.warn(`duplexd fault：${event.error}`);
        events.emit('state', { phase: 'fault', error: String(event.error ?? '') });
        break;
      case 'bye':
        break;
      default:
        log?.warn(`duplexd 未知事件：${JSON.stringify(event).slice(0, 120)}`);
    }
  }

  function onExit(code, signal) {
    if (!child) return;
    settleLaunch?.({ ok: false, reason: 'helper-exited', code, signal });
    settleLaunch = null;
    child = null;
    lineBuffer = '';
    if (stopping || !active || !everReady) return;

    // 60s 滑窗内的第 MAX_RESTARTS+1 次死亡 → 放弃（R-07：不无限重试）。
    restartTimestamps.push(now());
    while (restartTimestamps.length && now() - restartTimestamps[0] > RESTART_WINDOW_MS) {
      restartTimestamps.shift();
    }
    if (restartTimestamps.length > MAX_RESTARTS) {
      active = false;
      log?.error(`duplexd 连续退出 ${restartTimestamps.length - 1} 次重启后仍不稳定，放弃（60s 窗口）`);
      events.emit('state', { phase: 'failed', reason: 'restart-exhausted' });
      return;
    }
    log?.warn(`duplexd 异常退出（code=${code} signal=${signal}），第 ${restartTimestamps.length} 次重启`);
    events.emit('state', { phase: 'restarting', attempt: restartTimestamps.length });
    void launch();
  }

  function launch() {
    return new Promise((resolve) => {
      settleLaunch = resolve;
      const thisChild = spawnFn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
      child = thisChild;
      // 迟到事件防御：重启换代后，旧实例的 exit/error 不许动新实例的状态。
      const guard = (callback) => (...args) => {
        if (child !== thisChild) return;
        callback(...args);
      };
      thisChild.stderr?.on('data', (chunk) => {
        const text = String(chunk).trim();
        if (text) log?.warn(`duplexd stderr：${text.slice(0, 200)}`);
      });
      child.stdout?.on('data', (chunk) => {
        lineBuffer += chunk.toString('utf8');
        let newline = lineBuffer.indexOf('\n');
        while (newline >= 0) {
          const line = lineBuffer.slice(0, newline);
          lineBuffer = lineBuffer.slice(newline + 1);
          newline = lineBuffer.indexOf('\n');
          if (!line.trim()) continue;
          try {
            handleEvent(JSON.parse(line));
          } catch {
            log?.warn(`duplexd 坏行：${line.slice(0, 120)}`);
          }
        }
      });
      thisChild.on('error', guard((error) => {
        // spawn 失败（ENOENT 等）不一定伴随 exit 事件：按退出处理，走同一结算。
        log?.warn(`duplexd spawn 失败：${error.message}`);
        onExit(-1, 'spawn-error');
      }));
      thisChild.on('exit', guard(onExit));
      const timer = setTimeoutFn(() => {
        settleLaunch?.({ ok: false, reason: 'ready-timeout' });
        settleLaunch = null;
        // 超时杀掉：没有 ready 的实例不可信。active 门控决定 exit 后是否重启——
        // 首启路径 start() 会在结算后置 active=false（微任务先于 exit 事件）。
        child?.kill('SIGKILL');
      }, DUPLEX_READY_TIMEOUT_MS);
      // 结算后清掉超时计时器（ready 正常到达时）。
      const originalSettle = settleLaunch;
      settleLaunch = (value) => {
        clearTimeoutFn(timer);
        originalSettle(value);
      };
      send({ cmd: 'start' });
    });
  }

  return {
    events,
    get isActive() {
      return active && child !== null;
    },
    get state() {
      if (!active) return 'idle';
      return child ? 'running' : 'restarting';
    },

    /** 会话开始：拉起并等 ready。失败不抛——返回 {ok:false, reason} 由调用方回退。 */
    async start() {
      if (this.isActive) return { ok: true, note: 'already-running' };
      if (!bin || !existsSync(bin)) {
        log?.warn(`duplexd 二进制不存在：${bin}`);
        return { ok: false, reason: 'binary-missing', bin };
      }
      active = true;
      stopping = false;
      everReady = false;
      restartTimestamps.length = 0;
      const result = await launch();
      if (!result.ok) {
        // 首次启动失败：不留半死实例。
        active = false;
        stopping = true;
        child?.kill('SIGKILL');
        stopping = false;
      }
      return result;
    },

    /** TTS 直推（tts.ipc 调用）：24k 单声道 i16。 */
    play(data) {
      if (!this.isActive) return false;
      const pcm = base64From(data);
      if (!pcm) return false;
      return send({ cmd: 'play', pcm });
    },

    /** 打断停播（渲染层 barge-in 确认后调用）。 */
    stopPlay() {
      return send({ cmd: 'stopPlay' });
    },

    /** 播放增益（duck/恢复；20ms 子块渐变，见 duplexd）。 */
    setVolume(gain) {
      return send({ cmd: 'volume', gain: Math.max(0, Math.min(1, Number(gain) || 0)) });
    },

    /** 会话结束：优雅关停，主动路径不重启。 */
    async stop() {
      if (!child) {
        active = false;
        return;
      }
      active = false;
      stopping = true;
      send({ cmd: 'shutdown' });
      const exited = new Promise((resolve) => {
        const timer = setTimeoutFn(() => resolve(false), STOP_GRACE_MS);
        child?.once('exit', () => {
          clearTimeoutFn(timer);
          resolve(true);
        });
      });
      if (!(await exited)) child?.kill('SIGKILL');
      stopping = false;
    },
  };
}

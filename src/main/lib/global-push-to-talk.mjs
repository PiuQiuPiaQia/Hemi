import { shell, systemPreferences } from 'electron';

import { readStoredConfig, saveStoredConfig } from './config-store.mjs';
import { nextHealRestartDelayMs, HEAL_RESTART_DELAYS_MS } from './heal-backoff.mjs';
import { createLogger } from './logger.mjs';
import { purgeAppleDoubleJunk } from './native-module-hygiene.mjs';
import { isOnboardingInProgress } from '../ipc/onboarding.ipc.mjs';
import { createOptionHoldDetector, isOptionKeycode } from './option-hold-detector.mjs';
import { isAllowedPushToTalkKey } from '../platform/hold-keys.mjs';
import { isSmokeTest } from '../state.mjs';
import {
  sendFloatingHoldCancel,
  sendFloatingHoldEnd,
  sendFloatingHoldStart,
} from '../ipc/floating.ipc.mjs';

const pushToTalkLog = createLogger('push-to-talk');

/** 授权轮询间隔：只在「开关已开但辅助功能未授权」期间运行。 */
const TRUST_POLL_MS = 3_000;

/**
 * 022 全局长按 Option 对话（仅 macOS）：
 * uiohook-napi 的全局键盘钩子（CGEventTap listenOnly，只听不拦截）喂
 * option-hold-detector，决策直接转成悬浮球同款 floating:command——
 * 主窗口渲染层因此只有一种长按语义，不新建会话模式。
 *
 * 失败兜底：native 模块加载失败/未授权都只影响本功能，不拖垮启动；
 * 原因落 hemi.log，设置页按 ready/startError 提示。
 */

let hookModule = null;
let hookStarted = false;
let detector = null;
let trustPollTimer = null;
let healTimer = null;
let startInFlight = false;
let lastStartError = '';
/**
 * 022 实测（macOS 26）：CGEventTap 未授权时创建成功但事件被静默吞掉，
 * 且 `isTrustedAccessibilityClient` 会因「责任进程」继承终端的授权而误报
 * true（dev 下 Electron.app 自己没有授权）。所以除了 AX 探测，还要看
 * 事件流是否真的来了：收到过任意按键事件＝监听链路确认可用。
 */
let receivedAnyKeyEvent = false;

function isAccessibilityTrusted() {
  if (process.platform !== 'darwin') return false;
  // false＝只查询、不弹系统授权框；弹框走 requestAccessibilityTrust 的用户手势。
  return systemPreferences.isTrustedAccessibilityClient(false);
}

function stopTrustPoll() {
  if (trustPollTimer === null) return;
  clearInterval(trustPollTimer);
  trustPollTimer = null;
}

/**
 * 自愈看门狗：tap 在无授权时创建会被静默吞事件（022 实测），而事后补的
 * 授权未必救活已存在的 tap。钩子活着但始终没见过事件时按退避梯次重建
 * （10s/30s/90s/5m×3，见 heal-backoff.mjs），事件来了即自清。
 *
 * 2026-09-30 晚间审计：原实现是 10s 固定 interval 且无上限——「没见过
 * 按键」与「tap 是聋的」不可区分，纯语音用户会每 10 秒无限重建。现在
 * 梯次走完即停手（healAttempt 达上限不再排程），恢复交还用户手势：
 * 设置页开关、去授权、输入监控引导都会重置梯次（resetHealLadder）。
 */
let healAttempt = 0;

function scheduleHealRestart() {
  if (healTimer !== null) return;
  const delay = nextHealRestartDelayMs(healAttempt + 1);
  if (delay === null) {
    pushToTalkLog.info(
      `全局钩子自愈重建已达上限（${HEAL_RESTART_DELAYS_MS.length} 次）仍未见事件流，暂停重建；` +
        '如已补授权，请在设置页关闭后重新开启全局快捷键',
    );
    return;
  }
  healTimer = setTimeout(() => {
    healTimer = null;
    if (receivedAnyKeyEvent || !hookStarted) return;
    healAttempt += 1;
    const next = nextHealRestartDelayMs(healAttempt + 1);
    pushToTalkLog.info(
      `全局钩子未收到任何按键事件，重建事件 tap（自愈第 ${healAttempt}/${HEAL_RESTART_DELAYS_MS.length} 次` +
        (next === null ? '，最后一次' : `，之后 ${Math.round(next / 1000)}s 再试`) +
        '）',
    );
    stopGlobalPushToTalk();
    void startGlobalPushToTalk();
  }, delay);
  healTimer.unref?.();
}

/** 用户手势（设置页开关 / 去授权 / 输入监控引导）＝正在处理授权：梯次从头来。 */
function resetHealLadder() {
  healAttempt = 0;
}

function scheduleTrustPoll() {
  if (trustPollTimer !== null) return;
  trustPollTimer = setInterval(() => {
    if (!isAccessibilityTrusted()) return;
    stopTrustPoll();
    pushToTalkLog.info('辅助功能授权完成，启动全局 Option 钩子');
    void startGlobalPushToTalk();
  }, TRUST_POLL_MS);
  // 不让定时器拖住进程退出。
  trustPollTimer.unref?.();
}

/** 读取配置并启动钩子；重复调用安全（startInFlight / hookStarted 双闸）。 */
export async function startGlobalPushToTalk() {
  if (process.platform !== 'darwin' || isSmokeTest) return;
  if (hookStarted || startInFlight) return;
  // 032：首启引导进行中不启用全局语音快捷键（用户还没完成配置门槛）；
  // 完成钩子（index.mjs 注入）会再调一次这里恢复启动。
  if (isOnboardingInProgress()) {
    pushToTalkLog.info('首启引导进行中，全局 Option 钩子暂不启动');
    return;
  }
  startInFlight = true;
  try {
    const stored = await readStoredConfig();
    if (!stored.globalPushToTalkEnabled) return;
    if (!isAccessibilityTrusted()) {
      pushToTalkLog.info(
        '全局 Option 对话已开启但缺少辅助功能授权，钩子暂不启动（设置页可引导授权）',
      );
      scheduleTrustPoll();
      return;
    }

    // 动态 import：native 模块坏掉只让本功能不可用，不影响应用启动。
    // 加载前先清 AppleDouble 垃圾（exFAT 工作区/安装拷贝链路都会再生），
    // 否则 node-gyp-build 的 readdir 兜底会装到 ._uiohook_napi.node。
    const purged = purgeAppleDoubleJunk('uiohook-napi');
    if (purged.length) {
      pushToTalkLog.warn(`清理了原生模块旁的 AppleDouble 垃圾：${purged.join(', ')}`);
    }
    hookModule = await import('uiohook-napi');
    detector = createOptionHoldDetector({
      start: () => {
        pushToTalkLog.debug('全局 Option 按下 → hold-start');
        sendFloatingHoldStart();
      },
      end: () => {
        pushToTalkLog.debug('全局 Option 松开 → hold-end');
        sendFloatingHoldEnd();
      },
      cancel: () => {
        pushToTalkLog.debug('全局 Option 按住中出现其他按键 → hold-cancel');
        sendFloatingHoldCancel();
      },
    });
    const markEvent = () => {
      if (!receivedAnyKeyEvent) {
        receivedAnyKeyEvent = true;
        healAttempt = 0;
        pushToTalkLog.info('全局钩子事件流已确认（收到首个按键事件）');
      }
    };
    hookModule.uIOhook.on('keydown', (event) => {
      markEvent();
      if (detector && isOptionKeycode(event.keycode)) detector.keydown(event.keycode);
    });
    hookModule.uIOhook.on('keyup', (event) => {
      markEvent();
      if (detector && isOptionKeycode(event.keycode)) detector.keyup(event.keycode);
    });
    hookModule.uIOhook.start();
    hookStarted = true;
    receivedAnyKeyEvent = false;
    lastStartError = '';
    stopTrustPoll();
    if (!receivedAnyKeyEvent) scheduleHealRestart();
    pushToTalkLog.info('全局 Option 钩子已启动（长按说话、松开提交）');
  } catch (error) {
    lastStartError = String(error?.message ?? error);
    pushToTalkLog.error(`全局 Option 钩子启动失败：${lastStartError}`);
  } finally {
    startInFlight = false;
  }
}

export function stopGlobalPushToTalk() {
  stopTrustPoll();
  if (healTimer !== null) {
    clearTimeout(healTimer);
    healTimer = null;
  }
  detector = null;
  lastStartError = '';
  receivedAnyKeyEvent = false;
  if (!hookStarted || !hookModule) return;
  try {
    hookModule.uIOhook.stop();
    hookModule.uIOhook.removeAllListeners('keydown');
    hookModule.uIOhook.removeAllListeners('keyup');
    pushToTalkLog.info('全局 Option 钩子已停止');
  } catch (error) {
    pushToTalkLog.warn(`全局 Option 钩子停止失败：${error?.message ?? error}`);
  }
  hookStarted = false;
}

/** 设置页开关：写配置后热启停，不用重启。 */
export async function setGlobalPushToTalkEnabled(enabled) {
  return setPushToTalkConfig({ enabled: Boolean(enabled) });
}

/**
 * 043：长按键配置统一入口（旧 setGlobalPushToTalkEnabled 映射到它）。
 * key 只接受当前平台已验证的键（白名单见 platform/hold-keys）——Windows
 * 候选键等 WP-04 真机探针过了才放开。未验证的键回 INVALID_INPUT 且不改
 * 变任何现有状态。
 */
export { PUSH_TO_TALK_ALLOWED_KEYS, isAllowedPushToTalkKey } from '../platform/hold-keys.mjs';

/** 当前钩子运行态 + 存储配置（设置页回执同源）。 */
async function pushToTalkStatus() {
  const stored = await readStoredConfig();
  return {
    globalPushToTalkEnabled: stored.globalPushToTalkEnabled === true,
    globalPushToTalkKey: stored.globalPushToTalkKey ?? '',
    globalPushToTalkReady: hookStarted,
    globalPushToTalkListening: receivedAnyKeyEvent,
    globalPushToTalkStartError: lastStartError,
  };
}

export async function setPushToTalkConfig({ enabled, key } = {}) {
  const patch = {};
  let invalidKey = false;
  if (typeof enabled === 'boolean') patch.globalPushToTalkEnabled = enabled;
  if (key !== undefined) {
    if (!isAllowedPushToTalkKey(process.platform, key)) {
      invalidKey = true;
    } else {
      patch.globalPushToTalkKey = String(key);
    }
  }
  if (invalidKey) {
    // 不改状态只报错：设置页据此提示「这个键暂不可用」，不静默吞掉。
    return { ...(await pushToTalkStatus()), error: 'INVALID_INPUT' };
  }
  if (Object.keys(patch).length) await saveStoredConfig(patch);
  if (typeof patch.globalPushToTalkEnabled === 'boolean') {
    resetHealLadder();
    if (patch.globalPushToTalkEnabled) await startGlobalPushToTalk();
    else stopGlobalPushToTalk();
  }
  return pushToTalkStatus();
}

export function isGlobalPushToTalkRunning() {
  return hookStarted;
}

export function isGlobalPushToTalkListening() {
  return receivedAnyKeyEvent;
}

/** 设置页展示真实启动失败原因（空串=没有失败），避免误报成缺辅助功能授权。 */
export function getGlobalPushToTalkStartError() {
  return lastStartError;
}

/** 设置页「去授权」：弹系统授权引导框（须由用户手势触发才合规）。 */
export function requestAccessibilityTrust() {
  if (process.platform !== 'darwin') return false;
  // 弹框只负责引导；授权是否完成由轮询/下次 start 探测。用户手势＝正在
  // 处理授权，重置自愈梯次（即便钩子已在跑、start 早退，下一轮也按新梯次重试）。
  resetHealLadder();
  scheduleHealRestart();
  void startGlobalPushToTalk();
  return systemPreferences.isTrustedAccessibilityClient(true);
}

/**
 * 直达「系统设置 → 隐私与安全性 → 输入监控」。022 实测：部分系统版本上
 * 键盘事件 tap 只认输入监控授权（辅助功能授权不够），事件流确认失败时
 * 引导用户来这里补勾。
 */
export async function openInputMonitoringPane() {
  if (process.platform !== 'darwin') return false;
  // 用户正要去系统设置补勾输入监控：回来后按新梯次重试（手势重置）。
  resetHealLadder();
  scheduleHealRestart();
  await shell.openExternal(
    'x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent',
  );
  return true;
}

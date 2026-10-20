/**
 * barge-in（播报打断）的判定状态机：纯逻辑、零副作用，参数集中在本文维护。
 *
 * 为什么单独一个文件：判定参数与状态（门是否「见过关」、连续过阈时长、压低态）
 * 曾经散在 page.tsx 与 types.ts 里，调参与回看都费劲；实测误打断（2026-09-19
 * 一声「嗯」就停播、2026-09-20 安静房间被自己的播报回声打断）也证明这套逻辑
 * 必须能离线复现——配套测试见 barge-in.test.mjs，每个历史故障一个用例。
 *
 * 019 的关键裁决：确认计数只统计**压低状态下**的过阈帧。压低是本地唯一可用的
 * 声学判别器——回声会随播报音量一起落回阈下，人声不会；因此「过阈且扛住了压低」
 * 才能攒确认时长。2026-09-20 的事故签名（压低→解除→8ms 后再压低→打断）正是
 * 旧版在满音量下把回声帧也攒进确认序列导致的。
 *
 * 页面侧职责：每个采集帧调一次 feed()，按返回动作执行副作用（压音量/停播/
 * 写日志）；「压低恢复」的滞回计时由页面安排（quiet 且处于压低态时起
 * duckReleaseMs 的计时，任何不安静的帧都取消该计时）。
 */

export type BargeInConfig = {
  /**
   * 确认人声需要的「压低状态下连续过阈」时长（毫秒）。用时长而不是帧数：
   * 85ms/帧是 48kHz 的数字，44.1kHz 采样下帧会变宽，固定帧数会把确认窗口
   * 拉长 9%。默认 340ms = 压低前的第一帧（触发 duck）+ 4 帧压低态过阈，
   * 与旧版「满 5 帧」的人声打断延迟完全一致。
   */
  confirmMs: number;
  /**
   * 播报期间打断判定在静音门门限之上再抬这么多 dB（只影响本地打断，不动
   * 上行静音门）。安静房间里门限会被地板钳在 -52，外放回声峰值（实测 -43
   * 一档）远超其上；抬高后残余回声更难逐帧过阈。这是 AEC 之后的保护层，
   * 不是根治——轻声插话的可达性随它变差，调参必须回真机（AC-02/03 对测）。
   */
  playbackMarginDb: number;
  /** 确认人声前先把播报音量压到这个值：回声会随音量落回阈下，人声不受影响。 */
  duckVolume: number;
  /** 电平落回阈下后，压低状态滞回这么久才恢复，防音量抖动。 */
  duckReleaseMs: number;
};

export const DEFAULT_BARGE_IN_CONFIG: BargeInConfig = {
  confirmMs: 340,
  playbackMarginDb: 6,
  duckVolume: 0.25,
  duckReleaseMs: 500,
};

/** 每个采集帧（48kHz 下约 85ms）喂给判定器的输入。 */
export type BargeInFrame = {
  /** SilenceGate 是否开门（能量已连续越过门限）。 */
  gateOpen: boolean;
  /** 本帧瞬时电平与当帧门限（dBFS），用于开门期间的连续性计数。 */
  levelDb: number;
  thresholdDb: number;
  /**
   * Hemi 的声音是否正在实际出声（播放已到排程起点）——不是「收到过音频
   * 字节」。回声只存在于出声期间；握手期的任何门上动静都与打断无关。
   */
  hasAudio: boolean;
  /** 本帧时长（毫秒），确认时长按它累计。 */
  frameMs: number;
};

export type BargeInAction = 'none' | 'duck' | 'interrupt' | 'duck-release';

export type BargeInDecision = {
  action: BargeInAction;
  /** 本帧是否安静（门已关，或电平落回抬升后的判定门限）；页面据此安排压低恢复。 */
  quiet: boolean;
};

export class BargeInController {
  private readonly config: BargeInConfig;

  /** 播报期间观察到门「关」过一次：从此门再开才算打断候选。 */
  private ready = false;
  /** 压低状态下累计的连续过阈时长（毫秒）；任何不过阈帧或状态切换都清零。 */
  private confirmedMs = 0;
  /** 播报音量当前是否被压低。 */
  private ducked = false;

  constructor(config: Partial<BargeInConfig> = {}) {
    this.config = { ...DEFAULT_BARGE_IN_CONFIG, ...config };
  }

  /** 当前是否处于压低态（页面判断要不要安排恢复计时）。 */
  get isDucked(): boolean {
    return this.ducked;
  }

  get duckVolume(): number {
    return this.config.duckVolume;
  }

  get duckReleaseMs(): number {
    return this.config.duckReleaseMs;
  }

  /** 新一次播报开始时复位：一切从「未武装」重新积累。 */
  reset(): void {
    this.ready = false;
    this.confirmedMs = 0;
    this.ducked = false;
  }

  /** 页面在滞回计时到期后调用；处于压低态则返回恢复动作。 */
  releaseDuck(): BargeInAction {
    if (!this.ducked) return 'none';
    this.ducked = false;
    // 压低→恢复是状态切换：旧确认作废。下一轮候选从「重新压低」重新攒。
    this.confirmedMs = 0;
    return 'duck-release';
  }

  feed(frame: BargeInFrame): BargeInDecision {
    // 音频还没真正出声：握手期的任何门上动静都与打断无关（实测误打断正是
    // 发生在这个窗口——回应刚落、音频未到，门还挂着上一句话的开启态）。
    if (!frame.hasAudio) {
      // Remember a quiet handshake. If the user starts before the first audio
      // arrives, they must not have to stop and start speaking again to interrupt.
      if (!frame.gateOpen) this.ready = true;
      return { action: 'none', quiet: false };
    }

    if (!frame.gateOpen) {
      // 门是关的：本次播报期间见过关门，打断从此「可武装」。
      this.ready = true;
      this.confirmedMs = 0;
      return { action: 'none', quiet: true };
    }
    if (!this.ready) {
      // 门一直开着：上一句话的悬挂或 thinking 期间的偶发开门，
      // 没见过关门之前不算打断候选。
      return { action: 'none', quiet: false };
    }

    // 播报期判定门限：静音门门限 + 播报保护余量。抬升只作用于打断判定——
    // 门本身的开合仍按静音门自己的门限（page 传入的 gateOpen）。
    const judgeDb = frame.thresholdDb + this.config.playbackMarginDb;
    const above = frame.levelDb >= judgeDb;
    if (!above) this.confirmedMs = 0;

    if (above && !this.ducked) {
      // 第一帧过阈先压音量：回声会落回阈下、连续性断掉、自动解除；
      // 人声扛得住压低，在压低态继续攒确认时长。
      this.ducked = true;
      this.confirmedMs = 0;
      return { action: 'duck', quiet: false };
    }

    if (this.ducked && above) {
      this.confirmedMs += frame.frameMs;
      if (this.confirmedMs >= this.config.confirmMs) {
        this.confirmedMs = 0;
        this.ducked = false;
        return { action: 'interrupt', quiet: false };
      }
    }

    return { action: 'none', quiet: !above };
  }
}

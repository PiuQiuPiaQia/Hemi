/**
 * TTS 播放器：把主进程推来的 16-bit 单声道 PCM 分片按顺序无缝排程到
 * Web Audio 时间线上。播放必须在渲染进程——系统回声消除（AEC）的参考
 * 信号要包含 Hemi 自己播出的声音，播在主进程里麦克风就分不清「Hemi 在说」
 * 和「用户在说」，本地打断判定（page.tsx 的 barge-in）会失效。
 *
 * 上下文用最小结构类型注入：离线测试给一个假 context 即可，不用真 AudioContext。
 */

export type TtsPlayerSource = {
  buffer: unknown;
  connect(destination: unknown): void;
  start(when?: number): void;
  stop(): void;
  /**
   * 兼容原生 AudioScheduledSourceNode 的 onended 签名（带 this 与 Event 参数，
   * 结构类型无法精确表达，这里放宽为任意参数列表）。
   */
  onended: ((...args: any[]) => void) | null;
};

export type TtsPlayerContext = {
  readonly currentTime: number;
  destination: unknown;
  createGain(): {
    gain: {
      value: number;
      cancelAndHoldAtTime(time: number): void;
      setValueAtTime(value: number, time: number): void;
      linearRampToValueAtTime(value: number, time: number): void;
    };
    connect(destination: unknown): void;
  };
  createBuffer(
    channels: number,
    length: number,
    sampleRate: number,
  ): { getChannelData(channel: number): Float32Array };
  createBufferSource(): TtsPlayerSource;
  close?(): Promise<void> | void;
  resume?(): Promise<void> | void;
};

export type TtsPlayerOptions = {
  /** 输入 PCM 的采样率。 */
  sampleRate?: number;
  /** 已排程的音频全部播完（队列传空）时回调；stopAll 不触发。 */
  onDrained?: () => void;
  /** Network / renderer scheduling exhausted the queued audio. */
  onUnderrun?: (gapMs: number) => void;
};

const INT16_RANGE = 32768;
/** 第一片音频的起播提前量，给排程留一点余量。 */
const INITIAL_LEAD_S = 0.12;
/** 片与片衔接的最小间隔，避免 start(过去时间) 被立即播放。 */
const MIN_GAP_S = 0.005;

export class TtsPlayer {
  private readonly context: TtsPlayerContext;
  private readonly sampleRate: number;
  private readonly onDrained?: () => void;
  private readonly onUnderrun?: (gapMs: number) => void;
  private previousEndTime: number | null = null;
  private pendingByte: number | null = null;
  private readonly volumeNode: ReturnType<TtsPlayerContext['createGain']>;
  private readonly sources = new Set<TtsPlayerSource>();
  /** 下一片应当开始的时间线位置；null = 当前没有已排程的音频。 */
  private nextStartTime: number | null = null;
  /** 当前这串音频的排程起点；null = 还没有任何已排程音频（019 实际出声判据）。 */
  private firstStartAt: number | null = null;
  /** stopAll 之后 onended 不再触发 drained：打断有自己的通路。 */
  private stopped = false;

  constructor(context: TtsPlayerContext, options: TtsPlayerOptions = {}) {
    this.context = context;
    this.sampleRate = options.sampleRate ?? 24000;
    this.onDrained = options.onDrained;
    this.onUnderrun = options.onUnderrun;
    this.volumeNode = context.createGain();
    this.volumeNode.connect(context.destination);
  }

  /** 没有在播、也没有已排程的音频。 */
  get isEmpty(): boolean {
    return this.sources.size === 0 && this.nextStartTime === null;
  }

  /**
   * Hemi 的声音是否已经实际出声（019）：播放时间线越过了排程起点。收到的
   * 字节还要等 INITIAL_LEAD_S 排程提前量才真正可闻——「收到」算不出声，
   * 回声也就不存在，打断判定必须以这个为准。
   */
  get isAudible(): boolean {
    return this.firstStartAt !== null && this.context.currentTime >= this.firstStartAt;
  }

  /** 播报音量。打断判定用它做 duck：压低后回声落回阈下，人声不受影响。 */
  setVolume(level: number): void {
    const gain = this.volumeNode.gain;
    const now = this.context.currentTime;
    // A step in gain at a nonzero sample is a click. Hold an in-flight ramp
    // before scheduling another so repeated duck/release stays continuous.
    gain.cancelAndHoldAtTime(now);
    // With no previous automation, cancelAndHold creates no anchor in
    // Chromium. Without this event the first ramp can start at time zero and
    // jump abruptly when issued during playback (verified with OfflineAudioContext).
    gain.setValueAtTime(gain.value, now);
    gain.linearRampToValueAtTime(Math.max(0, Math.min(1, level)), now + 0.015);
  }

  async resume(): Promise<void> {
    await this.context.resume?.();
  }

  /** 送来一段 PCM 分片，接到已排程片段的末尾。 */
  enqueue(pcm16: ArrayBuffer): void {
    // Transport chunks need not end at a sample boundary. Carry an odd byte
    // forward instead of throwing or shifting every later PCM sample.
    let bytes = new Uint8Array(pcm16);
    if (!bytes.length) return;
    if (this.pendingByte !== null) {
      const joined = new Uint8Array(bytes.length + 1);
      joined[0] = this.pendingByte;
      joined.set(bytes, 1);
      bytes = joined;
    }
    const evenLength = bytes.length - bytes.length % 2;
    this.pendingByte = bytes.length % 2 ? bytes[evenLength] : null;
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, evenLength / 2);
    if (!samples.length) return;

    this.stopped = false;
    const buffer = this.context.createBuffer(1, samples.length, this.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      channel[index] =
        sample < 0 ? sample / INT16_RANGE : sample / (INT16_RANGE - 1);
    }

    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.volumeNode);
    const startAt = Math.max(
      this.nextStartTime ?? this.context.currentTime + INITIAL_LEAD_S,
      this.context.currentTime + MIN_GAP_S,
    );
    if (this.firstStartAt === null) this.firstStartAt = startAt;
    if (this.previousEndTime !== null && startAt > this.previousEndTime + MIN_GAP_S) {
      this.onUnderrun?.((startAt - this.previousEndTime) * 1000);
    }
    source.start(startAt);
    this.nextStartTime = startAt + samples.length / this.sampleRate;
    this.previousEndTime = this.nextStartTime;
    this.sources.add(source);

    source.onended = () => {
      this.sources.delete(source);
      if (this.sources.size || this.nextStartTime === null) return;
      // 最后一片真的播到了自己的末尾才算排空；被打断的片子不触发回调。
      if (this.context.currentTime >= this.nextStartTime - MIN_GAP_S) {
        this.nextStartTime = null;
        if (!this.stopped) this.onDrained?.();
      }
    };
  }

  /** 立即停下一切（打断 / 结束通话 / 清空对话）。 */
  stopAll(): void {
    this.stopped = true;
    this.nextStartTime = null;
    this.previousEndTime = null;
    this.pendingByte = null;
    this.firstStartAt = null;
    for (const source of [...this.sources]) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // 尚未 start 的源 stop 会抛；忽略，本来就要求它不出声。
      }
      this.sources.delete(source);
    }
  }

  /** 停下并释放音频上下文（组件卸载时）。 */
  dispose(): void {
    this.stopAll();
    void this.context.close?.();
  }
}
